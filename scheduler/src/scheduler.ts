import {
  CAPABILITIES,
  continuationUnderway,
  DECISION_MAX_CANDIDATES,
  PASS_CLOSE_GRACE_MS,
  parseSpillStamp,
  queuedTask,
  quote,
  successorPrompt,
  successorSpec,
  type BranchState,
  type FleetQuotaEntry,
  type IdleTaskRef,
  type PrAlertStamp,
  type PassResponse,
  type PrStatus,
  type PauseHold,
  type PauseRequest,
  type ResumeRequest,
  type SessionState,
  type SpillStamp,
  type SuccessorTrigger,
} from "@seance/shared";
import { isDeepStrictEqual } from "node:util";
import {
  escalation,
  inputAlert,
  inputClock,
  prBlockedAlert,
  questionAlert,
  SpillAlerts,
  type SchedulerAlert,
} from "./alerts.ts";
import { dispatchOrder } from "./batch.ts";
import { DEFAULT_CONFIG, type SchedulerConfig } from "./config.ts";
import { continuedChange } from "./continued.ts";
import { admission } from "./deps.ts";
import { branchChange, ended as settledEnd, prBound, prChange } from "./done.ts";
import { endClock, expiry } from "./expiry.ts";
import { PauseRecord, withHold, withoutHold, type PauseResult } from "./pause.ts";
import {
  StoreRevoked,
  UNREACHABLE,
  WRITE_ATTEMPTS,
  type Fleet,
  type PrHeadReading,
  type QueueStore,
  type StoreEntry,
  type StoreWrite,
  type TaskCreateResult,
  type TaskSessionsReply,
  type UnreadableTask,
} from "./ports.ts";
import { codeUnitOrder } from "./order.ts";
import { prunable, unprunable } from "./prune.ts";
import { accountResetAt, route, type Decision } from "./route.ts";
import {
  answerable,
  asSeen,
  deviceOf,
  holds,
  sessionChange,
  settle,
  verdict,
  waitsForExit,
  type SessionSource,
} from "./settle.ts";
export { sourceOf } from "./settle.ts";
import { advance, FINISHED, forgetPrompt, PLACED, type Reservation, type Task, type TaskSpec } from "./task.ts";
import { traitsHolding, type TraitHold } from "./traits.ts";

export type { SessionSource } from "./settle.ts";
export type { PauseResult } from "./pause.ts";

/**
 * The `client` a scheduler spawn audits as: `origin=relay client=scheduler`
 * (Settled defaults 3) on another machine, `origin=leader` on the leader's own.
 */
export const SCHEDULER_CLIENT = "scheduler";

/**
 * Legacy finished records rewritten lean (`lean`) per pass. Sequential
 * round-trips inside `#pass` delay the next admission and dispatch and nudge
 * every app per write, so the backlog (up to `pruneAt` - 1 records, once) is
 * worked off a few at a time.
 */
const LEAN_PER_PASS = 8;

export interface SchedulerOptions {
  readonly store: QueueStore;
  readonly fleet: Fleet;
  readonly config?: SchedulerConfig;
  readonly now: () => number;
  /**
   * A dispatch runs outside any tick (`#launch`), so its fault has no caller to
   * reject. Without this, the first one surfaces from the next `drain()`.
   */
  readonly onError?: (err: unknown) => void;
  /**
   * A dispatch past the quota line on an account that may spill into credits, or
   * already spends them (once its spawn is confirmed), or an escalated wait for
   * input (once its write lands) — `SchedulerAlert`. A throw goes to `onError`.
   */
  readonly onAlert?: (alert: SchedulerAlert) => void;
  /**
   * A task's idle release (`idle`) began or ended with no write of its own, so
   * no store nudge says it: the host tells apps to re-read that task.
   */
  readonly onIdleChange?: (taskId: string) => void;
  /**
   * A required trait first holds a task unplaced (`traitsHolding`), once per task and trait in this
   * scheduler's memory: a new term tells again, and a trait that changes why it holds does not. `why` is
   * `absent` (no machine carries the trait) or `unhealthy` (the ones that do have a failing probe). The
   * host logs it ("What to measure"); a throw goes to `onError`.
   */
  readonly onTraitHeld?: (taskId: string, trait: string, why: TraitHold["why"]) => void;
  /**
   * Creates a task record at `expect: 0` through the leader's app-role leg: what `pass` makes its
   * successor with, since the daemon leg may not create under `task:`. Absent, `pass` answers
   * `successor_unsupported`.
   */
  readonly create?: (task: Task) => Promise<TaskCreateResult>;
  /**
   * Reads the head of a task's PR with the host's own `gh` (`PrHeadReading`), for `pass`. Absent, a
   * task with a PR answers `pr_unreadable`.
   */
  readonly prHead?: (prUrl: string) => Promise<PrHeadReading>;
  /**
   * One line per audited or measured event (`audit pass`, `pass joined`, `successor settled`,
   * `successor placed`): never a branch name, a PR head or a record.
   */
  readonly log?: (line: string) => void;
}

/**
 * `cancel` and `markDone`: the task as written, or why not (`#byHand`).
 * `dispatching`: it is `reserved`, its spawn in flight. `despawn_failed`: its
 * machine refused to end the session. `conflict`: it moved under the write.
 * `unrecorded`: the session was ended, then the term was lost before the write.
 */
export type ByHandResult =
  | { readonly ok: true; readonly task: Task }
  | {
      readonly ok: false;
      readonly code: "not_found" | "dispatching" | "finished" | "despawn_failed" | "conflict" | "unrecorded";
    };

export type CancelResult = ByHandResult;
export type MarkDoneResult = ByHandResult;

/**
 * `runNow`: the task as reserved, or why not. `not_waiting`: it is not `ready`
 * (waiting on admission or deps, or already placed). `unplaceable`: something
 * besides the caps holds it. `conflict`: it moved under the write.
 */
export type RunNowResult =
  | { readonly ok: true; readonly task: Task }
  | {
      readonly ok: false;
      readonly code: "not_found" | "dispatching" | "finished" | "not_waiting" | "unplaceable" | "conflict";
    };

/**
 * `pass`: the old task and its successor, or why not. `ok` also answers a task that already carries
 * `successor` (a repeat pass, or a retry after a timeout), with that successor. `unrecorded`: the
 * term ended before the commit was written. The codes are `SCHEDULER_ERROR_CODES`' (`not_found` is
 * `task_not_found` on the wire).
 */
export type PassResult =
  | ({ readonly ok: true } & PassResponse)
  | {
      readonly ok: false;
      readonly code:
        | "not_found"
        | "finished"
        | "dispatching"
        | "not_running"
        | "needs_input"
        | "here"
        | "offline"
        | "successor_unsupported"
        | "account_unknown"
        | "pr_unreadable"
        | "pr_not_open"
        | "branch_mismatch"
        | "dirty_worktree"
        | "detached_head"
        | "default_branch"
        | "push_rejected"
        | "push_failed"
        | "not_launched"
        | "pass_failed"
        | "conflict"
        | "unrecorded";
    };

type PassFailure = Extract<PassResult, { readonly ok: false }>;

/**
 * What a session's own pass (`session-pass`) brings: the machine that sent it (the leader acts only for the
 * task's own), the branch its daemon pushed and the commit it holds (so the push is not asked again), and
 * what the session wrote for its successor, which is prompt text: never logged.
 */
export interface SessionPassInput {
  readonly from: string;
  readonly pushed: { readonly remoteBranch: string; readonly tip: string };
  readonly record?: string;
}

/** What a settle by hand knew before its write: the task as it was, whether its session was live, and whether one was despawned. */
interface ByHand {
  readonly task: Task;
  readonly live: boolean;
  readonly despawned: boolean;
}

/**
 * `discard`: `not_found` when no record by that id is held unreadable,
 * `conflict` when it is held at another version — the caller re-reads first.
 */
export type DiscardResult = { readonly ok: true } | { readonly ok: false; readonly code: "not_found" | "conflict" };

type CancelFailure = { readonly ok: false; readonly code: "despawn_failed" };

interface Held {
  readonly version: number;
  readonly task: Task;
}

/**
 * The loop's state and its transitions, driven by the host: `tick()` on every
 * registry or status push and on a timer (the leader's fires every 30s). It
 * owns no timer, socket or clock, so a host that stops calling it leaves
 * nothing running but the spawns already sent.
 *
 * Writes go through the store per transition, never per tick: an unplaceable
 * task's latest decision is kept here (`lastDecision`) and written only with the
 * reservation it eventually leads to.
 */
