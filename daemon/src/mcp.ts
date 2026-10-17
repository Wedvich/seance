import { realpath } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  failureReasonText,
  importPsk,
  RequestFailure,
  QUEUE_MAX_TASKS,
  TASK_REQUEST_LIMITS,
  type Candidate,
  type Decision,
  type DespawnRequest,
  type DespawnResponse,
  type ErrorResponse,
  type Machine,
  type Reason,
  type RepoEntry,
  type RequestOp,
  type SchedulerErrorCode,
  type SessionsResponse,
  type SpawnClient,
  type SpawnRequest,
  type SpawnResponse,
  type Task,
  type TaskRequest,
} from "@seance/shared";
import { appRelayClient, LazyRelay } from "./app-relay.ts";
import { BrokerError } from "./broker-client.ts";
import type { Check } from "./check.ts";
import { loadConfig, loadPsk, type Config } from "./config.ts";
import { exec } from "./exec.ts";
import { userScopeTargets } from "./exclaves.ts";
import {
  brokerFailureText,
  brokerFleet,
  FleetUnreachable,
  relayFleet,
  selectFleet,
  type Fleet,
  type FleetLease,
  type SchedulerLeg,
} from "./fleet.ts";
import { recordedBunCheck, resolvedMain } from "./link.ts";
import { localRequest, localSocketReachable, LocalUnavailable } from "./local-client.ts";
import { readState } from "./state.ts";

/**
 * What this box is, and how to reach its daemon without the relay.
 *
 * Resolved from `config.json` and `state.json` rather than from the registry, so
 * recognising a target as local never depends on the relay being up — which is
 * what lets a local request fail with "the daemon isn't running" instead of
 * quietly paying a round trip to Cloudflare to be told the same thing.
 *
 * `request` is injectable so the tools can be driven without a socket; in
 * production it is `localRequest`.
 */
export interface LocalMachine {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  /**
   * Re-read per call, not snapshotted: the daemon rewrites state.json on every
   * rescan and `seanced mcp` outlives many of them. A snapshot rejects a repo
   * cloned since startup, and rejects every repo if the first scan hadn't landed.
   */
  readonly repos: () => Promise<readonly RepoEntry[]>;
  /** Any op may answer with an `ErrorResponse`, as over the relay. */
  readonly request: <T>(op: RequestOp, payload: unknown) => Promise<T | ErrorResponse>;
  /** Whether its daemon is listening, asked without sending an op — nothing is run or audited. */
  readonly reachable: () => Promise<boolean>;
}

/**
 * Whether a tool's `machine` argument names this box. Same precedence as
 * `resolveMachine`: a deviceId matches exactly, a name case-insensitively.
 *
 * Local wins over a remote machine of the same name, deliberately — the point of
 * the short circuit is that the common case takes no round trip, and a name
 * collision is exactly what `deviceId` is the escape hatch for.
 */
export function isLocalRef(local: LocalMachine, ref: string): boolean {
  return ref === local.deviceId || ref.toLowerCase() === local.name.toLowerCase();
}

/**
 * `machine` is the human name from the target's config, resolved against the
 * live registry; a deviceId is accepted as the exact-match escape hatch for
 * names that collide. Misses come back with the candidates, because the model
 * on the other end of this tool can correct itself from a good error.
 */
export function resolveMachine(
  machines: readonly Machine[],
  ref: string,
): { readonly machine: Machine } | { readonly error: string } {
  const byId = machines.find((machine) => machine.deviceId === ref);
  if (byId !== undefined) return { machine: byId };
  const named = machines.filter((machine) => machine.name.toLowerCase() === ref.toLowerCase());
  const [only] = named;
  if (named.length === 1 && only !== undefined) return { machine: only };
  if (named.length > 1) {
    const ids = named.map((machine) => `${machine.name} (${machine.deviceId})`).join(", ");
    return { error: `"${ref}" names more than one machine — use a deviceId: ${ids}` };
  }
  const known = machines.map((machine) => machine.name).join(", ");
  return { error: `no machine named "${ref}" — known machines: ${known === "" ? "(none registered)" : known}` };
}

