import {
  accountNameIn,
  CAPABILITIES,
  closedAt,
  drainStart,
  drainStuckText,
  drainSummary,
  drainView,
  isTransportError,
  parseAvailabilityResponse,
  QUEUE_MAX_TASKS,
  RequestFailure,
  failureReasonText,
  knownAccounts,
  lastHeardAt,
  leaderCloseNote,
  leadsQueue,
  schedulerErrorText,
  type AvailabilityRequest,
  type SessionsResponse,
  type Task,
} from "@seance/shared";
import { advertises, resolveAccount, resolveMachine, type AutoEnqueued } from "./auto.ts";
import { SCHEDULER_NEEDS_NEWER_DAEMON, type Fleet, type FleetLease, type SchedulerLeg } from "./fleet.ts";
import { RESTART_GRACE_MS } from "./local-client.ts";

/**
 * Closing and reopening a machine as an app-role client does it, apart from the MCP SDK so `seance
 * close`/`open` and `set_machine_open` share one rule (as `passAuto` is shared). Nothing here may
 * call `log.ts`: `seance mcp` reaches it, and its stdout is the JSON-RPC channel.
 */

const KEYLESS_TEXT =
  "not sent — closing or opening a machine needs this machine's key, which is service-delivered here; use the PWA's Machines screen, or seanced on a machine whose key is readable";

const OLD_LEADER_TEXT =
  "not closed — the scheduler's leader predates closing machines, and would fail tasks sent here instead of routing them elsewhere; update seanced on the leader's machine";

/**
 * A close or open's answer; a close that stands also names the machine, the `cl` it carries and whether its drain
 * has started (false only for a soft close, sent or found), which `waitForDrain` needs.
 */
export interface AvailabilityOutcome extends AutoEnqueued {
  readonly closed?: {
    readonly deviceId: string;
    readonly name: string;
    readonly at: number;
    readonly draining: boolean;
  };
}

const done = (text: string, closed?: AvailabilityOutcome["closed"]): AvailabilityOutcome => ({
  ok: true,
  text,
  ...(closed === undefined ? {} : { closed }),
});
const failed = (text: string): AvailabilityOutcome => ({ ok: false, text });

const KEYLESS_ACCOUNT_TEXT =
  "not sent — closing or opening an account needs this machine's key, which is service-delivered here; use the PWA's Machines screen, or seanced on a machine whose key is readable";

/**
 * Closes an account to new scheduled work, or reopens it: an account hold until resumed at the leader (`pause`), or
 * its `resume`, which lifts any hold on it, a reset hold included (DESIGN.md, "Closing an account"). The leader holds
 * only placements, never a running session. `ref` is the account's id, email or alias, resolved as a pin's is. Only
 * on a leg with a key of its own (`SchedulerLeg.holds`): the broker does not carry `pause`.
 */
export async function setAccountOpen(opts: {
  readonly ref: string;
  readonly open: boolean;
  readonly lease: FleetLease;
}): Promise<AutoEnqueued> {
  const { lease, open } = opts;
  const verb = open ? "open" : "close";
  const leg = lease.scheduler;
  if (leg?.holds === undefined) return failed(KEYLESS_ACCOUNT_TEXT);
  const records = await leg.accounts();
  const matched = resolveAccount(lease.machines, records, opts.ref, "account");
  if ("error" in matched) return failed(matched.error);
  const { accountId } = matched;
  let reply;
  try {
    reply = open
      ? await leg.holds.resume({ account: accountId })
      : await leg.holds.pause({ until: "resume", account: accountId });
  } catch (err) {
    const why =
      err instanceof RequestFailure ? failureReasonText(err) : err instanceof Error ? err.message : String(err);
    return failed(`${verb} failed: ${why}`);
  }
  if (reply === null)
    return failed(`${verb} failed: the scheduler's answer was unreadable — it may or may not have landed`);
  if ("ok" in reply) {
    const note = isTransportError(reply.code) ? " — it may or may not have landed" : "";
    return failed(`${verb} failed (${reply.code}): ${schedulerErrorText(reply.code)}${note}`);
  }
  const alias = records?.find((record) => record.accountId === accountId)?.alias ?? undefined;
  const name = `${accountNameIn(knownAccounts(lease.machines), accountId, alias)} (${accountId})`;
  if (open) return done(`${name} is open for work`);
  return done(
    `${name} is closed to new scheduled work: the scheduler places nothing new on it, a task pinned to it waits, and its running sessions keep going`,
  );
}

