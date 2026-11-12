import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  asTargetArgv,
  assertUnprivileged,
  missingBinariesMessage,
  missingUnitBinaries,
  mkdirAsTarget,
  parsePasswdLine,
  reachableAs,
  reachablePath,
  requireRoot,
  targetUserName,
  untrustedChain,
  untrustedTree,
  whichIn,
  writeRisk,
  type TargetUser,
  SUDO_SEANCED,
} from "./target-user.ts";

const dirs: string[] = [];

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "seance-target-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("requireRoot", () => {
  test("names the sudo form it wants, PATH preservation included", () => {
    expect(() => requireRoot(1000, "install --system")).toThrow(
      /sudo --preserve-env=PATH "\$\(command -v seanced\)" install --system/u,
    );
  });

  test("root passes, and an unknown uid is not root", () => {
    expect(() => requireRoot(0, "install --system")).not.toThrow();
    expect(() => requireRoot(undefined, "install --system")).toThrow();
  });
});

describe("targetUserName", () => {
  test("the flag beats SUDO_USER", () => {
    expect(targetUserName("ada", { SUDO_USER: "grace" })).toBe("ada");
    expect(targetUserName(undefined, { SUDO_USER: "grace" })).toBe("grace");
  });

  test("neither, or root, refuses — the daemon must not run as root", () => {
    expect(() => targetUserName(undefined, {})).toThrow(/--user/u);
    expect(() => targetUserName(undefined, { SUDO_USER: "" })).toThrow(/--user/u);
    expect(() => targetUserName(undefined, { SUDO_USER: "root" })).toThrow(/never run as root/u);
    expect(() => targetUserName("root", {})).toThrow(/never run as root/u);
  });
});

describe("parsePasswdLine", () => {
  test("the fields the unit needs, GECOS commas and all", () => {
    expect(parsePasswdLine("ada:x:1000:1001:Ada L,,,:/home/ada:/bin/zsh\n")).toEqual({
      name: "ada",
      uid: 1000,
      gid: 1001,
      home: "/home/ada",
    });
  });

  test("null on anything it can't trust", () => {
    expect(parsePasswdLine("")).toBeNull();
    expect(parsePasswdLine("ada:x:1000:1001:/home/ada")).toBeNull();
    expect(parsePasswdLine("ada:x:notanumber:1001::/home/ada:/bin/sh")).toBeNull();
    expect(parsePasswdLine("ada:x:1000:1001:::/bin/sh")).toBeNull();
    // Number("") is 0: an empty field must not parse as root.
    expect(parsePasswdLine("ada:x::1001::/home/ada:/bin/sh")).toBeNull();
    expect(parsePasswdLine("ada:x:1000:::/home/ada:/bin/sh")).toBeNull();
  });
});

describe("whichIn", () => {
  test("scans the PATH it is given, in order, and needs the executable bit", async () => {
    const first = await fixtureDir();
    const second = await fixtureDir();
    await writeFile(join(second, "bun"), "#!/bin/sh\n", { mode: 0o755 });
    const notExecutable = join(first, "bun");
    await writeFile(notExecutable, "#!/bin/sh\n", { mode: 0o644 });
    await chmod(notExecutable, 0o644);

    const path = [first, second].join(delimiter);
    expect(await whichIn("bun", path)).toBe(join(second, "bun"));
    expect(await whichIn("tmux", path)).toBeNull();
    expect(await whichIn("bun", "")).toBeNull();
  });
});

describe("missing binaries", () => {
  test("an empty PATH is missing all four, and the message names the sudo cause", async () => {
    const missing = await missingUnitBinaries("", []);
    expect(missing).toEqual(["bun", "git", "tmux", "claude"]);
    const message = missingBinariesMessage(missing, "/usr/sbin:/usr/bin");
    expect(message).toContain("secure_path");
    expect(message).toContain(SUDO_SEANCED);
    expect(message).toContain('sudo env PATH="$PATH" seanced install --system');
  });

  test("with dirs left out, it names them and --path instead of re-preserving PATH", () => {
    const message = missingBinariesMessage(["bun"], "/usr/bin", ["/root/.local/share/mise/installs/bun/latest/bin"]);
    expect(message).toContain("/root/.local/share/mise/installs/bun/latest/bin");
    expect(message).toContain(`${SUDO_SEANCED} install --system --path`);
    expect(message).not.toContain("secure_path");
  });
});

// The production prefix is `asTargetArgv`, which only root can run; an empty one
// probes as this process, so a dir locked against us stands in for root's home.
describe("reaching PATH as the unit's user", () => {
  test("the prefix drops to the target's uid and gid with its supplementary groups", () => {
    expect(asTargetArgv({ name: "ada", uid: 1000, gid: 1001, home: "/home/ada" })).toEqual([
      "setpriv",
      "--reuid=1000",
      "--regid=1001",
      "--init-groups",
      "--",
    ]);
  });

  // Root searches a 0700 dir regardless of its mode.
  test.if(process.getuid?.() !== 0)("leaves out what the user can't search, and empty entries", async () => {
    const open = await fixtureDir();
    const locked = await fixtureDir();
    const inside = join(locked, "bin");
    await mkdir(inside);
    await chmod(locked, 0o000);
    try {
      const offered = [inside, open, "", join(open, "absent"), open].join(delimiter);
      expect(await reachablePath(offered, [])).toEqual({
        pathEnv: [open, open].join(delimiter),
        dropped: [inside, join(open, "absent")],
      });
    } finally {
      await chmod(locked, 0o700);
    }
  });

  test("a file counts only with the exec bit, whatever its position", async () => {
    const dir = await fixtureDir();
    const plain = join(dir, "plain");
    const runnable = join(dir, "runnable");
    await writeFile(plain, "", { mode: 0o644 });
    await writeFile(runnable, "#!/bin/sh\n", { mode: 0o755 });
    // paths[0] is the one a misread empty line would wrongly vouch for.
    expect(await reachableAs([], [plain, runnable])).toEqual(new Set([runnable]));
    expect(await reachableAs([], [])).toEqual(new Set());
  });

  test("a probe that can't run refuses rather than vouching for nothing or everything", async () => {
    await expect(reachableAs(["false"], ["/usr/bin"])).rejects.toThrow(/couldn't check PATH as the unit's user/u);
  });
});

