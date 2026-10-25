import {
  accountNameIn,
  knownAccounts,
  reasonText,
  taskFailureText,
  type Candidate,
  type Decision,
  type Machine,
  type QuotaBasis,
  type Score,
  type Task,
} from "@seance/shared";
import { failedBody, formatSeen } from "./view.ts";

/**
 * A decision record as sentences: "chose X because …, rejected Y because …"
 * (the `Decision` that DESIGN.md's Scheduler section has `route.ts` return). Pure, so every reason and component
 * line is testable without a DOM; the card only lays these out.
 */

export interface DecisionLine {
  /** `deviceId/exclave`: unique in a record, where `where` is names, which two machines can share. */
  readonly id: string;
  /** `machine · exclave`, or the machine alone for a daemon that reports no exclaves. */
  readonly where: string;
  readonly outcome: "chosen" | "scored" | "rejected";
  readonly why: string;
  /** The account reading the candidate was judged on, worded as the account cards word it. */
  readonly quota: string | null;
}

export interface DecisionSummary {
  readonly headline: string;
  readonly chosen: DecisionLine | null;
  /** Scored losers first, best first, then the rejected — the record's own order. */
  readonly others: readonly DecisionLine[];
  /** Candidates the leader cut from this copy (`Decision.trimmed`): `others` is then partial. */
  readonly omitted: { readonly count: number; readonly text: string } | null;
}

function omittedOf(decision: Decision): DecisionSummary["omitted"] {
  const count = decision.trimmed ?? 0;
  if (count === 0) return null;
  return { count, text: `${count} more not shown — left out to keep the record small` };
}

function lineId(deviceId: string, exclave: string | null): string {
  return `${deviceId}/${exclave ?? ""}`;
}

function where(candidate: Candidate): string {
  return candidate.exclave === null ? candidate.machine : `${candidate.machine} · ${candidate.exclave}`;
}

/** Two places, never more: the components are small fractions or a convex cost, and a third digit is noise. */
function n(value: number): string {
  return value.toFixed(2);
}

function scoreText(score: Score): string {
  const { components: c } = score;
  const parts = [
    `account ${n(c.accountPressure)}`,
    `load ${Math.round(c.machinePressure * 100)}%`,
    `queue ${c.queuePressure}`,
  ];
  if (c.dependencyDistance > 0) parts.push(`distance ${n(c.dependencyDistance)}`);
  if (score.sticky > 0) parts.push(`continuation −${n(score.sticky)}`);
  return `score ${n(score.total)} (${parts.join(" · ")})`;
}

/**
 * The observed line of an account card (`machines-view.ts`): source, age, and
 * the machine that saw it, asleep or not — so the age on a decision reads
 * exactly as it does where the quota itself is shown.
 */
function quotaText(
  quota: QuotaBasis | undefined,
  decision: Decision,
  machines: readonly Machine[],
  now: number,
): string | null {
  if (quota === undefined) return null;
  const observer = machines.find((m) => m.deviceId === quota.observer);
  const named = observer?.name ?? decision.candidates.find((c) => c.deviceId === quota.observer)?.machine;
  const at = formatSeen(quota.observedAt * 1000, now);
  if (named === undefined) return `quota: ${quota.source} · ${at}`;
  return `quota: ${quota.source} · ${at} on ${observer?.connected === false ? `${named}, asleep` : named}`;
}

/** A placed task already spent them: "would" is wrong for a record read after the fact. */
function spillText(candidate: Candidate, tense: "would" | "did"): string | null {
  const { spill } = candidate;
  if (spill === undefined) return null;
  const pct = Math.round(spill.projectedPct);
  return tense === "would"
    ? `would spend credits (${spill.window} at ${pct}%)`
    : `spending credits (${spill.window} projected at ${pct}%)`;
}

function line(
  candidate: Candidate,
  outcome: DecisionLine["outcome"],
  decision: Decision,
  machines: readonly Machine[],
  now: number,
  winner: Candidate | undefined,
  tense: "would" | "did",
): DecisionLine {
  const quota = quotaText(candidate.quota, decision, machines, now);
  const id = lineId(candidate.deviceId, candidate.exclave);
  if (outcome === "rejected") {
    // Reasons a leader a version ahead minted are dropped at parse: say so rather than show none.
    const why =
      candidate.rejected.length === 0
        ? "rejected for a reason this app can't read — update it"
        : candidate.rejected.map(reasonText).join(", ");
    return { id, where: where(candidate), outcome, why, quota };
  }
  const score = candidate.score;
  const scored = score === undefined ? "scored" : scoreText(score);
  const spill = spillText(candidate, tense);
  const why =
    outcome === "chosen"
      ? ["lowest score", scored, spill].filter((part) => part !== null).join(" — ")
      : [lostBy(scored, candidate, winner), spill].filter((part) => part !== null).join(" — ");
  return { id, where: where(candidate), outcome, why, quota };
}

