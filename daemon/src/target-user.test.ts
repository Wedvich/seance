import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  assertUnprivileged,
  missingBinariesMessage,
  missingUnitBinaries,
  mkdirAsTarget,
  parsePasswdLine,
  requireRoot,
  targetUserName,
  whichIn,
  type TargetUser,
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
    expect(() => requireRoot(1000, "install --system")).toThrow(/sudo --preserve-env=PATH seanced install --system/u);
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
    const missing = await missingUnitBinaries("");
    expect(missing).toEqual(["bun", "git", "tmux", "claude"]);
    const message = missingBinariesMessage(missing, "/usr/sbin:/usr/bin");
    expect(message).toContain("secure_path");
    expect(message).toContain("--preserve-env=PATH");
    expect(message).toContain('--path "$PATH"');
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