interface ToolResult {
  [key: string]: unknown;
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const errorResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function describeMachine(machine: Machine, local: LocalMachine | null): Record<string, unknown> {
  return {
    name: machine.name,
    deviceId: machine.deviceId,
    platform: machine.platform,
    connected: machine.connected,
    lastSeen: new Date(machine.lastSeen).toISOString(),
    repos: machine.repos.map((repo) => repo.name),
    // Named so the model knows which target costs nothing to reach; spawning
    // there goes straight to the daemon on this box.
    local: local !== null && machine.deviceId === local.deviceId,
  };
}

/** The local machine as `list_machines` renders it when the relay cannot be reached at all. */
function describeLocal(local: LocalMachine, reachable: boolean, repos: readonly RepoEntry[]): Record<string, unknown> {
  return {
    name: local.name,
    deviceId: local.deviceId,
    platform: local.platform,
    connected: reachable,
    repos: repos.map((repo) => repo.name),
    local: true,
  };
}

/**
 * Whether the local entry is `connected`. A broker failure already observed the
 * daemon on the very socket local ops use, so its verdict stands; probing again
 * could race a restart and contradict the advice in the same answer.
 */
function localReachable(local: LocalMachine, err: unknown): Promise<boolean> {
  if (err instanceof FleetUnreachable && err.localOps !== "unknown") return Promise.resolve(err.localOps === "up");
  return local.reachable();
}

function fallbackNote(err: unknown, reachable: boolean): string {
  // The broker's advice already says what local ops can expect; adding to it would only repeat or contradict it.
  if (err instanceof FleetUnreachable) return `${err.message} Only this machine is listed.`;
  const why = `the relay is unreachable (${failureText("connect", err)})`;
  return reachable
    ? `${why} — only this machine is listed, and only local spawns will work`
    : `${why} — only this machine is listed, and its daemon is not listening either, so nothing will spawn until ` +
        "seanced is running (`seanced status`)";
}

/** `LocalUnavailable` is the one worth naming a fix for — here, so every flavour of it carries the advice. */
function localFailureText(op: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof LocalUnavailable) {
    return `${op} failed: ${detail} — is seanced running? try \`seanced status\``;
  }
  return `${op} failed: ${detail}`;
}

/**
 * Both legs need this: a handler that throws answers with an `ErrorResponse`, and
 * neither client treats that as a failure — `RequestFailure` is the relay refusing
 * to deliver, not the daemon refusing to serve. Unchecked, `sessions` is undefined
 * and `JSON.stringify` hands `textResult` a non-string.
 */
function renderSessions(reply: SessionsResponse | ErrorResponse): ToolResult {
  if ("ok" in reply) return errorResult(`get_sessions failed (${reply.code}): ${reply.message}`);
  return textResult(JSON.stringify(reply.sessions, null, 2));
}

/** One line per failure whichever transport carried it: a brokered `RequestFailure` renders as the direct one does. */
function failureText(op: string, err: unknown): string {
  const detail =
    err instanceof RequestFailure
      ? failureReasonText(err)
      : err instanceof BrokerError
        ? brokerFailureText(err)
        : err instanceof Error
          ? err.message
          : String(err);
  return `${op} failed: ${detail}`;
}

/** Why the fleet could not be opened at all. A keyless box's reason is self-explanatory; a direct failure is the relay's. */
function openFailureText(err: unknown): string {
  return err instanceof FleetUnreachable ? err.message : failureText("connecting to the relay", err);
}

/**
 * `machine: "auto"`: the scheduler places the spawn. Matched in any case, as
 * names are; a machine actually named "auto" is still reached by its deviceId.
 */
export const AUTO_MACHINE = "auto";

function isAutoRef(ref: string): boolean {
  return ref.toLowerCase() === AUTO_MACHINE;
}

/**
 * Said wherever `auto` is described, because an agent will otherwise take the
 * queue for a backlog. M2's queue is the leader's memory (docs/scheduler.md, M2 gaps).
 */
const AUTO_LIMITS =
  "The scheduler's queue lives only in the leading daemon's memory: a task still waiting for capacity is lost when leadership changes, and it changes on every relay deploy and every daemon self-update. A task already placed is an ordinary session and survives that. There are no dependencies or ordering between tasks. Do not use auto as a durable backlog — submit only work that should start now.";

/** The broker's actions are fixed (DESIGN.md "Fleet broker"), so a keyless box gets no scheduler — and no fallback. */
function keylessText(op: "auto" | "get_queue"): string {
  const instead = op === "auto" ? " — name a machine instead (list_machines)" : "";
  return `${op} needs this machine's own key; unavailable through the broker${instead}`;
}

/** A lost reply must never read as a failure: the task may be queued, and a blind retry would run it twice. */
const MAY_HAVE_QUEUED = "the task may have queued anyway — check get_queue and get_sessions before retrying";

/**
 * `auto`'s `repo` as the scheduler keys it, `RepoEntry.origin`. Callers hold
 * clone names from `list_machines`, so either is accepted: an origin exactly,
 * or a clone name whose clones all share one origin. Clone names are
 * machine-local, so two unrelated repos can share one — picking between them
 * would run the task in the wrong repo, so that is an error naming each.
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
  if (origins.has(repo)) return { origin: repo };
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
 * Past a bound the leader answers `invalid_request`, which reads as a version
 * mismatch — so it is refused here, naming the bound, as the PWA does.
 */
function overBound(field: keyof typeof TASK_REQUEST_LIMITS, value: string | undefined): string | null {
  const limit = TASK_REQUEST_LIMITS[field];
  if (value === undefined || value.length <= limit) return null;
  const fix = field === "prompt" ? " — shorten it (the session can gather the rest with tools), or name a machine" : "";
  return `the ${field} is ${value.length} characters; auto takes at most ${limit}${fix}`;
}