/** An exact tie is named as one: `route` breaks it by device id, then exclave, so the record reproduces. */
function lostBy(scored: string, candidate: Candidate, winner: Candidate | undefined): string {
  const score = candidate.score;
  const best = winner?.score;
  if (best === undefined || score === undefined) return scored;
  if (score.total === best.total) {
    const breaker = candidate.deviceId === winner?.deviceId ? "the exclave sorted first" : "the lower device id";
    return `tied, ${scored} — a tie goes to ${breaker}`;
  }
  return `scored higher, ${scored} against ${n(best.total)}`;
}

/**
 * `tense`: a preview says what would happen, a placed task what did. A record
 * whose winner is not among its candidates (a leader a version ahead) still
 * names the target it chose.
 */
export function describeDecision(
  decision: Decision,
  machines: readonly Machine[],
  now: number,
  tense: "would" | "did",
): DecisionSummary {
  const { chosen } = decision;
  const winner =
    chosen === null
      ? undefined
      : decision.candidates.find(
          (c) => c.deviceId === chosen.deviceId && c.exclave === chosen.exclave && c.score !== undefined,
        );
  const others = decision.candidates
    .filter((c) => c !== winner)
    .map((c) => line(c, c.score === undefined ? "rejected" : "scored", decision, machines, now, winner, tense));
  const omitted = omittedOf(decision);
  if (chosen === null) {
    return {
      headline:
        // A record cut to nothing still had candidates: it is a full fleet, not an empty one.
        decision.candidates.length === 0 && omitted === null
          ? "No machine is registered to take it."
          : tense === "would"
            ? "No machine can take it right now."
            : "Waiting — no machine can take it yet.",
      chosen: null,
      others,
      omitted,
    };
  }
  const name = winner === undefined ? chosen.deviceId : where(winner);
  return {
    headline: tense === "would" ? `Would start on ${name}.` : `Placed on ${name}.`,
    chosen:
      winner === undefined
        ? { id: lineId(chosen.deviceId, chosen.exclave), where: name, outcome: "chosen", why: "chosen", quota: null }
        : line(winner, "chosen", decision, machines, now, undefined, tense),
    others,
    omitted,
  };
}

/** What became of a queued task, in one line: the verdict's headline. */
export function taskHeadline(task: Task, machines: readonly Machine[], now: number): string {
  const at = task.assignment ?? task.reservation;
  const machine =
    at === undefined ? undefined : (machines.find((m) => m.deviceId === at.deviceId)?.name ?? at.deviceId);
  const place = at === undefined ? "" : ` on ${machine ?? ""} · ${at.exclave}`;
  switch (task.state) {
    case "queued":
      return "Queued — waiting for the scheduler.";
    case "blocked":
      return "Queued — waiting on the tasks it depends on.";
    case "ready":
      return "Queued — waiting for a machine.";
    case "reserved":
      return `Starting${place}…`;
    case "running":
      return `It's running${place}.`;
    case "needs-input":
      return `It's waiting for input${place}.`;
    case "lost":
      return task.absentSince === undefined
        ? `Lost${place} — its machine stopped answering.`
        : `Lost${place} — its machine went away ${formatSeen(task.absentSince, now)}.`;
    case "awaiting-merge":
      // Under `until: "reported"` the merge settles nothing: only the session's own report does.
      if (task.merged === true) return `Merged${place} — waiting for its session to report it done.`;
      return `Its session ended${place} — waiting for the PR to merge.`;
    case "done":
      // `leftRunning` is "marked by hand" only for `manual`: the leader settles a merged PR whose session it never stopped.
      if (task.doneBy === "merged") {
        return task.leftRunning === true
          ? `Its PR merged — its session may still be running${place}.`
          : `Its PR merged${place}.`;
      }
      if (task.leftRunning === true) return `Marked done — its session may still be running${place}.`;
      // Marked by hand: nothing saw it finish, so "finished" would claim too much.
      if (task.doneBy === "linear") return `Its Linear issue was closed${place}.`;
      if (task.doneBy === "reported") return `It reported done${place}.`;
      return task.doneBy === "manual" ? `Marked done${place}.` : `It finished${place}.`;
    case "failed":
      if (task.failure?.code === "dispatch_unconfirmed") return `Never confirmed${place} — it may have started there.`;
      if (task.failure?.code === "lost_expired") return `Given up${place} — its session may still be running there.`;
      if (task.failure?.code === "merge_expired") return "No merge seen for its PR — the scheduler gave up waiting.";
      if (task.failure?.code === "session_failed") return `Its session exited with an error${place}, with no PR.`;
      // A scheduler-set failure never reached a machine; only a daemon refusal "didn't take" there.
      return task.failure !== undefined && taskFailureText(task.failure.code) !== null
        ? "It won't run."
        : `It didn't take${place}.`;
    case "cancelled":
      return task.leftRunning === true ? `Cancelled — its session may still be running${place}.` : "Cancelled.";
  }
}

