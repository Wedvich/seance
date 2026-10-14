import { RequestFailure, type Machine, type RelayState, type RequestOp } from "@seance/shared";
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
  setState: (next: Partial<RelayState>) => void;
}

/** `respond` may return an Error to reject, or a promise to answer later. */
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
    skewed: 0,
    settling: false,
    registrySettled: status === "open",
  };
  const listeners = new Set<() => void>();
  const pending = new Set<(err: Error) => void>();
  const fake: FakeRelay = {
    requests: [],
    started: 0,
    stopped: false,
    setState: (next) => {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    start: () => {
      fake.started += 1;
    },
    // The real client fails every pending request as "disconnected" on stop.
    stop: () => {
      fake.stopped = true;
      for (const reject of pending) reject(new RequestFailure("disconnected", "client stopped"));
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
  };
  return fake;
}
