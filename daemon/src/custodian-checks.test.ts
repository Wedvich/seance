import { describe, expect, test } from "bun:test";
import type { ExclaveInfo } from "@seance/shared";
import { custodianChecks, type CustodianCheckDeps } from "./custodian-checks.ts";
import { CUSTODIAN_DEFAULTS } from "./config.ts";
import { roundDirFor } from "./custodian-launch.ts";
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
    config: { custodian: CUSTODIAN_DEFAULTS },
    home: HOME,
    platform,
    live: true,
    deps: {
      scan: () => Promise.resolve(scan(["work"])),
      trusted: () => Promise.resolve(true),
      rootExists: () => Promise.resolve(true),
      planted: () => Promise.resolve(false),
      sandboxProblem: () => Promise.resolve(null),
      weakerNested: () => Promise.resolve(false),
      sessionEventsMissing: () => Promise.resolve([]),
      ...deps,
    },
  });

describe("custodianChecks", () => {
  test("while rounds are held it is one ok line and probes nothing, so doctor cannot fail on the key", async () => {
    const probed: string[] = [];
    const checks = await custodianChecks({
      config: { custodian: CUSTODIAN_DEFAULTS },
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
      },
    });
    expect(checks).toEqual([{ level: "ok", message: expect.stringContaining("held until the round is contained") }]);
    expect(probed).toEqual([]);
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
      [{ planted: () => Promise.resolve(true) }, "round dir holds settings or agents"],
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
    expect(checks[1]?.message).toContain("seanced mod install");
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