function taskRequestError(request: TaskRequest): string | null {
  return (
    overBound("prompt", request.prompt) ??
    overBound("title", request.title) ??
    overBound("model", request.model) ??
    overBound("effort", request.effort) ??
    overBound("repo", request.repo)
  );
}

/** Every code worded, so a new one fails the build here as it does in the PWA's table. */
const SCHEDULER_ERRORS: Record<SchedulerErrorCode, string> = {
  not_leader: "the scheduler moved to another machine while this was on its way; try again",
  not_ready: "the scheduler is still taking over after a leader change; try again in a few seconds",
  invalid_request:
    "the scheduler refused the request as malformed — are this machine's and the leader's seanced the same version?",
  queue_full:
    "the scheduler already holds as many unfinished tasks as it will take; wait for some to start (get_queue), or name a machine",
  task_not_found: "the scheduler holds no such task",
  dispatching: "the task is starting on a machine right now; try again in a moment",
  finished: "the task has already finished",
  despawn_failed: "its machine refused to end the session; nothing changed",
  conflict: "the task changed while this was on its way; try again",
  reset_unknown: "no quota reading says when that account resets",
  internal_error: "the scheduler hit an error",
  too_large: "the scheduler's answer was too large to send back",
};

/** One clause per code, as the PWA's decision card words them, shortened for a line. */
function reasonText(reason: Reason): string {
  switch (reason.code) {
    case "offline":
      return "offline";
    case "status_stale":
      return "no fresh status";
    case "task_id_unsupported":
      return "its daemon predates task ids";
    case "exclaves_unknown":
      return "its daemon reports no exclaves";
    case "disk_low":
      return `disk nearly full (${reason.freeMib} MiB free)`;
    case "pressure_unknown":
      return "no CPU or memory load reported";
    case "pin_mismatch":
      return reason.field === "deviceId" ? "not the pinned machine" : "not the pinned exclave";
    case "repo_absent":
      return "no clone of this repo";
    case "auth_missing":
      return "not signed in";
    case "quota_unknown":
      return reason.why === "trimmed" ? "quota trimmed from its status" : "quota never observed";
    case "quota_over_line":
      return `${reason.window} quota would reach ${Math.round(reason.projectedPct)}%`;
    case "cap_reached":
      return `${reason.inFlight} of ${reason.max} auto tasks already in flight`;
  }
}

function candidateWhere(candidate: Candidate): string {
  return candidate.exclave === null ? candidate.machine : `${candidate.machine}/${candidate.exclave}`;
}

/** A decision record in one line: who was chosen, and why each other candidate was not. */
export function decisionText(decision: Decision): string {
  const { chosen } = decision;
  const winner =
    chosen === null
      ? undefined
      : decision.candidates.find((c) => c.deviceId === chosen.deviceId && c.exclave === chosen.exclave);
  let head = "no candidate can take it now";
  if (chosen !== null) {
    const where = winner === undefined ? `${chosen.deviceId}/${chosen.exclave}` : candidateWhere(winner);
    const score = winner?.score === undefined ? "" : ` (lowest score, ${winner.score.total.toFixed(2)})`;
    const spill = winner?.spill === undefined ? "" : `, spending credits (${winner.spill.window})`;
    head = `chose ${where}${score}${spill}`;
  }
  const others = decision.candidates
    .filter((c) => c !== winner)
    .map((c) => {
      if (c.rejected.length > 0) return `${candidateWhere(c)}: ${c.rejected.map(reasonText).join(", ")}`;
      if (c.score === undefined) return `${candidateWhere(c)}: rejected for a reason this seanced cannot read`;
      // With nothing chosen a scored candidate lost to something other than its score (a hold, a race).
      const lost = chosen === null ? "scored but not chosen" : "scored higher";
      return `${candidateWhere(c)}: ${lost}, ${c.score.total.toFixed(2)}`;
    });
  return others.length === 0 ? head : `${head}; ${others.join("; ")}`;
}

interface TaskPlacement {
  readonly machine: string;
  readonly deviceId: string;
  readonly exclave: string;
  readonly clone: string;
  readonly window?: string;
}

/** Where a task landed, or is landing, by registry name where this view still has it. */
function placementOf(task: Task, machines: readonly Machine[]): TaskPlacement | null {
  const target = task.assignment ?? task.reservation;
  if (target === undefined) return null;
  const machine =
    machines.find((m) => m.deviceId === target.deviceId)?.name ??
    task.decision?.candidates.find((c) => c.deviceId === target.deviceId)?.machine ??
    target.deviceId;
  const { deviceId, exclave, clone } = target;
  const window = task.assignment?.window;
  return { machine, deviceId, exclave, clone, ...(window === undefined ? {} : { window }) };
}