export class Scheduler {
  readonly #store: QueueStore;
  readonly #fleet: Fleet;
  readonly #config: SchedulerConfig;
  readonly #now: () => number;
  readonly #onError: (err: unknown) => void;
  readonly #onAlert: (alert: SchedulerAlert) => void;
  readonly #onIdleChange: (taskId: string) => void;
  readonly #onTraitHeld: (taskId: string, trait: string, why: TraitHold["why"]) => void;
  readonly #create: SchedulerOptions["create"];
  readonly #prHead: SchedulerOptions["prHead"];
  readonly #log: (line: string) => void;
  readonly #held = new Map<string, Held>();
  readonly #pause: PauseRecord;
  readonly #spills: SpillAlerts;
  /** Records the store holds that no reader can use: reported, never acted on, never deleted unasked. */
  readonly #unreadable = new Map<string, UnreadableTask>();
  readonly #decisions = new Map<string, Decision>();
  /** The traits `onTraitHeld` has told per task, forgotten with the task's decision. */
  readonly #traitHeld = new Map<string, Set<string>>();
  /**
   * deviceId → when a pass first saw it not connected (or gone from the
   * registry), for machines holding placed or `awaiting-merge` tasks: what
   * `lost` and slot release (`#released`) both age from. Memory only: a new
   * leader starts the count again, which can only delay either, never hasten
   * it — and it is this clock, not `Machine.lastSeen`, because a
   * timeout's offline mark can make a machine read disconnected beside a
   * `lastSeen` hours old.
   */
  readonly #absentSince = new Map<string, number>();
  /**
   * Task id → when its session went idle at its prompt, and on which machine:
   * what `#released` frees an idle task's slot by. Set only by an `idle` from
   * the machine the task runs on, cleared by any other state it reports, and
   * pruned once the task is not `running` there. Memory only: a new leader
   * counts an idle task until its next `idle`, which can only delay a release.
   */
  readonly #idleSince = new Map<string, { readonly since: number; readonly deviceId: string }>();
  /** The idle releases last told to the host (`onIdleChange`): what `#syncIdle` diffs against. */
  #idleTold: ReadonlySet<string> = new Set();
  /**
   * deviceId → when its `sessions` first failed, until one answers: how long
   * a connected machine has said nothing usable, for a reservation past its
   * TTL (`goneSince`). Memory only, as `#absentSince` is.
   */
  readonly #unansweredSince = new Map<string, number>();
  /**
   * Machines seen absent that are connected again, until the next `#due` reads
   * their tasks' `sessions`: what they sent while away (`branch-state`) went
   * to no one, and `progress` holds it.
   */
  #returned = new Set<string>();
  /**
   * Tasks whose session's PR-less `ended` came from a machine that reports exit
   * statuses (`onSession`): each pass checks their machine until its answer
   * settles them, since a check landing before the pane died still lists the
   * session. Memory only — a takeover checks every placed task anyway.
   */
  /** Task id → when its PR-less `ended` was deferred to its machine's next answer. */
  readonly #ending = new Map<string, number>();
  /**
   * Task id → its cancels still out (`cancel`): the session end a cancel's own
   * despawn causes is left to the cancel's write (`#yieldToCancel`). It catches
   * an end reaching the scheduler while the despawn is out, not one that ended
   * on its own and is still queued or in flight there (a `cancelled` write may
   * win over it). Memory only: a new leader mid-cancel may still settle it as
   * its session ended.
   */
  readonly #cancelling = new Map<string, number>();
  /**
   * Task id → its `cancel` and `markDone` calls still out, counted or not (`#cancelling` is the subset that
   * holds the despawn's own `ended`). A pass refuses `conflict` while one is out, before it pushes, before
   * it creates and inside the commit write, so a stop that began first wins over a pass that starts or
   * commits under its despawn, as one that begins after the commit does (`#counting`).
   */
  readonly #stopping = new Map<string, number>();
  /** Task id → its pass, still out (`pass`): a second pass of the task waits for it and answers its result. */
  readonly #passInFlight = new Map<string, Promise<PassResult>>();
  /**
   * Task id → when the leader closes its session itself, for a task carrying `successor` whose close has
   * not landed. Entered before the commit write (so no pass sees a task carrying `successor` that no
   * entry covers), kept while the task still carries it, and retried every pass once past `deadline`.
   * Memory only: reconcile (`#closePasses`) re-enters every such task after a takeover.
   */
  readonly #passing = new Map<string, { deadline: number }>();
  /** Tasks whose dependency chain was reported unreadable, so it is logged once per stall. */
  readonly #stalled = new Set<string>();
  /**
   * `#ending` notes made by a hold (`#yieldToCancel`), not by a session's own
   * deferred `ended`: only the latter means "ended first" to a cancel. Cleared
   * with the note (`#clearEnding`), so a retry after `despawn_failed` holds again.
   */
  readonly #heldNotes = new Set<string>();
  /**
   * Finished records whose leaning write (`#leanFinished`) did not land this
   * term: a refusal repeats, so retrying would take a slot of every pass and
   * log every time. Cleared on takeover.
   */
  readonly #leanFailed = new Set<string>();
  /** Task id → the tail of its writes (`#serial`). */
  readonly #chains = new Map<string, Promise<void>>();
  /** Task id → its spawn, still out. No pass awaits one; `drain` does. */
  readonly #dispatches = new Map<string, Promise<void>>();
  /** deviceId → its `sessions` check, still out (`#checkOut`): one per machine. No pass awaits one; `drain` does. */
  readonly #checks = new Map<string, Promise<void>>();
  /**
   * deviceId → whether it was connected when its `sessions` went unanswered:
   * not asked again until the next sweep, unless that changes. A hung peer
   * would otherwise cost a timed-out call every pass, and passes run on every
   * registry push. Memory only.
   */
  readonly #quiet = new Map<string, boolean>();
  /**
   * deviceId → when the last `sessions` that answered ok was asked (not
   * answered: a pane that died while the call was out may still be listed).
   * `#settleEndings` reads it: a deadline settles a session only once a read
   * begun after it still listed it. Memory only.
   */
  readonly #listedAt = new Map<string, number>();
  #sweptAt: number;
  #fault: { readonly err: unknown } | null = null;
  #ticking: Promise<void> | null = null;
  #again = false;

  constructor(options: SchedulerOptions) {
    this.#store = options.store;
    this.#fleet = options.fleet;
    this.#config = options.config ?? DEFAULT_CONFIG;
    this.#now = options.now;
    this.#onError =
      options.onError ??
      ((err) => {
        this.#fault ??= { err };
      });
    this.#onAlert = options.onAlert ?? (() => {});
    this.#onIdleChange = options.onIdleChange ?? (() => {});
    this.#onTraitHeld = options.onTraitHeld ?? (() => {});
    this.#create = options.create;
    this.#prHead = options.prHead;
    this.#log = options.log ?? (() => {});
    this.#pause = new PauseRecord(this.#store, this.#now, this.#onError);
    this.#spills = new SpillAlerts(this.#config.resetGraceMs);
    this.#sweptAt = this.#now();
  }

