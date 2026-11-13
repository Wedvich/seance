import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExclaveInfo, MachineStatus, QuotaReading } from "@seance/shared";
import { CUSTODIAN_DEFAULTS } from "./config.ts";
import {
  createCustodianSeat,
  createPick,
  pickExclave,
  roundDue,
  seatEnabled,
  type CloseOutcome,
  type SeatDeps,
  type SeatRecord,
} from "./custodian-seat.ts";
import type { Exclave, ExclaveScan } from "./exclaves.ts";
import { newestReadings } from "./fleet-quota.ts";
import type { TrackedActivity } from "./pane-activity.ts";

const MIN = 60_000;
const EVERY = CUSTODIAN_DEFAULTS.everyMinutes * MIN;
const NOW = 10_000_000_000;

const pane = (over: Partial<TrackedActivity> = {}): TrackedActivity => ({
  pane: "%1",
  state: "busy",
  stateSince: NOW - MIN,
  turnEnded: false,
  screenSince: NOW - MIN,
  sampledAt: NOW,
  ...over,
});

const baseDue = {
  now: NOW,
  everyMs: EVERY,
  lastEndedAt: undefined,
  running: false,
  draining: false,
  panes: [pane({ state: "idle", stateSince: NOW - EVERY })],
  untouchable: (): boolean => false,
};

describe("roundDue", () => {
  test("a pane idle long enough makes a round due", () => {
    expect(roundDue(baseDue)).toBe(true);
  });

  test("a screen unchanged long enough does, whatever the state", () => {
    expect(roundDue({ ...baseDue, panes: [pane({ state: "busy", screenSince: NOW - EVERY })] })).toBe(true);
  });

  test("each other condition alone makes it not due", () => {
    expect(roundDue({ ...baseDue, running: true })).toBe(false);
    expect(roundDue({ ...baseDue, draining: true })).toBe(false);
    expect(roundDue({ ...baseDue, lastEndedAt: NOW - EVERY + 1 })).toBe(false);
    expect(roundDue({ ...baseDue, lastEndedAt: NOW - EVERY })).toBe(true);
    expect(roundDue({ ...baseDue, panes: [] })).toBe(false);
    expect(roundDue({ ...baseDue, panes: [pane({ state: "idle", stateSince: NOW - EVERY + 1 })] })).toBe(false);
    expect(roundDue({ ...baseDue, panes: [pane({ state: null, stateSince: null, screenSince: null })] })).toBe(false);
  });

  test("a long-still needs-input pane alone is not due: no verb may touch it", () => {
    expect(
      roundDue({
        ...baseDue,
        panes: [pane({ state: "needs-input", stateSince: NOW - EVERY, screenSince: NOW - EVERY })],
      }),
    ).toBe(false);
  });

  test("a needs-input pane with a moving screen is not due", () => {
    expect(roundDue({ ...baseDue, panes: [pane({ state: "needs-input", stateSince: NOW - EVERY })] })).toBe(false);
  });

  test("a long-idle pane marked for a hand-off, pass or drain alone is not due", () => {
    expect(roundDue({ ...baseDue, untouchable: (id) => id === "%1" })).toBe(false);
  });

  test("another pane that qualifies still makes it due", () => {
    expect(
      roundDue({
        ...baseDue,
        panes: [
          pane({ pane: "%1", state: "needs-input", screenSince: NOW - EVERY }),
          pane({ pane: "%2", state: "idle", stateSince: NOW - EVERY }),
        ],
      }),
    ).toBe(true);
  });
});

const exclave = (id: string): Exclave => ({
  id,
  root: `/x/${id}`,
  configDir: `/x/.claude-${id}`,
  configFile: `/x/.claude-${id}/.claude.json`,
});
const info = (id: string, over: Partial<ExclaveInfo> = {}): ExclaveInfo => ({
  id,
  accountId: `org:${id}`,
  extraUsageEnabled: null,
  authOk: true,
  skills: [],
  ...over,
});
const scanOf = (
  ids: readonly string[],
  overrides: Readonly<Record<string, Partial<ExclaveInfo>>> = {},
): ExclaveScan => ({
  exclaves: ids.map(exclave),
  info: ids.map((id) => info(id, overrides[id])),
  rejected: [],
});
const reading = (h: number, extra: Partial<QuotaReading> = {}): QuotaReading => ({
  h,
  s: "cache",
  at: NOW / 1000,
  ...extra,
});

