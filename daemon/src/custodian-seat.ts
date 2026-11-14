import type { CustodianAudit } from "./audit.ts";
import {
  isRemoteSessionId,
  quotaPressure,
  quotaWindows,
  windowAppliesTo,
  type CustodianStatus,
  type QuotaReading,
} from "@seance/shared";
import type { Config, CustodianConfig } from "./config.ts";
import type { CustodianVerb } from "./custodian-frame.ts";
import { pausedAt, ROUND_REQUEST_MIN_GAP_MS, type PauseRead, type RoundRequest } from "./custodian-control.ts";
import { countedVerb, emptyCounts, type RoundEntry } from "./custodian-rounds.ts";
import { exclaveOf, type Exclave, type ExclaveScan } from "./exclaves.ts";
import type { TrackedActivity } from "./pane-activity.ts";
import type { SeatRecord } from "./seat-record.ts";

/**
 * The custodian seat (docs/custodian.md C1–C4, C12–C16; DESIGN.md, "The custodian's seat"): once a minute, with no
 * model call, decide whether a round is due, pick the exclave to run it, start it, close it at its deadline and
 * audit each step. Logic over injected deps, so it runs without tmux; `run-capabilities.ts` wires the real ones.
 * Nothing here reads a pane's text, and nothing it logs or audits holds any.
 */

/**
 * Rounds are held until the hardening (docs/custodian.md, build item 4b). The verbs bound only what goes through
 * them: a live round's sandbox can still reach the tmux socket and the daemon's plain local ops, and read on-disk
 * secrets with github.com reachable, so an injected round would not be bound by them. Owner decision, 2026-11-14;
 * item 4b removes this constant.
 */
export const ROUNDS_LIVE = false;

/** `RunOpts.custodian`: the seat's seams. Production passes `{}`; the rest is for tests, which must never launch a real round. */
export interface CustodianSeatOpts {
  /** Tests only: `true` turns the seat on where `ROUNDS_LIVE` holds it. */
  readonly live?: boolean;
  readonly checkIntervalMs?: number;
  /** The graceful exit's grace before a round is killed. */
  readonly graceMs?: number;
  readonly sandboxProblem?: () => Promise<string | null>;
  readonly weakerNested?: () => Promise<boolean>;
}

export function seatLive(opts: CustodianSeatOpts): boolean {
  return opts.live ?? ROUNDS_LIVE;
}

export function custodianPlatform(platform: NodeJS.Platform): "darwin" | "linux" | null {
  return platform === "darwin" || platform === "linux" ? platform : null;
}

/**
 * Whether this daemon holds a seat: the machine's own config carries the key, the process was started for one
 * (`RunOpts.custodian`), rounds are live, and the platform has a fence. One predicate for the capability bit and the
 * seat, so they cannot disagree.
 */
export function seatEnabled(
  config: Pick<Config, "custodian">,
  opts: CustodianSeatOpts | null | undefined,
  platform: NodeJS.Platform,
): boolean {
  return (
    config.custodian !== undefined &&
    opts !== null &&
    opts !== undefined &&
    seatLive(opts) &&
    custodianPlatform(platform) !== null
  );
}

const MINUTE_MS = 60_000;
export const CHECK_INTERVAL_MS = MINUTE_MS;

/**
 * C14 and C45: some tracked pane has stood `idle` since a turn's end for `everyMs`; the last round ended at least that
 * long ago; none is running; the daemon is not draining for a restart; the owner has not paused the seat. The owner's
 * request (`seanced custodian round`, `requested`) skips the interval, the last round's age, the quiet condition and
 * the pause, never a running round or a drain. A pane counts only when a built verb
 * could act on it, else it would keep a round due every `everyMinutes` that closes nothing (DESIGN.md records the
 * narrowing): C7's exclusions (a last state of `needs-input`, or a drain, hand-off or pass mark: `untouchable`), a
 * pane no frame has given a state (`close` answers `unobserved`), and an `idle` without `turnEnded` (`close` answers
 * that `unobserved` too, and a mod's `session.start` on a reload or respawn sends exactly that for a finished session).
 */
