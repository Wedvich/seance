import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importPsk,
  open as openSealed,
  parseMachineInfo,
  parseMachineStatus,
  STATUS_MAX_TRAIT_PAIRS,
  toBase64,
  type MachineStatus,
} from "@seance/shared";
import { createBackend } from "../src/backend-default.ts";
import type { Config, TraitProbeConfig, TraitsConfig } from "../src/config.ts";
import type { Exclave } from "../src/exclaves.ts";
import { PROBE_FLOOR_MS, createTraitProbes, type TraitProbes, type TraitProbesDeps } from "../src/trait-probes.ts";
import { startDaemon } from "../src/run.ts";
import {
  captureLog,
  makeGitFixture,
  pollUntil,
  usePrivateTmux,
  type GitFixture,
  type PrivateTmux,
} from "./fixtures.ts";
import { startTestRelay } from "./harness.ts";

/** System binaries only (`sh`, `true`, `false`, `sleep`): nothing written here is exec'd inside a timed window. */
let base = "";
let home = "";

function exclave(id: string): Exclave {
  const configDir = join(home, `.claude-${id}`);
  return { id, root: join(home, id), configDir, configFile: join(configDir, ".claude.json") };
}

const probe = (argv: readonly string[], over: Partial<TraitProbeConfig> = {}): { probe: TraitProbeConfig } => ({
  probe: { argv, everyMinutes: 30, timeoutSeconds: 10, ...over },
});

/** Every instance a test starts, stopped in afterEach: `bun test` fires no exit hooks, so a leftover would run on. */
const live: TraitProbes[] = [];

function make(
  allTraits: TraitsConfig,
  over: Partial<TraitProbesDeps> = {},
  exclaves: readonly Exclave[] = [exclave("default"), exclave("work")],
): TraitProbes {
  const probes = createTraitProbes({
    allTraits,
    scan: () => ({ exclaves }),
    home,
    onChange: () => {},
    audit: () => {},
    // Per-test timers must not fire a second pass under a slow test.
    checkIntervalMs: 3_600_000,
    ...over,
  });
  live.push(probes);
  return probes;
}

const settled = (p: TraitProbes): boolean => {
  const view = p.view();
  return view.size > 0 && [...view.values()].every((s) => s.kind !== "pending");
};