const pick = (over: Partial<Parameters<typeof pickExclave>[0]> & { ids?: readonly string[] } = {}): string | null => {
  const { ids = ["a", "b"], ...rest } = over;
  return (
    pickExclave({
      scan: scanOf(ids),
      readings: new Map(),
      expired: () => false,
      eligible: new Set(ids),
      model: "haiku",
      now: NOW,
      ...rest,
    })?.id ?? null
  );
};

describe("pickExclave", () => {
  test("the lowest quota pressure wins, readings looked up by account id", () => {
    const readings = new Map([
      ["org:a", reading(80)],
      ["org:b", reading(10)],
    ]);
    expect(pick({ readings })).toBe("b");
  });

  test("a known reading ranks before an unknown one, and a tie keeps scan order", () => {
    expect(pick({ readings: new Map([["org:b", reading(90)]]) })).toBe("b");
    expect(pick()).toBe("a");
    expect(
      pick({
        readings: new Map([
          ["org:a", reading(40)],
          ["org:b", reading(40)],
        ]),
      }),
    ).toBe("a");
  });

  test("a signed-out, lapsed or ineligible exclave is skipped, and none left is null", () => {
    expect(pick({ scan: scanOf(["a", "b"], { a: { authOk: false } }) })).toBe("b");
    expect(pick({ scan: scanOf(["a", "b"], { a: { accountId: null } }) })).toBe("b");
    expect(pick({ expired: (id) => id === "a" })).toBe("b");
    expect(pick({ eligible: new Set(["b"]) })).toBe("b");
    expect(pick({ eligible: new Set() })).toBeNull();
    expect(pick({ expired: () => true })).toBeNull();
  });

  test("a per-model weekly counts only for a matching model", () => {
    const readings = new Map([
      ["org:a", reading(5, { w: [{ m: "Fable", p: 95 }] })],
      ["org:b", reading(30)],
    ]);
    expect(pick({ readings, model: "claude-fable-5-1" })).toBe("b");
    expect(pick({ readings, model: "haiku" })).toBe("a");
  });

  test("a reading with no window that applies to the model is unknown, not the best", () => {
    const readings = new Map([
      ["org:a", { s: "cache", at: NOW / 1000, w: [{ m: "Fable", p: 99 }] } satisfies QuotaReading],
      ["org:b", reading(30)],
    ]);
    expect(pick({ readings, model: "haiku" })).toBe("b");
  });

  test("ranks by what newestReadings makes of a real status, not by exclave id", () => {
    const scan = scanOf(["default", "work"], { default: { accountId: "org:one" }, work: { accountId: "org:two" } });
    const status: MachineStatus = {
      at: NOW / 1000,
      scan: 7,
      quota: [
        { x: 0, h: 85, s: "cache", at: NOW / 1000 },
        { x: 1, h: 15, s: "cache", at: NOW / 1000 },
      ],
    };
    const readings = newestReadings(status, 7, scan.info);
    expect(
      pickExclave({
        scan,
        readings,
        expired: () => false,
        eligible: new Set(["default", "work"]),
        model: "haiku",
        now: NOW,
      })?.id,
    ).toBe("work");
    // A status naming another blob reads as no readings: scan order decides.
    const stale = newestReadings(status, 6, scan.info);
    expect(
      pickExclave({
        scan,
        readings: stale,
        expired: () => false,
        eligible: new Set(["default", "work"]),
        model: "haiku",
        now: NOW,
      })?.id,
    ).toBe("default");
  });
});