export function roundDue(o: {
  readonly now: number;
  readonly everyMs: number;
  readonly lastEndedAt: number | undefined;
  readonly running: boolean;
  readonly draining: boolean;
  readonly paused: boolean;
  readonly requested: boolean;
  readonly panes: readonly TrackedActivity[];
  readonly untouchable: (pane: string) => boolean;
}): boolean {
  if (o.running || o.draining) return false;
  if (o.requested) return true;
  if (o.paused) return false;
  if (o.lastEndedAt !== undefined && o.now - o.lastEndedAt < o.everyMs) return false;
  return o.panes.some((pane) => !o.untouchable(pane.pane) && actionable(pane, o.now, o.everyMs));
}

/**
 * Whether a verb that exists could act on this pane once `everyMs` has passed: `close`, on a pane idle since its
 * turn ended. Custodian 8's `interrupt` adds its own term here (a `busy` pane whose screen has stood still,
 * `screenSince`), so a due round keeps meaning "something could be done", never "something is old".
 */
function actionable(pane: TrackedActivity, now: number, everyMs: number): boolean {
  return pane.state === "idle" && pane.turnEnded && pane.stateSince !== null && now - pane.stateSince >= everyMs;
}

/** Why an exclave cannot host a round before its round dir is looked at, null when it might. */
export function exclaveSkip(
  info: ExclaveScan["info"][number],
  expired: (id: string) => boolean,
): "signed-out" | "lapsed" | null {
  if (!info.authOk || info.accountId === null) return "signed-out";
  return expired(info.id) ? "lapsed" : null;
}

/**
 * C12, C13: the exclave to run a round in. `eligible` holds the ids whose round dir is trusted, unplanted and
 * resolves to that exclave. Lowest quota pressure wins; unknown quota ranks after known but stays eligible; ties go to
 * scan order. `readings` is keyed by account id (`newestReadings`), not exclave id. `added` is 0: a round is not a
 * task, and the per-task estimate is the leader's.
 */
export function pickExclave(o: {
  readonly scan: ExclaveScan;
  readonly readings: ReadonlyMap<string, QuotaReading>;
  readonly expired: (id: string) => boolean;
  readonly eligible: ReadonlySet<string>;
  readonly model: string;
  readonly now: number;
}): Exclave | null {
  const ranked: { readonly exclave: Exclave; readonly pressure: number | null }[] = [];
  o.scan.exclaves.forEach((exclave, at) => {
    const info = o.scan.info[at];
    if (info === undefined || info.id !== exclave.id) return;
    if (exclaveSkip(info, o.expired) !== null || !o.eligible.has(exclave.id)) return;
    const reading = info.accountId === null ? undefined : o.readings.get(info.accountId);
    // No window that applies to the model is unknown, as the scheduler's `judgeAccount` reads it, never zero pressure.
    const windows =
      reading === undefined ? [] : quotaWindows(reading).filter((window) => windowAppliesTo(window, o.model));
    ranked.push({ exclave, pressure: windows.length === 0 ? null : quotaPressure(windows, () => 0, o.now) });
  });
  const known = ranked
    .filter((entry) => entry.pressure !== null)
    .toSorted((a, b) => (a.pressure ?? 0) - (b.pressure ?? 0));
  const unknown = ranked.filter((entry) => entry.pressure === null);
  return [...known, ...unknown][0]?.exclave ?? null;
}

export type PickResult = { readonly exclave: Exclave } | { readonly none: string };

/** The I/O the pick needs, injected: the real ones are `isDirTrusted`, `roundDirPlanted`, `ensureRoundDir`. */
export interface PickDeps {
  readonly scan: () => ExclaveScan;
  readonly readings: () => ReadonlyMap<string, QuotaReading>;
  readonly expired: (id: string) => boolean;
  readonly model: string;
  readonly now: () => number;
  readonly roundDirFor: (exclave: Exclave) => string;
  readonly rootExists: (root: string) => Promise<boolean>;
  readonly trusted: (dir: string, configFile: string) => Promise<boolean>;
  readonly planted: (dir: string) => Promise<boolean>;
  /** mkdir 0700 and realpath, for the one exclave picked. */
  readonly ensureDir: (dir: string) => Promise<string>;
}

