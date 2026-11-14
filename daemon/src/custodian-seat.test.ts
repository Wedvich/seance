import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustodianStatus, ExclaveInfo, MachineStatus, QuotaReading } from "@seance/shared";
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
import { emptyCounts, type RoundEntry } from "./custodian-rounds.ts";
import { ROUND_REQUEST_MIN_GAP_MS, type PauseRead, type RoundRequest } from "./custodian-control.ts";
import type { Exclave, ExclaveScan } from "./exclaves.ts";
import { newestReadings } from "./fleet-quota.ts";
import { pollUntil } from "../test/fixtures.ts";
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
  paused: false,
  requested: false,
  panes: [pane({ state: "idle", stateSince: NOW - EVERY, turnEnded: true })],
  untouchable: (): boolean => false,
};

describe("roundDue", () => {
  test("a pane idle long enough makes a round due", () => {
    expect(roundDue(baseDue)).toBe(true);
  });

  test("a pane idle without a turn's end is not due: close answers it unobserved", () => {
    expect(roundDue({ ...baseDue, panes: [pane({ state: "idle", stateSince: NOW - EVERY, turnEnded: false })] })).toBe(
      false,
    );
  });

  test("a busy pane whose screen has stood still for the interval is due: nudge can act on it", () => {
    expect(roundDue({ ...baseDue, panes: [pane({ state: "busy", screenSince: NOW - EVERY })] })).toBe(true);
    expect(roundDue({ ...baseDue, panes: [pane({ state: "busy", screenSince: NOW - EVERY + 1 })] })).toBe(false);
    expect(roundDue({ ...baseDue, panes: [pane({ state: "busy", screenSince: null })] })).toBe(false);
    // A busy pane marked for a drain, hand-off or pass is no more due than an idle one.
    expect(
      roundDue({ ...baseDue, panes: [pane({ state: "busy", screenSince: NOW - EVERY })], untouchable: () => true }),
    ).toBe(false);
  });

  test("each other condition alone makes it not due", () => {
    expect(roundDue({ ...baseDue, running: true })).toBe(false);
    expect(roundDue({ ...baseDue, draining: true })).toBe(false);
    expect(roundDue({ ...baseDue, lastEndedAt: NOW - EVERY + 1 })).toBe(false);
    expect(roundDue({ ...baseDue, lastEndedAt: NOW - EVERY })).toBe(true);
    expect(roundDue({ ...baseDue, panes: [] })).toBe(false);
    expect(
      roundDue({ ...baseDue, panes: [pane({ state: "idle", stateSince: NOW - EVERY + 1, turnEnded: true })] }),
    ).toBe(false);
  });

  test("a pane with no observed state is not due, however long its screen has stood still", () => {
    expect(roundDue({ ...baseDue, panes: [pane({ state: null, stateSince: null, screenSince: NOW - EVERY })] })).toBe(
      false,
    );
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
          pane({ pane: "%2", state: "idle", stateSince: NOW - EVERY, turnEnded: true }),
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

/** The verbs' audit lines, which the seat never writes. */
const UNUSED_AUDIT = {
  close: (): Promise<void> => Promise.resolve(),
  removedWorktree: (): Promise<void> => Promise.resolve(),
  keptWorktree: (): Promise<void> => Promise.resolve(),
  flag: (): Promise<void> => Promise.resolve(),
  nudge: (): Promise<void> => Promise.resolve(),
  interrupt: (): Promise<void> => Promise.resolve(),
};

interface Rig {
  readonly seat: ReturnType<typeof createCustodianSeat>;
  readonly rounds: RoundEntry[];
  readonly clock: { now: number };
  readonly state: { record: SeatRecord; stopped: boolean; draining: boolean };
  readonly log: string[];
  readonly warnings: string[];
  readonly live: Set<string>;
  readonly launches: string[];
  readonly lingering: { rounds: { pane: string; dead: boolean }[] };
  readonly fail: { launch: Error | null; pick: string | null };
  readonly gate: { launch: Promise<void> | null };
  readonly control: { read: PauseRead };
  readonly request: { state: RoundRequest; drops: number; peek: () => RoundRequest };
  readonly remote: { id: string | null };
  readonly published: CustodianStatus[];
  readonly onView: { calls: number };
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
  const rounds: RoundEntry[] = [];
  const control = { read: { pause: null, unreadable: false } as PauseRead };
  const request = {
    state: "none" as RoundRequest,
    drops: 0,
    // A call, so a test's assignment of `state` does not narrow what it then reads back.
    peek(): RoundRequest {
      return this.state;
    },
  };
  const remote = { id: null as string | null };
  const published: CustodianStatus[] = [];
  const onView = { calls: 0 };
  let next = 1;
  const deps: SeatDeps = {
    settings: CUSTODIAN_DEFAULTS,
    now: () => clock.now,
    checkIntervalMs: 3_600_000,
    activity: () => [pane({ state: "idle", stateSince: clock.now - EVERY, turnEnded: true })],
    untouchable: () => false,
    // The round log's own rule (`upsertRound`, tested in custodian-rounds.test.ts): by start, never over a healthy line.
    appendRound: (entry) => {
      const at = rounds.findIndex((round) => round.start === entry.start);
      if (at < 0) rounds.push(entry);
      else if (rounds[at]?.outcome !== "healthy") rounds[at] = entry;
      return Promise.resolve();
    },
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
      end: (p, _outcome, reason) => {
        log.push(`end ${p ?? "-"} ${reason}`);
        return Promise.resolve();
      },
      ...UNUSED_AUDIT,
    },
    readRounds: () => Promise.resolve([...rounds]),
    readControl: () => Promise.resolve(control.read),
    peekRoundRequest: () => Promise.resolve(request.state),
    dropRoundRequest: () => {
      request.state = "none";
      request.drops++;
      return Promise.resolve();
    },
    remoteId: () => Promise.resolve(remote.id),
    publishView: (view) => {
      published.push(view);
      return Promise.resolve();
    },
    onView: () => {
      onView.calls++;
    },
    warn: (line) => warnings.push(line),
    ...over,
  };
  return {
    seat: createCustodianSeat(deps),
    rounds,
    clock,
    state,
    log,
    warnings,
    live,
    launches,
    lingering,
    fail,
    gate,
    control,
    request,
    remote,
    published,
    onView,
  };
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

  test("a stop during the start audit closes the pane the record never got", async () => {
    const r = rig({
      audit: {
        start: (e, p, outcome) => {
          r.log.push(`start ${e} ${p ?? "-"} ${outcome}`);
          r.state.stopped = true;
          return Promise.resolve();
        },
        kill: (p, reason, outcome) => {
          r.log.push(`kill ${p} ${reason} ${outcome}`);
          return Promise.resolve();
        },
        end: () => Promise.resolve(),
        ...UNUSED_AUDIT,
      },
    });
    await r.seat.start();
    await r.seat.tick();
    expect(r.log).toContain("kill %1 stray exited");
    expect(r.log).toContain(`rm ${TMP}`);
    expect(r.live.size).toBe(0);
    r.seat.stop();
  });

  test("a pick that throws backs off like one that found nothing, and warns once per back-off", async () => {
    let picks = 0;
    const r = rig({
      pick: () => {
        picks += 1;
        return Promise.reject(new Error("EACCES"));
      },
    });
    await r.seat.start();
    await r.seat.tick();
    r.clock.now += EVERY - 1;
    await r.seat.tick();
    expect(picks).toBe(1);
    expect(r.warnings).toHaveLength(1);
    r.clock.now += 1;
    await r.seat.tick();
    expect(picks).toBe(2);
    r.seat.stop();
  });

  test("a close that throws while recording a started round keeps the pane on the record, and a write-ahead record's tick sweeps it", async () => {
    let closes = 0;
    const r = rig({
      audit: {
        start: () => Promise.reject(new Error("disk full")),
        kill: (p, reason, outcome) => {
          r.log.push(`kill ${p} ${reason} ${outcome}`);
          return Promise.resolve();
        },
        end: (p, _outcome, reason) => {
          r.log.push(`end ${p ?? "-"} ${reason}`);
          return Promise.resolve();
        },
        ...UNUSED_AUDIT,
      },
      close: (id) => {
        closes += 1;
        if (closes === 1) return Promise.reject(new Error("tmux gone"));
        r.live.delete(id);
        return Promise.resolve("exited");
      },
    });
    await r.seat.start();
    await r.seat.tick();
    expect(r.live.size).toBe(1);
    expect(r.state.record.round).toEqual({ pane: "%1", startedAt: NOW, tmpDir: TMP, exclave: "default" });
    expect(r.warnings.join("\n")).toContain("closing the round's pane failed");

    // The record write failing too leaves the write-ahead `pane: null`: the next tick sweeps the live pane.
    r.state.record = { round: { pane: null, startedAt: NOW, tmpDir: TMP, exclave: "default" } };
    r.log.length = 0;
    await r.seat.tick();
    expect(r.log).toEqual([
      "kill %1 stray exited",
      `rm ${TMP}`,
      "end - lost",
      `save ${JSON.stringify({ lastEndedAt: NOW })}`,
    ]);
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
        ...UNUSED_AUDIT,
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
    expect(adopted.log.slice(0, 2)).toEqual(["kill %1 exited gone", `rm ${TMP}`]);
    expect(adopted.log).toContain("end %1 exited");
    expect(adopted.log).not.toContain("end %1 lost");
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

describe("the round's verbs reach the seat", () => {
  const started = async (): Promise<Rig> => {
    const r = rig();
    await r.seat.start();
    await r.seat.tick();
    r.log.length = 0;
    return r;
  };

  test("roundPane is the running round's pane, and null before one, and after a stop", async () => {
    const r = rig();
    expect(r.seat.roundPane()).toBeNull();
    await r.seat.start();
    await r.seat.tick();
    expect(r.seat.roundPane()).toBe("%1");
    r.state.stopped = true;
    expect(r.seat.roundPane()).toBeNull();
    r.seat.stop();
  });

  test("done logs a healthy entry with the summary and the verbs' tally, marks the record, and the next tick closes the pane", async () => {
    const r = await started();
    r.seat.count("sessions", true);
    r.seat.count("close", true);
    r.seat.count("close", false);
    r.seat.countWorktree("removed");
    r.seat.countWorktree("kept");
    r.seat.count("flag", true);
    r.seat.countFlagged();
    r.seat.countFlagged();
    expect(await r.seat.done("closed one, kept one")).toBe("ok");
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0]).toMatchObject({
      start: NOW,
      exclave: "default",
      outcome: "healthy",
      reason: "done",
      summary: "closed one, kept one",
      counts: {
        sessions: { ok: 1, refused: 0 },
        close: { ok: 1, refused: 1 },
        notes: { ok: 0, refused: 0 },
        flag: { ok: 1, refused: 0 },
        done: { ok: 1, refused: 0 },
        flagged: 2,
        worktrees: { removed: 1, kept: 1 },
      },
    });
    expect(r.state.record.round?.done).toBe(true);
    expect(r.seat.isDone()).toBe(true);
    // The pane is closed by the tick, never inside the verb whose caller is waiting on the reply.
    expect(r.live.has("%1")).toBe(true);
    r.clock.now += 1_000;
    await r.seat.tick();
    expect(r.live.size).toBe(0);
    expect(r.log).toContain("kill %1 done exited");
    expect(r.log).toContain("end %1 done");
    expect(r.rounds).toHaveLength(1);
    expect(r.state.record).toEqual({ lastEndedAt: NOW + 1_000 });
    r.seat.stop();
  });

  test("a done the seat cannot mark writes no healthy line, and one whose log write fails still answers ok", async () => {
    // A stop that lands after `done` read the round, before it could mark it.
    let reads = 0;
    let armed = false;
    const lost = rig({ stopped: () => armed && ++reads > 1 });
    await lost.seat.start();
    await lost.seat.tick();
    armed = true;
    expect(await lost.seat.done("x")).toBe("no_round");
    expect(lost.rounds).toEqual([]);
    lost.seat.stop();

    const broken = rig({ appendRound: () => Promise.reject(new Error("disk full")) });
    await broken.seat.start();
    await broken.seat.tick();
    expect(await broken.seat.done("x")).toBe("ok");
    expect(broken.state.record.round?.done).toBe(true);
    expect(broken.warnings.join("\n")).toContain("writing the round log failed");
    broken.seat.stop();
  });

  test("a second done answers ok and writes nothing", async () => {
    const r = await started();
    expect(await r.seat.done("first")).toBe("ok");
    expect(await r.seat.done("second")).toBe("ok");
    expect(r.rounds.map((entry) => entry.summary)).toEqual(["first"]);
    r.seat.stop();
  });

  test("done at or past the deadline is too late and writes nothing", async () => {
    const r = await started();
    r.clock.now = NOW + TIMEOUT;
    expect(await r.seat.done("late")).toBe("too_late");
    expect(r.rounds).toEqual([]);
    expect(r.state.record.round?.done).toBeUndefined();
    r.seat.stop();
  });

  test("done with no round, or after a stop, is no_round", async () => {
    const none = rig();
    await none.seat.start();
    expect(await none.seat.done("x")).toBe("no_round");
    none.seat.stop();
    const stopped = await started();
    stopped.state.stopped = true;
    expect(await stopped.seat.done("x")).toBe("no_round");
    stopped.seat.stop();
  });

  test("a deadline appends a failed entry with the tally and no summary", async () => {
    const r = await started();
    r.seat.count("sessions", true);
    r.clock.now = NOW + TIMEOUT;
    await r.seat.tick();
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0]).toMatchObject({ outcome: "failed", reason: "deadline", counts: { sessions: { ok: 1 } } });
    expect(r.rounds[0]?.summary).toBeUndefined();
    r.seat.stop();
  });

  test("a failing round log write is a warning, never a stuck round", async () => {
    const r = rig({ appendRound: () => Promise.reject(new Error("disk full")) });
    await r.seat.start();
    await r.seat.tick();
    r.clock.now = NOW + TIMEOUT;
    await r.seat.tick();
    expect(r.warnings.join("\n")).toContain("writing the round log failed");
    expect(r.state.record).toEqual({ lastEndedAt: NOW + TIMEOUT });
    r.seat.stop();
  });

  test("a done whose log write failed is still recorded, without its summary, when the round ends", async () => {
    let failing = true;
    const r = rig({
      appendRound: (entry) => {
        if (failing) return Promise.reject(new Error("disk full"));
        r.rounds.push(entry);
        return Promise.resolve();
      },
    });
    await r.seat.start();
    await r.seat.tick();
    expect(await r.seat.done("lost with the failed write")).toBe("ok");
    expect(r.rounds).toEqual([]);
    failing = false;
    r.clock.now += 1_000;
    await r.seat.tick();
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0]).toMatchObject({ outcome: "healthy", reason: "done", counts: { done: { ok: 1 } } });
    expect(r.rounds[0]?.summary).toBeUndefined();
    r.seat.stop();
  });

  test("a restart after done: a live pane is closed by the next tick, a gone one is finished at once, and each records the round", async () => {
    const record = { round: { pane: "%1", startedAt: NOW, tmpDir: TMP, exclave: "default", done: true } } as const;
    const live = rig({}, record);
    live.live.add("%1");
    await live.seat.start();
    expect(live.live.size).toBe(1);
    await live.seat.tick();
    expect(live.log).toContain("kill %1 done exited");
    expect(live.log).toContain("end %1 done");
    expect(live.rounds).toMatchObject([{ outcome: "healthy", reason: "done" }]);
    expect(live.live.size).toBe(0);
    live.seat.stop();

    const gone = rig({}, record);
    await gone.seat.start();
    expect(gone.log).toContain("end %1 done");
    expect(gone.rounds).toMatchObject([{ outcome: "healthy", reason: "done" }]);
    expect(gone.state.record).toEqual({ lastEndedAt: NOW });
    gone.seat.stop();
  });
});

