import type { Machine } from "./app-client.ts";
import { autonomyOf } from "./autonomy.ts";
import { codexNeedsCheckpointLeader } from "./codex.ts";
import { blockedBrief, taskPrBlock } from "./pr-blocked.ts";
import { TASK_PHASES } from "./task-phase.ts";
import { chainTags, withoutTaskTags } from "./tags.ts";
import {
  CAPABILITIES,
  LAUNCH_LEDGER_MAX_AGE_MS,
  type Target,
  type Task,
  type TaskFailureCode,
  type TaskSpec,
} from "./types.ts";

/**
 * `resumes` is the id of the session's task when it is not `task` itself (an `awaiting-merge` task's chain
 * moved on: a later continuation holds the session), and `brief` the fixed text a blocked PR's continuation
 * opens with. Both absent: the offer resumes `task` and adds nothing. An id, not a `Task`: the caller's list
 * may not hold it.
 */
export type ContinueOffer =
  | { readonly ok: true; readonly at: Target; readonly resumes?: string; readonly brief?: string }
  | { readonly ok: false; readonly reason: string };

/**
 * What only the caller knows: its best leader-clock now, and whether the verified leader advertises `continueHandoff`
 * `codexContinue` and `codexCheckpoint`.
 */
export interface OfferContext {
  readonly now: number;
  readonly leaderHandoff: boolean;
  /** The verified leader advertises `CAPABILITIES.codexContinue`: an older one would hold a Codex continuation forever. */
  readonly leaderCodexContinue: boolean;
  /**
   * The verified leader advertises `CAPABILITIES.codexCheckpoint`. A continuation keeps its task's level, and an item
   * 10 leader continues Codex but places one at `checkpoint` nowhere.
   */
  readonly leaderCodexCheckpoint: boolean;
}

/**
 * Failure codes of a continuation that ran in the worktree: it landed, so a session may
 * have written there. A positive list, so a future code, `continue_expired`,
 * `dispatch_unconfirmed`, `queue_expired`, the dependency codes and every daemon refusal
 * default to "did not take over": a false "did not take over" costs one daemon refusal,
 * a false "took over" strands the conversation.
 */
const LANDED_FAILURES: ReadonlySet<string> = new Set<TaskFailureCode>([
  "session_failed",
  "session_closed",
  "lost_expired",
  "merge_expired",
]);

/**
 * The words of the daemon's `not_continuable` refusal when a continuation's worktree and local branch are both gone
 * (`readdWorktree`, which never checks out origin's ref). The daemon builds its message around them and the offer
 * looks for them: that refusal is the one that no retry on the same session can get past, where a held lock or an
 * open session can clear. Changing them makes an older daemon's refusal read as a passing one, which only re-offers.
 */
export const WORKTREE_AND_BRANCH_GONE = "and its branch are both gone";

/** The failures whose session can be resumed: it died, or its window was closed from outside. */
const RESUMABLE_FAILURES: ReadonlySet<string> = new Set<TaskFailureCode>(["session_failed", "session_closed"]);

/**
 * Whether continuation `y` holds the session of the task it continues. A queued
 * continuation may still fail unplaced, and cancelling it before it was placed frees the
 * offer; one that landed (placed, running, finished, or failed/cancelled after that)
 * has had the worktree, so the offer moves to it.
 */
function tookOver(y: Task): boolean {
  switch (y.state) {
    case "queued":
    case "blocked":
    case "ready":
      return false;
    case "failed":
      return LANDED_FAILURES.has(y.failure?.code ?? "");
    case "cancelled":
      return y.assignment !== undefined;
    default:
      return true;
  }
}

/**
 * The continuation of `task` still in the queue, among `tasks`, when none has taken over. It does
 * not hold the session (`tookOver`: it may never land), but a second Continue would only race it,
 * so the offer waits on it. A landed taker outranks it, so there is none then. Of several, the
 * oldest: the one the scheduler places first, whatever the list's order. One `QUEUE_MAX_TASKS`
 * left out of the list is invisible here, and the offer stands.
 */
export function waitingContinuation(task: Task, tasks: readonly Task[]): Task | undefined {
  const continuations = tasks.filter((other) => other.spec.continues?.task === task.id);
  if (continuations.some(tookOver)) return undefined;
  let oldest: Task | undefined;
  for (const other of continuations) {
    const waits = other.state === "queued" || other.state === "blocked" || other.state === "ready";
    if (waits && (oldest === undefined || other.createdAt < oldest.createdAt)) oldest = other;
  }
  return oldest;
}

