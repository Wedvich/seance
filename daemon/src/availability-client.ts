import {
  CAPABILITIES,
  closedAt,
  isTransportError,
  parseAvailabilityResponse,
  RequestFailure,
  failureReasonText,
  lastHeardAt,
  type AvailabilityRequest,
} from "@seance/shared";
import { advertises, resolveMachine, type AutoEnqueued } from "./auto.ts";
import { SCHEDULER_NEEDS_NEWER_DAEMON, type FleetLease } from "./fleet.ts";

/**
 * Closing and reopening a machine as an app-role client does it, apart from the MCP SDK so `seanced
 * close`/`open` and `set_machine_open` share one rule (as `passAuto` is shared). Nothing here may
 * call `log.ts`: `seanced mcp` reaches it, and its stdout is the JSON-RPC channel.
 */

const KEYLESS_TEXT =
  "not sent — closing or opening a machine needs this machine's key, which is service-delivered here; use the PWA's Machines screen, or seanced on a machine whose key is readable";

const OLD_LEADER_TEXT =
  "not closed — the scheduler's leader predates closing machines, and would fail tasks sent here instead of routing them elsewhere; update seanced on the leader's machine";

const done = (text: string): AutoEnqueued => ({ ok: true, text });
const failed = (text: string): AutoEnqueued => ({ ok: false, text });

/**
 * `ref` is a machine's name or deviceId, null for this machine, which is `selfId` in the registry. Always
 * over the relay as app-role, this machine included: a lease with no relay path (the broker) refuses.
 */
export async function setMachineOpen(opts: {
  readonly ref: string | null;
  readonly selfId: string | null;
  readonly open: boolean;
  readonly lease: FleetLease;
}): Promise<AutoEnqueued> {
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
  // A reopen needs only the target, so a close can always be undone.
  if (!open) {
    if (lease.scheduler === null) return failed(`not closed — ${SCHEDULER_NEEDS_NEWER_DAEMON}`);
    if (!advertises(lease.machines, lease.scheduler.availability(), CAPABILITIES.drain)) return failed(OLD_LEADER_TEXT);
  }
  if (!target.connected) {
    return failed(`${target.name} is not connected — last seen ${new Date(lastHeardAt(target)).toISOString()}`);
  }
  const request: AvailabilityRequest = { open };
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
  if (closedAt(target) === reply.closed) {
    return done(`${target.name} was already closed (since ${new Date(reply.closed).toISOString()})`);
  }
  return done(`${target.name} is closed to new work; running work finishes where it is`);
}
