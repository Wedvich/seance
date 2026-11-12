import { describe, expect, test } from "bun:test";
import { RequestFailure, type RelayState, type SessionsResponse } from "@seance/shared";
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
  runNow: unused,
  listAccounts: unused,
  onStoreChanged: () => () => {},
};

function fleetOver(sessions: () => Promise<SessionsResponse>, sessionsTimeoutMs?: number) {
  const local: LocalOps = { sessions, spawn: unused, despawn: unused, pushBranch: unused };
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

describe("a push-branch from the leader", () => {
  const TIP = "0123456789abcdef0123456789abcdef01234567";
  const request = { taskId: "t-old", expect: "feature/x" };

  function pushFleet(opts: {
    readonly local?: LocalOps["pushBranch"];
    readonly remote?: () => Promise<unknown>;
    readonly live?: boolean;
  }) {
    const asked: { op: string; payload: unknown }[] = [];
    const wire: AppRelay = {
      ...relay,
      request: (<T>(_deviceId: string, op: string, payload: unknown) => {
        asked.push({ op, payload });
        return (opts.remote ?? unused)() as Promise<T>;
      }) as AppRelay["request"],
    };
    const fleet = termFleet({
      relay: wire,
      selfDeviceId: "self",
      local: { sessions: unused, spawn: unused, despawn: unused, pushBranch: opts.local ?? unused },
      live: () => opts.live ?? true,
      demote: () => {},
    });
    return { fleet, asked };
  }

  test("this machine's own is answered in process, never over the relay", async () => {
    const ok = { ok: true, remoteBranch: "feature/x", tip: TIP, pushed: true } as const;
    const seen: unknown[] = [];
    const { fleet, asked } = pushFleet({
      local: (payload) => {
        seen.push(payload);
        return Promise.resolve(ok);
      },
    });
    expect(await fleet.pushBranch?.("self", request)).toEqual(ok);
    expect(seen).toEqual([request]);
    expect(asked).toEqual([]);
  });

  test("another machine's goes over the relay as push-branch, and its answer is parsed before it is believed", async () => {
    const ok = { ok: true, remoteBranch: "feature/x", tip: TIP, pushed: false } as const;
    const good = pushFleet({ remote: () => Promise.resolve(ok) });
    expect(await good.fleet.pushBranch?.("other", request)).toEqual(ok);
    expect(good.asked).toEqual([{ op: "push-branch", payload: request }]);
    const refusal = { ok: false, code: "dirty_worktree", message: "m" } as const;
    expect(await pushFleet({ remote: () => Promise.resolve(refusal) }).fleet.pushBranch?.("other", request)).toEqual(
      refusal,
    );
    for (const bad of [{ ok: true, remoteBranch: "-x", tip: TIP, pushed: true }, { ok: true }, "nope", null]) {
      // oxlint-disable-next-line no-await-in-loop -- one malformed reply at a time
      const reply = await pushFleet({ remote: () => Promise.resolve(bad) }).fleet.pushBranch?.("other", request);
      expect(reply).toMatchObject({ ok: false, code: "internal_error" });
    }
  });

  test("a machine that did not answer is unreachable, or undelivered when nothing can have run", async () => {
    const failing = (reason: "timeout" | "offline") =>
      pushFleet({ remote: () => Promise.reject(new RequestFailure(reason, "no")) }).fleet.pushBranch?.(
        "other",
        request,
      );
    expect(await failing("timeout")).toMatchObject({ ok: false, code: "unreachable" });
    expect(await failing("offline")).toMatchObject({ ok: false, code: "undelivered" });
  });

  test("an ended term pushes nothing, on this machine or another", async () => {
    const { fleet, asked } = pushFleet({ live: false });
    for (const device of ["self", "other"]) {
      // oxlint-disable-next-line no-await-in-loop -- two machines, one answer each
      expect(await fleet.pushBranch?.(device, request)).toMatchObject({ ok: false, code: "unreachable" });
    }
    expect(asked).toEqual([]);
  });
});