/**
 * The newest continuation of `task`'s chain that landed (`tookOver`), among `tasks`: walk down from `task`,
 * at each link taking the landed continuation created last (the greater id on a tie). Undefined when none
 * landed. The leader's pointer (`Task.continuedBy`) is this, so one definition of "landed" serves it and the offer.
 */
export function newestLanded(task: Task, tasks: readonly Task[]): Task | undefined {
  let found: Task | undefined;
  let current = task;
  for (let step = 0; step < tasks.length; step++) {
    let next: Task | undefined;
    for (const other of tasks) {
      if (other.spec.continues?.task !== current.id || !tookOver(other)) continue;
      if (
        next === undefined ||
        other.createdAt > next.createdAt ||
        (other.createdAt === next.createdAt && other.id > next.id)
      ) {
        next = other;
      }
    }
    if (next === undefined) return found;
    found = next;
    current = next;
  }
  return found;
}

/**
 * Whether any continuation of `task`, however deep its chain (a later one continues the previous,
 * not the original), is waiting, dispatching or placed among `tasks`. Bounded by the list's length,
 * so a cycle ends the walk.
 */
export function continuationUnderway(task: Task, tasks: readonly Task[]): boolean {
  const chain = new Set<string>([task.id]);
  for (let round = 0; round < tasks.length; round++) {
    const before = chain.size;
    for (const other of tasks) {
      const continues = other.spec.continues?.task;
      if (continues === undefined || !chain.has(continues) || chain.has(other.id)) continue;
      const phase = TASK_PHASES[other.state];
      if (phase === "waiting" || phase === "dispatching" || phase === "placed") return true;
      chain.add(other.id);
    }
    if (chain.size === before) return false;
  }
  return false;
}

/**
 * A continuation of `task`'s session, among `tasks`, that its machine refused because the worktree and branch are
 * both gone: nothing is left to resume in, so the offer stops. The session is the leader's pointer's, else the task's
 * own. A refused continuation never landed, so the session it named still holds. Fallen off a bounded list, it is
 * missed and the offer stands: one more refusal, as before.
 */
export function goneContinuation(task: Task, tasks: readonly Task[]): Task | undefined {
  const session = task.continuedBy?.task ?? task.id;
  return tasks.find(
    (other) =>
      other.spec.continues?.task === session &&
      other.state === "failed" &&
      other.failure?.code === "not_continuable" &&
      other.failure.message.includes(WORKTREE_AND_BRANCH_GONE),
  );
}

function goneReason(gone: Task): string {
  return `task ${gone.id} could not continue it: its worktree and its branch are both gone, so nothing is left to resume`;
}

/** The task-level eligibility `continueOffer` applies, so it can tell whether a taker would itself pass it. */
function sessionResumable(task: Task): boolean {
  if (task.state === "cancelled") return task.assignment !== undefined && task.endedAt === undefined;
  return task.state === "failed" && RESUMABLE_FAILURES.has(task.failure?.code ?? "");
}

/**
 * Whether a task's session can be resumed, and where: the one rule the PWA's button,
 * MCP's `continue_task` and `seance continue` share so they cannot drift (DESIGN.md,
 * Daemon, "Continuing a session"). A task whose session failed (`session_failed`) or
 * whose window was closed from outside (`session_closed`), or
 * that was cancelled after it was placed, qualifies — the others may never have launched,
 * and the daemon's ledger would refuse them anyway. The machine must advertise
 * `continueTask` and `continueSession`, and for a cancelled task `continueCancelled`. And only the newest landed task in a chain holds the
 * offer: `tasks` is the list the caller read it from, and a continuation that landed has
 * the worktree, so a second would only be refused by the daemon. One still waiting withholds
 * it too, until it lands or ends unplaced. Imports nothing that logs, since `seance mcp`
 * reaches it.
 *
 * A third case: an `awaiting-merge` task whose PR is blocked (`taskPrBlock`), not under `until: "reported"`,
 * and only with a `context`, since it needs the leader's clock and whether the verified leader advertises
 * `continueHandoff`. Which session to resume comes from the leader's pointer (`Task.continuedBy`), never from
 * `tasks`, which is bounded and may leave the chain's newest out: the offer then names it (`resumes`) and
 * carries the fixed text the continuation opens with (`brief`). The chain shares its first machine.
 */
