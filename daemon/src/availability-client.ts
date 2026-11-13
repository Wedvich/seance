import {
  CAPABILITIES,
  closedAt,
  drainStuckText,
  drainSummary,
  drainView,
  isTransportError,
  parseAvailabilityResponse,
  QUEUE_MAX_TASKS,
  RequestFailure,
  failureReasonText,
  lastHeardAt,
  type AvailabilityRequest,
  type SessionsResponse,
  type Task,
} from "@seance/shared";
import { advertises, resolveMachine, type AutoEnqueued } from "./auto.ts";
import { SCHEDULER_NEEDS_NEWER_DAEMON, type Fleet, type FleetLease, type SchedulerLeg } from "./fleet.ts";
import { RESTART_GRACE_MS } from "./local-client.ts";

/**
 * Closing and reopening a machine as an app-role client does it, apart from the MCP SDK so `seanced
 * close`/`open` and `set_machine_open` share one rule (as `passAuto` is shared). Nothing here may
 * call `log.ts`: `seanced mcp` reaches it, and its stdout is the JSON-RPC channel.
 */

const KEYLESS_TEXT =
  "not sent — closing or opening a machine needs this machine's key, which is service-delivered here; use the PWA's Machines screen, or seanced on a machine whose key is readable";

const OLD_LEADER_TEXT =
  "not closed — the scheduler's leader predates closing machines, and would fail tasks sent here instead of routing them elsewhere; update seanced on the leader's machine";

/** A close or open's answer; a close that stands also names the machine and the `cl` it carries, which `waitForDrain` needs. */
export interface AvailabilityOutcome extends AutoEnqueued {
  readonly closed?: { readonly deviceId: string; readonly name: string; readonly at: number };
}

const done = (text: string, closed?: AvailabilityOutcome["closed"]): AvailabilityOutcome => ({
  ok: true,
  text,
  ...(closed === undefined ? {} : { closed }),
});
const failed = (text: string): AvailabilityOutcome => ({ ok: false, text });

/**
 * `ref` is a machine's name or deviceId, null for this machine, which is `selfId` in the registry. Always
 * over the relay as app-role, this machine included: a lease with no relay path (the broker) refuses.
 */
