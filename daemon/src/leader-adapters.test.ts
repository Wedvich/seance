import { describe, expect, test } from "bun:test";
import type { RelayState, SessionsResponse } from "@seance/shared";
import type { AppRelay } from "./app-relay.ts";
import type { LocalOps } from "./handlers.ts";
import { termFleet } from "./leader-adapters.ts";

const unused = (): Promise<never> => Promise.reject(new Error("unexpected relay call"));

/** The term's leg, unreached: every call here is to this machine. */
const relay: AppRelay = {
  start: () => {},
  stop: () => {},
  getState: (): RelayState => {
    throw new Error("unexpected getState");
  },
  subscribe: () => () => {},
  request: unused,
  createTask: unused,
  queue: unused,
  cancel: unused,
  listAccounts: unused,
  onStoreChanged: () => () => {},
};

function fleetOver(sessions: () => Promise<SessionsResponse>, sessionsTimeoutMs?: number) {
  const local: LocalOps = { sessions, spawn: unused, despawn: unused };
  return termFleet({
    relay,
    selfDeviceId: "self",
    local,
    live: () => true,
    demote: () => {},
    ...(sessionsTimeoutMs === undefined ? {} : { sessionsTimeoutMs }),
  });
}

describe("this machine's sessions, from the leader", () => {
  // P1 of the M3 review: it waits for every launch in flight, and the pass waits for it.
  test("past the deadline a remote gets, it is unreachable rather than a pass held open", async () => {
    const never = Promise.withResolvers<SessionsResponse>();
    const started = performance.now();
    const reply = await fleetOver(() => never.promise, 50).sessions("self");
    expect(reply).toMatchObject({ ok: false, code: "unreachable" });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("inside it, the answer as it came", async () => {
    const reply = await fleetOver(() => Promise.resolve({ sessions: [], at: 1, ledgerSince: 0 }), 5_000).sessions(
      "self",
    );
    expect(reply).toEqual({ ok: true, sessions: [], ledgerSince: 0 });
  });

  test("interrupted passes through when it is a subset of ended; an id outside ended is dropped", async () => {
    // A remote's payload as it parses off the wire: not typed, so the bad shapes can be sent.
    const answer = (interrupted: unknown, ended: unknown = ["a", "b"]): Promise<unknown> =>
      fleetOver(
        () => Promise.resolve(JSON.parse(JSON.stringify({ sessions: [], at: 1, ledgerSince: 0, ended, interrupted }))),
        5_000,
      ).sessions("self");
    expect(await answer(["a"])).toMatchObject({ ended: ["a", "b"], interrupted: ["a"] });
    expect(await answer(["a", "zzz", 7])).toMatchObject({ interrupted: ["a"] });
    // Nothing usable left: the field is absent, as an older daemon's reply is read.
    expect(await answer(["zzz"])).not.toHaveProperty("interrupted");
    expect(await answer("a")).not.toHaveProperty("interrupted");
    expect(await answer(["a"], "a")).not.toHaveProperty("interrupted");
  });
});