export function continueOffer(
  task: Task,
  machines: readonly Machine[],
  tasks: readonly Task[],
  context?: OfferContext,
): ContinueOffer {
  if (task.spec.agent !== undefined && context?.leaderCodexContinue !== true) {
    return {
      ok: false,
      reason: "the scheduler's leader can't continue a Codex task yet (needs seance update)",
    };
  }
  if (codexNeedsCheckpointLeader(task.spec) && context?.leaderCodexCheckpoint !== true) {
    return {
      ok: false,
      reason: "the scheduler's leader can't run a Codex task at checkpoint yet (needs seance update)",
    };
  }
  if (task.state === "cancelled") {
    if (task.assignment === undefined) {
      return { ok: false, reason: "a task cancelled before it started has no session to continue" };
    }
    if (task.endedAt !== undefined) {
      return {
        ok: false,
        reason: "its session had already finished before it was cancelled; use Follow up instead",
      };
    }
  } else if (task.state === "awaiting-merge") {
    return blockedOffer(task, machines, tasks, context);
  } else if (task.state !== "failed" || !RESUMABLE_FAILURES.has(task.failure?.code ?? "")) {
    return {
      ok: false,
      reason:
        "only a task whose session failed or whose window was closed, or that was cancelled after it started, can be continued",
    };
  }
  const taker = tasks.find((other) => other.spec.continues?.task === task.id && tookOver(other));
  if (taker !== undefined) {
    const finished = taker.state === "failed" || taker.state === "cancelled";
    return {
      ok: false,
      reason: !finished
        ? "a continuation of it is already underway or finished"
        : sessionResumable(taker)
          ? `its session was taken over by task ${taker.id}; continue that one instead`
          : `its session was taken over by task ${taker.id}, which finished, so there is nothing left to continue`,
    };
  }
  const waiting = waitingContinuation(task, tasks);
  if (waiting !== undefined) {
    return { ok: false, reason: `already continuing as task ${waiting.id}, which is still waiting in the queue` };
  }
  const gone = goneContinuation(task, tasks);
  if (gone !== undefined) return { ok: false, reason: goneReason(gone) };
  const placed = placement(task, machines);
  if (!placed.ok) return placed;
  if (task.state === "cancelled" && !placed.machine.capabilities?.includes(CAPABILITIES.continueCancelled)) {
    return {
      ok: false,
      reason: "the machine it ran on can't continue a cancelled session yet (needs seance update)",
    };
  }
  return { ok: true, at: placed.at };
}

/** Where the task ran, when that machine can continue a session at all. */
function placement(
  task: Task,
  machines: readonly Machine[],
):
  | { readonly ok: true; readonly at: Target; readonly machine: Machine }
  | { readonly ok: false; readonly reason: string } {
  if (task.spec.mode === "here") {
    return { ok: false, reason: "a task run in place has no worktree of its own to continue" };
  }
  const { assignment } = task;
  if (assignment === undefined) return { ok: false, reason: "the task was never placed on a machine" };
  const machine = machines.find((m) => m.deviceId === assignment.deviceId);
  if (machine === undefined) return { ok: false, reason: "the machine it ran on is no longer listed" };
  // `continueSession`: an older daemon resumes with `--continue`, which misses a worktree spawn's conversation.
  const caps = machine.capabilities;
  if (caps?.includes(CAPABILITIES.continueTask) !== true || !caps.includes(CAPABILITIES.continueSession)) {
    return { ok: false, reason: "the machine it ran on can't continue a session yet (needs seance update)" };
  }
  // An older daemon refuses the spawn `not_continuable`, and the leader would wait for it (`continue_unsupported`).
  if (task.spec.agent !== undefined && !caps.includes(CAPABILITIES.codexContinue)) {
    return { ok: false, reason: "the machine it ran on can't continue a Codex session yet (needs seance update)" };
  }
  return {
    ok: true,
    at: { deviceId: assignment.deviceId, exclave: assignment.exclave, clone: assignment.clone },
    machine,
  };
}

/**
 * The offer for an `awaiting-merge` task. No list walk when the leader's pointer is absent: the leader gate
 * guarantees one that writes it, and a walk over a bounded list is what the pointer replaced.
 */