function describeTask(task: Task, machines: readonly Machine[]): Record<string, unknown> {
  const placement = placementOf(task, machines);
  const { spec } = task;
  return {
    id: task.id,
    state: task.state,
    repo: spec.repo,
    ...(spec.title === undefined ? {} : { title: spec.title }),
    // Cut to QUEUE_PROMPT_PREVIEW by the leader: enough to name the task.
    ...(spec.prompt === undefined ? {} : { prompt: spec.prompt }),
    createdAt: new Date(task.createdAt).toISOString(),
    ...(placement === null ? {} : { placement }),
    ...(task.decision === undefined ? {} : { decision: decisionText(task.decision) }),
    ...(task.failure === undefined ? {} : { failure: `${task.failure.code}: ${task.failure.message}` }),
  };
}

/**
 * Still on its way to a machine, so worth another look before answering. A
 * ready task the last pass routed nowhere waits for capacity — no point
 * holding the tool call for that.
 */
function stillPlacing(task: Task): boolean {
  if (task.state === "reserved") return true;
  return task.state === "ready" && task.decision?.chosen !== null;
}

/** The answer to an `auto` spawn: where the task is and what to do next, worded per state. */
function renderAutoTask(task: Task, machines: readonly Machine[], note: string | null): ToolResult {
  const placement = placementOf(task, machines);
  const window = placement?.window === undefined ? "" : `, window ${placement.window}`;
  const where =
    placement === null
      ? ""
      : ` on ${placement.machine} (exclave ${placement.exclave}, clone ${placement.clone}${window})`;
  const lines = [`task ${task.id}: ${task.state}${where}`];
  if (task.decision !== undefined) lines.push(`decision: ${decisionText(task.decision)}`);
  if (task.failure !== undefined) lines.push(`failure (${task.failure.code}): ${task.failure.message}`);
  const machine = placement?.machine ?? "its machine";
  switch (task.state) {
    case "running":
    case "needs-input":
      lines.push(
        `It is an ordinary session now: get_sessions on ${machine} lists it with taskId ${task.id}, and despawn_session ends it.`,
      );
      break;
    case "awaiting-merge":
    case "done":
      lines.push(`Its session on ${machine} has already ended.`);
      break;
    case "reserved":
      lines.push(`Its spawn on ${machine} is still in flight — check get_queue for the outcome.`);
      break;
    case "lost":
      lines.push(
        `${machine} stopped answering before the spawn was confirmed — check get_sessions there before retrying.`,
      );
      break;
    case "failed":
    case "cancelled":
      break;
    default:
      lines.push(
        "Not placed yet: it waits in the leader's memory for capacity, and a leader change drops it. Check get_queue; if it is gone with no session to show for it, submit again or name a machine.",
      );
  }
  if (note !== null) lines.push(note);
  const text = lines.join("\n");
  const settledBadly = task.state === "failed" || task.state === "lost" || task.state === "cancelled";
  return settledBadly ? errorResult(text) : textResult(text);
}

/**
 * Why a scheduler call threw. A reply lost on `submit` is "may have queued",
 * never "failed": the leader may have queued it before the answer went missing.
 */
function schedulerFailureText(op: "auto" | "get_queue", err: unknown): string {
  if (err instanceof RequestFailure) {
    if (err.reason === "no_leader" || err.reason === "leader_unverified") {
      const instead = op === "auto" ? " — name a machine instead (list_machines)" : "";
      return `${op} unavailable: ${failureReasonText(err)}${instead}`;
    }
    if (op === "auto" && (err.reason === "timeout" || err.reason === "disconnected")) {
      return `auto: no answer from the scheduler (${err.message}) — ${MAY_HAVE_QUEUED}`;
    }
    return `${op} failed: ${failureReasonText(err)}`;
  }
  const detail = err instanceof Error ? err.message : String(err);
  return op === "auto" ? `auto: ${detail} — ${MAY_HAVE_QUEUED}` : `${op} failed: ${detail}`;
}

export interface McpServerOpts {
  /** How an `auto` spawn follows its task to a machine through `queue`; tests shorten it. */
  readonly autoFollow?: { readonly intervalMs: number; readonly polls: number };
}

/** About as long as a spawn takes to land and be confirmed; a task still placing past it is reported as such. */
const AUTO_FOLLOW = { intervalMs: 1_000, polls: 20 } as const;

/**
 * Submits, then re-reads `queue` while the task is on its way to a machine,
 * so the answer names where it landed. The leader routes on submit, so this
 * is usually a poll or two. Nothing here ever submits twice.
 */
