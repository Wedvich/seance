import {
  failureReasonText,
  queuedTask,
  RequestFailure,
  schedulerRefusal,
  storeErrorText,
  TASK_REQUEST_LIMITS,
  type Machine,
  type TaskRequest,
} from "@seance/shared";
import { enqueueAudit, type AuditSink } from "./audit.ts";
import type { SchedulerLeg } from "./fleet.ts";
import { originQuery } from "./scan.ts";

/**
 * Enqueuing on `auto` as an app-role client does it — which origin a repo
 * names, whether a request fits the scheduler's bounds, and the create itself
 * — apart from the MCP SDK and zod, so another client (a CLI `--auto`, Raycast)
 * can reuse it. `mcp.ts` wraps the answers as tool results.
 */

/** How an enqueue ended, as a line for whoever asked: `ok` false is an error for them to see. */
export interface AutoEnqueued {
  readonly ok: boolean;
  readonly text: string;
}

const done = (text: string): AutoEnqueued => ({ ok: true, text });
const failed = (text: string): AutoEnqueued => ({ ok: false, text });

/**
 * `auto`'s `repo` as the scheduler keys it, `RepoEntry.origin`. Callers hold
 * clone names from `list_machines`, so either is accepted: an origin in any
 * form `originQuery` keys (a pasted URL, mixed case), or a clone name —
 * matched exactly, since it is a directory name — whose clones all share one
 * origin. Clone names are machine-local, so two unrelated repos can share one
 * — picking between them would run the task in the wrong repo, so that is an
 * error naming each.
 */
export function resolveOrigin(
  machines: readonly Machine[],
  repo: string,
): { readonly origin: string } | { readonly error: string } {
  const origins = new Set<string>();
  /** origin → the machines whose clone of it is named `repo` */
  const named = new Map<string, string[]>();
  /** Machines whose clone named `repo` reports no origin: an older daemon the scheduler cannot route to. */
  const unkeyed: string[] = [];
  for (const machine of machines) {
    for (const entry of machine.repos) {
      if (entry.origin === undefined) {
        if (entry.name === repo) unkeyed.push(machine.name);
        continue;
      }
      origins.add(entry.origin);
      if (entry.name !== repo) continue;
      const on = named.get(entry.origin) ?? [];
      if (!on.includes(machine.name)) on.push(machine.name);
      named.set(entry.origin, on);
    }
  }
  const key = originQuery(repo).find((candidate) => origins.has(candidate));
  if (key !== undefined) return { origin: key };
  const [only, ...rest] = named.keys();
  if (only !== undefined && rest.length === 0) return { origin: only };
  if (only !== undefined) {
    const each = [...named].map(([origin, on]) => `${origin} (on ${on.join(", ")})`).join("; ");
    return { error: `"${repo}" names clones of more than one repo — pass the origin instead: ${each}` };
  }
  const known = [...origins].toSorted().join(", ");
  const stale =
    unkeyed.length === 0
      ? ""
      : ` (${unkeyed.join(", ")} has a clone by that name, but its daemon reports no origin, so auto cannot route to it)`;
  return { error: `no repo "${repo}" for auto${stale} — known origins: ${known === "" ? "(none reported)" : known}` };
}

/**
 * Past a bound `createTask` refuses the enqueue locally as a bare
 * `invalid_request`, before any store write — so it is refused here, naming
 * the bound, as the PWA does.
 */
function overBound(field: keyof typeof TASK_REQUEST_LIMITS, value: string | undefined): string | null {
  const limit = TASK_REQUEST_LIMITS[field];
  if (value === undefined || value.length <= limit) return null;
  const fix = field === "prompt" ? " — shorten it (the session can gather the rest with tools), or name a machine" : "";
  return `the ${field} is ${value.length} characters; auto takes at most ${limit}${fix}`;
}

export function taskRequestError(request: TaskRequest): string | null {
  return (
    overBound("prompt", request.prompt) ??
    overBound("title", request.title) ??
    overBound("model", request.model) ??
    overBound("effort", request.effort) ??
    overBound("repo", request.repo)
  );
}

/** Tries at one create: each re-sends the same task, so a lost reply can never queue it twice. */
const ENQUEUE_ATTEMPTS = 3;
const ENQUEUE_RETRY_MS = 1_000;

/**
 * Enqueues by `store-put` — the relay answers it itself, so no leader is needed:
 * with none (or an unverified one) the task waits in the relay's queue until one
 * leads. A lost reply (timeout, dropped socket) or no socket is tried again with
 * the same task, since a repeat create reads `landedEarlier`; every try lost says
 * so and names the id. Never logs: `seance mcp`'s stdout is its JSON-RPC
 * channel. The text names MCP's tools (`get_queue`, `cancel_task`).
 */
export async function enqueueAuto(
  scheduler: SchedulerLeg,
  request: TaskRequest,
  audit: AuditSink,
): Promise<AutoEnqueued> {
  const task = queuedTask({ ...request, client: "mcp" }, Date.now());
  const audited = enqueueAudit(audit);
  // Whether any try left this process: a socket that was never open sent nothing, so nothing can have queued.
  let sent = false;
  for (let attempt = 1; attempt <= ENQUEUE_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      // oxlint-disable-next-line no-await-in-loop -- the wait between tries
      await Bun.sleep(ENQUEUE_RETRY_MS);
    }
    let reply: Awaited<ReturnType<SchedulerLeg["enqueue"]>>;
    try {
      // oxlint-disable-next-line no-await-in-loop -- each try follows the one before
      reply = await scheduler.enqueue(task);
    } catch (err) {
      const lost =
        err instanceof RequestFailure &&
        (err.reason === "timeout" || err.reason === "dropped" || err.reason === "disconnected");
      if (lost) {
        if (!(err instanceof RequestFailure && err.reason === "disconnected")) sent = true;
        continue;
      }
      const why =
        err instanceof RequestFailure ? failureReasonText(err) : err instanceof Error ? err.message : String(err);
      return failed(`auto failed: ${why}`);
    }
    if (reply === null) {
      sent = true;
      continue;
    }
    if (!reply.ok) {
      // oxlint-disable-next-line no-await-in-loop -- the last thing this try does: it returns
      await audited(task, { kind: "refused", code: reply.code });
      return failed(`auto refused (${reply.code}): ${storeErrorText(reply.code)}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    await audited(task, { kind: "queued", landedEarlier: reply.landedEarlier });
    const lines = [
      `task ${task.id}: queued${reply.landedEarlier ? " (an earlier try had already stored it)" : ""}`,
      "The scheduler places it as soon as a machine and account can take it; get_queue shows where it lands and why, and cancel_task takes it out.",
    ];
    if (schedulerRefusal(scheduler.availability()) !== null) {
      lines.push(
        "No scheduler is leading right now (or its leader is unverified); the task waits in the relay's queue until one does.",
      );
    }
    return done(lines.join("\n"));
  }
  if (!sent) {
    return failed(`auto: not queued — the relay was unreachable after ${ENQUEUE_ATTEMPTS} tries; try again`);
  }
  await audited(task, { kind: "unanswered" });
  return failed(
    `auto: no answer from the relay after ${ENQUEUE_ATTEMPTS} tries — task ${task.id} may have queued; check get_queue before retrying`,
  );
}