export async function setMachineOpen(opts: {
  readonly ref: string | null;
  readonly selfId: string | null;
  readonly open: boolean;
  /** Closing only, and only to a target advertising `drainAsk`: its sessions are interrupted at once, not after 5 minutes. */
  readonly now?: boolean;
  readonly lease: FleetLease;
}): Promise<AvailabilityOutcome> {
  const { lease, open } = opts;
  if (lease.appRequest === undefined) return failed(KEYLESS_TEXT);
  let target;
  if (opts.ref === null) {
    if (opts.selfId === null) return failed("this machine has no daemon state, so it names no machine here");
    target = lease.machines.find((m) => m.deviceId === opts.selfId);
    if (target === undefined)
      return failed("this machine is not in the registry — is seanced running? try `seanced status`");
  } else {
    const resolved = resolveMachine(lease.machines, opts.ref);
    if ("error" in resolved) return failed(resolved.error);
    target = resolved.machine;
  }
  if (target.capabilities?.includes(CAPABILITIES.close) !== true) {
    return failed(`${target.name} cannot be opened or closed yet — its daemon needs \`seanced update\``);
  }
  const asks = target.capabilities?.includes(CAPABILITIES.drainAsk) === true;
  const now = opts.now === true && !open;
  if (now && !asks) return failed(`${target.name} cannot drain now yet — its daemon needs \`seanced update\``);
  // A reopen needs only the target, so a close can always be undone.
  if (!open) {
    if (lease.scheduler === null) return failed(`not closed — ${SCHEDULER_NEEDS_NEWER_DAEMON}`);
    if (!advertises(lease.machines, lease.scheduler.availability(), CAPABILITIES.drain)) return failed(OLD_LEADER_TEXT);
  }
  if (!target.connected) {
    return failed(`${target.name} is not connected — last seen ${new Date(lastHeardAt(target)).toISOString()}`);
  }
  const request: AvailabilityRequest = { open, ...(now ? { now: true } : {}) };
  let reply;
  try {
    reply = parseAvailabilityResponse(await lease.appRequest(target.deviceId, "availability", request));
  } catch (err) {
    const why =
      err instanceof RequestFailure ? failureReasonText(err) : err instanceof Error ? err.message : String(err);
    return failed(`${open ? "open" : "close"} failed: ${why}`);
  }
  if (reply === null) return failed(`${open ? "open" : "close"} failed: unreadable reply`);
  if (!reply.ok) {
    const note = isTransportError(reply.code) ? " — it may or may not have landed" : "";
    return failed(`${open ? "open" : "close"} failed (${reply.code}): ${reply.message}${note}`);
  }
  if (reply.closed === null) return done(`${target.name} is open for work`);
  const closed = { deviceId: target.deviceId, name: target.name, at: reply.closed };
  if (closedAt(target) === reply.closed) {
    const since = new Date(reply.closed).toISOString();
    return done(
      asks && now
        ? `${target.name} was already closed (since ${since}); its sessions are being interrupted now`
        : `${target.name} was already closed (since ${since})`,
      closed,
    );
  }
  // Only a leader that advertises `drainPass` passes the work off; an older one leaves it where it is.
  const passes = advertises(
    lease.machines,
    lease.scheduler?.availability() ?? { kind: "none" },
    CAPABILITIES.drainPass,
  );
  if (asks) {
    const when = now ? "interrupted now" : "interrupted after 5 minutes";
    const left = passes ? "; any left are passed to other machines in 10 minutes unless you reopen it" : "";
    return done(
      `${target.name} is closed to new work; its sessions are asked to pass themselves at their next pause (${when})${left}`,
      closed,
    );
  }
  return done(
    passes
      ? `${target.name} is closed to new work; its running tasks will be passed to other machines in 10 minutes unless you reopen it`
      : `${target.name} is closed to new work; running work finishes where it is`,
    closed,
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface DrainWaitOutcome {
  readonly code: 0 | 1 | 2;
  readonly text: string;
}

/**
 * The queue's tasks, plus the ones a capped reply left out that a pane carries (asked by id: the reply
 * keeps the newest unfinished first, so a long-running task on a closed box falls out under a backlog).
 * The broker's leg carries no request (`queueByIdUnsupported`), so through it those stay unknown and a reader
 * counts them as moving (DESIGN.md, "Closing a machine").
 * Null when the queue could not be read.
 */
export async function queueTasksFor(
  leg: Pick<SchedulerLeg, "queue" | "queueByIdUnsupported">,
  paneTaskIds: readonly string[],
): Promise<readonly Task[] | null> {
  const reply = await leg.queue().catch(() => null);
  if (reply === null || !("tasks" in reply)) return null;
  const known = new Set(reply.tasks.map((t) => t.id));
  const missing = [...new Set(paneTaskIds.filter((id) => !known.has(id)))].slice(0, QUEUE_MAX_TASKS);
  if (missing.length === 0 || leg.queueByIdUnsupported === true) return reply.tasks;
  const more = await leg.queue({ tasks: missing }).catch(() => null);
  if (more === null || !("tasks" in more)) return reply.tasks;
  // A leader that predates the filter answers its newest again: keep only what was asked for and what we lack.
  const asked = new Set(missing);
  return [...reply.tasks, ...more.tasks.filter((t) => asked.has(t.id) && !known.has(t.id))];
}

const UNREADABLE_POLLS = 60;

/**
 * Blocks until the machine named by a close is empty (code 0) or only work that cannot move is left
 * (code 2, one line per item), and fails (code 1) when it reopens or goes offline. Polls: no frame says
 * "empty". `closedAt` is the close reply's `cl`: status lags a close by up to the relay's status floor, so
 * a status without `cl` is a reopen only when it was sampled after the close (`at` later than `closedAt`) or
 * after this close's own `cl` had shown (a status sampled before the close, or an older close's `cl`, is that
 * lag; a later `cl` is a reopen and a new close). A single failed read or a momentary disconnect (a daemon
 * restarting itself) never ends the wait: it takes an outage of `offlineGraceMs` (default `RESTART_GRACE_MS`,
 * the daemon's own restart budget), or `UNREADABLE_POLLS` unreadable polls in a row.
 * Nothing here may call `log.ts`.
 */
export async function waitForDrain(opts: {
  readonly fleet: Fleet;
  readonly deviceId: string;
  readonly closedAt: number;
  readonly pollMs?: number;
  /** How long a machine may stay offline before the wait gives up; tests only. */
  readonly offlineGraceMs?: number;
  readonly print?: (line: string) => void;
}): Promise<DrainWaitOutcome> {
  const { fleet, deviceId } = opts;
  const pollMs = opts.pollMs ?? 5_000;
  const print = opts.print ?? ((): void => undefined);
  let sawCurrent = false;
  let lastLine = "";
  const offlineGraceMs = opts.offlineGraceMs ?? RESTART_GRACE_MS;
  let offlineSince: number | null = null;
  let unreadable = 0;
  for (;;) {
    let lease: FleetLease;
    try {
      // oxlint-disable-next-line no-await-in-loop -- each poll reads the fleet afresh
      lease = await fleet.open();
    } catch (err) {
      print(`could not read the fleet: ${err instanceof Error ? err.message : String(err)}`);
      // oxlint-disable-next-line no-await-in-loop -- a wait between polls
      await sleep(pollMs);
      continue;
    }
    // Labelled so the offline branch leaves through `finally` (the lease is released) to the common sleep.
    poll: try {
      const machine = lease.machines.find((m) => m.deviceId === deviceId);
      if (machine === undefined || !machine.connected) {
        offlineSince ??= Date.now();
        if (Date.now() - offlineSince >= offlineGraceMs)
          return { code: 1, text: `${machine?.name ?? deviceId} went offline while draining` };
        break poll;
      }
      offlineSince = null;
      const cl = closedAt(machine);
      if (cl === opts.closedAt) sawCurrent = true;
      // `status.at` (seconds) and `closedAt` are the daemon's own clock: a status sampled after the close that
      // carries no `cl` says the machine was reopened before this close ever showed.
      const sampledAfter = machine.status !== undefined && machine.status.at * 1000 > opts.closedAt;
      if ((cl === null && (sawCurrent || sampledAfter)) || (cl !== null && cl > opts.closedAt)) {
        return { code: 1, text: `${machine.name} was reopened; the drain stopped` };
      }
      // oxlint-disable-next-line no-await-in-loop -- sessions first: they say which tasks the queue must name
      const reply = await lease.request<SessionsResponse>(deviceId, "sessions", {}).catch(() => null);
      const sessions = reply === null || "ok" in reply ? null : reply;
      const paneIds = (sessions?.sessions ?? []).flatMap((x) => (x.taskId === undefined ? [] : [x.taskId]));
      // oxlint-disable-next-line no-await-in-loop -- the second queue read depends on the sessions
      const tasks = lease.scheduler === null ? null : await queueTasksFor(lease.scheduler, paneIds);
      let line: string;
      if (sessions === null || tasks === null) {
        unreadable += 1;
        if (unreadable >= UNREADABLE_POLLS) {
          return {
            code: 1,
            text: `${machine.name}: could not read ${sessions === null ? "its sessions" : "the queue"}`,
          };
        }
        line = `${machine.name}: could not read ${sessions === null ? "its sessions" : "the queue"}; trying again`;
      } else {
        unreadable = 0;
        const view = drainView(machine, tasks, sessions.sessions, opts.closedAt);
        const lineOf = (s: (typeof view.stuck)[number]): string => `${s.taskId ?? "-"} ${drainStuckText(s)}`;
        if (view.empty === true) {
          const unplaced = view.stuck.filter((s) => s.reason === "unplaced").map(lineOf);
          return { code: 0, text: [`${machine.name} is empty`, ...unplaced].join("\n") };
        }
        const closing = sessions.sessions.some((s) => tasks.find((t) => t.id === s.taskId)?.successor !== undefined);
        const blocking = view.stuck.filter((s) => s.reason !== "unplaced");
        if (view.moving.length === 0 && !closing && blocking.length > 0) {
          return { code: 2, text: `${machine.name} still runs:\n${view.stuck.map(lineOf).join("\n")}` };
        }
        line = `${machine.name}: ${drainSummary(view)}`;
      }
      if (line !== lastLine) print(line);
      lastLine = line;
    } finally {
      lease.release();
    }
    // oxlint-disable-next-line no-await-in-loop -- a wait between polls, not before an assertion
    await sleep(pollMs);
  }
}
