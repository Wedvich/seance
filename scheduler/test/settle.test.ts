import { describe, expect, test } from "bun:test";
import { sessionChange, settle, waitsForExit, type Observed } from "../src/settle.ts";
import type { TaskSessionsReply } from "../src/ports.ts";
import { advance, type Task } from "../src/index.ts";
import { NOW, spec } from "./fixtures.ts";

/** `sessionChange` with `awaitsExit`: an `ended` that waits for the machine's exit status settles nothing itself. */

const ON_A = { deviceId: "a", exclave: "main", clone: "app", pane: "%1" } as const;
const FROM_A = { deviceId: "a", pane: "%1" } as const;
const task = (fields: Partial<Task> = {}): Task => ({
  id: "t",
  spec: spec(),
  state: "running",
  createdAt: NOW,
  assignment: ON_A,
  ...fields,
});

describe("sessionChange awaiting an exit", () => {
  test("a placed task holding its pane is left as it is; a needs-input one too", () => {
    for (const state of ["running", "needs-input"] as const) {
      expect(sessionChange(task({ state }), "ended", FROM_A, undefined, true)).toBeNull();
    }
  });

  test("a placed task with no pane takes the event's, and stays placed", () => {
    const { pane: _pane, ...bare } = ON_A;
    expect(sessionChange(task({ assignment: bare }), "ended", FROM_A, undefined, true)).toMatchObject({
      state: "running",
      assignment: { pane: "%1" },
    });
  });

  test("a lost task whose machine speaks is not settled by the event either", () => {
    expect(sessionChange(task({ state: "lost" }), "ended", FROM_A, undefined, true)).toBeNull();
  });

  test("a PR on the event or the record settles it as ever", () => {
    const pr = "https://github.com/acme/app/pull/7";
    expect(sessionChange(task(), "ended", FROM_A, pr, true)?.state).toBe("awaiting-merge");
    expect(sessionChange(task({ prUrl: pr }), "ended", FROM_A, undefined, true)?.state).toBe("awaiting-merge");
  });
});

describe("sessionChange done (#21)", () => {
  const reported = { spec: spec({ until: "reported" }) } as const;
  const { pane: _pane, ...target } = ON_A;

  test("a placed task settles done by reported, from the machine it is on", () => {
    expect(sessionChange(task(reported), "done", FROM_A)).toMatchObject({ state: "done", doneBy: "reported" });
    expect(sessionChange(task({ ...reported, state: "needs-input" }), "done", FROM_A)?.state).toBe("done");
  });

  test("an awaiting-merge task settles too, and a PR on the report is kept", () => {
    const pr = "https://github.com/acme/app/pull/7";
    expect(sessionChange(task({ ...reported, state: "awaiting-merge" }), "done", FROM_A, pr)).toMatchObject({
      state: "done",
      doneBy: "reported",
      prUrl: pr,
    });
  });

  test("a reserved task settles on the reservation's machine, taking the pane", () => {
    const held = task({
      ...reported,
      state: "reserved",
      assignment: undefined,
      reservation: { ...target, expiresAt: NOW + 60_000 },
    });
    expect(sessionChange(held, "done", FROM_A)).toMatchObject({
      state: "done",
      doneBy: "reported",
      assignment: { deviceId: "a", pane: "%1" },
    });
    expect(sessionChange(held, "done", { deviceId: "b", pane: "%1" })).toBeNull();
  });

  test("a foreign machine, an unnamed sender and an app cannot settle it", () => {
    expect(sessionChange(task(reported), "done", { deviceId: "b", pane: "%1" })).toBeNull();
    expect(sessionChange(task(reported), "done", { deviceId: "app", pane: "%1" })).toBeNull();
    expect(sessionChange(task(reported), "done", undefined)).toBeNull();
  });

  test("under until: merged (or absent) it is ignored", () => {
    expect(sessionChange(task(), "done", FROM_A)).toBeNull();
    expect(sessionChange(task({ spec: spec({ until: "merged" }) }), "done", FROM_A)).toBeNull();
  });

  test("a placed task with no pane takes the report's, as an event does", () => {
    expect(sessionChange(task({ ...reported, assignment: target }), "done", FROM_A)).toMatchObject({
      state: "done",
      assignment: { deviceId: "a", pane: "%1" },
    });
    expect(sessionChange(task({ ...reported, assignment: { ...ON_A, pane: "%9" } }), "done", FROM_A)).toMatchObject({
      assignment: { pane: "%9" },
    });
  });

  test("a task that was never placed is left alone", () => {
    for (const state of ["queued", "blocked", "ready"] as const) {
      expect(sessionChange(task({ ...reported, state, assignment: undefined }), "done", FROM_A)).toBeNull();
    }
  });
});

