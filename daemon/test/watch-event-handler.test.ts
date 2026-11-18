import { describe, expect, test } from "bun:test";
import { APP_ID, SCHEDULER_ID, type Plain } from "@seance/shared";
import type { SessionBackend } from "../src/backend.ts";
import { createHandler, createLocalOps, type HandlerContext } from "../src/handlers.ts";

/**
 * `watch-event` at the daemon, as step 2 leaves it: who may send one and what is answered. Delivering to a session is
 * step 3's, so every valid event is answered with nothing delivered (DESIGN.md, Scheduler, "PR status").
 */

const ID = "5f0c1c1e-8a5f-4d3a-9d6e-0a3f4a2b7c11";
const BOOT = "00000000-0000-4000-8000-000000009000";

const backend: SessionBackend = {
  spawn: () => Promise.reject(new Error("unused")),
  sessions: () => Promise.resolve([]),
  doctor: () => Promise.resolve([]),
};

const ctx: HandlerContext = {
  backend,
  getRepos: () => [],
  rescan: () => Promise.resolve([]),
  auditSink: () => {},
};

const event = {
  set: { gen: { boot: BOOT, n: 1 }, refused: [] },
  events: [{ id: ID, key: "merged", event: { kind: "merged" } }],
};

const request = (payload: unknown): Plain => ({ id: "req-1", ts: Date.now(), op: "watch-event", payload });

describe("watch-event at the daemon", () => {
  test("the scheduler's valid event is answered with nothing delivered", async () => {
    const reply = await createHandler(ctx)(request(event), SCHEDULER_ID);
    expect(reply?.payload).toEqual({ ok: true, delivered: [] });
    expect((await createHandler(ctx)(request({ events: [] }), SCHEDULER_ID))?.payload).toEqual({
      ok: true,
      delivered: [],
    });
  });

  test("an app, another machine, or an unnamed sealer is refused invalid_request", async () => {
    for (const from of [APP_ID, "other-machine", undefined]) {
      // oxlint-disable-next-line no-await-in-loop -- one sealer at a time
      const reply = await createHandler(ctx)(request(event), from);
      expect(reply?.payload).toMatchObject({ ok: false, code: "invalid_request" });
    }
  });

  test("a malformed request is refused invalid_request, never delivered", async () => {
    for (const bad of [
      null,
      "nope",
      {},
      { events: "x" },
      { events: [{ id: ID, key: "merged", event: { kind: "nope" } }] },
      { events: [], extra: 1 },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one payload at a time
      const reply = await createHandler(ctx)(request(bad), SCHEDULER_ID);
      expect(reply?.payload).toMatchObject({ ok: false, code: "invalid_request" });
    }
  });

  test("the leader's own machine is answered in process with the same rules", async () => {
    const ops = createLocalOps(ctx, "leader");
    expect(await ops.watchEvent(event)).toEqual({ ok: true, delivered: [] });
    expect(await ops.watchEvent({ events: "x" })).toMatchObject({ ok: false, code: "invalid_request" });
  });
});