describe("assertUnprivileged", () => {
  test("uid 0 under any name, and root's group too", () => {
    // `toor` is the case the name check misses: a second uid-0 account.
    expect(() => assertUnprivileged({ name: "toor", uid: 0, gid: 0, home: "/root" })).toThrow(/never run as root/u);
    expect(() => assertUnprivileged({ name: "ada", uid: 1000, gid: 0, home: "/home/ada" })).toThrow(
      /never run as root/u,
    );
    expect(() => assertUnprivileged({ name: "ada", uid: 1000, gid: 1000, home: "/home/ada" })).not.toThrow();
  });
});

describe("mkdirAsTarget", () => {
  // Needs a second group we belong to: chowning to our own primary gid would pass
  // whether or not the parents were touched, since mkdir already gives them that.
  const gid = process.getgroups?.().find((group) => group !== process.getgid?.());

  test.if(gid !== undefined)("hands over every component it creates, not just the leaf", async () => {
    const root = await fixtureDir();
    const user: TargetUser = { name: "self", uid: process.getuid?.() ?? 0, gid: gid ?? 0, home: root };
    const leaf = join(root, ".local", "state", "seance");
    await mkdirAsTarget(leaf, user);
    for (const dir of [join(root, ".local"), join(root, ".local", "state"), leaf]) {
      // oxlint-disable-next-line no-await-in-loop -- three stats, order irrelevant
      expect((await stat(dir)).gid).toBe(user.gid);
    }
  });

  test.if(gid !== undefined)("an existing directory changes hands too", async () => {
    const dir = await fixtureDir();
    const user: TargetUser = { name: "self", uid: process.getuid?.() ?? 0, gid: gid ?? 0, home: dir };
    await mkdirAsTarget(dir, user);
    expect((await stat(dir)).gid).toBe(user.gid);
  });
});

describe("write trust", () => {
  const trust = { uids: [0, 1001], gids: [0, 1001] };
  const file = { uid: 1001, gid: 1001, mode: 0o755, directory: false };

  test("writeRisk accepts the trusted owners and refuses another owner, a world or an untrusted group write", () => {
    expect(writeRisk(file, trust)).toBeNull();
    expect(writeRisk({ ...file, uid: 0, gid: 0, mode: 0o755 }, trust)).toBeNull();
    expect(writeRisk({ ...file, uid: 1000 }, trust)).toBe("owned by uid 1000");
    expect(writeRisk({ ...file, mode: 0o757 }, trust)).toBe("writable by anyone");
    expect(writeRisk({ ...file, gid: 50, mode: 0o775 }, trust)).toBe("writable by group 50");
    // A group write by a trusted group is the user's own.
    expect(writeRisk({ ...file, mode: 0o775 }, trust)).toBeNull();
  });

  test("a sticky world-writable directory passes as an ancestor, never as the entry", () => {
    const tmp = { uid: 0, gid: 0, mode: 0o1777, directory: true };
    expect(writeRisk(tmp, trust, true)).toBeNull();
    expect(writeRisk(tmp, trust)).toBe("writable by anyone");
    expect(writeRisk({ ...tmp, mode: 0o777 }, trust, true)).toBe("writable by anyone");
  });

  test("untrustedChain walks the realpath and every ancestor", async () => {
    const dir = await fixtureDir();
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "bun"), "#!/bin/sh\n", { mode: 0o755 });
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const mine = { uids: [0, uid], gids: [0, gid] };
    // The sandbox's own tmpdir ancestors are root's or sticky, so nothing in the chain is flagged.
    expect(await untrustedChain(join(bin, "bun"), mine)).toEqual([]);
    await chmod(bin, 0o777);
    expect((await untrustedChain(join(bin, "bun"), mine)).join("\n")).toContain(`${bin} (writable by anyone)`);
    expect((await untrustedChain(join(bin, "bun"), { uids: [0], gids: [0] })).length).toBeGreaterThan(0);
    expect(await untrustedChain(join(dir, "missing"), mine)).toEqual([]);
  });

  test("untrustedTree reports a writable entry and stops at the limit", async () => {
    const dir = await fixtureDir();
    await mkdir(join(dir, "src"));
    for (const name of ["a", "b", "c"]) {
      await writeFile(join(dir, "src", name), "x");
      // After the write: the umask would strip these bits from the create mode.
      await chmod(join(dir, "src", name), 0o666);
    }
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const found = await untrustedTree(dir, { uids: [uid], gids: [gid] }, 2);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("writable by anyone");
    expect(await untrustedTree(dir, { uids: [uid + 1], gids: [gid] }, 10)).toHaveLength(4);
  });
});
