import {
  reasonText,
  taskFailureText,
  type Candidate,
  type Decision,
  type Machine,
  type QuotaBasis,
  type Score,
  type Task,
} from "@seance/shared";
import { formatSeen } from "./view.ts";

/**
 * A decision record as sentences: "chose X because …, rejected Y because …"
 * (docs/scheduler.md, Routing, step 5). Pure, so every reason and component
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
      return `Its session ended${place} — waiting for the PR to merge.`;
    case "done":
      // Marked by hand: the session may still be running, so "finished" would claim too much.
      return task.doneBy === "manual" ? `Marked done${place}.` : `It finished${place}.`;
    case "failed":
      if (task.failure?.code === "dispatch_unconfirmed") return `Never confirmed${place} — it may have started there.`;
      if (task.failure?.code === "lost_expired") return `Given up${place} — its session may still be running there.`;
      if (task.failure?.code === "merge_expired") return "No merge seen for its PR — the scheduler gave up waiting.";
      // A scheduler-set failure never reached a machine; only a daemon refusal "didn't take" there.
      return task.failure !== undefined && taskFailureText(task.failure.code) !== null
        ? "It won't run."
        : `It didn't take${place}.`;
    case "cancelled":
      return task.leftRunning === true ? `Cancelled — its session may still be running${place}.` : "Cancelled.";
  }
}
