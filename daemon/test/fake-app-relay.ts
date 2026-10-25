import {
  RequestFailure,
  SCHEDULER_ID,
  type ErrorResponse,
  type Machine,
  type QueueReply,
  type RelayState,
  type RequestOp,
  type SchedulerOp,
  type StoreRefusal,
  type Task,
  type TaskCreated,
  type TaskReply,
} from "@seance/shared";
import type { AppRelay } from "../src/app-relay.ts";

/**
 * A socketless stand-in for the shared app-role client: registry state the test
 * sets, and requests answered by `respond`. The relay is a network boundary —
 * the real client is exercised against the real relay in e2e.
 */

export function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    deviceId: "device-1",
    name: "MacBook Pro",
    platform: "darwin",
    repos: [{ name: "seance", path: "/repos/seance", defaultBranch: "main" }],
    scannedAt: 1_000,
    lastSeen: 2_000,
    connected: true,
    ...overrides,
  };
}

export interface FakeRelay extends AppRelay {
  requests: { deviceId: string; op: RequestOp; payload: unknown }[];
  started: number;
  stopped: boolean;
  /** Every task `createTask` was handed, in order — a retry shows up as the same task again. */
  creates: Task[];
  /** What a create answers; an Error rejects, null is a reply this build cannot read. Defaults to stored. */
  onCreate: (task: Task) => Promise<TaskCreated | StoreRefusal | null> | TaskCreated | StoreRefusal | null | Error;
  setState: (next: Partial<RelayState>) => void;
}

/**
 * `respond` may return an Error to reject, or a promise to answer later. A
 * scheduler op reaches it with `deviceId` `SCHEDULER_ID`, and only once
 * `state.scheduler` is `ready` — the real client refuses at the source before
 * that, and so does this; e2e holds the two to the same behaviour.
 */
export function fakeRelay(
  machines: readonly Machine[],
  respond: (op: RequestOp, payload: unknown, deviceId: string) => unknown = () => ({}),
  status: RelayState["status"] = "open",
): FakeRelay {
  let state: RelayState = {
    status,
    rejection: status === "rejected" ? "unauthorized" : null,
    machines,
    registrySize: machines.length,
    ignored: 0,
    unbound: 0,
    skewed: 0,
    settling: false,
    registrySettled: status === "open",
    fleetQuota: [],
    scheduler: { kind: "none" },
  };
  const listeners = new Set<() => void>();
  const pending = new Set<(err: Error) => void>();
  const schedule = async <T>(op: SchedulerOp, payload: unknown): Promise<T | ErrorResponse> => {
    if (state.scheduler.kind === "none") throw new RequestFailure("no_leader", "no scheduler is leading");
    if (state.scheduler.kind === "unverified") {
      throw new RequestFailure("leader_unverified", "the scheduler nominee is unverified");
    }
    return fake.request<T>(SCHEDULER_ID, op, payload);
  };
  const fake: FakeRelay = {
    requests: [],
    started: 0,
    stopped: false,
    creates: [],
    onCreate: () => ({ ok: true, landedEarlier: false }),
    setState: (next) => {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    start: () => {
      fake.started += 1;
    },
    // The real client fails every pending request as "dropped" on stop.
    stop: () => {
      fake.stopped = true;
      for (const reject of pending) reject(new RequestFailure("dropped", "client stopped"));
      pending.clear();
    },
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request: async <T>(deviceId: string, op: RequestOp, payload: unknown): Promise<T> => {
      fake.requests.push({ deviceId, op, payload });
      const stopSignal = new Promise<never>((_, reject) => {
        pending.add(reject);
      });
      const reply: unknown = await Promise.race([respond(op, payload, deviceId), stopSignal]);
      if (reply instanceof Error) throw reply;
      // The fake's caller names T; this is the boundary that stands in for the wire.
      return reply as T;
    },
    // A store-put the relay answers itself: no leader gate, as in the real client.
    createTask: async (task) => {
      fake.creates.push(task);
      const reply = await fake.onCreate(task);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    queue: () => schedule<QueueReply | null>("queue", {}),
    cancel: (taskId) => schedule<TaskReply | null>("cancel", { taskId }),
  };
  return fake;
}