async function spawnAuto(
  scheduler: SchedulerLeg,
  machines: readonly Machine[],
  request: TaskRequest,
  follow: NonNullable<McpServerOpts["autoFollow"]>,
): Promise<ToolResult> {
  let reply: Awaited<ReturnType<SchedulerLeg["submit"]>>;
  try {
    reply = await scheduler.submit(request);
  } catch (err) {
    return errorResult(schedulerFailureText("auto", err));
  }
  if (reply === null) {
    return errorResult(
      `auto: the scheduler's answer was unreadable (a seanced version mismatch?) — ${MAY_HAVE_QUEUED}`,
    );
  }
  if ("ok" in reply) {
    // `too_large` judges the reply, not the submit; a crashed handler may have got as far as queueing.
    const landed = reply.code === "too_large" || reply.code === "internal_error" ? ` — ${MAY_HAVE_QUEUED}` : "";
    return errorResult(`auto failed (${reply.code}): ${SCHEDULER_ERRORS[reply.code]}${landed}`);
  }
  let task = reply.task;
  const { id } = task;
  let seen = false;
  for (let poll = 0; poll < follow.polls && stillPlacing(task); poll += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each poll follows the one before
    await Bun.sleep(follow.intervalMs);
    let queue: Awaited<ReturnType<SchedulerLeg["queue"]>>;
    try {
      // oxlint-disable-next-line no-await-in-loop -- as above
      queue = await scheduler.queue();
    } catch (err) {
      const why = schedulerFailureText("get_queue", err);
      return renderAutoTask(task, machines, `Queued, but following it went wrong (${why}) — check get_queue.`);
    }
    // An unreadable or refused poll is one poll lost, not a verdict: the next asks again.
    if (queue === null || "ok" in queue) continue;
    seen = true;
    const found = queue.tasks.find((t) => t.id === id);
    if (found === undefined) {
      // The reply is the newest QUEUE_MAX_TASKS only: a full one may just have scrolled past this task.
      if (queue.tasks.length >= QUEUE_MAX_TASKS) {
        return renderAutoTask(
          task,
          machines,
          "Newer tasks pushed it out of the queue's view before it was seen placed — check get_sessions before submitting again.",
        );
      }
      return errorResult(
        `task ${id} was queued, then left the leader's queue before it was placed — the leader probably changed, which drops waiting tasks. Check get_sessions before submitting again.`,
      );
    }
    task = found;
  }
  // Each refused poll was not a verdict, but all of them together are worth saying.
  const unread =
    !seen && stillPlacing(task) ? "Queued, but the scheduler never answered a follow-up read — check get_queue." : null;
  return renderAutoTask(task, machines, unread);
}

/**
 * The MCP face of Séance: tools mapping 1:1 onto the registry and the
 * `sessions`/`spawn`/`despawn` ops, plus the scheduler's `submit` and `queue`
 * behind `machine: "auto"` and `get_queue`. Anything this hands to the relay rides the same
 * envelope crypto as the PWA — there is no separate MCP wire surface, whether
 * this process seals it or the daemon's broker does (`fleet.ts`).
 *
 * `local` is what makes a self-targeted call skip the relay: the per-machine
 * ops go straight to this box's daemon over its op socket, which is the same
 * handler the relay leg reaches and so the same backend, repo set, machineTag
 * and audit trail — only tagged `origin=local`. Null on a box with no daemon
 * state, where every target is remote by definition.
 */