export type HostProblem =
  | "root missing"
  | "round dir is in another exclave"
  | "round dir untrusted"
  | "round dir holds settings or agents";

/**
 * Why a signed-in exclave's round dir cannot host a round, null when it can: the one rule the pick and `seanced
 * doctor` share, so doctor never says an exclave can host while the seat skips it.
 */
export async function hostProblem(
  d: Pick<PickDeps, "roundDirFor" | "rootExists" | "trusted" | "planted">,
  exclave: Exclave,
  exclaves: readonly Exclave[],
): Promise<HostProblem | null> {
  const dir = d.roundDirFor(exclave);
  if (!(await d.rootExists(exclave.root))) return "root missing";
  if (exclaveOf(dir, exclaves) !== exclave.id) return "round dir is in another exclave";
  if (!(await d.trusted(dir, exclave.configFile))) return "round dir untrusted";
  if (await d.planted(dir)) return "round dir holds settings or agents";
  return null;
}

/**
 * Touches no disk but reads until the pick: each candidate's round dir is checked at its uncreated path (trust walks
 * the path and its ancestors; a missing dir is unplanted), and only the exclave picked has its dir made. An
 * exclave root that does not exist is ineligible; a root is never invented. A null pick says why, as ids and fixed
 * reasons, for the seat's one warning.
 */
