import {
  queuedTask,
  RequestFailure,
  sentence,
  storeErrorText,
  type Machine,
  type SchedulerAvailability,
  type StoreRefusal,
  type Task,
  type TaskCreated,
  type TaskRequest,
} from "@seance/shared";
import { failureText } from "./errors.ts";
import { SPAWN_CLIENT } from "./relay.ts";

/**
 * `auto`: the form as a task in the relay's store, as the PWA queues one.
 * The store answers the create itself, so no leader need be up; whichever one
 * leads next places it.
 */

/** A task whose create may have landed (or did), kept so the next submit of the same request re-sends the same id. */
export interface Unsettled {
  readonly task: Task;
  /** The request it was built from, serialised: a changed form is a new task. */
  readonly request: string;
}

/**
 * The task to send. Re-sending an unsettled one keeps its id, so a create that
 * had landed answers `landedEarlier` instead of queuing the work twice.
 */
export function taskFor(request: TaskRequest, unsettled: Unsettled | null, now: number): Unsettled {
  const key = JSON.stringify(request);
  if (unsettled !== null && unsettled.request === key) return unsettled;
  return { task: queuedTask({ ...request, client: SPAWN_CLIENT }, now), request: key };
}

export type Enqueued =
  | { readonly kind: "queued"; readonly landedEarlier: boolean }
  /** Nothing was stored. */
  | { readonly kind: "refused"; readonly message: string }
  /** It may have been stored: keep the task, and say to look before retrying. */
  | { readonly kind: "unsure"; readonly message: string };

/** Same remedy as the PWA's `STORE_UNREADABLE`. */
const UNREADABLE = "Couldn't read the relay's answer. Update the extension and the relay to matching versions.";
const CHECK_QUEUE = "It may have queued — check the Queue in the app; Queue again re-sends the same task.";

export async function enqueue(
  create: (task: Task) => Promise<TaskCreated | StoreRefusal | null>,
  task: Task,
): Promise<Enqueued> {
  let reply: TaskCreated | StoreRefusal | null;
  try {
    reply = await create(task);
  } catch (err) {
    // No socket means nothing left this process; anything else (a timeout, a drop) may have landed.
    if (err instanceof RequestFailure && err.reason === "disconnected") {
      return { kind: "refused", message: sentence(failureText(err)) };
    }
    return { kind: "unsure", message: `${sentence(failureText(err))} ${CHECK_QUEUE}` };
  }
  if (reply === null) return { kind: "unsure", message: `${UNREADABLE} ${CHECK_QUEUE}` };
  if (!reply.ok) return { kind: "refused", message: sentence(storeErrorText(reply.code)) };
  return { kind: "queued", landedEarlier: reply.landedEarlier };
}

/**
 * Why a queued task would wait for a leader: none, or one that has not shown it
 * holds the PSK. Neither blocks a submit — the store holds the task — so it is
 * said rather than refused.
 */
const WAITS = {
  none: "No scheduler is leading — the task waits in the queue until one does",
  unverified: "Leader unverified — the task waits until one shows it holds this key",
} as const;

/** Null: a verified leader will place it. */
export function leaderWait(scheduler: SchedulerAvailability): string | null {
  return scheduler.kind === "ready" ? null : WAITS[scheduler.kind];
}

/** Who will place the task, for the form's Scheduler line. */
export function schedulerLine(
  scheduler: SchedulerAvailability,
  machines: readonly Pick<Machine, "deviceId" | "name">[],
): string {
  if (scheduler.kind !== "ready") return WAITS[scheduler.kind];
  const leader = machines.find((machine) => machine.deviceId === scheduler.deviceId);
  return `Led by ${leader?.name ?? "a machine not in the registry"}`;
}