export function buildMcpServer(fleet: Fleet, local: LocalMachine | null = null, opts: McpServerOpts = {}): McpServer {
  const follow = opts.autoFollow ?? AUTO_FOLLOW;
  // 0.0.0 mirrors the package: the daemon versions by git sha, not semver.
  const server = new McpServer({ name: "seance", version: "0.0.0" });

  // Every tool bumps the idle clock via open/release, even ones that fail.
  const withFleet = async (fn: (lease: FleetLease) => Promise<ToolResult>): Promise<ToolResult> => {
    let lease: FleetLease;
    try {
      lease = await fleet.open();
    } catch (err) {
      return errorResult(openFailureText(err));
    }
    try {
      return await fn(lease);
    } finally {
      lease.release();
    }
  };

  server.registerTool(
    "list_machines",
    {
      title: "List machines",
      description:
        "List the dev machines registered with the Séance relay: name, platform, connectivity, and the repos each one can spawn a Claude Code session in. Offline machines are listed with their last-seen time.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      let lease: FleetLease;
      try {
        lease = await fleet.open();
      } catch (err) {
        // The fleet needs the relay, but this box does not. Answering with the
        // local machine alone beats answering with nothing: a model that cannot
        // see any machine cannot spawn on the one it is sitting on either.
        if (local === null) return errorResult(openFailureText(err));
        const [reachable, repos] = await Promise.all([localReachable(local, err), local.repos()]);
        return textResult(
          JSON.stringify(
            { machines: [describeLocal(local, reachable, repos)], note: fallbackNote(err, reachable) },
            null,
            2,
          ),
        );
      }
      try {
        const machines = lease.machines.map((machine) => describeMachine(machine, local));
        return textResult(JSON.stringify(machines, null, 2));
      } finally {
        lease.release();
      }
    },
  );

  server.registerTool(
    "get_sessions",
    {
      title: "List running sessions",
      description:
        "List the Claude Code tmux sessions currently running on a machine. Naming this machine answers from the local daemon without touching the relay.",
      inputSchema: z.object({ machine: z.string().describe("Machine name (or deviceId) from list_machines") }),
      annotations: { readOnlyHint: true },
    },
    async ({ machine }) => {
      if (local !== null && isLocalRef(local, machine)) {
        try {
          return renderSessions(await local.request<SessionsResponse>("sessions", {}));
        } catch (err) {
          return errorResult(localFailureText("get_sessions", err));
        }
      }
      return withFleet(async (lease) => {
        const resolved = resolveMachine(lease.machines, machine);
        if ("error" in resolved) return errorResult(resolved.error);
        try {
          return renderSessions(await lease.request<SessionsResponse>(resolved.machine.deviceId, "sessions", {}));
        } catch (err) {
          return errorResult(failureText("get_sessions", err));
        }
      });
    },
  );

  server.registerTool(
    "get_queue",
    {
      title: "List the scheduler's queue",
      description: `List the scheduler's newest tasks — the ones spawn_session with machine "auto" submitted from any client — with each one's state, where it was placed, and why the latest routing decision chose or rejected each machine. Prompts are cut to a preview. ${AUTO_LIMITS}`,
      annotations: { readOnlyHint: true },
    },
    async () =>
      withFleet(async (lease) => {
        if (lease.scheduler === null) return errorResult(keylessText("get_queue"));
        let reply: Awaited<ReturnType<SchedulerLeg["queue"]>>;
        try {
          reply = await lease.scheduler.queue();
        } catch (err) {
          return errorResult(schedulerFailureText("get_queue", err));
        }
        if (reply === null)
          return errorResult("get_queue: the scheduler's answer was unreadable (a seanced version mismatch?)");
        if ("ok" in reply) return errorResult(`get_queue failed (${reply.code}): ${SCHEDULER_ERRORS[reply.code]}`);
        const tasks = reply.tasks.map((task) => describeTask(task, lease.machines));
        return textResult(JSON.stringify({ at: new Date(reply.at).toISOString(), tasks }, null, 2));
      }),
  );

  server.registerTool(
    "spawn_session",
    {
      title: "Spawn a Claude Code session",
      description: `Spawn a remote-controlled Claude Code session on a machine, in a named repo. Defaults to a fresh git worktree; mode "here" runs in the repo's main checkout instead. Naming this machine goes straight to the local daemon, with no relay round trip; if a remote machine shares this one's name, reach it by deviceId. machine "auto" hands the spawn to the scheduler, which picks the machine and account and answers with the task id, where it landed and why; it needs this machine's own key, the relay and a scheduler leading, and caps the prompt at ${TASK_REQUEST_LIMITS.prompt} characters. ${AUTO_LIMITS}`,
      inputSchema: z.object({
        machine: z
          .string()
          .describe('Machine name (or deviceId) from list_machines, or "auto" to let the scheduler place the session'),
        repo: z
          .string()
          .describe(
            "Repo name from that machine's repo list. With machine \"auto\": a repo name from list_machines that means one repo across the fleet, or the repo's origin (host/path) when it does not",
          ),
        prompt: z.string().optional().describe("The task for the spawned session"),
        title: z
          .string()
          .optional()
          .describe(
            "Name for the spawned Claude session — also names the window the backend runs it in, and the worktree branched for it. Defaults to a slug of the prompt.",
          ),
        mode: z.enum(["worktree", "here"]).default("worktree"),
        model: z.string().optional().describe('Model for the session, e.g. "opus"'),
        effort: z.string().optional().describe('Reasoning effort, e.g. "medium"'),
        plan: z
          .boolean()
          .optional()
          .describe(
            "Start the session in plan mode: it researches and writes an implementation plan for approval instead of editing files. Set this when the request is to plan, design, investigate or scope work rather than carry it out. Omit it otherwise.",
          ),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ machine, repo, prompt, title, mode, model, effort, plan }) => {
      if (isAutoRef(machine)) {
        // `client` is not a TaskRequest field: the leader stamps its own
        // dispatch `client=scheduler`, so the target audits the session as the
        // scheduler's. Empty model/effort mean "default", which a task spells as absent.
        const task = {
          mode,
          ...(prompt === undefined ? {} : { prompt }),
          ...(title === undefined ? {} : { title }),
          ...(model === undefined || model === "" ? {} : { model }),
          ...(effort === undefined || effort === "" ? {} : { effort }),
          ...(plan === undefined ? {} : { plan }),
        };
        // Refused before the fleet opens: no relay round trip to learn the prompt is too long.
        const tooLong = taskRequestError({ repo, ...task });
        if (tooLong !== null) return errorResult(`auto refused: ${tooLong}`);
        return withFleet(async (lease) => {
          // Never a fallback: through the broker there is no scheduler leg at all.
          if (lease.scheduler === null) return errorResult(keylessText("auto"));
          const resolved = resolveOrigin(lease.machines, repo);
          if ("error" in resolved) return errorResult(resolved.error);
          // The origin a clone name resolved to is what the leader bounds, not the name.
          const longOrigin = overBound("repo", resolved.origin);
          if (longOrigin !== null) return errorResult(`auto refused: ${longOrigin}`);
          return spawnAuto(lease.scheduler, lease.machines, { repo: resolved.origin, ...task }, follow);
        });
      }
      const request: SpawnRequest = {
        repo,
        mode,
        client: "mcp" satisfies SpawnClient,
        ...(prompt === undefined ? {} : { prompt }),
        ...(title === undefined ? {} : { title }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(plan === undefined ? {} : { plan }),
      };
      const rendered = (reply: SpawnResponse, where: string): ToolResult => {
        if (!reply.ok) {
          // `too_large` judges the reply, not the spawn: a success embeds the
          // session list, so an agent must look before it retries.
          const look = reply.code === "too_large" ? " — it may be running; check get_sessions" : "";
          return errorResult(`spawn failed (${reply.code}): ${reply.message}${look}`);
        }
        const note = reply.note === undefined ? "" : `\nnote: ${reply.note}`;
        const state = reply.pending === true ? " (started, not registered yet)" : "";
        return textResult(`spawned window ${reply.window} on ${where} at ${reply.path}${state}${note}`);
      };

      if (local !== null && isLocalRef(local, machine)) {
        // Same pre-check as the relay path and for the same reason — the daemon
        // resolves the repo authoritatively, this just answers with candidates
        // instead of costing a round trip to be told `repo_not_found`. An empty
        // set means the first scan hasn't landed, not that there are no repos:
        // deny nothing then, and let the daemon answer.
        const repos = await local.repos();
        if (repos.length > 0 && !repos.some((entry) => entry.name === repo)) {
          const known = repos.map((entry) => entry.name).join(", ");
          return errorResult(`${local.name} has no repo named "${repo}" — its repos: ${known}`);
        }
        try {
          return rendered(await local.request<SpawnResponse>("spawn", request), local.name);
        } catch (err) {
          return errorResult(localFailureText("spawn_session", err));
        }
      }

      return withFleet(async (lease) => {
        const resolved = resolveMachine(lease.machines, machine);
        if ("error" in resolved) return errorResult(resolved.error);
        const target = resolved.machine;
        if (!target.connected) {
          return errorResult(`${target.name} is not connected — last seen ${new Date(target.lastSeen).toISOString()}`);
        }
        if (!target.repos.some((entry) => entry.name === repo)) {
          const known = target.repos.map((entry) => entry.name).join(", ");
          return errorResult(`${target.name} has no repo named "${repo}" — its repos: ${known}`);
        }
        try {
          return rendered(await lease.request<SpawnResponse>(target.deviceId, "spawn", request), target.name);
        } catch (err) {
          return errorResult(failureText("spawn_session", err));
        }
      });
    },
  );

  server.registerTool(
    "despawn_session",
    {
      title: "End a Claude Code session",
      description:
        "End a running Claude Code session on a machine and close its window. Asks claude to /exit — a worktree session keeps its worktree — and kills it if it hasn't exited within about five seconds; force kills straight away. Take the id from get_sessions. Naming this machine goes straight to the local daemon.",
      inputSchema: z.object({
        machine: z.string().describe("Machine name (or deviceId) from list_machines"),
        id: z.string().describe('The session\'s id from get_sessions, e.g. "%12"'),
        force: z.boolean().optional().describe("Kill without asking claude to exit first"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ machine, id, force }) => {
      const request: DespawnRequest = {
        id,
        client: "mcp" satisfies SpawnClient,
        ...(force === true ? { force } : {}),
      };
      // An `ErrorResponse` (a crashed handler) is `ok: false` too, and renders the same way.
      const rendered = (reply: DespawnResponse | ErrorResponse, where: string): ToolResult => {
        if (!reply.ok) return errorResult(`despawn failed (${reply.code}): ${reply.message}`);
        return textResult(`${reply.outcome} ${reply.window} on ${where}`);
      };

      if (local !== null && isLocalRef(local, machine)) {
        try {
          return rendered(await local.request<DespawnResponse>("despawn", request), local.name);
        } catch (err) {
          return errorResult(localFailureText("despawn_session", err));
        }
      }

      return withFleet(async (lease) => {
        const resolved = resolveMachine(lease.machines, machine);
        if ("error" in resolved) return errorResult(resolved.error);
        const target = resolved.machine;
        if (!target.connected) {
          return errorResult(`${target.name} is not connected — last seen ${new Date(target.lastSeen).toISOString()}`);
        }
        try {
          return rendered(await lease.request<DespawnResponse>(target.deviceId, "despawn", request), target.name);
        } catch (err) {
          return errorResult(failureText("despawn_session", err));
        }
      });
    },
  );

  return server;
}

/**
 * This box, as the tools see it, or null when no daemon state exists here — a
 * checkout that has never run `seanced` has no deviceId, and `readState` will
 * not invent one just to answer the question.
 */
export async function localMachine(config: Config): Promise<LocalMachine | null> {
  const state = await readState();
  if (state === null) return null;
  return {
    deviceId: state.deviceId,
    name: config.name,
    platform: process.platform,
    // Falls back to the startup read: a transient failure shouldn't read as "no repos".
    repos: async (): Promise<readonly RepoEntry[]> => (await readState())?.repos ?? state.repos,
    request: <T>(op: RequestOp, payload: unknown): Promise<T | ErrorResponse> => localRequest<T>(op, payload),
    reachable: (): Promise<boolean> => localSocketReachable(),
  };
}

/**
 * The fleet as `seanced mcp` reaches it. The PSK is resolved on first remote
 * use, not at startup, because local ops need no key at all; when this process
 * can read none — the key exists only as a credential systemd delivers to the
 * daemon's unit — remote ops go through the daemon's broker instead, and the
 * key never enters this process. `selectFleet` memoizes the direct choice and
 * re-asks the stores after a while when there was nothing to find.
 */
function mcpFleet(config: Config): Fleet {
  return selectFleet({
    key: async (): Promise<CryptoKey | null> => {
      const resolved = await loadPsk(config);
      return resolved === null ? null : importPsk(resolved.psk);
    },
    direct: (key) =>
      relayFleet(
        // stdout carries the protocol frames — the wire log must land on stderr.
        new LazyRelay({ create: () => appRelayClient(config, key, (line) => console.error(line)) }),
      ),
    broker: brokerFleet(),
  });
}

/** `seanced mcp` — serve MCP over stdio until the client hangs up. */
export async function runMcpServer(): Promise<void> {
  const config = await loadConfig();
  const local = await localMachine(config);
  const fleet = mcpFleet(config);
  const handle = serveStdio(() => buildMcpServer(fleet, local), {
    onerror: (err) => console.error(`mcp: ${err.message}`),
  });
  await new Promise<void>((resolve) => {
    // The SDK's stdio transport watches 'data' but never 'end', so a client
    // that exits without signalling would leave this process — and any open
    // relay socket — orphaned behind it.
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
  });
  await handle.close();
  fleet.stop();
  process.exit(0);
}

/** `Command:` line of `claude mcp get` — the interpreter Claude Code will exec. Null when the output doesn't parse. */
export function mcpBunPath(output: string): string | null {
  return /^\s*Command:\s*(.+?)\s*$/mu.exec(output)?.[1] ?? null;
}

/**
 * `Args:` line of `claude mcp get`, minus the trailing `mcp` subcommand — the
 * script Claude Code will run. Null when the output doesn't parse.
 */
export function mcpScriptPath(output: string): string | null {
  return /^\s*Args:\s*(.+?)\s+mcp\s*$/mu.exec(output)?.[1] ?? null;
}

/**
 * Null when the entry runs this checkout's main.ts, compared realpath to realpath
 * so a symlinked checkout path still matches. Otherwise the stale-clone hazard
 * `modChecksFrom` guards for mods: an entry left pointing at another clone runs
 * *its* code, and fails in every session once that clone is deleted or never had
 * `bun install` run. Exported for tests; `current` defaults to `resolvedMain()`.
 */
export async function mcpScriptCheck(recorded: string | null, label: string, current?: string): Promise<Check | null> {
  if (recorded === null) return null;
  const [real, expected] = await Promise.all([realpath(recorded).catch(() => recorded), current ?? resolvedMain()]);
  if (real === expected) return null;
  return {
    level: "warn",
    message: `MCP entry (${label}) runs ${recorded}, not this checkout's ${expected} — \`seanced mcp install\` repoints it`,
  };
}

/** Whether each exclave's Claude Code knows about `seanced mcp`, and whether its recorded bun and script are current; renders under doctor's binaries section. */
export async function mcpChecks(): Promise<readonly Check[]> {
  const claude = Bun.which("claude");
  if (claude === null) {
    return [{ level: "warn", message: "claude not on PATH — `seanced mcp install` needs Claude Code" }];
  }
  const { present } = await userScopeTargets();
  const perTarget = await Promise.all(
    present.map(async (target): Promise<readonly Check[]> => {
      const result = await exec([claude, "mcp", "get", "seance"], { timeoutMs: 15_000, env: target.env });
      if (result.exitCode !== 0) {
        return [
          {
            level: "warn",
            message: `MCP server not registered with Claude Code in ${target.label} — run \`seanced mcp install\``,
          },
        ];
      }
      const registered: Check = { level: "ok", message: `MCP server registered with Claude Code in ${target.label}` };
      // Same drift hazard as the plist/unit: `mcp install` records PATH's bun and
      // this checkout's main.ts in Claude's config, and nothing rewrites that entry
      // on its own.
      const findings = await Promise.all([
        recordedBunCheck(mcpBunPath(result.stdout), `MCP entry (${target.label})`, "seanced mcp install"),
        mcpScriptCheck(mcpScriptPath(result.stdout), target.label),
      ]);
      return [registered].concat(findings.filter((check) => check !== null));
    }),
  );
  return perTarget.flat();
}