function blockedOffer(
  task: Task,
  machines: readonly Machine[],
  tasks: readonly Task[],
  context: OfferContext | undefined,
): ContinueOffer {
  if (task.spec.until === "reported") {
    return { ok: false, reason: "it waits on its session's own done report, not on a merge" };
  }
  const reason = taskPrBlock(task);
  if (reason === null) return { ok: false, reason: "its pull request is not blocked; it is waiting to merge" };
  if (context === undefined || !context.leaderHandoff) {
    return {
      ok: false,
      reason: "the scheduler's leader can't continue a task waiting to merge yet (needs seance update)",
    };
  }
  if (task.continuedBy?.live === true || continuationUnderway(task, tasks)) {
    return { ok: false, reason: "a continuation of it is still waiting or running" };
  }
  const gone = goneContinuation(task, tasks);
  if (gone !== undefined) return { ok: false, reason: goneReason(gone) };
  const resumes = task.continuedBy?.task ?? task.id;
  const since = task.continuedBy?.createdAt ?? task.createdAt;
  // The ledger evicts by launch time, `createdAt` is never later than the launch: this stops early, never late.
  if (context.now - since > LAUNCH_LEDGER_MAX_AGE_MS) {
    return {
      ok: false,
      reason: "its session is older than its machine's launch ledger keeps (a week); resume it by hand",
    };
  }
  const placed = placement(task, machines);
  if (!placed.ok) return placed;
  if (placed.machine.capabilities?.includes(CAPABILITIES.continueHandoff) !== true) {
    return {
      ok: false,
      reason: "the machine it ran on can't continue a handed-off session yet (needs seance update)",
    };
  }
  return {
    ok: true,
    at: placed.at,
    ...(resumes === task.id ? {} : { resumes }),
    brief: blockedBrief(task, reason),
  };
}

/**
 * The spec of the task that continues `task`. Carries what shapes the session
 * (model, effort, plan, autonomy, title), what settles it (`until`, `linear`) and its `creator.*` tags (never `owner.*`:
 * the leader copies those at admission; never `scheduler.*`), and
 * nothing that places or orders it (never `notBefore`, DESIGN.md "Not before"): the target is exact, and the old task's
 * dependents stay failed. The caller stamps `client`.
 *
 * `continues` names the session it resumes: the task itself, or, for a chain's later continuation, the
 * newest one that landed, while the spec is still copied from `task`, the one the user tapped.
 *
 * A `steer` task continues at `checkpoint`, without plan mode: the resumed conversation holds
 * whatever plan the user approved, and a session that stopped mid-build would otherwise stall
 * on a second approval.
 */
export function continuationSpec(task: Task, at: Target, prompt?: string, continues: string = task.id): TaskSpec {
  const { spec } = task;
  const note = prompt?.trim();
  const steered = autonomyOf(spec) === "steer";
  const creator = chainTags(spec.tags, "creator");
  return {
    repo: spec.repo,
    mode: "continue",
    ...(note === undefined || note === "" ? {} : { prompt: note }),
    ...(spec.title === undefined ? {} : { title: spec.title }),
    ...(spec.model === undefined ? {} : { model: spec.model }),
    ...(spec.effort === undefined ? {} : { effort: spec.effort }),
    ...(steered
      ? { autonomy: "checkpoint" }
      : {
          ...(spec.plan === undefined ? {} : { plan: spec.plan }),
          ...(spec.autonomy === undefined ? {} : { autonomy: spec.autonomy }),
        }),
    ...(spec.until === undefined ? {} : { until: spec.until }),
    ...(spec.linear === undefined ? {} : { linear: spec.linear }),
    ...(spec.requires === undefined ? {} : { requires: spec.requires }),
    ...(creator === undefined ? {} : { tags: creator }),
    // Never another agent: the daemon refuses a continuation whose agent is not the one its ledger noted.
    ...(spec.agent === undefined ? {} : { agent: spec.agent }),
    continues: { task: continues, at },
  };
}

/**
 * What every client writes for an accepted offer: the continuation's spec with the blocked PR's brief ahead of
 * the user's own note (a blank line between), resuming the session the offer names. One place, so no client
 * can skip the brief. `leaderTakesTags` is whether the verified leader advertises `CAPABILITIES.taskTags`: when it does
 * not, the copied `creator.*` tags are dropped, never refused, since display data must not block a resume and an older
 * leader would hold a tagged record unreadable. Both clients go through here, so neither drops them on its own.
 */
export function offeredSpec(
  task: Task,
  offer: Extract<ContinueOffer, { ok: true }>,
  prompt: string | undefined,
  leaderTakesTags: boolean,
): TaskSpec {
  const joined = [offer.brief, prompt?.trim()].filter((part) => part !== undefined && part !== "").join("\n\n");
  const copied = continuationSpec(task, offer.at, joined, offer.resumes ?? task.id);
  const spec: TaskSpec = leaderTakesTags ? copied : withoutTaskTags(copied);
  // An untitled task would otherwise be named by its prompt's first line, the brief's: on its card and as its window.
  return offer.brief === undefined || spec.title !== undefined ? spec : { ...spec, title: blockedTitle(task) };
}

/** `Unblock PR #7`: the number is the last path segment of the PR URL, kept only when it is digits. */
function blockedTitle(task: Task): string {
  const number = task.prUrl?.split("/").at(-1);
  return number !== undefined && /^[0-9]+$/u.test(number) ? `Unblock PR #${number}` : "Unblock PR";
}