  /** The store's view replaces this one, unreconciled — a new leader calls `takeover` instead. */
  async load(): Promise<void> {
    const stored = await this.#store.list();
    this.#held.clear();
    this.#unreadable.clear();
    this.#decisions.clear();
    this.#traitHeld.clear();
    for (const entry of stored) this.#keep(entry);
    // Windows an earlier term alerted, so this one does not alert an ongoing spill once more.
    for (const { task } of this.#held.values())
      if (task.spillAlert !== undefined) this.#spills.seed(task.spillAlert, this.#now());
    await this.#pause.load();
  }

  /** The in-flight cap routing enforces. */
  globalMax(): number {
    return this.#config.globalMax;
  }

  /** The holds in force now: a reset hold past its `resumeAt` has lifted, written or not. */
  holds(): readonly PauseHold[] {
    return this.#pause.active();
  }

  /**
   * Holds dispatch on the whole queue (no `account`) or on one account's
   * candidates; running sessions are never touched. `until: "reset"` lifts at
   * the account's next reset (`accountResetAt`), resolved now and stored, so a
   * later leader lifts it at the same time.
   */
  async pause(request: PauseRequest): Promise<PauseResult> {
    const now = this.#now();
    const { account } = request;
    let hold: PauseHold;
    if (request.until === "resume") {
      hold = { ...(account === undefined ? {} : { account }), until: "resume", at: now };
    } else {
      const resumeAt =
        account === undefined
          ? null
          : accountResetAt(
              account,
              this.#fleet.machines(),
              this.tasks(),
              now,
              this.#config,
              this.#fleetQuota(),
              this.#released(now),
            );
      if (account === undefined || resumeAt === null) return { ok: false, code: "reset_unknown" };
      hold = { account, until: "reset", at: now, resumeAt };
    }
    return this.#pause.write((current) => withHold(current, hold, now));
  }

  /** Lifts the hold on `account`, or the whole-queue hold when absent; lifting none writes nothing. */
  async resume(request: ResumeRequest): Promise<PauseResult> {
    return this.#pause.write((current) => withoutHold(current, request.account, this.#now()));
  }

  /**
   * One record re-read, as `load` reads them all — what a host calls when the
   * store says a key changed under it (`store-changed`). Serialized with the
   * task's own writes, so it never lands between a write and its refresh.
   */
  async refresh(id: string): Promise<void> {
    await this.#serial(id, async () => {
      const entry = await this.#store.get(id);
      this.#held.delete(id);
      this.#unreadable.delete(id);
      if (entry === null) {
        this.#forgetDecision(id);
        return;
      }
      this.#keep(entry);
    });
  }

  /** What the store holds that this scheduler cannot read, and why — for the host to report. */
  unreadable(): readonly UnreadableTask[] {
    return [...this.#unreadable.values()];
  }

  /**
   * Deletes a record held as unreadable (`unreadable`), at the version it was
   * read at: junk a token holder planted, or a record sealed under an old PSK.
   * Nothing else ever deletes one, and each holds a slot of the store's cap.
   * A readable task is never `discard`ed, nor one that changed since the caller
   * saw it. A lost reply or a conflict is read back, as prune reads it: gone
   * is done, otherwise the record is held as it now reads. A refusal throws,
   * as the pause's does: no race to retry.
   */
  async discard(taskId: string, version: number): Promise<DiscardResult> {
    return this.#serial(taskId, async (): Promise<DiscardResult> => {
      const held = this.#unreadable.get(taskId);
      if (held === undefined) return { ok: false, code: "not_found" };
      if (held.version !== version) return { ok: false, code: "conflict" };
      const write = await this.#store.delete(taskId, version);
      if (write.ok) {
        this.#unreadable.delete(taskId);
        return { ok: true };
      }
      if (write.code !== "version_conflict" && write.code !== "indeterminate") {
        throw new Error(`store refused delete of task ${taskId}: ${write.code}`);
      }
      const fresh = await this.#store.get(taskId);
      this.#unreadable.delete(taskId);
      if (fresh === null) return { ok: true };
      this.#keep(fresh);
      return { ok: false, code: "conflict" };
    });
  }

  /**
   * Takeover (docs/scheduler.md): load the store, then check every task the
   * previous leader left reserved or placed against its machine's own
   * `sessions` — one call per machine — before the host's first `tick`
   * dispatches anything. Each is settled as a pass settles it (`settle`), except
   * that a reservation is checked at any age: a session or `ended` entry
   * carrying its id resolves it inside its TTL, and past the TTL an unanswered
   * check on a machine no longer connected makes it `lost`. A placed task whose
   * session is gone ended while no leader was listening: `awaiting-merge` if its
   * machine's `progress` (or its record) shows a PR, `done` if the branch merged
   * meanwhile or there was none. An `awaiting-merge` task is read back the same
   * way, for a merge the gap hid — what a pass checks, by the same rule
   * (`answerable`). An unanswered machine leaves everything else
   * as it was. Expiry, pruning and leaning finished records (`#leanFinished`)
   * run in the first pass after it, which the host ticks right away, so the
   * term answers after one list and one round of `sessions`.
   */
  async takeover(): Promise<void> {
    await this.load();
    this.#sweptAt = this.#now();
    this.#leanFailed.clear();
    this.#unansweredSince.clear();
    this.#quiet.clear();
    this.#listedAt.clear();
    await this.#check(this.tasks().filter(answerable));
  }

  /**
   * The store caps `task:` (`MAX_TASKS`), so past `keep` the oldest finished
   * tasks are deleted (`prunable`) — never one with anything left to happen,
   * nor one an unfinished task names. Runs at the end of a pass once the store
   * holds `pruneAt` records — an app's create meeting `store_full` is never
   * seen here. The deletes go out together: each is its own CAS on its own
   * task's chain, so crossing `pruneAt` costs one round trip, not one per record.
   */
  async prune(keep = this.#config.keepFinished): Promise<void> {
    await Promise.all(
      prunable(this.tasks(), keep).map((task) =>
        this.#serial(task.id, async () => {
          const held = this.#held.get(task.id);
          if (held === undefined || !FINISHED.includes(held.task.state) || unprunable(this.tasks()).has(task.id))
            return;
          const write = await this.#store.delete(task.id, held.version);
          if (write.ok) {
            this.#held.delete(task.id);
            this.#forgetDecision(task.id);
            return;
          }
          if (write.code !== "version_conflict" && write.code !== "indeterminate") {
            this.#refused(task.id, "delete", write);
            return;
          }
          // A lost reply may be our delete landing, a conflict another write: the store says which,
          // and a record held after it is gone would take a slot of every later prune.
          const fresh = await this.#store.get(task.id);
          this.#held.delete(task.id);
          if (fresh === null) {
            this.#forgetDecision(task.id);
            return;
          }
          this.#keep(fresh);
        }),
      ),
    );
  }

  tasks(): readonly Task[] {
    return [...this.#held.values()].map((h) => h.task);
  }

  task(id: string): Task | undefined {
    return this.#held.get(id)?.task;
  }

  /** The newest routing outcome for a task, placed or not. */
  lastDecision(id: string): Decision | undefined {
    return this.#decisions.get(id) ?? this.#held.get(id)?.task.decision;
  }

  /**
   * A dry run over the current fleet: what `tick` would decide for this spec now.
   * `attachments`: route-preview's flag, as though the spec carried a manifest.
   */
  preview(spec: TaskSpec, attachments = false): Decision {
    const now = this.#now();
    const task: Task = { id: "", spec, state: "ready", createdAt: now };
    return this.#route(task, now, false, attachments);
  }

  /** `task` routed over the current fleet and queue, as a pass would. */
  #route(task: Task, now: number, uncapped = false, attachments = false): Decision {
    return capped(
      route({
        task,
        machines: this.#fleet.machines(),
        tasks: this.tasks(),
        now,
        config: this.#config,
        holds: this.#pause.holds,
        fleetQuota: this.#fleetQuota(),
        // Per route, not per pass: each reservation's await can land a `busy` or a reconnect that counts a task again.
        released: this.#released(now),
        uncapped,
        attachments,
      }),
    );
  }

  /**
   * Tasks that hold no slot (`RouteInput.released`): placed on a machine
   * absent past `slotReleaseAfterMs` by `#absentSince` and still away — one
   * back since the last `#markAbsent` already counts again, so a `preview`
   * between the two says what the next pass will — or `running` where their
   * session has been idle past `idleReleaseAfterMs`.
   */
  #released(now: number): ReadonlySet<string> {
    const connected = this.#connectedIds();
    const asleep = (deviceId: string): boolean => {
      const since = this.#absentSince.get(deviceId);
      return since !== undefined && !connected.has(deviceId) && now - since >= this.#config.slotReleaseAfterMs;
    };
    const idle = new Set(this.#idleReleases(now).map((r) => r.taskId));
    return new Set(
      this.tasks()
        .filter((t) => {
          const at = t.assignment ?? t.reservation;
          return (at !== undefined && asleep(at.deviceId)) || idle.has(t.id);
        })
        .map((t) => t.id),
    );
  }

  /** Tasks holding no slot for sitting idle at their prompt past `idleReleaseAfterMs`, and since when: `queue` shows them. */
  idle(): readonly IdleTaskRef[] {
    return this.#idleReleases(this.#now());
  }

  #idleReleases(now: number): IdleTaskRef[] {
    return this.tasks().flatMap((task) => {
      const clock = this.#idleSince.get(task.id);
      if (clock === undefined || !idleHere(task, clock.deviceId)) return [];
      return now - clock.since >= this.#config.idleReleaseAfterMs ? [{ taskId: task.id, since: clock.since }] : [];
    });
  }

  /** Tells the host of each task whose idle release began or ended since it was last told. */
  #syncIdle(): void {
    const now = new Set(this.#idleReleases(this.#now()).map((r) => r.taskId));
    const told = this.#idleTold;
    this.#idleTold = now;
    for (const id of new Set([...now, ...told])) if (now.has(id) !== told.has(id)) this.#onIdleChange(id);
  }

  #fleetQuota(): readonly FleetQuotaEntry[] {
    return this.#fleet.fleetQuota?.() ?? [];
  }

  /** Coalesces: a tick asked for while one runs runs once more after it, never alongside. */
  tick(): Promise<void> {
    if (this.#ticking !== null) {
      this.#again = true;
      return this.#ticking;
    }
    this.#ticking = (async () => {
      try {
        do {
          this.#again = false;
          // oxlint-disable-next-line no-await-in-loop -- passes are sequential by design: that is the coalescing
          await this.#pass();
        } while (this.#again);
      } finally {
        this.#ticking = null;
      }
    })();
    return this.#ticking;
  }

  /**
   * Resolves once no tick runs and no spawn or check is out, rejecting with the
   * first fault no `onError` took. For tests, and a host that wants quiet.
   */
  async drain(): Promise<void> {
    for (;;) {
      const out = [
        ...this.#dispatches.values(),
        ...this.#checks.values(),
        ...(this.#ticking === null ? [] : [this.#ticking]),
      ];
      if (out.length === 0) break;
      // oxlint-disable-next-line no-await-in-loop -- a settled spawn's verdict can start no other, but a tick can
      await Promise.allSettled(out);
    }
    const fault = this.#fault;
    this.#fault = null;
    if (fault !== null) throw fault.err;
  }

  /**
   * A session's state, from a `session-event`. For a reserved task it is proof
   * the spawn landed — the reply may be lost — so it resolves the reservation:
   * the assignment is the reservation's target plus the reporting pane. `from`
   * is checked against where the task was placed, so a machine can move only
   * the tasks it was given; without `from` (a host that cannot say) a reserved
   * task is left to its verdict or its TTL. `prUrl` is the event's: a session
   * that ends with one is `awaiting-merge`, not `done`. One that ends with no
   * PR known, from a machine advertising `exitStatus`, waits for that
   * machine's answer (`sessionChange`, `#ending`): its exit says `failed` or
   * `done`. `done` is the session's own report (#21): it settles a
   * `until: "reported"` task from the machine it was placed on, and nothing else.
   * A `needs-input` whose source says `reason: "question"` is alerted in the
   * same write, without the debounce (`questionAlert`). The event's reason and
   * tool are written onto the record (display-only) by `sessionChange`.
   */
  async onSession(taskId: string, state: SessionState, from?: SessionSource, prUrl?: string): Promise<void> {
    const awaitsExit = from !== undefined && this.#reportsExit(from.deviceId);
    let defers = false;
    let asked = false;
    const written = await this.#update(taskId, (task) => {
      defers = waitsForExit(task, state, from, prUrl, awaitsExit);
      const moved = this.#yieldToCancel(task, sessionChange(task, state, from, prUrl, awaitsExit));
      if (state !== "needs-input" || from?.reason !== "question") return moved;
      const alerted = questionAlert(task, moved, from.deviceId, this.#now(), this.#config.needsInputEscalateMs);
      // Set on every run that gets here: a version conflict applies the change again to what the store holds.
      asked = alerted !== null;
      return alerted ?? moved;
    });
    // From the written record: `inputClock` stamped the stay's start as it landed.
    if (asked && written?.inputAlerted === true && written.needsInputSince !== undefined) {
      this.#alert({
        kind: "needs-input",
        taskId: written.id,
        since: written.needsInputSince,
        escalated: false,
        question: true,
        message: `needs input: task=${quote(written.id)} asking a question`,
      });
    }
    this.#idleClock(taskId, state, from);
    this.#syncIdle();
    if (!defers) return;
    const held = this.#held.get(taskId)?.task;
    if (held === undefined || !PLACED.includes(held.state)) return;
    if (!this.#ending.has(taskId)) this.#ending.set(taskId, this.#now());
    // Asked now, not at the next timed pass: the answer is what settles it, and frees its slot.
    this.tick().catch(this.#onError);
  }

  /**
   * An `idle` from the machine the task runs on starts its clock unless one
   * runs already, since a turn's end and a hooks-worker restart both say idle
   * again; any other state it reports stops it. Another machine's event
   * touches nothing, as `sessionChange` moves nothing for it — or any machine
   * could hold a slot by resetting the clock. A sender that does not say which
   * machine it is starts nothing, but its other states stop the clock, since
   * `sessionChange` accepts them for a confirmed task.
   */
  #idleClock(taskId: string, state: SessionState, from: SessionSource | undefined): void {
    const task = this.#held.get(taskId)?.task;
    if (task === undefined) return;
    if (from !== undefined && task.assignment?.deviceId !== from.deviceId) return;
    if (state !== "idle" || from === undefined || task.state !== "running") {
      this.#idleSince.delete(taskId);
      return;
    }
    if (!this.#idleSince.has(taskId)) this.#idleSince.set(taskId, { since: this.#now(), deviceId: from.deviceId });
  }

  #reportsExit(deviceId: string): boolean {
    const machine = this.#fleet.machines().find((m) => m.deviceId === deviceId);
    return machine?.capabilities?.includes(CAPABILITIES.exitStatus) === true;
  }

  /**
   * A task branch's state, from a `branch-state` sealed by `from`: its branch
   * and `pushed` recorded, a merge making it `done` (`branchChange`). Only the
   * machine the task was placed on moves it. A dependent it releases moves on
   * the next pass.
   */
  async onBranchState(state: BranchState, from: string): Promise<void> {
    await this.#update(state.taskId, (task) => branchChange(task, state, from));
  }

  /**
   * The leader's own forge reading of a task's PR (`prChange`): never a frame,
   * so it carries no `from`. Bound to `prUrl`, the URL it was read for: one of
   * the task's PRs (`taskPrs`). A dependent it releases moves on the next pass,
   * as with `onBranchState`.
   */
  async onPrStatus(taskId: string, prUrl: string, status: PrStatus): Promise<void> {
    let raised: PrAlertStamp | undefined;
    const next = await this.#update(taskId, (task) => {
      // The mutator may run again on a conflict: each run starts clean.
      raised = undefined;
      const read = prChange(task, prUrl, status) ?? task;
      // Also when the reading changed nothing: a continuation that ended without pushing alerts at the next poll.
      const alerted =
        read.prUrl === prUrl ? prBlockedAlert(read, continuationUnderway(read, this.tasks()), this.#now()) : null;
      if (alerted !== null) raised = alerted.prAlert;
      return alerted ?? (read === task ? null : read);
    });
    // Once the stamp has landed, as `#alertInput` does, so a new leader never repeats it.
    if (raised === undefined || next === null || !isDeepStrictEqual(next.prAlert, raised)) return;
    this.#alert({
      kind: "pr-blocked",
      taskId,
      reason: raised.reason,
      head: raised.head,
      message: `pr blocked: task=${quote(taskId)} reason=${raised.reason}`,
    });
  }

  /**
   * A reserved task is mid-dispatch: its spawn may already be running, so it is
   * refused until the verdict lands rather than raced. A `queued`, `blocked` or
   * `awaiting-merge` task has no session to stop, so it is cancelled as it
   * stands. A `lost` task whose
   * machine is back is despawned like a running one; with its machine still
   * gone nothing can be despawned, so it is cancelled as it stands and marked
   * `leftRunning` — the record says plainly that a session may outlive it.
   * While the despawn is out, the session's end it causes (`ended`, its machine's
   * answer, the `#ending` deadline) settles nothing (`#yieldToCancel`), so the
   * task reads `cancelled`, never `done` or `failed`: its dependents fail, and
   * it is continuable. Only an `ended` already deferred on a machine reporting
   * exit statuses (`#ending`, noted by `onSession`, not by a hold) when the
   * cancel began ended first, and is not held. One sent on its own but still
   * queued or in flight (or, there, a real crash in that window) is written
   * `cancelled`: the window is inherent. A merge, a PR open and the session's
   * own `done` report are facts or its statement, not held. A task that
   * finished anyway is answered as it finished. A despawn that ran and then lost the right to write `cancelled`
   * is `unrecorded`: the session is gone, the term ends, and asking again is
   * safe (the despawn finds no session).
   */
  async cancel(taskId: string): Promise<CancelResult> {
    const result = await this.#stopOut(taskId, () =>
      this.#counting(taskId, () =>
        this.#byHand(taskId, (current, { task, live }) => {
          if (FINISHED.includes(current.state)) return { ok: true, task: current };
          if (current.state === "reserved") return { ok: false, code: "dispatching" };
          const leftRunning = task.state === "lost" && task.assignment !== undefined && !live;
          // What was despawned, or found gone, must still be what is cancelled.
          if (leftRunning ? current.state !== "lost" : current.assignment?.deviceId !== task.assignment?.deviceId) {
            return null;
          }
          return advance(current, "cancelled", leftRunning ? { leftRunning: true } : {});
        }),
      ),
    );
    // A settle held for this cancel waits on the machine's answer: ask now, not at the next sweep.
    if (!result.ok && result.code === "despawn_failed" && this.#heldNotes.has(taskId)) {
      this.tick().catch(this.#onError);
    }
    return result;
  }

  /** `run` with a stop (`cancel`, `markDone`) registered for `taskId` (`#stopping`), whatever it returns or throws. */
  async #stopOut<T>(taskId: string, run: () => Promise<T>): Promise<T> {
    this.#stopping.set(taskId, (this.#stopping.get(taskId) ?? 0) + 1);
    try {
      return await run();
    } finally {
      const left = (this.#stopping.get(taskId) ?? 1) - 1;
      if (left > 0) this.#stopping.set(taskId, left);
      else this.#stopping.delete(taskId);
    }
  }

  /**
   * `run` with a cancel counted out for `taskId` (`#cancelling`), unless an `ended` was already deferred
   * on the machine before it began (that one ended first, and is not held): what `cancel` and the
   * `markDone` of a task carrying `successor` share, so the despawn's own `ended` settles neither as
   * `failed`, `done` by session or `superseded`.
   */
  async #counting<T>(taskId: string, run: () => Promise<T>): Promise<T> {
    const held = !this.#ending.has(taskId) || this.#heldNotes.has(taskId);
    if (held) this.#cancelling.set(taskId, (this.#cancelling.get(taskId) ?? 0) + 1);
    try {
      return await run();
    } finally {
      if (held) {
        const left = (this.#cancelling.get(taskId) ?? 1) - 1;
        if (left > 0) this.#cancelling.set(taskId, left);
        else this.#cancelling.delete(taskId);
      }
    }
  }

  /**
   * `next`, unless it settles a task whose cancel is out (`#cancelling`) as its
   * session ended — `failed`, or `done` by `session`: the cancel's own despawn
   * ends that session, and its write says `cancelled`. A merge and the
   * session's own `done` report are its statement, not the despawn's. A
   * `superseded` settle is held the same way: a task a person cancels or marks done after a pass's
   * commit ends as they said, and its successor fails `pass_abandoned`. The
   * state stands and only the facts `next` carried are written (null when
   * none is new). Noted in `#ending`, so a cancel that writes nothing
   * (`despawn_failed`) leaves the next pass to ask its machine again.
   */
  #yieldToCancel(current: Task, next: Task | null): Task | null {
    const id = current.id;
    if (next === null || current.state === "reserved" || !this.#cancelling.has(id)) return next;
    const heldEnd =
      next.state === "failed" ||
      next.state === "superseded" ||
      (next.state === "done" && next.doneBy !== "merged" && next.doneBy !== "reported");
    if (!heldEnd) return next;
    if (!this.#ending.has(id)) this.#ending.set(id, this.#now());
    // Even for a note an `ended` made during the cancel: it began held, so a retry holds too.
    this.#heldNotes.add(id);
    const { state: _state, doneBy: _doneBy, failure: _failure, ...facts } = next;
    const kept: Task = { ...current, ...facts };
    return isDeepStrictEqual(kept, current) ? null : kept;
  }

  #clearEnding(id: string): void {
    this.#ending.delete(id);
    this.#heldNotes.delete(id);
  }

  /**
   * What `cancel` and `markDone` share: refuse a `reserved` or finished task,
   * end the session of a live one (`running`, `needs-input`, or `lost` on a
   * machine that is connected), then write what `decide` makes of the task as
   * it is by then — a result instead answers without writing, and null is a
   * `conflict`. A despawn that ran and then lost the right to write is
   * `unrecorded`: the session is gone but the record still says otherwise, so
   * the term must end, yet the caller must not read that as "nothing happened".
   */
  async #byHand(
    taskId: string,
    decide: (current: Task, at: ByHand) => Task | ByHandResult | null,
  ): Promise<ByHandResult> {
    const task = this.task(taskId);
    if (task === undefined) return { ok: false, code: "not_found" };
    if (task.state === "reserved") return { ok: false, code: "dispatching" };
    if (FINISHED.includes(task.state)) return { ok: false, code: "finished" };
    const { assignment } = task;
    const live =
      task.state === "running" ||
      task.state === "needs-input" ||
      (task.state === "lost" && assignment !== undefined && this.#connected(assignment.deviceId));
    const ended = live ? await this.#endSession(task) : { ok: true as const, despawned: false };
    if (!ended.ok) return ended;
    const at: ByHand = { task, live, despawned: ended.despawned };
    let outcome: ByHandResult = { ok: false, code: "conflict" };
    const next = await this.#update(taskId, (current) => {
      const step = decide(current, at);
      if (step === null || !("ok" in step)) return step;
      outcome = step;
      return null;
    }).catch((err: unknown) => {
      if (!at.despawned || !(err instanceof StoreRevoked)) throw err;
      this.#onError(err);
      outcome = { ok: false, code: "unrecorded" };
      return null;
    });
    if (next === null) return outcome;
    this.#forgetDecision(taskId);
    return { ok: true, task: next };
  }

  /**
   * Ends the session of a placed task: whether it was despawned, or refused as
   * `despawn_failed`. No pane to name and none listed is nothing to end.
   */
  async #endSession(task: Task): Promise<{ readonly ok: true; readonly despawned: boolean } | CancelFailure> {
    const { assignment } = task;
    if (assignment === undefined || !PLACED.includes(task.state)) return { ok: true, despawned: false };
    // A `task_running` verdict may name no pane; the machine's sessions still carry the task id.
    let pane = assignment.pane;
    if (pane === undefined) {
      const listed = await this.#fleet.sessions(assignment.deviceId);
      if (!listed.ok) return { ok: false, code: "despawn_failed" };
      pane = listed.sessions.find((s) => s.taskId === task.id)?.id;
    }
    if (pane === undefined) return { ok: true, despawned: false };
    const reply = await this.#fleet.despawn(assignment.deviceId, { id: pane, client: SCHEDULER_CLIENT });
    if (!reply.ok && reply.code !== "session_not_found") return { ok: false, code: "despawn_failed" };
    return { ok: true, despawned: true };
  }

  /**
   * Settles an unfinished task `done` (`doneBy: "manual"`) as it stands: the
   * human says its work is over, so it wins over whatever else the task was
   * waiting for. A `running` or `needs-input` task, or a `lost` one whose
   * machine is connected, has its session ended first, as `cancel` does, since a
   * `done` task holds no slot and a session left running would keep working
   * beyond the caps. `lost`, `awaiting-merge` and the waiting states are settled
   * as they stand (their session is gone, or unreachable, or never was); a
   * `lost` one is marked `leftRunning`, as `cancel` marks it. A later event for a `done` task is ignored
   * (`sessionChange` and `branchChange` touch placed tasks only). `reserved` is
   * refused as `cancel` refuses it: its spawn is in flight. A despawn that ran
   * and then lost the right to write `done` is `unrecorded`, as for `cancel`.
   */
  async markDone(taskId: string): Promise<MarkDoneResult> {
    const decide = (current: Task, { task, live, despawned }: ByHand): Task | ByHandResult | null => {
      // The despawn's `ended` event may have settled it first: unlike for cancel, that is the answer.
      if (FINISHED.includes(current.state))
        return despawned ? { ok: true, task: current } : { ok: false, code: "finished" };
      if (current.state === "reserved") return { ok: false, code: "dispatching" };
      // No despawn ran, yet a session is live now: it would outlive a `done` write.
      if (!live && (current.state === "running" || current.state === "needs-input")) return null;
      // What was despawned must still be what is settled.
      if (live && current.assignment?.deviceId !== task.assignment?.deviceId) return null;
      const leftRunning = !live && current.state === "lost";
      return advance(current, "done", { doneBy: "manual", ...(leftRunning ? { leftRunning: true } : {}) });
    };
    // A passed task's despawn ends its session as a cancel's does, and would settle it `superseded` first; so
    // would one whose pass is in flight, which may commit while this despawn runs.
    const counted = this.task(taskId)?.successor !== undefined || this.#passInFlight.has(taskId);
    return this.#stopOut(taskId, () =>
      counted ? this.#counting(taskId, () => this.#byHand(taskId, decide)) : this.#byHand(taskId, decide),
    );
  }

  /**
   * Places a `ready` task now, past both concurrency caps (`RouteInput.uncapped`)
   * and nothing else: a pause, the quota line, disk, a pin and every other filter
   * still hold it, answered `unplaceable` with nothing written. Once placed it
   * counts toward the caps like any task, so the fleet may run over them until
   * the count drains — as when a machine wakes with released slots. One-shot:
   * nothing on the record says it was forced, so a takeover mid-way leaves it
   * `ready`, waiting as before.
   */
  async runNow(taskId: string): Promise<RunNowResult> {
    const task = this.task(taskId);
    if (task === undefined) return { ok: false, code: "not_found" };
    if (FINISHED.includes(task.state)) return { ok: false, code: "finished" };
    if (task.state === "reserved" || this.#dispatches.has(taskId)) return { ok: false, code: "dispatching" };
    if (task.state !== "ready") return { ok: false, code: "not_waiting" };
    const now = this.#now();
    const decision = this.#route(task, now, true);
    if (decision.chosen === null) return { ok: false, code: "unplaceable" };
    const reserved = await this.#reserve(taskId, decision.chosen, decision, now);
    if (reserved !== null) return { ok: true, task: reserved };
    // A pass may have placed it meanwhile, which is what was asked.
    const current = this.task(taskId);
    return current?.state === "reserved" ? { ok: true, task: current } : { ok: false, code: "conflict" };
  }

  /**
   * Passes a running task to a successor (DESIGN.md, "Passing to a successor"): its branch is pushed by
   * its machine, a queued successor is created and held until the old task is `superseded`, the pass is
   * committed on the old task (`successor`), its session is closed and it settles `superseded`. One pass
   * per task at a time: a second call waits for the first and answers its result, and a task that
   * already carries `successor` answers `ok` with it, so a client that timed out can ask again.
   * Refused, with nothing written beyond a pushed branch, before the successor exists; after the commit
   * a failed close still answers `ok` (the old task stays `running` with `successor` set, and `#closePasses`
   * retries it every pass). A `cancel` or `markDone` out for the task is `conflict` (`#stopping`).
   *
   * With `session` (the session's own pass, `session-pass`) the machine already pushed, so the push is skipped and
   * its branch is compared with the PR's head instead; a `needs-input` task is accepted, since the session
   * calling the tool is waiting on nobody; the record becomes the successor's prompt; and the close is the
   * daemon's, at the session's turn end, armed by `pass-close` once the commit is written. Only the
   * task's own machine may ask.
   */
  pass(taskId: string, trigger: SuccessorTrigger = "manual", session?: SessionPassInput): Promise<PassResult> {
    const joined = this.#passInFlight.get(taskId);
    if (joined !== undefined) {
      this.#log(`pass joined task=${quote(taskId)}`);
      return joined;
    }
    const run = this.#runPass(taskId, session === undefined ? trigger : "session", session).finally(() =>
      this.#passInFlight.delete(taskId),
    );
    this.#passInFlight.set(taskId, run);
    return run;
  }

  #passed(task: Task, successorId: string, created?: Task): PassResult {
    return { ok: true, task, successorId, successor: this.task(successorId) ?? created ?? null };
  }

  async #runPass(taskId: string, trigger: SuccessorTrigger, session?: SessionPassInput): Promise<PassResult> {
    const task = this.task(taskId);
    if (task === undefined) return { ok: false, code: "not_found" };
    if (task.successor !== undefined) return this.#passed(task, task.successor);
    if (FINISHED.includes(task.state)) return { ok: false, code: "finished" };
    if (task.state === "reserved") return { ok: false, code: "dispatching" };
    // The session's own pass is let through a `needs-input` task: its caller is waiting on nobody, and the
    // leader's view can lag the answer by an event, which would silently drop a pass already pushed.
    if (task.state === "needs-input" && session === undefined) return { ok: false, code: "needs_input" };
    const { assignment } = task;
    if ((task.state !== "running" && task.state !== "needs-input") || assignment === undefined) {
      return { ok: false, code: "not_running" };
    }
    if (task.spec.mode === "here") return { ok: false, code: "here" };
    if (session !== undefined && session.from !== assignment.deviceId) {
      // Nothing to answer: the frame is fire-and-forget, and another machine has no say over this task.
      this.#log(`pass refused op=session-pass task=${quote(taskId)} from=${quote(session.from)} outcome=not_holder`);
      return { ok: false, code: "conflict" };
    }
    // A cancel or mark-done already out wins: its despawn would otherwise end a session this pass then supersedes.
    if (this.#stopping.has(taskId)) return { ok: false, code: "conflict" };
    const fleet = this.#fleet;
    const create = this.#create;
    // Before any push: an older host answers an unknown op `invalid_request`, which would read as a failure to push.
    if (create === undefined || (session === undefined ? fleet.pushBranch : fleet.passClose) === undefined) {
      return { ok: false, code: "successor_unsupported" };
    }
    const machine = fleet.machines().find((m) => m.deviceId === assignment.deviceId);
    if (machine === undefined || !machine.connected) return { ok: false, code: "offline" };
    const needed = session === undefined ? CAPABILITIES.successor : CAPABILITIES.successorSelf;
    if (machine.capabilities?.includes(needed) !== true) return { ok: false, code: "successor_unsupported" };
    const account = machine.exclaves?.find((x) => x.id === assignment.exclave)?.accountId;
    if (account === undefined || account === null) return { ok: false, code: "account_unknown" };

    let expect: string | undefined;
    if (task.prUrl !== undefined) {
      const prHead = this.#prHead;
      if (prHead === undefined) return { ok: false, code: "pr_unreadable" };
      const reading = await prHead(task.prUrl);
      if (reading.kind === "unreadable") return { ok: false, code: "pr_unreadable" };
      if (reading.kind === "read") {
        if (reading.crossRepository) return { ok: false, code: "branch_mismatch" };
        if (reading.state === "merged" || reading.state === "closed") return { ok: false, code: "pr_not_open" };
        // The session's push has happened: all that is left to say is that it went to another branch than the PR's.
        if (session !== undefined && reading.head !== session.pushed.remoteBranch) {
          return { ok: false, code: "branch_mismatch" };
        }
        expect = reading.head;
      }
    }

    let pushed: { readonly remoteBranch: string; readonly tip: string };
    if (session !== undefined) {
      pushed = session.pushed;
    } else {
      const pushBranch = fleet.pushBranch;
      if (pushBranch === undefined) return { ok: false, code: "successor_unsupported" };
      const reply = await pushBranch.call(fleet, assignment.deviceId, {
        taskId,
        ...(expect === undefined ? {} : { expect }),
      });
      if (!reply.ok) return passPushFailure(reply.code);
      pushed = reply;
    }

    // The pushes and reads above took time: the task must still be the one that was checked.
    const current = this.task(taskId);
    const at = current?.assignment;
    if (
      current === undefined ||
      (current.state !== "running" && !(session !== undefined && current.state === "needs-input")) ||
      current.successor !== undefined ||
      at === undefined ||
      at.deviceId !== assignment.deviceId ||
      this.#stopping.has(taskId)
    ) {
      return { ok: false, code: "conflict" };
    }
    const built = successorPrompt({
      task: current,
      remoteBranch: pushed.remoteBranch,
      tip: pushed.tip,
      ...(session?.record === undefined ? {} : { record: session.record }),
    });
    if (built.recordCut) this.#log(`pass record cut task=${quote(taskId)}`);
    const spec: TaskSpec = {
      ...successorSpec({ ...current, assignment: at }, account, trigger, built.prompt),
      client: SCHEDULER_CLIENT,
    };
    const successor: Task = {
      ...queuedTask(spec, this.#now()),
      ...(current.prUrl === undefined ? {} : { prUrl: current.prUrl }),
      ...(current.prs === undefined ? {} : { prs: current.prs }),
    };
    const made = await create(successor);
    if (!made.ok) return { ok: false, code: "pass_failed" };
    // Held now, not at the store's nudge: admission keeps it `blocked` from this pass on. A failed read is not a
    // failed pass: it exists, the commit below names it, and a retry would only leave this one an orphan.
    await this.refresh(successor.id).catch(this.#onError);

    // Entered before the commit: no pass may see a task carrying `successor` that no entry covers.
    this.#passing.set(taskId, { deadline: this.#now() + PASS_CLOSE_GRACE_MS });
    let committed: Task | null = null;
    try {
      committed = await this.#update(taskId, (c) =>
        (c.state === "running" || (session !== undefined && c.state === "needs-input")) &&
        c.successor === undefined &&
        c.assignment?.deviceId === assignment.deviceId &&
        !this.#stopping.has(taskId)
          ? { ...c, successor: successor.id }
          : null,
      );
    } catch (err) {
      this.#passing.delete(taskId);
      if (!(err instanceof StoreRevoked)) throw err;
      // The successor exists but its predecessor never named it: admission fails it `pass_abandoned` once this one ends.
      this.#onError(err);
      return { ok: false, code: "unrecorded" };
    }
    if (committed === null) {
      this.#passing.delete(taskId);
      return { ok: false, code: "conflict" };
    }
    this.#log(`audit pass task=${quote(taskId)} successor=${quote(successor.id)} trigger=${trigger}`);

    if (session !== undefined) {
      // The daemon closes at the turn's end, the gentler close; the deadline (`#closePasses`) backs anything
      // that does not answer, and a session already gone settles through its `ended`.
      await this.#armClose(assignment.deviceId, taskId);
      return this.#passed(this.task(taskId) ?? committed, successor.id, successor);
    }
    const closed = await this.#endSession(committed);
    if (!closed.ok) {
      const entry = this.#passing.get(taskId);
      if (entry !== undefined) entry.deadline = this.#now();
      return this.#passed(this.task(taskId) ?? committed, successor.id, successor);
    }
    await this.#settlePassed(taskId);
    return this.#passed(this.task(taskId) ?? committed, successor.id, successor);
  }

  /** `pass-close`: the daemon holding a session-passed task may close it at its turn's end. Best effort; the deadline backs it. */
  async #armClose(deviceId: string, taskId: string): Promise<void> {
    const passClose = this.#fleet.passClose;
    if (passClose === undefined) return;
    try {
      const reply = await passClose.call(this.#fleet, deviceId, { taskId });
      this.#log(`audit pass-close task=${quote(taskId)} outcome=${reply.ok ? "armed" : reply.code}`);
      // No live pane carries the task: its session is already gone, so no turn's end is coming for the daemon to
      // close at, and waiting out the grace only holds the successor blocked. The next tick's `#closePass` settles it.
      if (!reply.ok && reply.code === "no_pane") {
        const entry = this.#passing.get(taskId);
        if (entry !== undefined) entry.deadline = this.#now();
      }
    } catch (err) {
      this.#onError(err);
    }
  }

  /**
   * A passed task's session is closed: it settles `superseded`, unless a cancel or a mark-done is out for it
   * (`#yieldToCancel`) or already settled it, or the despawn's own `ended` got there first. A term that ends
   * before the write leaves it to reconcile (`#closePasses`) in the next one, which closes again harmlessly.
   */
  async #settlePassed(taskId: string): Promise<void> {
    try {
      await this.#update(taskId, (c) => (passCarried(c) ? this.#yieldToCancel(c, advance(c, "superseded")) : null));
    } catch (err) {
      if (!(err instanceof StoreRevoked)) throw err;
      this.#onError(err);
      return;
    }
    const after = this.task(taskId);
    if (after === undefined || !passCarried(after)) this.#passing.delete(taskId);
  }

  /**
   * Passes whose close has not landed: a task carrying `successor` that is still `running`, `needs-input`
   * or `lost` has its session closed through `#endSession` once its entry's deadline passes, every pass
   * until it settles. Every such task not in `#passing` or `#passInFlight` gets an entry with no wait
   * first (reconcile: a takeover between the commit and the close, or a close that never landed). An entry
   * is dropped once its task no longer carries `successor` in one of those states; a `lost` task on a
   * machine that is not connected waits for it or for its expiry (`expiry`: `superseded` with `leftRunning`).
   */
  async #closePasses(): Promise<void> {
    const now = this.#now();
    const rearmed: Task[] = [];
    for (const task of this.tasks()) {
      if (!passCarried(task) || this.#passing.has(task.id) || this.#passInFlight.has(task.id)) continue;
      // A session's own pass is closed by its daemon at the turn's end, so reconcile asks again (idempotent)
      // and waits a fresh grace; anything else is closed at once, as an outside pass is.
      if (this.#asksItsDaemon(task)) {
        this.#passing.set(task.id, { deadline: now + PASS_CLOSE_GRACE_MS });
        rearmed.push(task);
      } else {
        this.#passing.set(task.id, { deadline: now });
      }
    }
    // Not awaited: the entry's deadline is already set, so nothing here depends on the answer, and a daemon that is
    // connected but slow must not hold the tick's admission and dispatch for its 10 s (`#armClose` never rejects).
    for (const t of rearmed) void this.#armClose(t.assignment?.deviceId ?? "", t.id);
    const due: string[] = [];
    for (const [id, entry] of this.#passing) {
      const task = this.task(id);
      if (task === undefined || !passCarried(task)) this.#passing.delete(id);
      else if (entry.deadline <= now && !this.#passInFlight.has(id)) due.push(id);
    }
    await Promise.all(due.map((id) => this.#closePass(id)));
  }

  /** Whether a passed task's close is its daemon's to make: a session-triggered (or unreadable) successor, its machine 2b and connected. */
  #asksItsDaemon(task: Task): boolean {
    const deviceId = task.assignment?.deviceId;
    if (deviceId === undefined || task.successor === undefined || this.#fleet.passClose === undefined) return false;
    const trigger = this.task(task.successor)?.spec.succeeds?.trigger;
    if (trigger !== undefined && trigger !== "session") return false;
    return this.#fleet
      .machines()
      .some(
        (m) => m.deviceId === deviceId && m.connected && m.capabilities?.includes(CAPABILITIES.successorSelf) === true,
      );
  }

  async #closePass(id: string): Promise<void> {
    const task = this.task(id);
    if (task === undefined || !passCarried(task)) return;
    const deviceId = task.assignment?.deviceId;
    if (task.state === "lost" && (deviceId === undefined || !this.#connected(deviceId))) return;
    const closed = await this.#endSession(task);
    // Kept, so the next pass tries again.
    if (!closed.ok) return;
    await this.#settlePassed(id);
  }

  #connected(deviceId: string): boolean {
    return this.#fleet.machines().some((m) => m.deviceId === deviceId && m.connected);
  }

  /**
   * `lost` and `awaiting-merge` are never pruned, hold no slot and outlive
   * every term: past their bound they fail (`expiry`). Before admission, so
   * dependents fail in the same pass. A task whose machine's check is out is
   * left to it, so a machine back in time settles its task first; so is a
   * `lost` task whose machine is connected now, for the next check. Judged
   * again inside the write, since either may change between the two. A `ready`
   * continuation or pinned task also fails past its bound, worded from the held decision.
   */
  async #expire(): Promise<void> {
    const now = this.#now();
    const spared = (t: Task): boolean => {
      const deviceId = deviceOf(t);
      if (deviceId === undefined) return false;
      return this.#checks.has(deviceId) || (t.state === "lost" && this.#connected(deviceId));
    };
    await Promise.all(
      this.tasks()
        .filter((t) => expiry(t, now, this.#config, this.lastDecision(t.id)) !== null && !spared(t))
        .map((seen) =>
          this.#update(seen.id, (current) =>
            spared(current) ? null : expiry(current, now, this.#config, this.lastDecision(current.id)),
          ),
        ),
    );
  }

  async #pass(): Promise<void> {
    for (const [id, { deviceId }] of this.#idleSince) {
      const task = this.#held.get(id)?.task;
      if (task === undefined || !idleHere(task, deviceId)) this.#idleSince.delete(id);
    }
    this.#syncIdle();
    await this.#settleEndings();
    await this.#markAbsent();
    this.#checkOut(this.#due());
    await this.#expire();
    await this.#markContinued();
    await this.#alertInput();
    await this.#escalate();
    await this.#closePasses();
    // A check ticks again once its answer is settled, so a predecessor it settled releases or fails its dependents then.
    await this.#admit();
    // Again: a task admission just released may already be past its bound, and must not launch.
    await this.#expire();
    const ready = dispatchOrder(this.tasks().filter((t) => t.state === "ready" && !this.#dispatches.has(t.id)));
    // Reserve one at a time, so each sees the reservations before it in projected
    // usage and the caps. The spawns are not awaited: one slow machine
    // must not hold every other placement, TTL and absence check behind its 90s
    // timeout.
    for (const seen of ready) {
      // A `runNow` may have placed it while an earlier reservation was awaited: its decision must not
      // be overwritten with this snapshot's, which nothing would clear while it runs.
      const task = this.task(seen.id);
      if (task?.state !== "ready" || this.#dispatches.has(task.id)) continue;
      const now = this.#now();
      const decision = this.#route(task, now);
      this.#decisions.set(task.id, decision);
      this.#tellTraitHeld(task, decision);
      if (decision.chosen === null) continue;
      // oxlint-disable-next-line no-await-in-loop -- each route must see the reservation before it
      await this.#reserve(task.id, decision.chosen, decision, now);
    }
    // Lazily: a finished task an app is about to name in `deps` must outlive the refresh that tells us of it.
    await this.#pruneDue();
    await this.#leanFinished();
  }

  /**
   * Finished records written before a finished task was kept lean (`lean`), or
   * by an older leader, still hold a prompt or a full decision: rewrite them
   * lean, oldest first and at most `LEAN_PER_PASS` per pass, each its own
   * fenced CAS'd put. `#update` leans at the boundary, so handing back
   * `current` is enough. A write that did not land is reported by `#update`,
   * and the record stays as it was and is skipped until the next term
   * (`#leanFailed`). `StoreRevoked` propagates: the term is over. Not in
   * `takeover`: a throw there fails the takeover and blocks the term.
   */
  async #leanFinished(): Promise<void> {
    const stale = this.tasks()
      .filter((t) => lean(t) !== t && !this.#leanFailed.has(t.id))
      .toSorted((a, b) => a.createdAt - b.createdAt || codeUnitOrder(a.id, b.id))
      .slice(0, LEAN_PER_PASS);
    for (const task of stale) {
      // oxlint-disable-next-line no-await-in-loop -- one CAS'd write at a time
      const written = await this.#update(task.id, (current) => (lean(current) === current ? null : current));
      if (written === null) this.#leanFailed.add(task.id);
    }
  }

  /** An alert is a side channel: a host that throws must not strand a reservation or end a pass. */
  #alert(alert: SchedulerAlert): void {
    try {
      this.#onAlert(alert);
    } catch (err) {
      this.#onError(err);
    }
  }

  /** A decision and what was told of its task's held traits go together: a re-decided task tells again. */
  #forgetDecision(id: string): void {
    this.#decisions.delete(id);
    this.#traitHeld.delete(id);
  }

  /** Once per task and trait: the first pass whose decision shows the trait holding it (`traitsHolding`). */
  #tellTraitHeld(task: Task, decision: Decision): void {
    const requires = task.spec.requires ?? [];
    if (requires.length === 0) return;
    for (const { trait, why } of traitsHolding(decision, requires)) {
      const told = this.#traitHeld.get(task.id) ?? new Set<string>();
      if (told.has(trait)) continue;
      this.#traitHeld.set(task.id, told.add(trait));
      try {
        this.#onTraitHeld(task.id, trait, why);
      } catch (err) {
        this.#onError(err);
      }
    }
  }

  /**
   * An `awaiting-merge` task's `continuedBy` follows its chain (`continuedChange`): written here, before
   * `#alertInput`, so a continuation that just landed has cleared its stamp by the next poll's reading.
   */
  async #markContinued(): Promise<void> {
    const all = this.tasks();
    await Promise.all(
      all
        .filter((t) => continuedChange(t, all) !== null)
        .map((seen) => this.#update(seen.id, (current) => continuedChange(current, this.tasks()))),
    );
  }

  /**
   * A task waiting for input past `needsInputAlertMs` is marked `inputAlerted` —
   * one write per stay — and alerted once that write lands, so a new leader
   * reading the record never alerts it again. Before `#escalate`: a stay past
   * both is one alert, the escalation's.
   */
  async #alertInput(): Promise<void> {
    const now = this.#now();
    const { needsInputAlertMs: after, needsInputEscalateMs: escalateAfter } = this.#config;
    await Promise.all(
      this.tasks()
        .filter((t) => inputAlert(t, now, after, escalateAfter) !== null)
        .map(async (seen) => {
          const next = await this.#update(seen.id, (current) => inputAlert(current, now, after, escalateAfter));
          if (next?.inputAlerted !== true || next.needsInputSince === undefined) return;
          const minutes = Math.round((now - next.needsInputSince) / 60_000);
          this.#alert({
            kind: "needs-input",
            taskId: next.id,
            since: next.needsInputSince,
            escalated: false,
            message: `needs input: task=${quote(next.id)} waiting ${minutes} min`,
          });
        }),
    );
  }

  /**
   * A task waiting for input past `needsInputEscalateMs` is marked `escalated`
   * — one write per stay — and alerted once that write lands, so a new leader
   * reading the record never alerts it again.
   */
  async #escalate(): Promise<void> {
    const now = this.#now();
    const after = this.#config.needsInputEscalateMs;
    await Promise.all(
      this.tasks()
        .filter((t) => escalation(t, now, after) !== null)
        .map(async (seen) => {
          const next = await this.#update(seen.id, (current) => escalation(current, now, after));
          if (next?.escalated !== true || next.needsInputSince === undefined) return;
          const minutes = Math.round((now - next.needsInputSince) / 60_000);
          this.#alert({
            kind: "needs-input",
            taskId: next.id,
            since: next.needsInputSince,
            escalated: true,
            message: `needs input: task=${quote(next.id)} waiting ${minutes} min — escalated, its slot kept`,
          });
        }),
    );
  }

  /**
   * Gated, not unconditional: a create naming a finished task may be in flight
   * at any pass, and pruning only past `pruneAt` narrows that race (it does not
   * close it).
   */
  async #pruneDue(): Promise<void> {
    if (this.#held.size + this.#unreadable.size >= this.#config.pruneAt) await this.prune();
  }

  /**
   * Reserves a `ready` task where `decision` chose and sends its spawn: the
   * task as reserved, or null when it moved since it was routed (a cancel, or
   * another reservation) and keeps what it moved to.
   */
  async #reserve(
    id: string,
    chosen: NonNullable<Decision["chosen"]>,
    decision: Decision,
    now: number,
  ): Promise<Task | null> {
    const reservation: Reservation = { ...chosen, expiresAt: now + this.#config.reservationTtlMs };
    const reserved = await this.#update(id, (current) =>
      current.state === "ready" ? advance(current, "reserved", { reservation, decision, reservedAt: now }) : null,
    );
    if (reserved === null) return null;
    this.#forgetDecision(id);
    this.#launch(reserved, reservation, decision);
    return reserved;
  }

  /**
   * Admission (`admission`): each `queued` or `blocked` task to where its edges
   * put it. Computed over one snapshot, so a cascade lands whole; each write
   * re-checks that its task is still waiting where it was.
   */
  async #admit(): Promise<void> {
    const stalled = new Set<string>();
    const moves = admission(this.tasks(), new Set(this.#unreadable.keys()), this.#now(), (id) => {
      stalled.add(id);
      if (this.#stalled.has(id)) return;
      this.#stalled.add(id);
      this.#log(`dependency chain unreadable task=${quote(id)}`);
    });
    // Only a chain still unreadable stays noted: a pruned task leaves it, and a later stall is logged again.
    for (const id of this.#stalled) if (!stalled.has(id)) this.#stalled.delete(id);
    await Promise.all(
      [...moves].map(([id, move]) =>
        this.#update(id, (current) => {
          if ((current.state !== "queued" && current.state !== "blocked") || current.state === move.state) return null;
          if (move.state === "failed") return advance(current, move.state, { failure: move.failure });
          // A successor whose predecessor merged while it waited: its work is done, and nothing was placed.
          if (move.state === "done") return advance(current, move.state, { doneBy: move.doneBy });
          return advance(current, move.state);
        }),
      ),
    );
  }

  #launch(task: Task, at: Reservation, decision: Decision): void {
    const run = this.#dispatch(task, at, decision)
      .catch(this.#onError)
      .finally(() => this.#dispatches.delete(task.id));
    this.#dispatches.set(task.id, run);
  }

  async #dispatch(task: Task, at: Reservation, decision: Decision): Promise<void> {
    const { spec } = task;
    const reply = await this.#fleet.spawn(at.deviceId, {
      repo: at.clone,
      mode: spec.mode,
      ...(spec.prompt === undefined ? {} : { prompt: spec.prompt }),
      ...(spec.title === undefined ? {} : { title: spec.title }),
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.effort === undefined ? {} : { effort: spec.effort }),
      ...(spec.plan === undefined ? {} : { plan: spec.plan }),
      ...(spec.autonomy === undefined ? {} : { autonomy: spec.autonomy }),
      ...(spec.continues === undefined ? {} : { continues: spec.continues.task }),
      ...(spec.attachments === undefined ? {} : { attachments: spec.attachments }),
      client: SCHEDULER_CLIENT,
      taskId: task.id,
    });
    // Only a confirmed spawn spent anything: a refused one must not alert or burn the window's one alert.
    // Before the awaits: `on` remembers the window at once, so two dispatches of one pass cannot both alert.
    const spill = reply.ok
      ? this.#spills.on(task.id, decision, this.#fleet.machines(), this.#now(), this.#fleetQuota())
      : null;
    // An event may have resolved it while the spawn was out; a verdict answers only its own reservation.
    await this.#update(task.id, (current) => (holds(current, at) ? verdict(current, at, reply) : null));
    if (spill === null) return;
    // Its own write, not part of the verdict: that one declines when a session event moved the task
    // first, which is the usual order (the reply waits for the pane's title, a hook need not).
    // A stamp lost to a refused write costs at most one repeat under a later leader.
    await this.#update(task.id, (current) => stamped(current, at, spill.stamp));
    this.#alert(spill.alert);
  }

  /**
   * A placed task on a machine that stops answering is never routed again: its
   * session may be alive on a machine that only sleeps, and a second dispatch
   * would be its twin. Absent past `lostAfterMs` it is `lost`, so the record
   * says so instead of reading `running` forever; once its machine is
   * connected again, that machine's `sessions` settles it (`#due`).
   */
  async #markAbsent(): Promise<void> {
    const now = this.#now();
    const connected = this.#connectedIds();
    const placed = this.tasks().filter((t) => PLACED.includes(t.state) && t.assignment !== undefined);
    const devices = new Set(
      this.tasks()
        .filter((t) => PLACED.includes(t.state) || t.state === "awaiting-merge")
        .flatMap((t) => t.assignment?.deviceId ?? []),
    );
    for (const deviceId of [...this.#absentSince.keys()]) {
      if (devices.has(deviceId) && connected.has(deviceId)) this.#returned.add(deviceId);
      if (!devices.has(deviceId) || connected.has(deviceId)) this.#absentSince.delete(deviceId);
    }
    for (const deviceId of devices) {
      if (!connected.has(deviceId) && !this.#absentSince.has(deviceId)) this.#absentSince.set(deviceId, now);
    }
    await Promise.all(
      placed.map(async (task) => {
        const deviceId = task.assignment?.deviceId ?? "";
        const since = this.#absentSince.get(deviceId);
        if (task.state === "lost" || since === undefined || now - since < this.#config.lostAfterMs) return;
        // Its session ended, and only its exit was awaited: `lost` would fail dependents at `lost_expired` for a session that is over.
        const settling = this.#ending.has(task.id);
        // Before the write, so a settle held for a cancel (`#yieldToCancel`) notes it again.
        if (settling) this.#clearEnding(task.id);
        await this.#update(task.id, (current) => {
          if (current.state === "lost" || !PLACED.includes(current.state)) return null;
          if (current.assignment?.deviceId !== deviceId) return null;
          if (!settling) return advance(current, "lost", { absentSince: since });
          return this.#yieldToCancel(current, settledEnd(current, undefined));
        });
      }),
    );
  }

  /**
   * A task whose `ended` waited on its exit past `endingTimeoutMs` settles as
   * the event would have without one (`ended`): a claude still alive after its
   * SessionEnd hook is no failure to read, and must not hold its slot for good.
   */
  async #settleEndings(): Promise<void> {
    const now = this.#now();
    const due = [...this.#ending].filter(
      ([id, at]) => now - at >= this.#config.endingTimeoutMs && !this.#awaited(id, at),
    );
    await Promise.all(
      due.map(async ([id]) => {
        this.#clearEnding(id);
        await this.#update(id, (current) =>
          PLACED.includes(current.state) ? this.#yieldToCancel(current, settledEnd(current, undefined)) : null,
        );
      }),
    );
  }

  /**
   * Whether a deadline-past `#ending` task still waits for its machine: a
   * check out may carry the exit (a late answer would be dropped once the
   * task settled), and so may the next one, until a read begun after the
   * deadline has listed the session. A disconnected machine answers nothing
   * (`#due` skips it), so the deadline alone settles its task.
   */
  #awaited(id: string, deferredAt: number): boolean {
    const task = this.#held.get(id)?.task;
    const deviceId = task === undefined ? undefined : deviceOf(task);
    if (deviceId === undefined || !this.#connected(deviceId)) return false;
    if (this.#checks.has(deviceId)) return true;
    return (this.#listedAt.get(deviceId) ?? -Infinity) < deferredAt + this.#config.endingTimeoutMs;
  }

  /**
   * What this pass checks against `sessions`: a reservation past its TTL whose
   * spawn is no longer out (one still out may yet land, and its verdict is
   * the better answer); a `lost` task whose machine is back; every placed or
   * `awaiting-merge` task on a machine back from an absence, whose
   * `branch-state`s went nowhere meanwhile; and, once per `sweepIntervalMs`,
   * every running or `awaiting-merge` task on a connected machine — the only
   * way a task whose `ended` or `merged` event was lost ever finishes; and
   * every pass, a task whose `ended` waits on its exit (`#ending`). None on
   * a machine whose check is still out, or that went unanswered since the last
   * sweep (`#quiet`); a machine skipped keeps its return for the pass that asks it.
   */
  #due(): readonly Task[] {
    const now = this.#now();
    const connected = this.#connectedIds();
    const sweep = now - this.#sweptAt >= this.#config.sweepIntervalMs;
    if (sweep) {
      this.#sweptAt = now;
      this.#quiet.clear();
    }
    // Dropped the moment it differs, so a machine that leaves and comes back between two checks is asked.
    for (const [deviceId, was] of this.#quiet) if (was !== connected.has(deviceId)) this.#quiet.delete(deviceId);
    const skipped = (deviceId: string): boolean => this.#checks.has(deviceId) || this.#quiet.has(deviceId);
    const returned = this.#returned;
    this.#returned = new Set([...returned].filter(skipped));
    for (const id of this.#ending.keys()) {
      const task = this.#held.get(id)?.task;
      if (task === undefined || !PLACED.includes(task.state)) this.#clearEnding(id);
    }
    return this.tasks().filter((t) => {
      const deviceId = deviceOf(t);
      if (!answerable(t) || deviceId === undefined || skipped(deviceId)) return false;
      if (t.state === "reserved") {
        return t.reservation !== undefined && t.reservation.expiresAt <= now && !this.#dispatches.has(t.id);
      }
      if (!connected.has(deviceId)) return false;
      return t.state === "lost" || sweep || returned.has(deviceId) || this.#ending.has(t.id);
    });
  }

  /** Every machine's check at once, awaited: takeover's, before the term's first pass. */
  async #check(tasks: readonly Task[]): Promise<void> {
    await Promise.all([...byDevice(tasks)].map(([deviceId, mine]) => this.#checkDevice(deviceId, mine)));
  }

  /**
   * A pass's checks, not awaited: one slow `sessions` must not hold every
   * admission and dispatch behind it. Each ticks again once its answer is
   * settled, while still counted out, so that tick asks the machine nothing.
   */
  #checkOut(tasks: readonly Task[]): void {
    for (const [deviceId, mine] of byDevice(tasks)) {
      const run = this.#checkDevice(deviceId, mine)
        .then(() => this.tick())
        .catch(this.#onError)
        .finally(() => this.#checks.delete(deviceId));
      this.#checks.set(deviceId, run);
    }
  }

  /**
   * One `sessions` to a machine, then each of its tasks settled from the answer
   * (`settle`) — unless it moved while the call was out, since an answer read
   * before an event landed could undo it.
   */
  async #checkDevice(deviceId: string, tasks: readonly Task[]): Promise<void> {
    const asked = this.#now();
    const reply = await this.#fleet.sessions(deviceId);
    if (reply.ok) this.#listedAt.set(deviceId, asked);
    this.#heard(deviceId, reply);
    await Promise.all(
      tasks.map((seen) =>
        this.#update(seen.id, (current) =>
          asSeen(current, seen)
            ? this.#yieldToCancel(
                current,
                settle(current, reply, {
                  now: this.#now(),
                  connected: this.#connected(deviceId),
                  unansweredSince: this.#unansweredSince.get(deviceId),
                  reservationTtlMs: this.#config.reservationTtlMs,
                  lostAfterMs: this.#config.lostAfterMs,
                }),
              )
            : null,
        ),
      ),
    );
  }

  /** What a `sessions` answer says of its machine: since when it has failed (`#unansweredSince`), and whether to stop asking (`#quiet`). */
  #heard(deviceId: string, reply: TaskSessionsReply): void {
    if (reply.ok) {
      this.#unansweredSince.delete(deviceId);
      this.#quiet.delete(deviceId);
      return;
    }
    if (!this.#unansweredSince.has(deviceId)) this.#unansweredSince.set(deviceId, this.#now());
    if (reply.code === UNREACHABLE) this.#quiet.set(deviceId, this.#connected(deviceId));
  }

  #connectedIds(): ReadonlySet<string> {
    return new Set(
      this.#fleet
        .machines()
        .filter((m) => m.connected)
        .map((m) => m.deviceId),
    );
  }

  /** Runs `step` after every earlier step for the same task has finished, failed or not. */
  #serial<T>(id: string, step: () => Promise<T>): Promise<T> {
    const turn = (this.#chains.get(id) ?? Promise.resolve()).then(step);
    const tail = turn.then(
      () => undefined,
      () => undefined,
    );
    this.#chains.set(id, tail);
    void tail.then(() => {
      if (this.#chains.get(id) === tail) this.#chains.delete(id);
    });
    return turn;
  }

  /**
   * The one way a held task is written. Serialized per task, with `change`
   * computed from the copy held when its turn comes, so two writers never race
   * one version: an `ended` event landing while a verdict's write is out
   * applies after it, to what it wrote. A version conflict is a write this
   * process did not make — a term that ended without hearing it had, or a
   * create racing its own — so the held copy is refreshed from the store and
   * `change` applied again to what it finds. A lost reply (`indeterminate`) is
   * read the same way, except that the one version after ours is ours. A record
   * past the store's bound is written again with its decision cut to the
   * winner, never the task cut. An idle clock (`#idleSince`) ends on any write
   * into or out of `running`. The needs-input clock (`inputClock`) rides
   * whatever state a write lands, so no path can enter or leave `needs-input`
   * without it, and the merge clock (`endClock`) rides entering `awaiting-merge` the same way.
   * A forge reading (`pr`) is dropped when the write moves `prUrl` (`prBound`).
   * A finished task is kept lean on the same write (`lean`), so none reaches
   * the store with a prompt or the losers of its decision. Null when `change` declines (it returns null
   * for a task no longer in the state it acts on), the task is gone or
   * unreadable, the store refused the write, or the conflicts outlast
   * `WRITE_ATTEMPTS`. `StoreRevoked` is not caught: the term is over.
   */
  #update(id: string, change: (task: Task) => Task | null): Promise<Task | null> {
    return this.#serial(id, async () => {
      let trim = false;
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
        const held = this.#held.get(id);
        if (held === undefined) return null;
        const proposed = change(held.task);
        if (proposed === null) return null;
        const now = this.#now();
        const changed = lean(endClock(held.task, inputClock(prBound(held.task, proposed), now), now));
        const next = trim ? trimmed(changed) : changed;
        // oxlint-disable-next-line no-await-in-loop -- each attempt follows the refresh before it
        const write = await this.#store.put(id, held.version, next);
        if (write.ok) {
          this.#held.set(id, { version: write.version, task: next });
          // A stay at the prompt ends with `running`: one back from `lost` starts its grace over.
          if (held.task.state !== "running" || next.state !== "running") this.#idleSince.delete(id);
          this.#noteSuccessor(held.task, next);
          return next;
        }
        if (write.code === "too_large" && !trim && next.decision !== undefined) {
          trim = true;
          continue;
        }
        if (write.code !== "version_conflict" && write.code !== "indeterminate") {
          this.#refused(id, "put", write);
          return null;
        }
        // oxlint-disable-next-line no-await-in-loop -- as above
        const fresh = await this.#store.get(id);
        this.#held.delete(id);
        if (fresh === null) return null;
        // Every overwrite of a task is the leader's, so the one version after ours, after a
        // lost reply, is our write — adopted as written, or the change would decline itself.
        if (write.code === "indeterminate" && fresh.body !== undefined && fresh.version === held.version + 1) {
          this.#held.set(id, { version: fresh.version, task: next });
          this.#noteSuccessor(held.task, next);
          return next;
        }
        this.#keep(fresh);
        if (fresh.body === undefined) return null;
      }
      return null;
    });
  }

  /**
   * The two measures a successor gives (DESIGN.md, "Passing to a successor"): how long it waited for a
   * session of its own, and how it ended. Ids and states only.
   */
  #noteSuccessor(before: Task, after: Task): void {
    if (after.spec.succeeds === undefined) return;
    // A successor may land straight in `needs-input`: its first event is that one.
    if (before.state === "reserved" && (after.state === "running" || after.state === "needs-input")) {
      this.#log(`successor placed task=${quote(after.id)} after=${Math.max(0, this.#now() - after.createdAt)}`);
      return;
    }
    if (FINISHED.includes(before.state) || !FINISHED.includes(after.state)) return;
    const by = after.doneBy === undefined ? "" : ` doneBy=${after.doneBy}`;
    const why = after.failure === undefined ? "" : ` failure=${quote(after.failure.code)}`;
    this.#log(`successor settled task=${quote(after.id)} state=${after.state}${by}${why}`);
  }

  /** A record as read: held when it opened, set aside with its reason when it did not. */
  #keep(entry: StoreEntry): void {
    if (entry.body === undefined) {
      this.#unreadable.set(entry.id, entry);
      this.#forgetDecision(entry.id);
      return;
    }
    this.#unreadable.delete(entry.id);
    this.#held.set(entry.id, { version: entry.version, task: entry.body });
  }

  /** A write the store refused outright: no race to retry, so it is a fault for the host to see. */
  #refused(id: string, op: string, write: Extract<StoreWrite, { readonly ok: false }>): void {
    this.#onError(new Error(`store refused ${op} of task ${id}: ${write.code}`));
  }
}