describe("waitsForExit", () => {
  test("only the machine the task is on, and only a PR-less end", () => {
    expect(waitsForExit(task(), "ended", FROM_A, undefined, true)).toBe(true);
    expect(waitsForExit(task(), "ended", { deviceId: "b", pane: "%1" }, undefined, true)).toBe(false);
    expect(waitsForExit(task(), "ended", undefined, undefined, true)).toBe(false);
    expect(waitsForExit(task(), "ended", FROM_A, undefined, false)).toBe(false);
    expect(waitsForExit(task(), "busy", FROM_A, undefined, true)).toBe(false);
    expect(waitsForExit(task({ state: "queued", assignment: undefined }), "ended", FROM_A, undefined, true)).toBe(
      false,
    );
  });
});

describe("sessionChange remote session", () => {
  const remote = "session_01TuECqfR7Twko9QJm98sWAw";
  const FROM_REMOTE = { ...FROM_A, remoteSession: remote } as const;

  test("a new id is written, with or without a state change; the same id again is no write", () => {
    expect(sessionChange(task(), "busy", FROM_REMOTE)).toMatchObject({ state: "running", remoteSession: remote });
    expect(sessionChange(task(), "needs-input", FROM_REMOTE)).toMatchObject({
      state: "needs-input",
      remoteSession: remote,
    });
    expect(sessionChange(task({ remoteSession: remote }), "busy", FROM_REMOTE)).toBeNull();
    expect(sessionChange(task({ remoteSession: "session_old" }), "busy", FROM_REMOTE)?.remoteSession).toBe(remote);
  });

  test("an event without one keeps the id the record holds", () => {
    expect(sessionChange(task({ remoteSession: remote }), "needs-input", FROM_A)?.remoteSession).toBe(remote);
  });

  test("it resolves a reservation with the id, and an end waiting on the exit still writes it", () => {
    const reserved = task({
      state: "reserved",
      assignment: undefined,
      reservation: { deviceId: "a", exclave: "main", clone: "app", expiresAt: NOW + 1 },
    });
    expect(sessionChange(reserved, "busy", FROM_REMOTE)?.remoteSession).toBe(remote);
    expect(sessionChange(task(), "ended", FROM_REMOTE, undefined, true)).toMatchObject({
      state: "running",
      remoteSession: remote,
    });
  });

  test("another machine's id is never written", () => {
    expect(sessionChange(task(), "needs-input", { deviceId: "b", pane: "%1", remoteSession: remote })).toBeNull();
  });

  test("a task sent back to ready forgets it: the next session has its own", () => {
    const lost = task({ state: "lost", remoteSession: remote, reservedAt: NOW });
    expect(advance(lost, "ready").remoteSession).toBeUndefined();
    expect(advance(task({ remoteSession: remote }), "done").remoteSession).toBe(remote);
  });
});

/** `settle` on a reply that names an id in `ended` and `interrupted`: a launch its machine died in the middle of. */
describe("settle an interrupted launch", () => {
  const TTL = 120_000;
  const observed = (now: number): Observed => ({ now, connected: true, reservationTtlMs: TTL, lostAfterMs: 900_000 });
  const reserved = task({
    state: "reserved",
    assignment: undefined,
    reservedAt: NOW,
    reservation: { deviceId: "a", exclave: "main", clone: "app", expiresAt: NOW + TTL },
  });
  const reply = (fields: Partial<Extract<TaskSessionsReply, { ok: true }>> = {}): TaskSessionsReply => ({
    ok: true,
    sessions: [],
    ledgerSince: NOW - 86_400_000,
    ...fields,
  });

  test("before its TTL it waits, for a pane on a startup dialog to register", () => {
    expect(settle(reserved, reply({ ended: ["t"], interrupted: ["t"] }), observed(NOW + 1))).toBeNull();
  });

  test("past its TTL, with no session, it fails dispatch_unconfirmed and says why", () => {
    const settled = settle(reserved, reply({ ended: ["t"], interrupted: ["t"] }), observed(NOW + TTL));
    expect(settled).toMatchObject({ state: "failed", failure: { code: "dispatch_unconfirmed" } });
    expect(settled?.failure?.message).toContain("restarted");
  });

  test("a session carrying the id settles it running, interrupted or not", () => {
    const entry = { id: "%1", window: "w", repo: "app", path: "/p", taskId: "t" };
    const live = reply({ sessions: [entry], ended: ["t"], interrupted: ["t"] });
    expect(settle(reserved, live, observed(NOW + 1))).toMatchObject({ state: "running" });
    expect(settle(reserved, live, observed(NOW + TTL))).toMatchObject({ state: "running" });
  });

  test("ended alone still resolves before the TTL as done (today's behaviour)", () => {
    expect(settle(reserved, reply({ ended: ["t"] }), observed(NOW + 1))).toMatchObject({ state: "done" });
  });

  test("a never-confirmed lost task fails the same way when its machine returns", () => {
    const lost = task({
      state: "lost",
      reservedAt: NOW,
      assignment: { deviceId: "a", exclave: "main", clone: "app" },
    });
    const settled = settle(lost, reply({ ended: ["t"], interrupted: ["t"] }), observed(NOW + TTL * 5));
    expect(settled).toMatchObject({ state: "failed", failure: { code: "dispatch_unconfirmed" } });
  });
});