/**
 * `ref` is a machine's name or deviceId, null for this machine, which is `selfId` in the registry. Always
 * over the relay as app-role, this machine included: a lease with no relay path (the broker) refuses.
 */
export async function setMachineOpen(opts: {
  readonly ref: string | null;
  readonly selfId: string | null;
  readonly open: boolean;
  /** Closing only, and only to a target advertising `drainAsk`: its sessions are interrupted at once, not after 5 minutes. Implies `drain`. */
  readonly now?: boolean;
  /**
   * Closing only: start the drain (the close before soft close existed). Without it a close is soft wherever the
   * target and the verified leader advertise `softClose`, and a plain close (which drains) elsewhere.
   */
  readonly drain?: boolean;
  readonly lease: FleetLease;
}): Promise<AvailabilityOutcome> {
  const { lease, open } = opts;
  if (lease.appRequest === undefined) return failed(KEYLESS_TEXT);
  let target;
  if (opts.ref === null) {
    if (opts.selfId === null) return failed("this machine has no daemon state, so it names no machine here");
    target = lease.machines.find((m) => m.deviceId === opts.selfId);
    if (target === undefined)
      return failed("this machine is not in the registry — is seanced running? try `seance status`");
  } else {
    const resolved = resolveMachine(lease.machines, opts.ref);
    if ("error" in resolved) return failed(resolved.error);
    target = resolved.machine;
  }
  if (target.capabilities?.includes(CAPABILITIES.close) !== true) {
    return failed(`${target.name} cannot be opened or closed yet — its daemon needs \`seance update\``);
  }
  const asks = target.capabilities?.includes(CAPABILITIES.drainAsk) === true;
  const now = opts.now === true && !open;
  if (now && !asks) return failed(`${target.name} cannot drain now yet — its daemon needs \`seance update\``);
  // A reopen needs only the target, so a close can always be undone.
  if (!open) {
    if (lease.scheduler === null) return failed(`not closed — ${SCHEDULER_NEEDS_NEWER_DAEMON}`);
    if (!advertises(lease.machines, lease.scheduler.availability(), CAPABILITIES.drain)) return failed(OLD_LEADER_TEXT);
  }
  if (!target.connected) {
    return failed(`${target.name} is not connected — last seen ${new Date(lastHeardAt(target)).toISOString()}`);
  }
  const leader = lease.scheduler?.availability() ?? { kind: "none" };
  // Soft only where both ends know it: an older daemon would drop `soft` and drain, an older leader pass on `cl` alone.
  const soft =
    !open &&
    !now &&
    opts.drain !== true &&
    target.capabilities?.includes(CAPABILITIES.softClose) === true &&
    advertises(lease.machines, leader, CAPABILITIES.softClose);
  const request: AvailabilityRequest = { open, ...(now ? { now: true } : {}), ...(soft ? { soft: true } : {}) };
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
  const wasClosed = closedAt(target) === reply.closed;
  // Already closed and draining: a soft request changes nothing (`unchanged`), a drain request starts nothing new.
  const wasDraining = wasClosed && drainStart(target) !== null;
  const closed = { deviceId: target.deviceId, name: target.name, at: reply.closed, draining: !soft || wasDraining };
  // It keeps leading while closed: said on every close that stands, fresh or not, soft or not.
  const leads = leadsQueue(target, leader);
  const standing = (text: string): AvailabilityOutcome =>
    done(leads ? `${text}\n${leaderCloseNote(target.name)}` : text, closed);
  // Only a leader that advertises `drainPass` passes the work off; an older one leaves it where it is.
  const passes = advertises(lease.machines, leader, CAPABILITIES.drainPass);
  const drainText = (): string => {
    if (asks) {
      const when = now ? "interrupted now" : "interrupted after 5 minutes";
      const left = passes ? "; any left are passed to other machines in 10 minutes unless you reopen it" : "";
      return `its sessions are asked to pass themselves at their next pause (${when})${left}`;
    }
    return passes
      ? "its running tasks will be passed to other machines in 10 minutes unless you reopen it"
      : "running work finishes where it is";
  };
  if (wasClosed) {
    const since = new Date(reply.closed).toISOString();
    if (soft || wasDraining) {
      return standing(
        asks && now
          ? `${target.name} was already closed (since ${since}); its sessions are being interrupted now`
          : `${target.name} was already closed (since ${since})`,
      );
    }
    // A soft-closed machine: this request started its drain (`drain_started`).
    return standing(`${target.name} was already closed (since ${since}); draining it: ${drainText()}`);
  }
  if (soft) {
    return standing(
      `${target.name} is closed to new work; its running tasks keep going until they finish or you drain it`,
    );
  }
  return standing(`${target.name} is closed to new work; ${drainText()}`);
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
 * `idle` is the reply's `QueueResponse.idle` ids (complete whatever the cap), what `drainView` reads a task idle at
 * its prompt by. Null when the queue could not be read.
 */
export async function queueTasksFor(
  leg: Pick<SchedulerLeg, "queue" | "queueByIdUnsupported">,
  paneTaskIds: readonly string[],
): Promise<DrainQueue | null> {
  const reply = await leg.queue().catch(() => null);
  if (reply === null || !("tasks" in reply)) return null;
  const idle = (reply.idle ?? []).map((ref) => ref.taskId);
  const known = new Set(reply.tasks.map((t) => t.id));
  const missing = [...new Set(paneTaskIds.filter((id) => !known.has(id)))].slice(0, QUEUE_MAX_TASKS);
  if (missing.length === 0 || leg.queueByIdUnsupported === true) return { tasks: reply.tasks, idle };
  const more = await leg.queue({ tasks: missing }).catch(() => null);
  if (more === null || !("tasks" in more)) return { tasks: reply.tasks, idle };
  // A leader that predates the filter answers its newest again: keep only what was asked for and what we lack.
  const asked = new Set(missing);
  return { tasks: [...reply.tasks, ...more.tasks.filter((t) => asked.has(t.id) && !known.has(t.id))], idle };
}

export interface DrainQueue {
  readonly tasks: readonly Task[];
  readonly idle: readonly string[];
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
  /** The close drained (`AvailabilityOutcome.closed.draining`): false waits for the tasks to finish on their own, and says so. */
  readonly draining: boolean;
  readonly pollMs?: number;
  /** How long a machine may stay offline before the wait gives up; tests only. */
  readonly offlineGraceMs?: number;
  readonly print?: (line: string) => void;
}): Promise<DrainWaitOutcome> {
  const { fleet, deviceId } = opts;
  const pollMs = opts.pollMs ?? 5_000;
  const print = opts.print ?? ((): void => undefined);
  let sawCurrent = false;
  let saidSoft = false;
  let saidIdle = false;
  let draining = opts.draining;
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
      // A drain the owner starts while this waits shows from the status (`drainStart`).
      // Sticky: the reopen that ends it carries no `dr`, and must still read as the drain's.
      if (drainStart(machine) !== null) draining = true;
      if ((cl === null && (sawCurrent || sampledAfter)) || (cl !== null && cl > opts.closedAt)) {
        return { code: 1, text: `${machine.name} was reopened; the ${draining ? "drain" : "wait"} stopped` };
      }
      // oxlint-disable-next-line no-await-in-loop -- sessions first: they say which tasks the queue must name
      const reply = await lease.request<SessionsResponse>(deviceId, "sessions", {}).catch(() => null);
      const sessions = reply === null || "ok" in reply ? null : reply;
      const paneIds = (sessions?.sessions ?? []).flatMap((x) => (x.taskId === undefined ? [] : [x.taskId]));
      // oxlint-disable-next-line no-await-in-loop -- the second queue read depends on the sessions
      const queue = lease.scheduler === null ? null : await queueTasksFor(lease.scheduler, paneIds);
      if (!draining && !saidSoft) {
        print(
          `${machine.name}: waiting for its tasks to finish on their own; nothing is moved until you drain it (seance close --drain), and a task idle at its prompt never finishes`,
        );
        saidSoft = true;
      }
      let line: string;
      if (sessions === null || queue === null) {
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
        const { tasks } = queue;
        const view = drainView(machine, tasks, sessions.sessions, { cl: opts.closedAt, draining, idle: queue.idle });
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
        // A soft close's wait ends only when its tasks do, and an idle or waiting one never does: say so once, not by hanging.
        const onlyStuck = !draining && view.moving.length > 0 && view.moving.every((m) => m.idle || m.waitingOnYou);
        if (onlyStuck && !saidIdle) {
          print(
            `${machine.name}: nothing left is running; what remains sits idle at its prompt or waits on you and will not finish on its own. Drain it (seance close --drain), or stop this wait`,
          );
        }
        saidIdle = onlyStuck;
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