export function createPick(d: PickDeps): () => Promise<PickResult> {
  return async () => {
    const scan = d.scan();
    const eligible = new Set<string>();
    const reasons: string[] = [];
    for (const [at, exclave] of scan.exclaves.entries()) {
      const info = scan.info[at];
      if (info === undefined || info.id !== exclave.id) continue;
      const skip = exclaveSkip(info, d.expired);
      if (skip !== null) {
        reasons.push(`${exclave.id}: ${skip}`);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- a handful of exclaves, one small read each
      const problem = await hostProblem(d, exclave, scan.exclaves);
      if (problem === null) eligible.add(exclave.id);
      else reasons.push(`${exclave.id}: ${problem}`);
    }
    const exclave = pickExclave({
      scan,
      readings: d.readings(),
      expired: d.expired,
      eligible,
      model: d.model,
      now: d.now(),
    });
    if (exclave === null) return { none: reasons.length === 0 ? "no exclave" : reasons.join("; ") };
    const real = await d.ensureDir(d.roundDirFor(exclave));
    if (exclaveOf(real, scan.exclaves) !== exclave.id)
      return { none: `${exclave.id}: round dir resolves to another exclave` };
    return { exclave };
  };
}

export type { SeatRecord };

export type CloseOutcome = Parameters<CustodianAudit["kill"]>[2];

export interface SeatDeps {
  readonly settings: CustodianConfig;
  readonly now: () => number;
  readonly checkIntervalMs?: number;
  /** Tests: the round's deadline in ms, in place of `roundTimeoutMinutes`. */
  readonly roundTimeoutMs?: number;
  readonly activity: () => readonly TrackedActivity[];
  /** A pane a hand-off, pass or drain ask marked: C7 keeps the custodian off it. */
  readonly untouchable: (pane: string) => boolean;
  readonly draining: () => boolean;
  /** The capability was stopped: nothing is saved, and a late launch closes its own pane. */
  readonly stopped: () => boolean;
  readonly record: () => SeatRecord;
  readonly save: (record: SeatRecord) => Promise<void>;
  readonly pick: () => Promise<PickResult>;
  readonly launch: (
    exclave: Exclave,
    onTmp: (tmpDir: string) => Promise<void>,
  ) => Promise<{ readonly pane: string; readonly tmpDir: string }>;
  readonly listRounds: () => Promise<readonly { readonly pane: string; readonly dead: boolean }[]>;
  readonly paneAlive: (pane: string) => Promise<"live" | "dead" | "gone">;
  readonly close: (pane: string) => Promise<CloseOutcome>;
  readonly removeTmp: (tmpDir: string) => Promise<void>;
  readonly audit: CustodianAudit;
  /** Writes one round-log entry (`upsertRound`): the real one is the round log file's. */
  readonly appendRound: (entry: RoundEntry) => Promise<void>;
  /** The round log, oldest first (`readRounds`): the view's last round and the failing count come from it. */
  readonly readRounds: () => Promise<readonly RoundEntry[]>;
  /** The owner's pause (`custodian/state.json`): an unreadable file reads as paused. */
  readonly readControl: () => Promise<PauseRead>;
  /** The owner's round request, by age; `drop` removes it. */
  readonly peekRoundRequest: (now: number) => Promise<RoundRequest>;
  readonly dropRoundRequest: () => Promise<void>;
  /** The running round's Remote Control id (`custodian-remote.ts`), null when unknown. */
  readonly remoteId: (round: NonNullable<SeatRecord["round"]>) => Promise<string | null>;
  /** The view changed in `s`, `e` or `rc`: the status refreshes at once rather than at its next beat. */
  readonly onView?: () => void;
  /** The view, without `rc`, for `seat.json`: every tick, so its age says the daemon is alive. */
  readonly publishView: (view: CustodianStatus) => Promise<void>;
  /**
   * C41: tells the leader the seat has failed `FAILING_AFTER` rounds in a row (a `custodian-event` `failing`, which it
   * pushes). True once handed on. The seat holds an undelivered one and tries again on its ticks, since the third
   * failure is often an `adopt` at daemon start, before the relay is registered or a term runs.
   */
  readonly onFailing?: () => Promise<boolean>;
  readonly warn: (line: string) => void;
}

/** C41: this many failed rounds (or failed attempts) in a row make the seat `failing`. */
export const FAILING_AFTER = 3;

const COUNT_CAP = 999;

/** `e` and `n` from the log's newest entry; absent with none. `e` is seconds, as `MachineStatus.at`. */
export function lastRoundView(last: RoundEntry | undefined): Pick<CustodianStatus, "e" | "n"> {
  if (last === undefined) return {};
  return {
    e: Math.floor(last.end / 1000),
    n: [Math.min(last.counts.close.ok, COUNT_CAP), 0, Math.min(last.counts.flagged, COUNT_CAP)],
  };
}

/** How many entries at the log's tail are failed ones. */
export function trailingFailures(entries: readonly RoundEntry[]): number {
  let count = 0;
  for (const entry of entries.toReversed()) {
    if (entry.outcome !== "failed") break;
    count++;
  }
  return count;
}

export interface CustodianSeat {
  /** Adopts what a restart left, then ticks on the interval; resolves once the adoption is done. */
  readonly start: () => Promise<void>;
  /** One pass now (the interval's own); a call while one runs does nothing. For tests. */
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
  /**
   * The pane of the round this seat is running, null when none is or the seat is stopped: what the `custodian` frame
   * binds a caller to (`custodian-verbs.ts`).
   */
  readonly roundPane: () => string | null;
  /** The round's verb tally, as the round log carries it. In memory: a restart loses an adopted round's counts. */
  readonly count: (verb: CustodianVerb, ok: boolean) => void;
  readonly countWorktree: (kind: "removed" | "kept") => void;
  /** A flag for the round: one the `flag` verb took as new, or the daemon's own after a close kept a worktree. */
  readonly countFlagged: () => void;
  /** The round's `done` was accepted: its verbs are refused `round_done`. */
  readonly isDone: () => boolean;
  /**
   * C40: the round's summary is in the log and the round is marked done; the seat closes the pane at its next tick,
   * never here, since the caller's Bash is waiting on the reply. A second `done` answers `ok` and writes nothing.
   */
  readonly done: (summary: string) => Promise<"ok" | "too_late" | "no_round">;
  /** The seat's state for the status's `cu` (C40), synchronous: it reads what the last tick cached. */
  readonly view: (now: number) => CustodianStatus;
  /** False until `start` has read the log and the control file: before that `view` would say `idle` whatever is true. */
  readonly ready: () => boolean;
}

export function createCustodianSeat(d: SeatDeps): CustodianSeat {
  const everyMs = d.settings.everyMinutes * MINUTE_MS;
  const timeoutMs = d.roundTimeoutMs ?? d.settings.roundTimeoutMinutes * MINUTE_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  let counts = emptyCounts();
  // `done` writes the record `step` reads: both run through this chain, one at a time. `busy` stays the tick's own
  // guard (a tick while one runs does nothing), which `done` must not be dropped by.
  let chain: Promise<unknown> = Promise.resolve();
  const serially = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };
  let lastNone: string | null = null;
  /** A pick that found nothing is not repeated before `everyMinutes`: each one reads every exclave's `.claude.json`. */
  let pickAfter = 0;
  // What `view` reads, kept in memory so the status collector does no I/O.
  let lastRound: RoundEntry | undefined;
  let control: PauseRead = { pause: null, unreadable: false };
  let unreadableWarned = false;
  /** C41's count: failed log entries, launch failures and picks that threw in a row; a healthy round clears it. A restart reseeds it from the log's tail. */
  let failures = 0;
  /** The run of `FAILING_AFTER` has been reached and its `failing` event not yet handed on. In memory: a restart seeded past it sends none. */
  let failingPending = false;
  let sendingFailing = false;
  /** When this process last started a launch: with the record's `lastEndedAt` and the log's newest start, it spaces requests. */
  let lastLaunchAt = 0;
  let ready = false;
  let remote: { readonly key: string; readonly id: string | null } | null = null;
  let lastViewKey: string | null = null;
  const roundKey = (round: NonNullable<SeatRecord["round"]>): string => `${round.pane ?? "-"}:${round.startedAt}`;

  const refreshLog = async (): Promise<void> => {
    try {
      lastRound = (await d.readRounds()).at(-1);
    } catch (err) {
      d.warn(`custodian: reading the round log failed: ${String(err)}`);
    }
  };

  /** Hands the pending `failing` on, once; a send that did not land stays pending for the next tick. */
  const flushFailing = async (): Promise<void> => {
    if (!failingPending || sendingFailing || d.onFailing === undefined || d.stopped()) return;
    sendingFailing = true;
    try {
      if (await d.onFailing()) failingPending = false;
    } catch (err) {
      d.warn(`custodian: sending the failing event failed: ${String(err)}`);
    } finally {
      sendingFailing = false;
    }
  };

  /** One failed round or attempt. Only the move onto `FAILING_AFTER` raises the event: a longer run and a restart seeded past it do not. */
  const failed = (): void => {
    failures += 1;
    if (failures !== FAILING_AFTER) return;
    failingPending = true;
    void flushFailing();
  };

  /** A healthy round ends the run, and with it an event nobody took. */
  const healthy = (): void => {
    failures = 0;
    failingPending = false;
  };

  const view = (now: number): CustodianStatus => {
    const round = d.record().round;
    const shared = lastRoundView(lastRound);
    if (round !== undefined) {
      const id = remote !== null && round.pane !== null && remote.key === roundKey(round) ? remote.id : null;
      return { s: "running", ...shared, ...(id !== null && isRemoteSessionId(id) ? { rc: id } : {}) };
    }
    if (failures >= FAILING_AFTER) return { s: "failing", ...shared };
    return { s: pausedAt(control, now) ? "paused" : "idle", ...shared };
  };

  /** Tells the status loop when `s`, `e` or `rc` moved, and publishes the view for the owner's commands. */
  const notify = async (): Promise<void> => {
    if (d.stopped()) return;
    const current = view(d.now());
    const key = JSON.stringify(current);
    if (key !== lastViewKey) {
      lastViewKey = key;
      d.onView?.();
    }
    const { rc: _rc, ...published } = current;
    await d
      .publishView(published)
      .catch((err: unknown) => d.warn(`custodian: publishing the seat's view failed: ${String(err)}`));
  };

  // A reload's second `startDaemon` writes `state` too: the outgoing instance saving over it would clobber it
  // (the guard `reapSchedule` keeps). The next process's `adopt` covers what is left.
  const persist = async (record: SeatRecord): Promise<boolean> => {
    if (d.stopped()) return false;
    await d.save(record);
    return true;
  };

  const finish = async (
    round: NonNullable<SeatRecord["round"]>,
    reason: "done" | "deadline" | "exited" | "lost",
  ): Promise<void> => {
    await d.removeTmp(round.tmpDir);
    await d.audit.end(round.pane, reason === "done" ? "healthy" : "failed", reason);
    // A `done` wrote its healthy entry, with the summary, when it was accepted, and the log never overwrites a healthy
    // one: this upsert is then a no-op. When that write failed (warned) or the daemon died between the record and the
    // log, the round is still recorded here, without its summary, which only the failed write held. Every other end is
    // a failed round, which carries no summary.
    await d
      .appendRound({
        start: round.startedAt,
        end: d.now(),
        exclave: round.exclave,
        outcome: reason === "done" ? "healthy" : "failed",
        reason,
        counts: reason === "done" ? countedVerb(counts, "done", true) : counts,
      })
      .catch((err: unknown) => d.warn(`custodian: writing the round log failed: ${String(err)}`));
    if (reason === "done") healthy();
    else failed();
    remote = null;
    await refreshLog();
    await persist({ lastEndedAt: d.now() });
  };

  /** Closes every round pane but `kept`; the recorded round's own dead pane is `exited`, any other is stray. */
  const sweep = async (
    panes: readonly { readonly pane: string; readonly dead: boolean }[],
    recorded: string | null,
    kept: string | null,
  ): Promise<void> => {
    for (const pane of panes) {
      if (pane.pane === kept) continue;
      const reason = pane.pane === recorded ? "exited" : "stray";
      // oxlint-disable-next-line no-await-in-loop -- one pane at a time: each close is a graceful exit
      await d.audit.kill(pane.pane, reason, await d.close(pane.pane));
    }
  };

  /** C4: the round a restart or reload left is adopted with its original deadline; any other round pane is stray. */
  const adopt = async (): Promise<void> => {
    const round = d.record().round;
    const panes = await d.listRounds();
    const recordedPane = round?.pane ?? null;
    const recorded = recordedPane === null ? undefined : panes.find((pane) => pane.pane === recordedPane);
    const kept = recorded !== undefined && !recorded.dead ? recorded.pane : null;
    await sweep(panes, recordedPane, kept);
    if (round === undefined || kept !== null) return;
    if (round.done === true) return finish(round, "done");
    await finish(round, recorded === undefined ? "lost" : "exited");
  };

  const closeStray = async (launched: { readonly pane: string; readonly tmpDir: string }): Promise<void> => {
    await d.audit.kill(launched.pane, "stray", await d.close(launched.pane));
    await d.removeTmp(launched.tmpDir);
  };

  const launch = async (requested: boolean): Promise<void> => {
    let picked: PickResult;
    try {
      picked = await d.pick();
    } catch (err) {
      // A pick that throws has read every exclave's `.claude.json` too: back off like a `none`, but this one is a fault.
      pickAfter = d.now() + everyMs;
      failed();
      throw err;
    }
    if ("none" in picked) {
      // Not the seat's fault (quota, a lapsed login, no trusted exclave), so it does not count toward `failing`.
      pickAfter = d.now() + everyMs;
      if (picked.none !== lastNone) d.warn(`custodian: no exclave can host a round: ${picked.none}`);
      lastNone = picked.none;
      if (requested) d.warn("custodian: the requested round found no exclave to run in");
      return;
    }
    lastLaunchAt = d.now();
    lastNone = null;
    const { exclave } = picked;
    const startedAt = d.now();
    const lastEndedAt = d.record().lastEndedAt;
    const ahead = (pane: string | null, tmpDir: string): SeatRecord => ({
      ...(lastEndedAt === undefined ? {} : { lastEndedAt }),
      round: { pane, startedAt, tmpDir, exclave: exclave.id },
    });
    let launched: { readonly pane: string; readonly tmpDir: string };
    counts = emptyCounts();
    try {
      launched = await d.launch(exclave, async (tmpDir) => {
        await persist(ahead(null, tmpDir));
      });
    } catch (err) {
      failed();
      await d.audit.start(exclave.id, null, "launch_failed");
      // A broken launch retries only after `everyMinutes`, never every tick.
      await persist({ lastEndedAt: d.now() });
      d.warn(`custodian: round launch failed: ${String(err)}`);
      return;
    }
    if (d.stopped()) {
      // Nothing saved this pane, so the incoming instance cannot adopt it: close it here.
      await closeStray(launched);
      return;
    }
    try {
      await d.audit.start(exclave.id, launched.pane, "started");
      // A stop that landed during the audit append makes `persist` write nothing, and the incoming instance may have
      // adopted the write-ahead record already, finding no pane: nobody else will close this one.
      if (!(await persist(ahead(launched.pane, launched.tmpDir)))) await closeStray(launched);
    } catch (err) {
      // The pane exists but its record may not: a round nothing tracks has no deadline and no reader can reach it
      // (C10), so close it here and count it as ended.
      failed();
      d.warn(`custodian: recording a started round failed, closing it: ${String(err)}`);
      let outcome: CloseOutcome;
      try {
        outcome = await d.close(launched.pane);
      } catch (closeErr) {
        // Not closed: keep the pane on the record so its deadline closes it, or, failing that, the write-ahead
        // record's `step` sweeps it.
        d.warn(`custodian: closing the round's pane failed: ${String(closeErr)}`);
        await persist(ahead(launched.pane, launched.tmpDir)).catch(() => {});
        return;
      }
      await d.removeTmp(launched.tmpDir);
      await d.audit.kill(launched.pane, "stray", outcome).catch(() => {});
      await persist({ lastEndedAt: d.now() }).catch(() => {});
    }
  };

  const step = async (): Promise<void> => {
    const now = d.now();
    const record = d.record();
    const round = record.round;
    control = await d.readControl();
    if (!control.unreadable) unreadableWarned = false;
    else if (!unreadableWarned) {
      unreadableWarned = true;
      d.warn(
        "custodian: custodian/state.json is unreadable; the seat is paused until it is fixed or `seanced custodian resume` rewrites it",
      );
    }
    let request = await d.peekRoundRequest(now);
    if (d.stopped()) return;
    if (request === "stale" || (request === "fresh" && round !== undefined)) {
      // A request that arrived while a round runs is moot: that round is the round now.
      await d.dropRoundRequest();
      request = "none";
    }
    if (request === "fresh" && !d.draining()) {
      const latest = Math.max(lastLaunchAt, record.lastEndedAt ?? 0, lastRound?.start ?? 0);
      if (now - latest < ROUND_REQUEST_MIN_GAP_MS) {
        await d.dropRoundRequest();
        request = "none";
        d.warn("custodian: a round was requested too soon after the last one; dropped");
      }
    }
    if (round === undefined) {
      const requested = request === "fresh";
      const due = roundDue({
        now,
        everyMs,
        lastEndedAt: record.lastEndedAt,
        running: false,
        draining: d.draining(),
        paused: pausedAt(control, now),
        requested,
        panes: d.activity(),
        untouchable: d.untouchable,
      });
      if (!due || (!requested && now < pickAfter)) return;
      // Dropped before the launch, so a crash in it cannot repeat the request.
      if (requested) await d.dropRoundRequest();
      await launch(requested);
      return;
    }
    // A write-ahead record with no pane outside a launch (ticks never overlap one): a crash's, which `adopt` could not clear.
    // A close that threw after the pane existed leaves it running: close whatever round panes there are first.
    if (round.pane === null) {
      await sweep(await d.listRounds(), null, null);
      await finish(round, "lost");
      return;
    }
    // The round's `done` was accepted: close it now, ahead of the deadline, which a late tick must not read as a failure.
    if (round.done === true) {
      if ((await d.paneAlive(round.pane)) !== "gone") {
        await d.audit.kill(round.pane, "done", await d.close(round.pane));
      }
      await finish(round, "done");
      return;
    }
    if (now >= round.startedAt + timeoutMs) {
      await d.audit.kill(round.pane, "deadline", await d.close(round.pane));
      await finish(round, "deadline");
      return;
    }
    const alive = await d.paneAlive(round.pane);
    if (alive === "live") {
      const key = roundKey(round);
      if (remote?.key !== key || remote.id === null) {
        remote = { key, id: await d.remoteId(round).catch(() => null) };
      }
      return;
    }
    if (alive === "dead") await d.audit.kill(round.pane, "exited", await d.close(round.pane));
    await finish(round, "exited");
  };

  const tick = async (): Promise<void> => {
    if (busy || d.stopped()) return;
    busy = true;
    try {
      await serially(step);
    } catch (err) {
      d.warn(`custodian: seat pass failed: ${String(err)}`);
    } finally {
      busy = false;
    }
    await flushFailing();
    await notify();
  };

  return {
    start: (): Promise<void> => {
      if (timer !== null) return Promise.resolve();
      busy = true;
      timer = setInterval(() => void tick(), d.checkIntervalMs ?? CHECK_INTERVAL_MS);
      // The daemon's stop clears it; a handle dropped without one must not hold the process open.
      timer.unref();
      // Seeded before adoption, whose own ended rounds add to the count.
      const seeded = d
        .readRounds()
        .then((entries) => {
          lastRound = entries.at(-1);
          failures = trailingFailures(entries);
          return null;
        })
        .catch((err: unknown) => d.warn(`custodian: reading the round log failed: ${String(err)}`));
      return seeded
        .then(() => d.readControl())
        .then((read) => {
          control = read;
          ready = true;
          return null;
        })
        .then(() => serially(adopt))
        .catch((err: unknown) => d.warn(`custodian: adopting a round failed: ${String(err)}`))
        .finally(() => {
          busy = false;
        })
        .then(notify);
    },
    tick,
    ready: () => ready,
    // Never closes the round: a reload or restart adopts it (C4).
    stop: (): void => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    roundPane: (): string | null => (d.stopped() || timer === null ? null : (d.record().round?.pane ?? null)),
    count: (verb, ok): void => {
      counts = countedVerb(counts, verb, ok);
    },
    countWorktree: (kind): void => {
      counts = { ...counts, worktrees: { ...counts.worktrees, [kind]: counts.worktrees[kind] + 1 } };
    },
    countFlagged: (): void => {
      counts = { ...counts, flagged: counts.flagged + 1 };
    },
    isDone: (): boolean => d.record().round?.done === true,
    done: (summary) =>
      serially(async () => {
        const round = d.record().round;
        if (round === undefined || round.pane === null || d.stopped()) return "no_round";
        if (round.done === true) return "ok";
        if (d.now() >= round.startedAt + timeoutMs) return "too_late";
        // The record first: a `done` the seat could not mark (a stop landed) writes no healthy line, so the log never
        // says healthy for a round whose end the audit then calls failed. A log write that fails after it is a
        // warning, like every other round-log write: the round is done either way.
        if (!(await persist({ ...d.record(), round: { ...round, done: true } }))) return "no_round";
        await d
          .appendRound({
            start: round.startedAt,
            end: d.now(),
            exclave: round.exclave,
            outcome: "healthy",
            reason: "done",
            counts: countedVerb(counts, "done", true),
            summary,
          })
          .catch((err: unknown) => d.warn(`custodian: writing the round log failed: ${String(err)}`));
        healthy();
        await refreshLog();
        return "ok";
      }),
    view,
  };
}
