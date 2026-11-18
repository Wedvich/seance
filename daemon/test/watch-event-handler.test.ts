import { describe, expect, test } from "bun:test";
import { APP_ID, SCHEDULER_ID, type Plain, type WatchEventRequest, type WatchEventResponse } from "@seance/shared";
import type { SessionBackend } from "../src/backend.ts";
import { createHandler, createLocalOps, type HandlerContext } from "../src/handlers.ts";

/**
 * `watch-event` at the daemon: who may send one and what is answered. The handler checks the sender and the shape and
 * hands the parsed request to the watch table (`watches.ts`, tested in `watches.test.ts`); a daemon with no table
 * answers `unsupported`, so the leader keeps every event unacknowledged (DESIGN.md, Scheduler, "PR status"; "Watches").
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

const event: WatchEventRequest = {
  set: { gen: { boot: BOOT, n: 1 }, refused: [] },
  events: [{ id: ID, key: "merged", event: { kind: "merged" } }],
};

const request = (payload: unknown): Plain => ({ id: "req-1", ts: Date.now(), op: "watch-event", payload });

const unsupported: WatchEventResponse = { ok: false, code: "unsupported", message: "this daemon keeps no watches" };

describe("watch-event at the daemon", () => {
  test("with no watch table, the scheduler's valid event is answered unsupported", async () => {
    expect((await createHandler(ctx)(request(event), SCHEDULER_ID))?.payload).toEqual(unsupported);
    expect((await createHandler(ctx)(request({ events: [] }), SCHEDULER_ID))?.payload).toEqual(unsupported);
  });

  test("with one, the parsed request reaches it and its answer is returned", async () => {
    const seen: WatchEventRequest[] = [];
    const withTable: HandlerContext = {
      ...ctx,
      watches: {
        onEvent: (parsed) => {
          seen.push(parsed);
          return Promise.resolve({ ok: true, delivered: [ID] });
        },
      },
    };
    const reply = await createHandler(withTable)(request(event), SCHEDULER_ID);
    expect(reply?.payload).toEqual({ ok: true, delivered: [ID] });
    expect(seen).toEqual([event]);
    // The sender and shape checks come first: a refused request never reaches the table.
    await createHandler(withTable)(request(event), APP_ID);
    await createHandler(withTable)(request({ events: "x" }), SCHEDULER_ID);
    expect(seen).toHaveLength(1);
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
    expect(await ops.watchEvent(event)).toEqual(unsupported);
    const tabled = createLocalOps(
      { ...ctx, watches: { onEvent: () => Promise.resolve({ ok: true, delivered: [ID] }) } },
      "leader",
    );
    expect(await tabled.watchEvent(event)).toEqual({ ok: true, delivered: [ID] });
    expect(await ops.watchEvent({ events: "x" })).toMatchObject({ ok: false, code: "invalid_request" });
  });
});
