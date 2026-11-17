import { describe, expect, test } from "bun:test";
import type { ExclaveInfo } from "@seance/shared";
import { custodianChecks, type CustodianCheckDeps } from "./custodian-checks.ts";
import { sandboxDrilled, SANDBOX_UNDRILLED } from "./custodian-seat.ts";
import { CUSTODIAN_DEFAULTS } from "./config.ts";
import { roundDirFor } from "./custodian-launch.ts";
import type { Check } from "./check.ts";
import type { Exclave, ExclaveScan } from "./exclaves.ts";

const HOME = "/home/m";
const exclave = (id: string): Exclave => ({
  id,
  root: `${HOME}/${id}`,
  configDir: `${HOME}/.claude-${id}`,
  configFile: `${HOME}/.claude-${id}/.claude.json`,
});
const info = (id: string, over: Partial<ExclaveInfo> = {}): ExclaveInfo => ({
  id,
  accountId: `org:${id}`,
  extraUsageEnabled: null,
  authOk: true,
  skills: [],
  ...over,
});
const scan = (...entries: readonly [string, Partial<ExclaveInfo>?][]): ExclaveScan => ({
  exclaves: entries.map(([id]) => exclave(id)),
  info: entries.map(([id, over]) => info(id, over)),
  rejected: [],
});

const run = (deps: Partial<CustodianCheckDeps>, platform: NodeJS.Platform = "linux") =>
  custodianChecks({
    config: { custodian: CUSTODIAN_DEFAULTS, repoRoots: [] },
    home: HOME,
    platform,
    deps: {
      scan: () => Promise.resolve(scan(["work"])),
      trusted: () => Promise.resolve(true),
      rootExists: () => Promise.resolve(true),
      planted: () => Promise.resolve(false),
      sandboxProblem: () => Promise.resolve(null),
      weakerNested: () => Promise.resolve(false),
      drilled: () => true,
      toolchainProblem: () => Promise.resolve(null),
      sessionEventsMissing: () => Promise.resolve([]),
      inboxMissing: () => Promise.resolve([]),
      ...deps,
    },
  });