const entry = (over: Partial<RoundEntry> = {}): RoundEntry => ({
  start: NOW - 2 * MIN,
  end: NOW - MIN,
  exclave: "default",
  outcome: "healthy",
  reason: "done",
  counts: emptyCounts(),
  ...over,
});
const failed = (at: number): RoundEntry => entry({ start: at, end: at + 1000, outcome: "failed", reason: "deadline" });

describe("pause and the owner's round request (C45)", () => {
  test("a paused seat starts no round, even past everyMinutes; an expired pause lets it", async () => {
    const r = rig();
    r.control.read = { pause: { at: NOW - 10, until: NOW + MIN }, unreadable: false };
    await r.seat.start();
    await r.seat.tick();
    expect(r.launches).toEqual([]);
    r.clock.now = NOW + MIN;
    await r.seat.tick();
    expect(r.launches).toEqual(["default"]);
    r.seat.stop();
  });

  test("a busy pane no verb could act on holds no round due: the verbs' own reach decides", async () => {
    let reach = false;
    const asked: number[] = [];
    const r = rig({
      activity: () => [pane({ state: "busy", screenSince: NOW - EVERY })],
      busyReach: (_pane, stillMs) => {
        asked.push(stillMs);
        return Promise.resolve(reach);
      },
    });
    await r.seat.start();
    await r.seat.tick();
    expect(r.launches).toEqual([]);
    expect(asked).toEqual([EVERY]);
    reach = true;
    await r.seat.tick();
    expect(r.launches).toEqual(["default"]);
    r.seat.stop();
  });

  test("no reach is asked while paused: no round could start, so the reads are not spent", async () => {
    const asked: number[] = [];
    const r = rig({
      activity: () => [pane({ state: "busy", screenSince: NOW - EVERY })],
      busyReach: (_pane, stillMs) => {
        asked.push(stillMs);
        return Promise.resolve(true);
      },
    });
    r.control.read = { pause: { at: 0, until: null }, unreadable: false };
    await r.seat.start();
    await r.seat.tick();
    expect(r.launches).toEqual([]);
    expect(asked).toEqual([]);
    r.seat.stop();
  });

  test("a pause with no end holds, and an unreadable control file holds with one warning", async () => {
    const r = rig();
    r.control.read = { pause: { at: 0, until: null }, unreadable: true };
    await r.seat.start();
    await r.seat.tick();
    await r.seat.tick();
    expect(r.launches).toEqual([]);
    expect(r.warnings.filter((line) => line.includes("custodian/state.json is unreadable"))).toHaveLength(1);
    r.control.read = { pause: null, unreadable: false };
    await r.seat.tick();
    expect(r.launches).toEqual(["default"]);
    r.seat.stop();
  });

  test("a fresh request starts a round despite everyMinutes, a busy pane and the pick's back-off, dropped before the launch", async () => {
    const r = rig({ activity: () => [pane({ state: "busy" })] }, { lastEndedAt: NOW - ROUND_REQUEST_MIN_GAP_MS });
    await r.seat.start();
    await r.seat.tick();
    expect(r.launches).toEqual([]);
    r.request.state = "fresh";
    r.fail.pick = "no exclave";
    await r.seat.tick();
    // The pick backed off after finding none; a request skips the back-off.
    r.fail.pick = null;
    r.request.state = "fresh";
    r.fail.launch = new Error("boom");
    const dropsBefore = r.request.drops;
    await r.seat.tick();
    expect(r.request.drops).toBe(dropsBefore + 1);
    expect(r.request.peek()).toBe("none");
    r.fail.launch = null;
    r.clock.now = NOW + ROUND_REQUEST_MIN_GAP_MS;
    r.request.state = "fresh";
    await r.seat.tick();
    expect(r.launches).toEqual(["default"]);
    expect(r.request.peek()).toBe("none");
    r.seat.stop();
  });

  test("a requested round runs while paused, and the pause stays", async () => {
    const r = rig();
    const pause = { pause: { at: NOW - 10, until: null }, unreadable: false };
    r.control.read = pause;
    r.request.state = "fresh";
    await r.seat.start();
    await r.seat.tick();
    expect(r.launches).toEqual(["default"]);
    expect(r.control.read).toBe(pause);
    expect(r.seat.view(NOW).s).toBe("running");
    r.seat.stop();
  });

  test("a request while a round runs is dropped, and no second round starts", async () => {
    const r = rig();
    await r.seat.start();
    await r.seat.tick();
    r.request.state = "fresh";
    r.clock.now = NOW + MIN;
    await r.seat.tick();
    expect(r.launches).toEqual(["default"]);
    expect(r.request.peek()).toBe("none");
    r.seat.stop();
  });

  test("a request while draining is kept, and runs after, within its age", async () => {
    const r = rig();
    r.state.draining = true;
    r.request.state = "fresh";
    await r.seat.start();
    await r.seat.tick();
    expect(r.launches).toEqual([]);
    expect(r.request.peek()).toBe("fresh");
    r.state.draining = false;
    await r.seat.tick();
    expect(r.launches).toEqual(["default"]);
    r.seat.stop();
  });

  test("a stale request is dropped and starts nothing", async () => {
    const r = rig({ activity: () => [] });
    r.request.state = "stale";
    await r.seat.start();
    await r.seat.tick();
    expect(r.launches).toEqual([]);
    expect(r.request.drops).toBe(1);
    r.seat.stop();
  });

  test("requests are spaced: one within the minimum gap of the last round, or of a launch attempt, is dropped with a warning", async () => {
    const r = rig();
    await r.seat.start();
    await r.seat.tick();
    r.live.clear();
    r.clock.now = NOW + MIN;
    await r.seat.tick();
    expect(r.launches).toHaveLength(1);
    // The round ended at NOW + MIN: a request now, and again a minute short of the gap, starts nothing.
    for (const at of [NOW + 2 * MIN, NOW + MIN + ROUND_REQUEST_MIN_GAP_MS - 1]) {
      r.clock.now = at;
      r.request.state = "fresh";
      r.warnings.length = 0;
      await r.seat.tick();
      expect(r.request.peek()).toBe("none");
      expect(r.warnings.join("\n")).toContain("requested too soon");
    }
    expect(r.launches).toHaveLength(1);
    r.clock.now = NOW + MIN + ROUND_REQUEST_MIN_GAP_MS;
    r.request.state = "fresh";
    await r.seat.tick();
    expect(r.launches).toHaveLength(2);
    r.seat.stop();
  });

  test("a request right after a failed launch attempt is spaced from it too", async () => {
    const r = rig({}, {});
    r.fail.launch = new Error("no tmux");
    await r.seat.start();
    await r.seat.tick();
    r.fail.launch = null;
    r.clock.now = NOW + MIN;
    r.request.state = "fresh";
    await r.seat.tick();
    expect(r.launches).toEqual([]);
    expect(r.request.peek()).toBe("none");
    r.seat.stop();
  });
});