/**
 * `task` carrying the spill stamp of the dispatch `at` made, while it is still that dispatch's: still
 * reserved under it, or placed on its machine (a session event got there before the reply). Null for a
 * task that has moved on (cancelled, re-dispatched elsewhere), for one already stamped, and for a stamp
 * the record's reader would refuse (an over-long account id or label): that would void the whole task, so
 * the window goes unstamped, which costs a later term one repeat.
 */
function stamped(task: Task, at: Reservation, stamp: SpillStamp): Task | null {
  if (parseSpillStamp(stamp) === null) return null;
  const mine = holds(task, at) || (PLACED.includes(task.state) && task.assignment?.deviceId === at.deviceId);
  const held = task.spillAlert;
  const same =
    held?.accountId === stamp.accountId &&
    held.window === stamp.window &&
    held.reset === stamp.reset &&
    held.spending === stamp.spending;
  if (!mine || same) return null;
  return { ...task, spillAlert: stamp };
}

/** A passed task whose session is still to close: it carries `successor` and has not settled `superseded`. */
function passCarried(task: Task): boolean {
  return (
    task.successor !== undefined && (task.state === "running" || task.state === "needs-input" || task.state === "lost")
  );
}

/**
 * A `push-branch` that did not push, as a pass's refusal. Anything the leader did not ask for or
 * cannot act on (`no_upstream` is the session's own path's alone; `invalid_request` and the transport
 * codes mean the daemon did not take the request) is `push_failed`: the machine may or may not have pushed.
 */
