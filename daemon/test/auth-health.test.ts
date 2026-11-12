import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_EXPIRING_MS,
  CAPABILITIES,
  importPsk,
  open as openSealed,
  parseMachineInfo,
  parseMachineStatus,
  toBase64,
  type ExclaveInfo,
  type MachineStatus,
} from "@seance/shared";
import { createBackend } from "../src/backend-default.ts";
import type { Config } from "../src/config.ts";
import { startDaemon } from "../src/run.ts";
import {
  AUTH_READ_SCRIPT,
  createAuthHealth,
  keychainService,
  type AuthHealth,
  type AuthHealthDeps,
  type AuthView,
} from "../src/auth-health.ts";
import type { Exclave } from "../src/exclaves.ts";
import { exec } from "../src/exec.ts";
import { loginName } from "../src/usage-refresh.ts";
import {
  captureLog,
  makeGitFixture,
  pollUntil,
  usePrivateTmux,
  type GitFixture,
  type PrivateTmux,
} from "./fixtures.ts";
import { startTestRelay } from "./harness.ts";
import { makeSecurityShim, type SecurityShim } from "./security-shim.ts";

/** Distinctive fakes: the leak assertions search for these, so they live only in this file. */
const ACCESS = "sk-ant-oat01-FAKEACCESS-aaaaaaaaaaaaaaaaaaaaaaaa";
const REFRESH = "sk-ant-ort01-FAKEREFRESH-bbbbbbbbbbbbbbbbbbbbbbbb";
const MARKERS = ["FAKEACCESS", "FAKEREFRESH"];

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;
const WARM_FLAG = "--stub-warm";

let base = "";
let home = "";
let shim: SecurityShim;
let stubs: {
  readonly binDir: string;
  readonly wrongShape: string;
  readonly hang: string;
  readonly record: string;
  readonly slow: string;
  readonly seconds: string;
  readonly fdcheck: string;
  readonly escaper: string;
};

function creds(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: NOW + 3_600_000,
      refreshTokenExpiresAt: NOW + 20 * DAY,
      scopes: ["user:inference"],
      subscriptionType: "max",
      ...over,
    },
  });
}

/** The scan-shaped fixture: an exclave whose config dir holds `file` as `.credentials.json` (null: none). */
async function exclave(
  id: string,
  file: string | null,
  signedIn = true,
): Promise<{ exclave: Exclave; info: ExclaveInfo }> {
  const configDir = join(home, `.claude-${id}`);
  await rm(configDir, { recursive: true, force: true });
  await mkdir(configDir, { recursive: true });
  if (file !== null) await writeFile(join(configDir, ".credentials.json"), file, { mode: 0o600 });
  return {
    exclave: { id, root: join(home, id), configDir, configFile: join(configDir, ".claude.json") },
    info: { id, accountId: `org:${id}`, extraUsageEnabled: null, authOk: signedIn, skills: [] },
  };
}

function health(
  fixtures: readonly { exclave: Exclave; info: ExclaveInfo }[],
  over: Partial<AuthHealthDeps> = {},
): AuthHealth {
  return createAuthHealth({
    scan: () => ({ exclaves: fixtures.map((f) => f.exclave), info: fixtures.map((f) => f.info) }),
    home,
    // The file read, on every host: on darwin the keychain-off default reads nothing.
    platform: "linux",
    now: () => NOW,
    bunBin: process.execPath,
    // Per-test timers must not fire a second walk under a slow test.
    checkIntervalMs: 3_600_000,
    log: () => {},
    ...over,
  });
}

const settled = (v: AuthView): boolean => !(v.state === "unknown" && v.why === "pending");

/** Starts, waits for every exclave's first read, and for the reader to go quiet. */
async function run(h: AuthHealth): Promise<ReadonlyMap<string, AuthView>> {
  h.start();
  await pollUntil(() => {
    const view = h.view();
    return view.size > 0 && [...view.values()].every(settled);
  }, "first auth reads");
  await h.idle();
  await h.stop();
  return h.view();
}