describe("the seat's view (C40, C41)", () => {
  test("idle, paused, and running with the round's remote id once found", async () => {
    const r = rig({}, {});
    await r.seat.start();
    expect(r.seat.view(NOW)).toEqual({ s: "idle" });
    r.control.read = { pause: { at: NOW, until: NOW + MIN }, unreadable: false };
    await r.seat.tick();
    expect(r.seat.view(NOW).s).toBe("paused");
    // The expiry shows without waiting for a tick.
    expect(r.seat.view(NOW + MIN).s).toBe("idle");
    r.control.read = { pause: null, unreadable: false };
    r.remote.id = `session_${"a".repeat(10)}`;
    await r.seat.tick();
    expect(r.seat.view(NOW)).toEqual({ s: "running" });
    r.clock.now = NOW + MIN;
    await r.seat.tick();
    expect(r.seat.view(NOW)).toEqual({ s: "running", rc: `session_${"a".repeat(10)}` });
    r.seat.stop();
  });

  test("an id that is not a remote session id never shows, and none shows once the round ends", async () => {
    const r = rig();
    r.remote.id = "session_a b";
    await r.seat.start();
    await r.seat.tick();
    r.clock.now = NOW + MIN;
    await r.seat.tick();
    expect(r.seat.view(NOW)).toEqual({ s: "running" });
    r.remote.id = `session_${"b".repeat(5)}`;
    r.live.clear();
    await r.seat.tick();
    expect(r.seat.view(NOW)).not.toHaveProperty("rc");
    r.seat.stop();
  });

  test("e is the last log entry's end in seconds and n[0] its closed count, capped at 999", async () => {
    const r = rig();
    r.rounds.push(entry({ end: 1_763_000_123_456, counts: { ...emptyCounts(), close: { ok: 4_000, refused: 1 } } }));
    await r.seat.start();
    expect(r.seat.view(NOW)).toEqual({ s: "idle", e: 1_763_000_123, n: [999, 0, 0] });
    r.seat.stop();
  });

  test("n[1] is the last log entry's delivered nudges, capped at 999", async () => {
    const r = rig();
    r.rounds.push(entry({ end: 1_763_000_123_456, counts: { ...emptyCounts(), nudge: { ok: 2, refused: 7 } } }));
    await r.seat.start();
    expect(r.seat.view(NOW)).toEqual({ s: "idle", e: 1_763_000_123, n: [0, 2, 0] });
    r.seat.stop();
  });

  test("n[2] is the last log entry's flagged count, capped at 999", async () => {
    const r = rig();
    r.rounds.push(entry({ end: 1_763_000_123_456, counts: { ...emptyCounts(), flagged: 5_000 } }));
    await r.seat.start();
    expect(r.seat.view(NOW)).toEqual({ s: "idle", e: 1_763_000_123, n: [0, 0, 999] });
    r.seat.stop();
  });

  test("failing after three failed entries in a row, not after two failed and a healthy one, and cleared by a healthy round", async () => {
    const three = rig({}, {});
    three.rounds.push(failed(NOW - 4 * MIN), failed(NOW - 3 * MIN), failed(NOW - 2 * MIN));
    await three.seat.start();
    expect(three.seat.view(NOW).s).toBe("failing");
    three.seat.stop();

    const mixed = rig({}, {});
    mixed.rounds.push(failed(NOW - 4 * MIN), failed(NOW - 3 * MIN), entry({ start: NOW - 2 * MIN }));
    await mixed.seat.start();
    expect(mixed.seat.view(NOW).s).toBe("idle");
    mixed.seat.stop();
  });

  test("failed rounds ended by this seat count, and a round that reports done clears them", async () => {
    const r = rig();
    await r.seat.start();
    for (let at = 0; at < 3; at++) {
      r.clock.now = NOW + at * (TIMEOUT + EVERY);
      await r.seat.tick();
      r.clock.now += TIMEOUT;
      await r.seat.tick();
    }
    expect(r.seat.view(r.clock.now).s).toBe("failing");
    r.clock.now += EVERY;
    await r.seat.tick();
    expect(await r.seat.done("all quiet")).toBe("ok");
    expect(r.seat.view(r.clock.now).s).toBe("running");
    await r.seat.tick();
    expect(r.seat.view(r.clock.now).s).toBe("idle");
    r.seat.stop();
  });

  test("launch failures count: three throwing launches show failing, and a healthy round clears it", async () => {
    const r = rig();
    r.fail.launch = new Error("no tmux");
    await r.seat.start();
    for (let at = 0; at < 3; at++) {
      r.clock.now = NOW + at * EVERY;
      await r.seat.tick();
    }
    expect(r.seat.view(r.clock.now).s).toBe("failing");
    // The log holds no entry for them, so a restart would read a clean tail; the view's e/n stay absent.
    expect(r.rounds).toEqual([]);
    expect(r.seat.view(r.clock.now)).toEqual({ s: "failing" });
    r.fail.launch = null;
    r.clock.now += EVERY;
    await r.seat.tick();
    expect(await r.seat.done("fine")).toBe("ok");
    r.live.clear();
    r.clock.now += MIN;
    await r.seat.tick();
    expect(r.seat.view(r.clock.now).s).toBe("idle");

    const none = rig();
    none.fail.pick = "no exclave";
    await none.seat.start();
    for (let at = 0; at < 3; at++) {
      none.clock.now = NOW + at * EVERY;
      await none.seat.tick();
    }
    // An empty pick is quota or auth, not the seat's fault: it never turns the row to failing.
    expect(none.seat.view(none.clock.now).s).toBe("idle");
    r.seat.stop();
    none.seat.stop();
  });

  describe("the failing event (C41)", () => {
    const throwingLaunches = async (r: Rig, count: number): Promise<void> => {
      for (let at = 0; at < count; at++) {
        r.clock.now += EVERY;
        await r.seat.tick();
      }
    };

    test("the third failure in a row hands one event on, a fourth and a fifth do not", async () => {
      const sent: number[] = [];
      const r = rig({
        onFailing: () => {
          sent.push(r.clock.now);
          return Promise.resolve(true);
        },
      });
      r.fail.launch = new Error("no tmux");
      await r.seat.start();
      await throwingLaunches(r, 2);
      expect(sent).toEqual([]);
      await throwingLaunches(r, 1);
      expect(sent).toHaveLength(1);
      await throwingLaunches(r, 3);
      expect(sent).toHaveLength(1);
      r.seat.stop();
    });

    test("an event nothing could take is held and tried again on each tick until one lands", async () => {
      let accept = false;
      let tries = 0;
      const r = rig({
        onFailing: () => {
          tries += 1;
          return Promise.resolve(accept);
        },
      });
      r.fail.launch = new Error("no tmux");
      await r.seat.start();
      await throwingLaunches(r, 3);
      const first = tries;
      expect(first).toBeGreaterThanOrEqual(1);
      await r.seat.tick();
      expect(tries).toBeGreaterThan(first);
      accept = true;
      await r.seat.tick();
      const landed = tries;
      await r.seat.tick();
      await r.seat.tick();
      expect(tries).toBe(landed);
      r.seat.stop();
    });

    test("a held event is dropped when a healthy round ends the run first, and a throw is a warning", async () => {
      let tries = 0;
      const r = rig({
        onFailing: () => {
          tries += 1;
          return Promise.reject(new Error("relay"));
        },
      });
      r.fail.launch = new Error("no tmux");
      await r.seat.start();
      await throwingLaunches(r, 3);
      expect(r.warnings.join("\n")).toContain("sending the failing event failed");
      r.fail.launch = null;
      r.clock.now += EVERY;
      await r.seat.tick();
      // The round runs but has not reported: the held event is still tried.
      const before = tries;
      expect(await r.seat.done("fine")).toBe("ok");
      r.live.clear();
      r.clock.now += MIN;
      await r.seat.tick();
      await r.seat.tick();
      expect(tries).toBe(before);
      r.seat.stop();
    });

    test("a restart that reads three failed entries sends none: the transition was before this process", async () => {
      let tries = 0;
      const r = rig({
        onFailing: () => {
          tries += 1;
          return Promise.resolve(true);
        },
      });
      r.rounds.push(failed(NOW - 4 * MIN), failed(NOW - 3 * MIN), failed(NOW - 2 * MIN));
      await r.seat.start();
      await r.seat.tick();
      expect(tries).toBe(0);
      r.seat.stop();
    });
  });

  test("the view is not ready until start has read the log and the control file", async () => {
    const r = rig();
    expect(r.seat.ready()).toBe(false);
    await r.seat.start();
    expect(r.seat.ready()).toBe(true);
    r.seat.stop();
  });

  test("a failing seat that is also paused still shows failing; a failed launch does not move e", async () => {
    const r = rig();
    r.rounds.push(entry({ end: 5_000_000 }), failed(NOW - 3 * MIN), failed(NOW - 2 * MIN), failed(NOW - MIN));
    r.control.read = { pause: { at: 1, until: null }, unreadable: false };
    await r.seat.start();
    await r.seat.tick();
    expect(r.seat.view(NOW).s).toBe("failing");
    expect(r.seat.view(NOW).e).toBe(Math.floor((NOW - MIN + 1000) / 1000));
    r.seat.stop();
  });

  test("onView fires when s, e or rc change, not once per tick; the view is published every tick without rc", async () => {
    const r = rig();
    await r.seat.start();
    const afterStart = r.onView.calls;
    await r.seat.tick();
    // idle -> running
    expect(r.onView.calls).toBe(afterStart + 1);
    r.remote.id = `session_${"c".repeat(8)}`;
    r.clock.now = NOW + MIN;
    await r.seat.tick();
    expect(r.onView.calls).toBe(afterStart + 2);
    r.clock.now = NOW + 2 * MIN;
    await r.seat.tick();
    await r.seat.tick();
    expect(r.onView.calls).toBe(afterStart + 2);
    expect(r.published.length).toBeGreaterThanOrEqual(4);
    for (const published of r.published) expect(published).not.toHaveProperty("rc");
    r.seat.stop();
  });

  test("a pause behind running or failing shows as p; paused and idle never carry it", async () => {
    const r = rig();
    await r.seat.start();
    await r.seat.tick();
    // Paused while the round runs: the pause stops the due check, never a running round.
    r.control.read = { pause: { at: 1, until: null }, unreadable: false };
    await r.seat.tick();
    expect(r.seat.view(NOW)).toMatchObject({ s: "running", p: true });
    r.control.read = { pause: null, unreadable: false };
    r.clock.now = NOW + MIN;
    await r.seat.tick();
    expect(r.seat.view(r.clock.now)).not.toHaveProperty("p");
    r.seat.stop();

    const failing = rig({ activity: () => [] });
    failing.rounds.push(failed(NOW - 3 * MIN), failed(NOW - 2 * MIN), failed(NOW - MIN));
    failing.control.read = { pause: { at: 1, until: NOW + MIN }, unreadable: false };
    await failing.seat.start();
    expect(failing.seat.view(NOW)).toMatchObject({ s: "failing", p: true });
    expect(failing.seat.view(NOW + MIN)).not.toHaveProperty("p");
    failing.seat.stop();

    const paused = rig({ activity: () => [] });
    paused.control.read = { pause: { at: 1, until: null }, unreadable: false };
    await paused.seat.start();
    expect(paused.seat.view(NOW)).toEqual({ s: "paused" });
    paused.seat.stop();
  });

  test("poke reads the control file now and tells the status; one landing mid-pass runs another after it", async () => {
    const r = rig({ activity: () => [] });
    await r.seat.start();
    const calls = r.onView.calls;
    r.control.read = { pause: { at: NOW, until: null }, unreadable: false };
    r.seat.poke();
    await pollUntil(() => r.seat.view(NOW).s === "paused", "the poke read the pause");
    await pollUntil(() => r.onView.calls === calls + 1, "the status was told");

    // A pass held mid-step: the poke waits for it, then runs its own and sees the resume.
    const gate = Promise.withResolvers<void>();
    let reads = 0;
    const held = rig({
      activity: () => [],
      readControl: async () => {
        reads++;
        if (reads === 2) await gate.promise;
        return held.control.read;
      },
    });
    held.control.read = { pause: { at: NOW, until: null }, unreadable: false };
    await held.seat.start();
    const running = held.seat.tick();
    await pollUntil(() => reads === 2, "the pass is reading");
    held.control.read = { pause: null, unreadable: false };
    held.seat.poke();
    gate.resolve();
    await running;
    await pollUntil(() => reads === 3, "the poke's own pass ran");
    await pollUntil(() => held.seat.view(NOW).s === "idle", "it read the resume");
    r.seat.stop();
    held.seat.stop();
  });
});