function passPushFailure(code: string): PassFailure {
  switch (code) {
    case "not_launched":
    case "detached_head":
    case "default_branch":
    case "dirty_worktree":
    case "branch_mismatch":
    case "push_rejected":
      return { ok: false, code };
    default:
      return { ok: false, code: "push_failed" };
  }
}

/** Whether an idle clock started on `deviceId` still speaks for `task`: running there, as it was. */
function idleHere(task: Task, deviceId: string): boolean {
  return task.state === "running" && task.assignment?.deviceId === deviceId;
}

/** At most `DECISION_MAX_CANDIDATES`, cut from the end — the rejected trail — and counted in `trimmed`. */
function capped(decision: Decision): Decision {
  const over = decision.candidates.length - DECISION_MAX_CANDIDATES;
  if (over <= 0) return decision;
  return {
    ...decision,
    candidates: decision.candidates.slice(0, DECISION_MAX_CANDIDATES),
    trimmed: (decision.trimmed ?? 0) + over,
  };
}

/**
 * A finished task as it is kept: no prompt (`forgetPrompt`), and its decision
 * cut to the winner (`trimmed`) — nothing re-routes it, and the losers of a
 * large fleet's decision would otherwise ride every listing and re-seal until
 * it is pruned. Returns `task` itself when there is nothing to drop.
 */