describe("seatEnabled", () => {
  const config = { custodian: CUSTODIAN_DEFAULTS };
  test("needs the key, the process option, live rounds and a supported platform", () => {
    expect(seatEnabled(config, { live: true }, "linux")).toBe(true);
    expect(seatEnabled(config, { live: true }, "darwin")).toBe(true);
    expect(seatEnabled(config, { live: true }, "win32")).toBe(false);
    expect(seatEnabled({}, { live: true }, "linux")).toBe(false);
    expect(seatEnabled(config, undefined, "linux")).toBe(false);
  });

  test("rounds are held in production: no test seam, no seat", () => {
    expect(seatEnabled(config, {}, "linux")).toBe(false);
    expect(seatEnabled(config, { live: false }, "linux")).toBe(false);
  });
});

describe("createPick", () => {
  test("touches no disk but the picked exclave's round dir", async () => {
    const base = await mkdtemp(join(tmpdir(), "seat-pick-"));
    try {
      const ids = ["a", "b", "c"];
      const scan: ExclaveScan = {
        exclaves: ids.map((id) => ({ ...exclave(id), root: join(base, id) })),
        info: ids.map((id) => info(id)),
        rejected: [],
      };
      for (const id of ["a", "b"]) await mkdir(join(base, id));
      const created: string[] = [];
      const run = createPick({
        scan: () => scan,
        readings: () =>
          new Map([
            ["org:a", reading(90)],
            ["org:b", reading(10)],
            ["org:c", reading(1)],
          ]),
        expired: () => false,
        model: "haiku",
        now: () => NOW,
        roundDirFor: (e) => join(e.root, ".seance-custodian"),
        rootExists: (root) => Promise.resolve(root !== join(base, "c")),
        // "a" is untrusted; "b" trusted; "c" would win on quota but its root does not exist.
        trusted: (dir) => Promise.resolve(!dir.startsWith(join(base, "a"))),
        planted: () => Promise.resolve(false),
        ensureDir: async (dir) => {
          created.push(dir);
          await mkdir(dir, { recursive: true });
          return dir;
        },
      });
      const result = await run();
      expect("exclave" in result && result.exclave.id).toBe("b");
      expect(created).toEqual([join(base, "b", ".seance-custodian")]);
      // Ineligible exclaves have no round dir, and a missing root was never invented.
      expect(await Bun.file(join(base, "a", ".seance-custodian")).exists()).toBe(false);
      expect(await Bun.file(join(base, "c")).exists()).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("says why no exclave can host a round", async () => {
    const run = createPick({
      scan: () => scanOf(["a", "b", "c"], { a: { authOk: false } }),
      readings: () => new Map(),
      expired: (id) => id === "b",
      model: "haiku",
      now: () => NOW,
      roundDirFor: (e) => `${e.root}/.seance-custodian`,
      rootExists: () => Promise.resolve(true),
      trusted: () => Promise.resolve(false),
      planted: () => Promise.resolve(false),
      ensureDir: (dir) => Promise.resolve(dir),
    });
    const result = await run();
    expect(result).toEqual({ none: "a: signed-out; b: lapsed; c: round dir untrusted" });
  });

  test("a planted round dir is refused", async () => {
    const run = createPick({
      scan: () => scanOf(["a"]),
      readings: () => new Map(),
      expired: () => false,
      model: "haiku",
      now: () => NOW,
      roundDirFor: (e) => `${e.root}/.seance-custodian`,
      rootExists: () => Promise.resolve(true),
      trusted: () => Promise.resolve(true),
      planted: () => Promise.resolve(true),
      ensureDir: (dir) => Promise.resolve(dir),
    });
    expect(await run()).toEqual({ none: "a: round dir holds settings or agents" });
  });

  test("a round dir that resolves to another exclave is skipped", async () => {
    const scan = scanOf(["a", "b"]);
    const run = createPick({
      scan: () => scan,
      readings: () => new Map(),
      expired: () => false,
      model: "haiku",
      now: () => NOW,
      roundDirFor: (e) => `${e.root}/.seance-custodian`,
      rootExists: () => Promise.resolve(true),
      trusted: () => Promise.resolve(true),
      planted: () => Promise.resolve(false),
      // A symlinked round dir that lands in the other exclave's tree.
      ensureDir: () => Promise.resolve("/x/b/.seance-custodian"),
    });
    const result = await run();
    expect(result).toEqual({ none: "a: round dir resolves to another exclave" });
  });
});

interface Rig {
  readonly seat: ReturnType<typeof createCustodianSeat>;
  readonly clock: { now: number };
  readonly state: { record: SeatRecord; stopped: boolean; draining: boolean };
  readonly log: string[];
  readonly warnings: string[];
  readonly live: Set<string>;
  readonly launches: string[];
  readonly lingering: { rounds: { pane: string; dead: boolean }[] };
  readonly fail: { launch: Error | null; pick: string | null };
  readonly gate: { launch: Promise<void> | null };
}

const TMP = "/tmp/seance-cu-abc123";

function rig(over: Partial<SeatDeps> = {}, record: SeatRecord = {}): Rig {
  const clock = { now: NOW };
  const state = { record, stopped: false, draining: false };
  const log: string[] = [];
  const warnings: string[] = [];
  const live = new Set<string>();
  const launches: string[] = [];
  const lingering = { rounds: [] as { pane: string; dead: boolean }[] };
  const fail = { launch: null as Error | null, pick: null as string | null };
  const gate = { launch: null as Promise<void> | null };
  let next = 1;
  const deps: SeatDeps = {
    settings: CUSTODIAN_DEFAULTS,
    now: () => clock.now,
    checkIntervalMs: 3_600_000,
    activity: () => [pane({ state: "idle", stateSince: clock.now - EVERY })],
    untouchable: () => false,
    draining: () => state.draining,
    stopped: () => state.stopped,
    record: () => state.record,
    save: (saved) => {
      log.push(`save ${JSON.stringify(saved)}`);
      state.record = saved;
      return Promise.resolve();
    },
    pick: () => Promise.resolve(fail.pick === null ? { exclave: exclave("default") } : { none: fail.pick }),
    launch: async (picked, onTmp) => {
      if (fail.launch !== null) throw fail.launch;
      await onTmp(TMP);
      await gate.launch;
      const id = `%${next++}`;
      live.add(id);
      launches.push(picked.id);
      return { pane: id, tmpDir: TMP };
    },
    listRounds: () => Promise.resolve([...live].map((id) => ({ pane: id, dead: false })).concat(lingering.rounds)),
    paneAlive: (id) => Promise.resolve(live.has(id) ? "live" : "gone"),
    close: (id): Promise<CloseOutcome> => {
      const was = live.delete(id);
      return Promise.resolve(was ? "exited" : "gone");
    },
    removeTmp: (dir) => {
      log.push(`rm ${dir}`);
      return Promise.resolve();
    },
    audit: {
      start: (e, p, outcome) => {
        log.push(`start ${e} ${p ?? "-"} ${outcome}`);
        return Promise.resolve();
      },
      kill: (p, reason, outcome) => {
        log.push(`kill ${p} ${reason} ${outcome}`);
        return Promise.resolve();
      },
      end: (p, reason) => {
        log.push(`end ${p ?? "-"} ${reason}`);
        return Promise.resolve();
      },
    },
    warn: (line) => warnings.push(line),
    ...over,
  };
  return { seat: createCustodianSeat(deps), clock, state, log, warnings, live, launches, lingering, fail, gate };
}

const TIMEOUT = CUSTODIAN_DEFAULTS.roundTimeoutMinutes * MIN;

describe("the seat's lifecycle", () => {
  test("a due tick launches once, and a second due tick while it runs does not", async () => {
    const r = rig();
    await r.seat.start();
    await r.seat.tick();
    await r.seat.tick();
    expect(r.launches).toEqual(["default"]);
    expect(r.log).toEqual([
      `save ${JSON.stringify({ round: { pane: null, startedAt: NOW, tmpDir: TMP, exclave: "default" } })}`,
      "start default %1 started",
      `save ${JSON.stringify({ round: { pane: "%1", startedAt: NOW, tmpDir: TMP, exclave: "default" } })}`,
    ]);
    r.seat.stop();
  });

  test("the deadline closes the round, audits kill then end, removes tmp and saves when it ended", async () => {
    const r = rig();
    await r.seat.start();
    await r.seat.tick();
    r.log.length = 0;
    r.clock.now = NOW + TIMEOUT;
    await r.seat.tick();
    expect(r.log).toEqual([
      "kill %1 deadline exited",
      `rm ${TMP}`,
      "end %1 deadline",
      `save ${JSON.stringify({ lastEndedAt: NOW + TIMEOUT })}`,
    ]);
    // Not due again until everyMinutes after it ended.
    r.log.length = 0;
    r.clock.now = NOW + TIMEOUT + EVERY - 1;
    await r.seat.tick();
    expect(r.launches).toHaveLength(1);
    r.clock.now = NOW + TIMEOUT + EVERY;
    await r.seat.tick();
    expect(r.launches).toHaveLength(2);
    r.seat.stop();
  });

  test("a round still within its deadline is left alone", async () => {
    const r = rig();
    await r.seat.start();
    await r.seat.tick();
    r.log.length = 0;
    r.clock.now = NOW + TIMEOUT - 1;
    await r.seat.tick();
    expect(r.log).toEqual([]);
    r.seat.stop();
  });

  test("a round whose pane is gone ends as exited, with no kill", async () => {
    const r = rig();
    await r.seat.start();
    await r.seat.tick();
    r.live.clear();
    r.log.length = 0;
    r.clock.now = NOW + MIN;
    await r.seat.tick();
    expect(r.log).toEqual([`rm ${TMP}`, "end %1 exited", `save ${JSON.stringify({ lastEndedAt: NOW + MIN })}`]);
    r.seat.stop();
  });

  test("a launch that throws audits launch_failed and waits everyMinutes before the next", async () => {
    const r = rig();
    r.fail.launch = new Error("no tmux");
    await r.seat.start();
    await r.seat.tick();
    expect(r.log).toContain("start default - launch_failed");
    expect(r.state.record).toEqual({ lastEndedAt: NOW });
    expect(r.warnings.join("\n")).toContain("round launch failed");
    r.fail.launch = null;
    r.clock.now = NOW + EVERY - 1;
    await r.seat.tick();
    expect(r.launches).toEqual([]);
    r.seat.stop();
  });

  test("draining holds a due round back", async () => {
    const r = rig();
    r.state.draining = true;
    await r.seat.start();
    await r.seat.tick();
    expect(r.launches).toEqual([]);
    r.seat.stop();
  });

  test("adopting a live recorded pane re-arms its original deadline and launches nothing", async () => {
    const r = rig({}, { round: { pane: "%1", startedAt: NOW - TIMEOUT + MIN, tmpDir: TMP, exclave: "default" } });
    r.live.add("%1");
    await r.seat.start();
    await r.seat.tick();
    expect(r.launches).toEqual([]);
    expect(r.log).toEqual([]);
    r.clock.now = NOW + MIN;
    await r.seat.tick();
    expect(r.log.slice(0, 2)).toEqual(["kill %1 deadline exited", `rm ${TMP}`]);
    r.seat.stop();
  });

  test("adopting kills a second round pane as stray", async () => {
    const r = rig({}, { round: { pane: "%1", startedAt: NOW, tmpDir: TMP, exclave: "default" } });
    r.live.add("%1");
    r.live.add("%2");
    await r.seat.start();
    expect(r.log).toEqual(["kill %2 stray exited"]);
    expect([...r.live]).toEqual(["%1"]);
    r.seat.stop();
  });

  test("adopting a recorded round whose pane is gone ends it as lost and removes its tmp", async () => {
    const r = rig({}, { round: { pane: "%9", startedAt: NOW, tmpDir: TMP, exclave: "default" } });
    await r.seat.start();
    expect(r.log).toEqual([`rm ${TMP}`, "end %9 lost", `save ${JSON.stringify({ lastEndedAt: NOW })}`]);
    r.seat.stop();
  });

  test("a recorded round that never got a pane, with none found, is lost", async () => {
    const r = rig({}, { round: { pane: null, startedAt: NOW, tmpDir: TMP, exclave: "default" } });
    await r.seat.start();
    expect(r.log).toEqual([`rm ${TMP}`, "end - lost", `save ${JSON.stringify({ lastEndedAt: NOW })}`]);
    r.seat.stop();
  });

  test("an orphan round pane with no record is closed as stray", async () => {
    const r = rig();
    r.live.add("%5");
    await r.seat.start();
    expect(r.log).toEqual(["kill %5 stray exited"]);
    r.seat.stop();
  });

  test("a stopped seat saves nothing, and a launch finishing after the stop closes its own pane", async () => {
    const r = rig();
    let release: () => void = () => {};
    r.gate.launch = new Promise<void>((resolve) => {
      release = resolve;
    });
    await r.seat.start();
    const ticking = r.seat.tick();
    await Bun.sleep(0);
    r.state.stopped = true;
    r.log.length = 0;
    release();
    await ticking;
    expect(r.log).toEqual(["kill %1 stray exited", `rm ${TMP}`]);
    expect(r.log.some((line) => line.startsWith("save"))).toBe(false);
    expect(r.live.size).toBe(0);
    r.seat.stop();
  });

  test("the no-exclave warning fires once for repeated identical skips, and again when the reason changes", async () => {
    const r = rig();
    r.fail.pick = "a: signed-out";
    await r.seat.start();
    for (let at = 0; at < 3; at++) {
      await r.seat.tick();
      r.clock.now += EVERY;
    }
    expect(r.warnings).toHaveLength(1);
    r.fail.pick = "a: round dir untrusted";
    await r.seat.tick();
    expect(r.warnings).toHaveLength(2);
    r.seat.stop();
  });

  test("a pick that found nothing is not repeated before everyMinutes", async () => {
    let picks = 0;
    const r = rig({
      pick: () => {
        picks += 1;
        return Promise.resolve({ none: "a: round dir untrusted" });
      },
    });
    await r.seat.start();
    await r.seat.tick();
    r.clock.now += EVERY - 1;
    await r.seat.tick();
    await r.seat.tick();
    expect(picks).toBe(1);
    r.clock.now += 1;
    await r.seat.tick();
    expect(picks).toBe(2);
    r.seat.stop();
  });

  test("a failure recording a started round closes its pane, so no round runs untracked", async () => {
    const r = rig({
      audit: {
        start: () => Promise.reject(new Error("disk full")),
        kill: (p, reason, outcome) => {
          r.log.push(`kill ${p} ${reason} ${outcome}`);
          return Promise.resolve();
        },
        end: () => Promise.resolve(),
      },
    });
    await r.seat.start();
    await r.seat.tick();
    expect(r.live.size).toBe(0);
    expect(r.log).toContain("kill %1 stray exited");
    expect(r.log).toContain(`rm ${TMP}`);
    expect(r.state.record).toEqual({ lastEndedAt: NOW });
    expect(r.warnings.join("\n")).toContain("recording a started round failed");
    expect(r.warnings.join("\n")).not.toContain("round launch failed");
    r.seat.stop();
  });

  test("a recorded round with no pane that adoption did not clear is lost on the next tick", async () => {
    const r = rig({}, { round: { pane: null, startedAt: NOW, tmpDir: TMP, exclave: "default" } });
    await r.seat.tick();
    expect(r.log).toEqual([`rm ${TMP}`, "end - lost", `save ${JSON.stringify({ lastEndedAt: NOW })}`]);
    r.seat.stop();
  });

  test("a recorded round's pane found dead is closed with an exited kill, not a stray one, on adoption and on a tick", async () => {
    const adopted = rig({}, { round: { pane: "%1", startedAt: NOW, tmpDir: TMP, exclave: "default" } });
    adopted.lingering.rounds.push({ pane: "%1", dead: true });
    await adopted.seat.start();
    expect(adopted.log[0]).toBe("kill %1 exited gone");
    adopted.seat.stop();

    const ticked = rig({ paneAlive: () => Promise.resolve("dead") });
    await ticked.seat.start();
    await ticked.seat.tick();
    ticked.log.length = 0;
    ticked.clock.now += MIN;
    await ticked.seat.tick();
    expect(ticked.log.slice(0, 3)).toEqual(["kill %1 exited exited", `rm ${TMP}`, "end %1 exited"]);
    ticked.seat.stop();
  });
});