describe("custodianChecks", () => {
  test("the probes run with no seam: a key alone is a real check of the host", async () => {
    const probed: string[] = [];
    const checks = await custodianChecks({
      config: { custodian: CUSTODIAN_DEFAULTS, repoRoots: [] },
      home: HOME,
      platform: "linux",
      deps: {
        scan: () => {
          probed.push("scan");
          return Promise.resolve(scan());
        },
        sandboxProblem: () => {
          probed.push("sandbox");
          return Promise.resolve("bwrap and socat must be on PATH");
        },
        sessionEventsMissing: () => {
          probed.push("session-events");
          return Promise.resolve(["~/.claude-work"]);
        },
        weakerNested: () => Promise.resolve(true),
        toolchainProblem: () => Promise.resolve(null),
        inboxMissing: () => {
          probed.push("inbox");
          return Promise.resolve(["~/.claude-work"]);
        },
      },
    });
    expect(probed).toEqual(["sandbox", "scan", "session-events", "inbox"]);
    expect(checks.map((c) => c.level)).toEqual(["fail", "warn", "fail", "warn", "warn"]);
  });

  test("another platform fails at once", async () => {
    expect(await run({}, "win32")).toEqual([{ level: "fail", message: "the custodian runs only on macOS and Linux" }]);
  });

  test("a healthy host has one ok line per trusted exclave and nothing else", async () => {
    expect(await run({})).toEqual([
      { level: "ok", message: "exclave work: round dir ~/work/.seance-custodian trusted" },
    ]);
  });

  test("an exclave the seat would skip is never reported as able to host: no root, a planted dir", async () => {
    for (const [deps, reason] of [
      [{ rootExists: () => Promise.resolve(false) }, "root missing"],
      [{ planted: () => Promise.resolve(true) }, "round dir holds settings, agents or a link"],
    ] as const) {
      const checks = await run(deps);
      expect(checks).toEqual([
        { level: "warn", message: `exclave work: ${reason} — rounds skip it` },
        { level: "fail", message: "no exclave can host a round" },
      ]);
    }
  });

  test("an exclave without the session-events mod warns that close can never see a session", async () => {
    const checks = await run({ sessionEventsMissing: () => Promise.resolve(["~/.claude-work"]) });
    expect(checks).toEqual([
      { level: "ok", message: "exclave work: round dir ~/work/.seance-custodian trusted" },
      {
        level: "warn",
        message: expect.stringContaining("~/.claude-work: the session-events mod is not installed or enabled"),
      },
    ]);
    expect(checks[1]?.message).toContain("seance mod install");
  });

  test("an exclave without the inbox mod warns that nudge can never reach a session", async () => {
    const checks = await run({ inboxMissing: () => Promise.resolve(["~/.claude-work"]) });
    expect(checks).toEqual([
      { level: "ok", message: "exclave work: round dir ~/work/.seance-custodian trusted" },
      {
        level: "warn",
        message: expect.stringContaining("~/.claude-work: the inbox mod is not installed or enabled"),
      },
    ]);
    expect(checks[1]?.message).toContain("nudge");
    expect(checks[1]?.message).toContain("seance mod install");
  });

  test("a sandbox problem fails with its own words", async () => {
    const checks = await run({
      sandboxProblem: () => Promise.resolve("bwrap and socat must be on PATH (apt install bubblewrap socat)"),
    });
    expect(checks[0]).toEqual({ level: "fail", message: expect.stringContaining("apt install bubblewrap socat") });
  });

  test("a read-only /proc/sys warns that the weaker nested sandbox is on, on Linux only", async () => {
    const checks = await run({ weakerNested: () => Promise.resolve(true) });
    expect(checks[0]?.level).toBe("warn");
    expect(checks[0]?.message).toContain("enableWeakerNestedSandbox");
    expect((await run({ weakerNested: () => Promise.resolve(true) }, "darwin")).some((c) => c.level === "warn")).toBe(
      false,
    );
  });

  test("an undrilled Linux host fails with the seat's own words; macOS and a drilled host do not", async () => {
    const undrilled = { drilled: () => false };
    const checks = await run(undrilled);
    expect(checks[0]).toEqual({ level: "fail", message: SANDBOX_UNDRILLED });
    expect((await run(undrilled, "darwin")).some((c) => c.message === SANDBOX_UNDRILLED)).toBe(false);
    expect((await run({})).some((c) => c.message === SANDBOX_UNDRILLED)).toBe(false);
  });

  test("the real drilled test: Linux on an arch with no vsock filter fails in either bwrap mode, x64 passes", async () => {
    const on = (arch: string) => ({ drilled: (platform: "darwin" | "linux") => sandboxDrilled(platform, arch) });
    const undrilled = (checks: readonly Check[]): boolean => checks.some((c) => c.message === SANDBOX_UNDRILLED);
    expect(undrilled(await run(on("riscv64")))).toBe(true);
    const nested = await run({ ...on("riscv64"), weakerNested: () => Promise.resolve(true) });
    expect(undrilled(nested)).toBe(true);
    // Refused outright: no warning about a mode that never runs.
    expect(nested.some((c) => c.message.includes("enableWeakerNestedSandbox"))).toBe(false);
    expect(undrilled(await run(on("x64")))).toBe(false);
    expect(undrilled(await run({ ...on("x64"), weakerNested: () => Promise.resolve(true) }))).toBe(false);
  });

  test("a toolchain the sandbox's masks would hide fails, saying the round will not start", async () => {
    const checks = await run({ toolchainProblem: () => Promise.resolve("the daemon's checkout is not laid out") });
    expect(checks[0]).toEqual({
      level: "fail",
      message: "the daemon's checkout is not laid out — rounds refuse to start",
    });
  });

  test("the toolchain probe is given the repo roots and every exclave's root", async () => {
    let given: readonly string[] = [];
    await custodianChecks({
      config: { custodian: CUSTODIAN_DEFAULTS, repoRoots: ["/home/u/code"] },
      home: HOME,
      platform: "linux",
      deps: {
        scan: () => Promise.resolve(scan(["work"])),
        trusted: () => Promise.resolve(true),
        rootExists: () => Promise.resolve(true),
        planted: () => Promise.resolve(false),
        sandboxProblem: () => Promise.resolve(null),
        weakerNested: () => Promise.resolve(false),
        drilled: () => true,
        toolchainProblem: (_platform, roots) => {
          given = roots;
          return Promise.resolve(null);
        },
        sessionEventsMissing: () => Promise.resolve([]),
      },
    });
    expect(given).toEqual(["/home/u/code", exclave("work").root]);
  });

  test("a signed-out exclave warns, an untrusted one says how to trust it, and none able to host fails", async () => {
    const checks = await run({
      scan: () => Promise.resolve(scan(["a", { authOk: false }], ["b"])),
      trusted: () => Promise.resolve(false),
    });
    expect(checks).toEqual([
      { level: "warn", message: "exclave a: signed out — rounds skip it" },
      {
        level: "warn",
        message: `exclave b: ~/b/.seance-custodian is not trusted in ~/.claude-b/.claude.json — rounds skip it; trust it once: mkdir -p ${HOME}/b/.seance-custodian && cd ${HOME}/b/.seance-custodian && claude`,
      },
      { level: "fail", message: "no exclave can host a round" },
    ]);
  });

  test("one trusted exclave among others is enough", async () => {
    const checks = await run({
      scan: () => Promise.resolve(scan(["a", { accountId: null }], ["b"])),
    });
    expect(checks.map((c) => c.level)).toEqual(["warn", "ok"]);
  });

  test("the default exclave's round dir is the one under the state dir", () => {
    expect(roundDirFor(exclave("default"))).toContain("custodian/cwd");
  });
});