function lean(task: Task): Task {
  if (!FINISHED.includes(task.state)) return task;
  return trimmed(forgetPrompt(task));
}

/**
 * A task whose record would not fit: its decision cut to the candidate it chose,
 * the rest counted in `trimmed`. Everything else a record holds is bounded, so
 * this is the one cut that can make it fit (`STORE_MAX_CT_LENGTH`).
 */
function trimmed(task: Task): Task {
  const { decision } = task;
  if (decision === undefined) return task;
  const cut = winnerOnly(decision);
  return cut === decision ? task : { ...task, decision: cut };
}

/**
 * The winner's candidate alone, the rest added to `trimmed`: still where and
 * why, without the losers that make a record grow with the fleet. Unchanged
 * when there is nothing to cut.
 */
export function winnerOnly(decision: Decision): Decision {
  const { chosen } = decision;
  const kept = decision.candidates.filter(
    (c) => chosen !== null && c.deviceId === chosen.deviceId && c.exclave === chosen.exclave,
  );
  const cut = decision.candidates.length - kept.length;
  if (cut === 0) return decision;
  return { ...decision, candidates: kept, trimmed: (decision.trimmed ?? 0) + cut };
}

/** Tasks grouped by the machine they are reserved or placed on; one with neither is left out. */
function byDevice(tasks: readonly Task[]): ReadonlyMap<string, readonly Task[]> {
  const out = new Map<string, Task[]>();
  for (const task of tasks) {
    const deviceId = deviceOf(task);
    if (deviceId !== undefined) out.set(deviceId, [...(out.get(deviceId) ?? []), task]);
  }
  return out;
}