/** How many rejected places a wait reason names before "+N more". */
const WAITING_LIMIT = 3;

/**
 * Why a ready task is still waiting, from its decision: each place that took it
 * out and the reasons, the clause `reasonText` words. Places the pin or the
 * avoid list rules out (`pin_mismatch`, `avoided`) are left out whole — the pin is the ask, not news.
 * Null with no decision yet, or one that chose a place.
 */
export function waitingText(task: Task): string | null {
  const { decision } = task;
  if (task.state !== "ready" || decision === undefined || decision.chosen !== null) return null;
  const places = decision.candidates
    // A place the pin or the avoid list rules out is moot whatever else is wrong with it (an offline machine
    // the task was never going to use is not news).
    .filter((candidate) => !candidate.rejected.some((r) => r.code === "pin_mismatch" || r.code === "avoided"))
    .map((candidate) => ({ where: where(candidate), why: candidate.rejected.map(reasonText) }))
    .filter((place) => place.why.length > 0)
    .map((place) => `${place.where}: ${place.why.join(", ")}`);
  if (places.length === 0) return null;
  const more = places.length - WAITING_LIMIT;
  return `${places.slice(0, WAITING_LIMIT).join("; ")}${more > 0 ? `; +${more} more` : ""}`;
}

/** "Pinned to <machine> · <account>" for a pinned task; null otherwise. The labels are display text from the registry. */
export function pinLine(
  task: Task,
  machines: readonly Machine[],
  aliases: Readonly<Record<string, string>>,
): string | null {
  const { pin } = task.spec;
  if (pin === undefined) return null;
  const parts: string[] = [];
  if (pin.deviceId !== undefined) {
    parts.push(machines.find((m) => m.deviceId === pin.deviceId)?.name ?? pin.deviceId.slice(0, 8));
  }
  if (pin.account !== undefined) {
    const known = knownAccounts(machines, [pin.account]);
    parts.push(
      accountNameIn(known, pin.account, Object.hasOwn(aliases, pin.account) ? aliases[pin.account] : undefined),
    );
  }
  return parts.length === 0 ? null : `Pinned to ${parts.join(" · ")}`;
}

/** Keyed on `assignment`, not the state: a waiting task marked done was never placed, so its decision stays a "would". */
export function isPlaced(task: Task): boolean {
  return task.assignment !== undefined;
}

/** A cancel or a mark done that could not reach the task's machine: whatever session it had may outlive the record. */
const LEFT_RUNNING =
  "Its machine was away, so nothing was stopped there. End the session on that machine if it is still running.";

/** What the person can do next about a task the scheduler holds, by its state. */
export function queuedBody(task: Task): string {
  switch (task.state) {
    case "queued":
      return "It is in the queue. The scheduler picks it up as soon as one is running. Nothing is running yet.";
    case "blocked":
      return "It waits for the tasks it depends on. Nothing is running yet.";
    case "ready":
      return "The scheduler holds it and places it as soon as a machine can take it. Nothing is running yet.";
    case "reserved":
      return "The scheduler picked a machine and is starting the session there.";
    case "running":
    case "needs-input":
      return "Open Claude on your phone and continue the session from there.";
    case "lost":
      return "Its machine stopped answering and the session may still be alive there, so the scheduler starts it nowhere else unless that machine proves it never began. It settles once that machine is back, or is given up on after a week.";
    case "awaiting-merge":
      if (task.merged === true) {
        return "Its PR merged, but it was set to settle on its session's done report, which has not come. Tasks that wait for it to be done stay blocked; mark it done if the work is finished. The scheduler gives up after a week, and they fail.";
      }
      return "The session ended with a pull request open. Tasks that wait for it to merge stay blocked until it does; the scheduler gives up after a week, and they fail.";
    case "done":
      if (task.doneBy === "merged") {
        const merged = "Its pull request merged, so the scheduler marked it done.";
        // Not LEFT_RUNNING: a settle off a live session leaves it running with its machine present.
        return task.leftRunning === true
          ? `${merged} Its session was left as it was. End the session on that machine if it is still running.`
          : merged;
      }
      if (task.leftRunning === true) return `Marked done by hand. ${LEFT_RUNNING}`;
      if (task.doneBy === "linear") return "Its Linear issue was closed, so the scheduler marked it done.";
      if (task.doneBy === "reported") return "Its session reported it done.";
      return task.doneBy === "manual" ? "Marked done by hand." : "The session ended.";
    case "failed":
      return failedBody(task.failure?.code);
    case "cancelled":
      return task.leftRunning === true ? LEFT_RUNNING : "Nothing is running.";
  }
}