async function readOne(
  id: string,
  file: string | null,
  over: Partial<AuthHealthDeps> = {},
): Promise<AuthView | undefined> {
  const f = await exclave(id, file);
  return (await run(health([f], over))).get(id);
}

async function stub(name: string, body: string): Promise<string> {
  const path = join(stubs.binDir, name);
  await writeFile(path, `#!/bin/bash\n[ "$1" = ${WARM_FLAG} ] && exit 0\n${body}\n`);
  await chmod(path, 0o755);
  // First exec in setup: macOS scans a never-executed file, which must not land in a timed window.
  const warmed = await exec([path, WARM_FLAG]);
  if (warmed.exitCode !== 0) throw new Error(`stub ${name} failed to start`);
  return path;
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "auth-health-"));
  home = join(base, "home");
  await mkdir(home, { recursive: true });
  shim = await makeSecurityShim(base);
  const binDir = join(base, "stubs");
  await mkdir(binDir, { recursive: true });
  stubs = { binDir, wrongShape: "", hang: "", record: "", slow: "", seconds: "", fdcheck: "", escaper: "" };
  stubs = {
    binDir,
    // Both of the child's streams carry a marker: nothing it prints may reach a log or a view.
    wrongShape: await stub(
      "wrong-shape",
      `echo "${ACCESS}" >&2\nprintf '{"lapsed":false,"refreshExpiresAt":${NOW},"x":"${ACCESS}"}'`,
    ),
    seconds: await stub("seconds", `printf '{"lapsed":false,"refreshExpiresAt":1790000000}'`),
    // What the daemon hands the child, as the child sees it: the credentials file itself on stdin (not a pipe
    // the daemon wrote into) and /dev/null for stderr. /proc is Linux's; elsewhere only the shape is checked.
    fdcheck: await stub(
      "fdcheck",
      [
        "if [ -e /proc/self/fd/0 ]; then",
        "  in=$(readlink /proc/self/fd/0); err=$(readlink /proc/self/fd/2)",
        '  case "$in" in */.claude-fdcheck/.credentials.json) ;; *) exit 9 ;; esac',
        '  [ "$err" = /dev/null ] || exit 9',
        "fi",
        `printf '{"lapsed":false,"refreshExpiresAt":null}'`,
      ].join("\n"),
    ),
    // A descendant in its own session keeps the child's stdout open past the group kill.
    escaper: await stub("escaper", "setsid sleep 6 &\nsleep 30"),
    hang: await stub("hang", "sleep 30"),
    record: await stub(
      "record",
      `echo run >> "${join(base, "record.log")}"\nprintf '{"lapsed":false,"refreshExpiresAt":null}'`,
    ),
    slow: await stub(
      "slow",
      `echo "start $$" >> "${join(base, "slow.log")}"\nsleep 0.15\necho "end $$" >> "${join(base, "slow.log")}"\nprintf '{"lapsed":false,"refreshExpiresAt":null}'`,
    ),
  };
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("the reader, through the real bun child", () => {
  test("a healthy login is ok", async () => {
    expect(await readOne("ok", creds())).toEqual({ state: "ok" });
  });

  test("a refresh token expiring within 3 days is expiring, with its expiry", async () => {
    const at = NOW + 2 * DAY;
    expect(await readOne("soon", creds({ refreshTokenExpiresAt: at }))).toEqual({ state: "expiring", expiresAt: at });
    const edge = NOW + AUTH_EXPIRING_MS;
    expect(await readOne("edge", creds({ refreshTokenExpiresAt: edge }))).toEqual({
      state: "expiring",
      expiresAt: edge,
    });
  });

  test("an access token outliving the refresh expiry by days suppresses it: ok, as in Claude Code", async () => {
    const view = await readOne("suppressed", creds({ refreshTokenExpiresAt: NOW + DAY, expiresAt: NOW + 5 * DAY }));
    expect(view).toEqual({ state: "ok" });
  });

  test("both tokens empty is expired, whatever the expiry says", async () => {
    expect(await readOne("lapsed", creds({ accessToken: "", refreshToken: "", expiresAt: 0 }))).toEqual({
      state: "expired",
    });
  });

  test("one empty token alone is not a lapse", async () => {
    expect(await readOne("half", creds({ accessToken: "" }))).toEqual({ state: "ok" });
  });

  test("an expiry that is no ms epoch (seconds, a duration) is no expiry: never expired", async () => {
    expect(await readOne("secs", creds({ refreshTokenExpiresAt: 1_790_000_000 }))).toEqual({ state: "ok" });
    expect(await readOne("dur", creds({ refreshTokenExpiresAt: 2_592_000 }))).toEqual({ state: "ok" });
    // And a child that prints one is not believed either.
    expect(await readOne("printed", creds(), { bunBin: stubs.seconds })).toEqual({ state: "unknown", why: "output" });
  });

  test("a refresh expiry in the past is expired", async () => {
    expect(await readOne("past", creds({ refreshTokenExpiresAt: NOW - 1000 }))).toEqual({ state: "expired" });
  });

  test("no file reads unknown/absent, never ok or expired", async () => {
    expect(await readOne("absent", null)).toEqual({ state: "unknown", why: "absent" });
  });

  test("truncated JSON and a file that is not a credential store read unknown/output", async () => {
    expect(await readOne("truncated", creds().slice(0, 30))).toEqual({ state: "unknown", why: "output" });
    expect(await readOne("notstore", JSON.stringify({ mcpOAuth: {} }))).toEqual({ state: "unknown", why: "output" });
    expect(await readOne("badtype", creds({ refreshToken: 7 }))).toEqual({ state: "unknown", why: "output" });
  });

  test("a file over 64 KiB is never handed to a child: unknown/too_large", async () => {
    expect(await readOne("big", creds({ padding: "x".repeat(70_000) }), { bunBin: stubs.record })).toEqual({
      state: "unknown",
      why: "too_large",
    });
  });

  test("output off the exact shape reads unknown/output", async () => {
    expect(await readOne("shape", creds(), { bunBin: stubs.wrongShape })).toEqual({ state: "unknown", why: "output" });
  });

  test("the file reaches the child as its own descriptor, and stderr as /dev/null: the daemon reads neither", async () => {
    expect(await readOne("fdcheck", creds(), { bunBin: stubs.fdcheck })).toEqual({ state: "ok" });
  });

  test("a path that is not a regular file is refused without blocking: unknown/unreadable", async () => {
    const f = await exclave("fifo", null);
    const made = Bun.spawnSync(["mkfifo", join(f.exclave.configDir, ".credentials.json")]);
    expect(made.exitCode).toBe(0);
    expect((await run(health([f], { bunBin: stubs.record }))).get("fifo")).toEqual({
      state: "unknown",
      why: "unreadable",
    });
  });

  test.skipIf(Bun.which("setsid") === null)(
    "a descendant holding the child's stdout past the kill cannot wedge the lane: unknown/timeout at the hard deadline",
    async () => {
      const f = await exclave("wedge", creds());
      const started = Date.now();
      const view = (await run(health([f], { bunBin: stubs.escaper, timeoutMs: 200 }))).get("wedge");
      expect(view).toEqual({ state: "unknown", why: "timeout" });
      // 200 ms + 1 s kill grace + 1 s slack, well before the descendant's 6 s.
      expect(Date.now() - started).toBeLessThan(4_500);
    },
    10_000,
  );

  test("a child that never answers is killed at the timeout: unknown/timeout", async () => {
    expect(await readOne("slowpoke", creds(), { bunBin: stubs.hang, timeoutMs: 200 })).toEqual({
      state: "unknown",
      why: "timeout",
    });
  });

  test("a global ~/.bunfig.toml preload does not run in the child: bun reads that file for package-manager commands only", async () => {
    const marker = join(base, "preload-ran");
    const preload = join(base, "preload.js");
    await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    const toml = `preload = [${JSON.stringify(preload)}]\n`;
    // Control: the same file as a project bunfig.toml does fire, so a silent marker below means something.
    const project = join(base, "preload-project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "bunfig.toml"), toml);
    await exec([process.execPath, "--no-env-file", "--no-install", "-e", "1"], { cwd: project });
    expect(await Bun.file(marker).exists()).toBe(true);
    await rm(marker);

    const preloadHome = join(base, "preload-home");
    await mkdir(preloadHome, { recursive: true });
    await writeFile(join(preloadHome, ".bunfig.toml"), toml);
    const f = await exclave("preloaded", creds());
    expect((await run(health([f], { home: preloadHome }))).get("preloaded")).toEqual({ state: "ok" });
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("a bun that cannot be started reads unknown/spawn", async () => {
    expect(await readOne("nobun", creds(), { bunBin: join(base, "no-such-bun") })).toEqual({
      state: "unknown",
      why: "spawn",
    });
  });

  test("the script is constant: the same text however the reader is configured", () => {
    expect(AUTH_READ_SCRIPT).not.toContain(home);
    expect(AUTH_READ_SCRIPT).not.toContain("process.env");
  });
});

describe("bun resolves through PATH at each spawn, never process.execPath", () => {
  test("with bunBin unset, the bun on PATH is the one run", async () => {
    const dir = join(base, "pathbin");
    await mkdir(dir, { recursive: true });
    const log = join(base, "pathbun.log");
    const bun = join(dir, "bun");
    await writeFile(
      bun,
      `#!/bin/bash\n[ "$1" = ${WARM_FLAG} ] && exit 0\necho "$@" >> "${log}"\nprintf '{"lapsed":false,"refreshExpiresAt":null}'\n`,
    );
    await chmod(bun, 0o755);
    await exec([bun, WARM_FLAG]);
    const realPath = process.env["PATH"];
    process.env["PATH"] = `${dir}:${realPath ?? ""}`;
    try {
      const f = await exclave("viapath", creds());
      const view = await run(health([f], { bunBin: undefined }));
      expect(view.get("viapath")).toEqual({ state: "ok" });
    } finally {
      if (realPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = realPath;
    }
    const argv = await readFile(log, "utf8");
    expect(argv).toContain("--no-env-file --no-install -e");
    expect(argv).toContain(" stdin");
  });
});

describe("not read yet is unknown, never ok", () => {
  test("every signed-in exclave is unknown/pending while a read is out; a signed-out one is listed nowhere", async () => {
    const a = await exclave("p1", creds());
    const b = await exclave("p2", creds());
    const out = await exclave("p3", creds(), false);
    const h = health([a, b, out], { bunBin: stubs.hang, timeoutMs: 5_000 });
    expect(h.view().get("p1")).toEqual({ state: "unknown", why: "pending" });
    h.start();
    // The first read is a child that never answers: nothing completes, and nothing reads ok.
    await Bun.sleep(150);
    const view = h.view();
    expect([...view.keys()]).toEqual(["p1", "p2"]);
    expect(view.get("p1")).toEqual({ state: "unknown", why: "pending" });
    expect(view.get("p2")).toEqual({ state: "unknown", why: "pending" });
    expect(h.expired("p1")).toBe(false);
    await h.stop();
  });

  test("a gone exclave drops from the view", async () => {
    const a = await exclave("g1", creds());
    const b = await exclave("g2", creds());
    let fixtures = [a, b];
    const h = createAuthHealth({
      scan: () => ({ exclaves: fixtures.map((f) => f.exclave), info: fixtures.map((f) => f.info) }),
      home,
      platform: "linux",
      now: () => NOW,
      bunBin: stubs.record,
      checkIntervalMs: 20,
    });
    h.start();
    await pollUntil(() => h.view().get("g2")?.state === "ok", "g2 read");
    fixtures = [a];
    expect([...h.view().keys()]).toEqual(["g1"]);
    await h.stop();
  });
});

describe("macOS", () => {
  test("keychain off (the default): no child runs for an exclave with no file; it reads unknown/keychain_off", async () => {
    await rm(join(base, "record.log"), { force: true });
    const view = await readOne("mac-off", null, { platform: "darwin", bunBin: stubs.record });
    expect(view).toEqual({ state: "unknown", why: "keychain_off" });
    expect(await Bun.file(join(base, "record.log")).exists()).toBe(false);
  });

  test("keychain off ignores a credentials file in the config dir: a Mac's login lives in the keychain, so a leftover file must not read as its truth", async () => {
    await rm(join(base, "record.log"), { force: true });
    const stale = creds({ accessToken: "", refreshToken: "", refreshTokenExpiresAt: NOW - DAY });
    const view = await readOne("mac-file", stale, { platform: "darwin", bunBin: stubs.record });
    expect(view).toEqual({ state: "unknown", why: "keychain_off" });
    expect(await Bun.file(join(base, "record.log")).exists()).toBe(false);
  });

  test("keychain on: the item's value is judged, through the child's `security -w`", async () => {
    await shim.set("Claude Code-credentials", creds({ accessToken: "", refreshToken: "" }));
    const view = await readOne("default", null, {
      platform: "darwin",
      keychain: true,
      securityBin: join(shim.binDir, "security"),
    });
    expect(view).toEqual({ state: "expired" });
    const call = (await shim.calls()).at(-1);
    expect(call).toEqual(["find-generic-password", "-a", expectedAccount(), "-w", "-s", "Claude Code-credentials"]);
    await shim.set("Claude Code-credentials", null);
  });

  test("a named exclave uses the hashed service name", async () => {
    const f = await exclave("named", null);
    const service = `Claude Code-credentials-${createHash("sha256").update(f.exclave.configDir).digest("hex").slice(0, 8)}`;
    expect(keychainService(f.exclave)).toBe(service);
    await shim.set(service, creds());
    const view = await run(
      health([f], { platform: "darwin", keychain: true, securityBin: join(shim.binDir, "security") }),
    );
    expect(view.get("named")).toEqual({ state: "ok" });
    const call = (await shim.calls()).at(-1);
    expect(call).toEqual(["find-generic-password", "-a", expectedAccount(), "-w", "-s", service]);
    await shim.set(service, null);
  });

  test("no keychain item (exit 44) falls back to the file; no file either is absent", async () => {
    const withFile = await readOne("fallback", creds({ refreshTokenExpiresAt: NOW + 2 * DAY }), {
      platform: "darwin",
      keychain: true,
      securityBin: join(shim.binDir, "security"),
    });
    expect(withFile).toEqual({ state: "expiring", expiresAt: NOW + 2 * DAY });
    const without = await readOne("nofile", null, {
      platform: "darwin",
      keychain: true,
      securityBin: join(shim.binDir, "security"),
    });
    expect(without).toEqual({ state: "unknown", why: "absent" });
  });

  test("any other keychain failure reads unknown/keychain, and the file is not consulted", async () => {
    const fail = Bun.which("false");
    expect(fail).not.toBeNull();
    const view = await readOne("kc-fail", creds({ accessToken: "", refreshToken: "" }), {
      platform: "darwin",
      keychain: true,
      securityBin: fail ?? "false",
    });
    expect(view).toEqual({ state: "unknown", why: "keychain" });
  });
});

function expectedAccount(): string {
  const user = loginName();
  return user !== null && /^[a-zA-Z0-9._-]+$/u.test(user) ? user : "claude-code-user";
}

describe("no token reaches the daemon", () => {
  test("no marker appears in a view, a log line or anywhere a reader of the daemon could look", async () => {
    const fixtures = [
      await exclave("n-ok", creds()),
      await exclave("n-soon", creds({ refreshTokenExpiresAt: NOW + DAY })),
      await exclave("n-lapsed", creds({ accessToken: "", refreshToken: "" })),
      await exclave("n-trunc", creds().slice(0, 50)),
      await exclave("n-shape", creds()),
    ];
    const lines = await captureLog(async () => {
      // The default logger, so the daemon's own `log` is what is captured.
      const views = new Map<string, AuthView>();
      for (const f of fixtures.slice(0, 4)) {
        const h = createAuthHealth({
          scan: () => ({ exclaves: [f.exclave], info: [f.info] }),
          home,
          platform: "linux",
          now: () => NOW,
          bunBin: process.execPath,
          checkIntervalMs: 3_600_000,
        });
        for (const [id, view] of await run(h)) views.set(id, view);
      }
      const shaped = fixtures[4];
      if (shaped === undefined) throw new Error("fixture");
      const wrong = createAuthHealth({
        scan: () => ({ exclaves: [shaped.exclave], info: [shaped.info] }),
        home,
        platform: "linux",
        now: () => NOW,
        bunBin: stubs.wrongShape,
        checkIntervalMs: 3_600_000,
      });
      for (const [id, view] of await run(wrong)) views.set(id, view);
      for (const marker of MARKERS) expect(JSON.stringify([...views])).not.toContain(marker);
      expect(views.get("n-lapsed")).toEqual({ state: "expired" });
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      for (const marker of MARKERS) expect(line).not.toContain(marker);
      expect(line).toMatch(/auth: exclave=n-[a-z]+ state=(ok|expiring|expired|unknown)( why=[a-z_]+)?$/u);
    }
  });

  test("one line per state change, fixed text only", async () => {
    const f = await exclave("once", creds());
    const lines: string[] = [];
    const h = health([f], { log: (line) => lines.push(line), checkIntervalMs: 20, minRereadMs: 0 });
    h.start();
    await pollUntil(() => lines.length === 1, "first line");
    h.poke("once");
    await h.idle();
    await Bun.sleep(100);
    expect(lines).toEqual(["auth: exclave=once state=ok"]);
    await h.stop();
  });
});

describe("cadence", () => {
  async function count(file: string): Promise<number> {
    const text = await Bun.file(file)
      .text()
      .catch(() => "");
    return text.split("\n").filter((l) => l !== "").length;
  }

  test("a read is not repeated inside the 60 s floor, poked or not; past it, a poke re-reads", async () => {
    const log = join(base, "record.log");
    await rm(log, { force: true });
    const f = await exclave("floor", creds());
    let clock = NOW;
    const h = health([f], { bunBin: stubs.record, now: () => clock });
    h.start();
    await pollUntil(async () => (await count(log)) === 1, "first read");
    await h.idle();
    clock += 30_000;
    h.poke("floor");
    await h.idle();
    expect(await count(log)).toBe(1);
    clock += 31_000;
    h.poke("floor");
    await pollUntil(async () => (await count(log)) === 2, "poked re-read");
    await h.stop();
  });

  test("a changed credentials file is re-read at the next check; an unchanged one is not", async () => {
    const log = join(base, "record.log");
    await rm(log, { force: true });
    const f = await exclave("marker", creds());
    const h = health([f], { bunBin: stubs.record, checkIntervalMs: 20, minRereadMs: 0 });
    h.start();
    await pollUntil(async () => (await count(log)) === 1, "first read");
    // Negative assertion: a non-event cannot be polled.
    await Bun.sleep(150);
    expect(await count(log)).toBe(1);
    const file = join(f.exclave.configDir, ".credentials.json");
    await writeFile(file, creds({ accessToken: "", refreshToken: "" }));
    await utimes(file, new Date(NOW), new Date(NOW + 1000));
    await pollUntil(async () => (await count(log)) === 2, "re-read after the file changed");
    await h.stop();
  });

  test("one child at a time across instances: a reload's two daemons never read at once", async () => {
    const log = join(base, "slow.log");
    await rm(log, { force: true });
    const first = health([await exclave("c1", creds()), await exclave("c2", creds())], { bunBin: stubs.slow });
    const second = health([await exclave("d1", creds()), await exclave("d2", creds())], { bunBin: stubs.slow });
    first.start();
    second.start();
    const allRead = (h: AuthHealth): boolean => [...h.view().values()].every(settled);
    await pollUntil(() => allRead(first) && allRead(second), "both instances read", 15_000);
    await Promise.all([first.idle(), second.idle()]);
    await Promise.all([first.stop(), second.stop()]);
    const events = (await readFile(log, "utf8")).split("\n").filter((l) => l !== "");
    expect(events.map((e) => e.split(" ")[0])).toEqual([
      "start",
      "end",
      "start",
      "end",
      "start",
      "end",
      "start",
      "end",
    ]);
  });

  test("onChange fires once the reader is quiet, not per exclave; and again when the clock alone flips a state", async () => {
    const fixtures = [
      await exclave("o1", creds()),
      await exclave("o2", creds({ refreshTokenExpiresAt: NOW + DAY })),
      await exclave("o3", creds()),
    ];
    let clock = NOW;
    let h: AuthHealth | null = null;
    const seen: boolean[] = [];
    h = health(fixtures, {
      now: () => clock,
      checkIntervalMs: 20,
      // The clock jump must flip the state by itself, not through a re-read.
      rereadMs: 10 * DAY,
      onChange: () => seen.push([...(h?.view().values() ?? [])].every(settled)),
    });
    h.start();
    await pollUntil(() => seen.length > 0, "the settled walk");
    // Every exclave had a reading by the time it told.
    expect(seen).toEqual([true]);
    clock = NOW + DAY + 1;
    await pollUntil(() => seen.length >= 2, "the flip to expired");
    expect(h.view().get("o2")).toEqual({ state: "expired" });
    await h.stop();
  });

  test("one child at a time: reads never overlap", async () => {
    const log = join(base, "slow.log");
    await rm(log, { force: true });
    const fixtures = [await exclave("s1", creds()), await exclave("s2", creds()), await exclave("s3", creds())];
    const h = health(fixtures, { bunBin: stubs.slow });
    h.start();
    await pollUntil(() => [...h.view().values()].every(settled), "all three read", 10_000);
    await h.idle();
    await h.stop();
    const events = (await readFile(log, "utf8")).split("\n").filter((l) => l !== "");
    expect(events.map((e) => e.split(" ")[0])).toEqual(["start", "end", "start", "end", "start", "end"]);
  });

  test("a login on a lapsed exclave clears it at the next check, no poke needed", async () => {
    const f = await exclave("relogin", creds({ accessToken: "", refreshToken: "" }));
    const h = health([f], { checkIntervalMs: 20, minRereadMs: 0 });
    h.start();
    await pollUntil(() => h.expired("relogin"), "expired read");
    const file = join(f.exclave.configDir, ".credentials.json");
    await writeFile(file, creds());
    await utimes(file, new Date(NOW), new Date(NOW + 5000));
    await pollUntil(() => h.view().get("relogin")?.state === "ok", "cleared after /login");
    await h.stop();
  });

  test("an expiry that passes between reads flips to expired without a re-read", async () => {
    const f = await exclave("flip", creds({ refreshTokenExpiresAt: NOW + DAY }));
    let clock = NOW;
    const h = health([f], { now: () => clock });
    expect((await run(h)).get("flip")).toEqual({ state: "expiring", expiresAt: NOW + DAY });
    clock = NOW + DAY + 1;
    expect(h.expired("flip")).toBe(true);
    expect(h.view().get("flip")).toEqual({ state: "expired" });
  });
});

describe("the daemon", () => {
  const PSK = toBase64(new Uint8Array(32).fill(7));
  const TOKEN = "test-bearer";
  let privateTmux: PrivateTmux | undefined;
  let fixture: GitFixture;
  let appKey: CryptoKey;

  beforeAll(async () => {
    process.env["SEANCE_STATE_DIR"] = join(base, "state");
    privateTmux = usePrivateTmux(base, "auth-health");
    fixture = await makeGitFixture(base);
    appKey = await importPsk(PSK);
  });

  afterAll(async () => {
    await privateTmux?.dispose();
    delete process.env["SEANCE_STATE_DIR"];
  });

  const account = { oauthAccount: { organizationUuid: "org", accountUuid: "acct" } };

  /** A home with `default` lapsed, `work` healthy and `soon` expiring in a day, all signed in. */
  async function authHome(): Promise<string> {
    const dir = await mkdtemp(join(base, "daemon-home-"));
    await writeFile(join(dir, ".exclaves"), "work\nsoon\n");
    await writeFile(join(dir, ".claude.json"), JSON.stringify(account));
    const soon = Date.now() + DAY;
    const far = Date.now() + 20 * DAY;
    const layout: readonly (readonly [string, string, string])[] = [
      ["default", join(dir, ".claude"), creds({ accessToken: "", refreshToken: "", expiresAt: 0 })],
      ["work", join(dir, ".claude-work"), creds({ refreshTokenExpiresAt: far, expiresAt: Date.now() + 1000 })],
      ["soon", join(dir, ".claude-soon"), creds({ refreshTokenExpiresAt: soon, expiresAt: Date.now() + 1000 })],
    ];
    for (const [id, configDir, file] of layout) {
      // oxlint-disable-next-line no-await-in-loop -- three small writes
      await mkdir(configDir, { recursive: true });
      // oxlint-disable-next-line no-await-in-loop
      await writeFile(join(configDir, ".credentials.json"), file);
      if (id === "default") continue;
      // oxlint-disable-next-line no-await-in-loop
      await mkdir(join(dir, id), { recursive: true });
      // oxlint-disable-next-line no-await-in-loop
      await writeFile(join(configDir, ".claude.json"), JSON.stringify(account));
    }
    return dir;
  }

  async function withDaemon(
    options: { readonly authHealth?: Partial<AuthHealthDeps> },
    body: (relay: ReturnType<typeof startTestRelay>, statuses: () => Promise<MachineStatus>) => Promise<void>,
  ): Promise<void> {
    const daemonHome = await authHome();
    const relay = startTestRelay(TOKEN);
    const config: Config = {
      name: "AuthMac",
      relayUrl: relay.url,
      bearerToken: TOKEN,
      psk: PSK,
      repoRoots: [fixture.root],
      tmuxSession: "main",
    };
    let daemon: { stop(): void } | undefined;
    try {
      daemon = await startDaemon({
        config,
        backend: createBackend(config, { home: daemonHome }),
        home: daemonHome,
        pingIntervalMs: 60_000,
        pongTimeoutMs: 1_000,
        baseBackoffMs: 20,
        telemetryIntervalMs: 100,
        ...options,
      });
      await body(relay, async () => {
        const env = await relay.statuses.next(5_000);
        const plain = await openSealed(appKey, env);
        // The sealed-then-opened payload is what a reader of the relay's blobs gets: no token in it.
        for (const marker of MARKERS) expect(JSON.stringify(plain.payload)).not.toContain(marker);
        const status = parseMachineStatus(plain.payload);
        if (status === null) throw new Error("unparseable status");
        return status;
      });
    } finally {
      daemon?.stop();
      relay.stop();
    }
  }

  test("reports a lapsed login in ax and an expiring one in ae, and advertises authHealth", async () => {
    await withDaemon({ authHealth: { platform: "linux", bunBin: process.execPath } }, async (relay, next) => {
      const frame = await relay.registers.next(5_000);
      const info = parseMachineInfo((await openSealed(appKey, frame.info)).payload);
      expect(info?.capabilities).toContain(CAPABILITIES.authHealth);
      expect(info?.exclaves?.map((e) => e.id)).toEqual(["default", "work", "soon"]);

      let status: MachineStatus | null = null;
      const deadline = Date.now() + 15_000;
      // Until the first reads land every signed-in exclave is in `au`, never silently ok.
      while (status === null || status.ax === undefined || status.ae === undefined || status.au !== undefined) {
        if (Date.now() > deadline) throw new Error(`no settled auth status; last ${JSON.stringify(status)}`);
        // oxlint-disable-next-line no-await-in-loop -- statuses arrive in order
        status = await next();
      }
      expect(status.ax).toEqual([0]);
      expect(status.ae?.map(([x]) => x)).toEqual([2]);
      expect(status.ae?.[0]?.[1]).toBeGreaterThan(Date.now() / 1000);
    });
  });

  test("a daemon started without authHealth advertises nothing and reports no auth fields", async () => {
    await withDaemon({}, async (relay, next) => {
      const frame = await relay.registers.next(5_000);
      const info = parseMachineInfo((await openSealed(appKey, frame.info)).payload);
      expect(info?.capabilities).not.toContain(CAPABILITIES.authHealth);
      for (let i = 0; i < 3; i++) {
        // oxlint-disable-next-line no-await-in-loop -- statuses arrive in order
        const status = await next();
        expect(status).not.toHaveProperty("ax");
        expect(status).not.toHaveProperty("ae");
        expect(status).not.toHaveProperty("au");
      }
    });
  });
});