async function runOnce(p: TraitProbes): Promise<void> {
  p.start();
  await pollUntil(() => settled(p), "first probe results", 10_000);
  await p.idle();
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "trait-probes-"));
  home = join(base, "home");
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await Promise.all(live.splice(0).map((p) => p.stop()));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("what a run reads", () => {
  test("exit 0 is healthy, another exit is failing with its code, an unresolvable or unrunnable program is unknown", async () => {
    const notExecutable = join(base, "not-executable");
    await writeFile(notExecutable, "#!/bin/sh\nexit 0\n");
    await chmod(notExecutable, 0o644);
    const p = make({
      fine: probe(["true"]),
      bad: probe(["sh", "-c", "exit 3"]),
      gone: probe(["seance-no-such-program-xyz"]),
      cannot: probe([notExecutable]),
    });
    await runOnce(p);
    expect(Object.fromEntries(p.view())).toEqual({
      fine: { kind: "healthy" },
      bad: { kind: "failing", exit: 3 },
      gone: { kind: "unknown", why: "not_found" },
      cannot: { kind: "unknown", why: "spawn" },
    });
  });

  test("a probe that traps TERM is killed by group at its timeout and reads unknown", async () => {
    const p = make({ stuck: probe(["sh", "-c", "trap '' TERM; sleep 30"], { timeoutSeconds: 1 }) });
    const began = Date.now();
    p.start();
    await pollUntil(() => settled(p), "the timeout", 8_000);
    expect(p.view().get("stuck")).toEqual({ kind: "unknown", why: "timeout" });
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  test("a descendant a probe leaves behind is killed with its group when the probe exits on its own", async () => {
    const pidFile = join(base, "orphan.pid");
    await rm(pidFile, { force: true });
    const p = make({ forks: probe(["sh", "-c", `sleep 300 & echo $! > "${pidFile}"; exit 0`]) });
    await runOnce(p);
    expect(p.view().get("forks")).toEqual({ kind: "healthy" });
    const orphan = Math.trunc(Number(await readFile(pidFile, "utf8")));
    expect(orphan).toBeGreaterThan(0);
    await pollUntil(() => {
      try {
        process.kill(orphan, 0);
        return false;
      } catch {
        return true;
      }
    }, "the left-behind descendant to be gone");
  });

  test("a flood of output cannot stall a probe: its stdio is ignored", async () => {
    const p = make({ loud: probe(["sh", "-c", "head -c 4000000 /dev/zero; head -c 4000000 /dev/zero >&2"]) });
    await runOnce(p);
    expect(p.view().get("loud")).toEqual({ kind: "healthy" });
  });
});

describe("the environment", () => {
  const saved = {
    leak: process.env["SEANCE_PROBE_LEAK"],
    cred: process.env["CREDENTIALS_DIRECTORY"],
    cfg: process.env["CLAUDE_CONFIG_DIR"],
  };

  afterEach(() => {
    for (const [name, value] of [
      ["SEANCE_PROBE_LEAK", saved.leak],
      ["CREDENTIALS_DIRECTORY", saved.cred],
      ["CLAUDE_CONFIG_DIR", saved.cfg],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("a probe gets the session's environment, less the service-delivered credential directory", async () => {
    process.env["SEANCE_PROBE_LEAK"] = "yes";
    process.env["CREDENTIALS_DIRECTORY"] = "/run/credentials/seanced";
    const p = make({
      inherits: probe(["sh", "-c", 'test "$SEANCE_PROBE_LEAK" = yes']),
      stripped: probe(["sh", "-c", 'test -z "$CREDENTIALS_DIRECTORY"']),
    });
    await runOnce(p);
    expect(p.view().get("inherits")).toEqual({ kind: "healthy" });
    expect(p.view().get("stripped")).toEqual({ kind: "healthy" });
  });

  test("an exclave-scoped trait runs with that exclave's CLAUDE_CONFIG_DIR, and `default` with none", async () => {
    process.env["CLAUDE_CONFIG_DIR"] = "/ambient/not-an-exclave";
    const work = exclave("work");
    const p = make({
      named: {
        exclaves: ["work"],
        ...probe(["sh", "-c", 'test "$CLAUDE_CONFIG_DIR" = "$1"', "sh", work.configDir]),
      },
      unset: { exclaves: ["default"], ...probe(["sh", "-c", 'test -z "$CLAUDE_CONFIG_DIR"']) },
    });
    await runOnce(p);
    expect(Object.fromEntries(p.view())).toEqual({
      "named/work": { kind: "healthy" },
      "unset/default": { kind: "healthy" },
    });
  });
});

describe("one at a time", () => {
  test("across instances: a reload's two daemons never run a probe at once", async () => {
    const log = join(base, "lane.log");
    await rm(log, { force: true });
    const argv = ["sh", "-c", `echo start >> "${log}"; sleep 0.15; echo end >> "${log}"`];
    const first = make({ a: probe(argv), b: probe(argv) });
    const second = make({ c: probe(argv), d: probe(argv) });
    first.start();
    second.start();
    await pollUntil(() => settled(first) && settled(second), "both instances ran", 15_000);
    await Promise.all([first.idle(), second.idle()]);
    const events = (await readFile(log, "utf8")).split("\n").filter((l) => l !== "");
    expect(events).toEqual(["start", "end", "start", "end", "start", "end", "start", "end"]);
  });
});

describe("cadence", () => {
  async function count(file: string): Promise<number> {
    try {
      return (await readFile(file, "utf8")).split("\n").filter((l) => l !== "").length;
    } catch {
      return 0;
    }
  }

  test("every unit runs once at start; a healthy one reruns after everyMinutes, a failing one at the five-minute floor", async () => {
    const okLog = join(base, "cadence-ok.log");
    const badLog = join(base, "cadence-bad.log");
    await rm(okLog, { force: true });
    await rm(badLog, { force: true });
    let clock = 1_790_000_000_000;
    const p = make(
      {
        ok: probe(["sh", "-c", `echo run >> "${okLog}"`], { everyMinutes: 30 }),
        bad: probe(["sh", "-c", `echo run >> "${badLog}"; exit 1`], { everyMinutes: 30 }),
      },
      { now: () => clock, checkIntervalMs: 20 },
    );
    p.start();
    await pollUntil(async () => (await count(okLog)) === 1 && (await count(badLog)) === 1, "the run at start");
    // A non-event cannot be polled: give the 20 ms check a few beats to wrongly rerun either unit.
    await Bun.sleep(150);
    expect([await count(okLog), await count(badLog)]).toEqual([1, 1]);

    clock += PROBE_FLOOR_MS - 1;
    await Bun.sleep(150);
    expect([await count(okLog), await count(badLog)]).toEqual([1, 1]);
    clock += 1;
    await pollUntil(async () => (await count(badLog)) === 2, "the failing unit's rerun at the floor");
    await Bun.sleep(150);
    expect(await count(okLog)).toBe(1);

    clock += 30 * 60_000;
    await pollUntil(async () => (await count(okLog)) === 2, "the healthy unit's rerun at everyMinutes");
  });

  test("an exclave that appears in a later scan is armed and run then, and onChange fires once per quiet lane", async () => {
    const lines: string[] = [];
    const exclaves: Exclave[] = [exclave("default")];
    let changes = 0;
    let clock = 1_790_000_000_000;
    const p = make(
      { gate: { exclaves: ["default", "late"], ...probe(["true"]) } },
      {
        now: () => clock,
        checkIntervalMs: 20,
        audit: (line) => void lines.push(String(line)),
        onChange: () => void changes++,
      },
      exclaves,
    );
    p.start();
    await pollUntil(() => p.view().get("gate/default")?.kind === "healthy", "the default unit");
    await p.idle();
    expect([...p.view().keys()]).toEqual(["gate/default"]);
    expect(changes).toBe(1);
    exclaves.push(exclave("late"));
    await pollUntil(() => p.view().get("gate/late")?.kind === "healthy", "the late unit");
    await p.idle();
    expect(lines.filter((l) => l.includes("op=armed")).map((l) => /exclave=(\S+)/u.exec(l)?.[1])).toEqual([
      "default",
      "late",
    ]);
    expect(changes).toBe(2);
  });
});

describe("statusLists", () => {
  test("indices follow the advertised trait order, failing goes to tf, not-yet-run and unknown to tu, healthy nowhere", async () => {
    const traits: TraitsConfig = {
      a: probe(["false"]),
      b: {},
      c: { exclaves: ["work"], ...probe(["seance-no-such-program-xyz"]) },
      d: { exclaves: ["work"], ...probe(["true"]) },
    };
    const exclaves = [exclave("default"), exclave("work")];
    const p = make(traits, {}, exclaves);
    // Before any run every probed pair is unknown: default carries [a, b], work [a, b, c, d].
    expect(p.statusLists({ exclaves })).toEqual({
      tf: [],
      tu: [
        [0, 0],
        [1, 0],
        [1, 2],
        [1, 3],
      ],
    });
    await runOnce(p);
    expect(p.statusLists({ exclaves })).toEqual({
      tf: [
        [0, 0],
        [1, 0],
      ],
      tu: [[1, 2]],
    });
    // A scan with the exclaves in another order is indexed by that order.
    expect(p.statusLists({ exclaves: [exclaves[1] ?? exclave("work")] }).tf).toEqual([[0, 0]]);
  });

  test("at most 16 pairs together, tf first, and an overflow warns once", async () => {
    const exclaves = Array.from({ length: 10 }, (_, i) => exclave(`x${i}`));
    const p = make({ a: probe(["false"]), b: probe(["seance-no-such-program-xyz"]) }, {}, exclaves);
    await runOnce(p);
    const lines = await captureLog(async () => {
      const first = p.statusLists({ exclaves });
      expect(first.tf).toHaveLength(10);
      expect(first.tu).toHaveLength(STATUS_MAX_TRAIT_PAIRS - 10);
      expect(first.tu[0]).toEqual([0, 1]);
      await Promise.resolve();
    });
    expect(lines.filter((l) => l.includes("probe status overflow"))).toEqual([]);

    const twenty = Array.from({ length: 20 }, (_, i) => exclave(`y${i}`));
    const q = make({ a: probe(["false"]) }, {}, twenty);
    await runOnce(q);
    const warned = await captureLog(async () => {
      expect(q.statusLists({ exclaves: twenty }).tf).toHaveLength(STATUS_MAX_TRAIT_PAIRS);
      q.statusLists({ exclaves: twenty });
      await Promise.resolve();
    });
    expect(warned.filter((l) => l.includes("traits: probe status overflow: failing=20 kept=16"))).toHaveLength(1);
  });
});

describe("stop", () => {
  test("kills the running probe's group and resolves promptly", async () => {
    const pidFile = join(base, "stop.pid");
    await rm(pidFile, { force: true });
    const p = make({ slow: probe(["sh", "-c", `echo $$ > "${pidFile}"; sleep 30`], { timeoutSeconds: 30 }) });
    p.start();
    let pid = 0;
    await pollUntil(async () => {
      try {
        pid = Math.trunc(Number(await readFile(pidFile, "utf8")));
      } catch {
        return false;
      }
      return Number.isInteger(pid) && pid > 0;
    }, "the probe to be running");
    const began = Date.now();
    await p.stop();
    expect(Date.now() - began).toBeLessThan(3_000);
    await pollUntil(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, "the probe's process to be gone");
  });
});

describe("audit", () => {
  test("armed once per unit and result only on a change; the argv's text never reaches a line", async () => {
    const lines: string[] = [];
    let clock = 1_790_000_000_000;
    const runs = join(base, "audit-runs.log");
    await rm(runs, { force: true });
    const argv = ["sh", "-c", `echo run >> "${runs}"; exit 1`, "TOKEN-abc123"];
    const logged = await captureLog(async () => {
      const p = make(
        { gate: probe(argv, { everyMinutes: 7 }) },
        { now: () => clock, checkIntervalMs: 20, via: "reload", audit: (line) => void lines.push(String(line)) },
      );
      await runOnce(p);
      clock += PROBE_FLOOR_MS;
      await pollUntil(
        async () => (await readFile(runs, "utf8")).split("\n").filter((l) => l !== "").length === 2,
        "the rerun",
      );
      // Unchanged: a failing probe rerun is not a new line. A non-event cannot be polled.
      await Bun.sleep(250);
      await p.stop();
    });
    const sha = createHash("sha256").update(argv.join("\0")).digest("hex").slice(0, 12);
    expect(lines).toEqual([
      `audit probe origin=probe op=armed trait=gate every=7m timeout=10s argv=4 argvSha=${sha} argv0="sh" via=reload`,
      "audit probe origin=probe op=result trait=gate state=failing exit=1",
    ]);
    for (const line of [...lines, ...logged]) expect(line).not.toContain("abc123");
  });

  test("a scoped unit names its exclave; unknown names why", async () => {
    const lines: string[] = [];
    const p = make(
      { gate: { exclaves: ["work"], ...probe(["seance-no-such-program-xyz"]) } },
      { audit: (line) => void lines.push(String(line)) },
    );
    await runOnce(p);
    await pollUntil(() => lines.length === 2, "both lines");
    expect(lines[0]).toContain("op=armed trait=gate exclave=work every=30m");
    expect(lines[0]).toContain('argv0="seance-no-such-program-xyz" via=start');
    expect(lines[1]).toBe("audit probe origin=probe op=result trait=gate exclave=work state=unknown why=not_found");
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
    privateTmux = usePrivateTmux(base, "trait-probes");
    fixture = await makeGitFixture(base);
    appKey = await importPsk(PSK);
  });

  afterAll(async () => {
    await privateTmux?.dispose();
    delete process.env["SEANCE_STATE_DIR"];
  });

  test("a failing probe is in the sealed status as tf, beside the trait the register advertises", async () => {
    const daemonHome = await mkdtemp(join(base, "daemon-home-"));
    const relay = startTestRelay(TOKEN);
    const config: Config = {
      name: "ProbeMac",
      relayUrl: relay.url,
      bearerToken: TOKEN,
      psk: PSK,
      repoRoots: [fixture.root],
      tmuxSession: "main",
      traits: { atlas: probe(["false"]), plain: {} },
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
        traitProbes: { audit: () => {} },
      });
      const frame = await relay.registers.next(5_000);
      const info = parseMachineInfo((await openSealed(appKey, frame.info)).payload);
      expect(info?.exclaves?.[0]?.traits).toEqual(["atlas", "plain"]);
      let status: MachineStatus | null = null;
      const deadline = Date.now() + 15_000;
      while (status?.tf === undefined) {
        if (Date.now() > deadline) throw new Error(`no tf in any status; last ${JSON.stringify(status)}`);
        // oxlint-disable-next-line no-await-in-loop -- statuses arrive in order
        const env = await relay.statuses.next(5_000);
        // oxlint-disable-next-line no-await-in-loop
        status = parseMachineStatus((await openSealed(appKey, env)).payload);
      }
      expect(status.tf).toEqual([[0, 0]]);
      expect(status).not.toHaveProperty("tu");
    } finally {
      daemon?.stop();
      relay.stop();
    }
  });
});
