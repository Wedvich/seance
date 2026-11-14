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

describe("sessionChange wait reason", () => {
  const ask = { ...FROM_A, reason: "permission", tool: "Bash" } as const;

  test("a needs-input event writes its reason and tool; a changed one is a write when the state stands", () => {
    const waiting = sessionChange(task(), "needs-input", ask);
    expect(waiting).toMatchObject({ state: "needs-input", inputReason: "permission", inputTool: "Bash" });
    if (waiting === null) throw new Error("no write");
    expect(sessionChange(waiting, "needs-input", ask)).toBeNull();
    const asked = sessionChange(waiting, "needs-input", { ...FROM_A, reason: "question" });
    expect(asked).toMatchObject({ inputReason: "question" });
    expect(asked).not.toHaveProperty("inputTool");
    const other = sessionChange(waiting, "needs-input", { ...FROM_A, reason: "permission", tool: "Edit" });
    expect(other).toMatchObject({ inputReason: "permission", inputTool: "Edit" });
    const bare = sessionChange(waiting, "needs-input", { ...FROM_A, reason: "permission" });
    expect(bare).toMatchObject({ inputReason: "permission" });
    expect(bare).not.toHaveProperty("inputTool");
  });

  test("an event with no reason removes both; leaving needs-input carries none", () => {
    const waiting = task({ state: "needs-input", inputReason: "permission", inputTool: "Bash" });
    const cleared = sessionChange(waiting, "needs-input", FROM_A);
    expect(cleared).not.toHaveProperty("inputReason");
    expect(cleared).not.toHaveProperty("inputTool");
    expect(sessionChange(waiting, "busy", ask)).not.toHaveProperty("inputReason");
  });

  test("a reservation resolving straight to needs-input takes it; another machine's event writes nothing", () => {
    const reserved = task({
      state: "reserved",
      assignment: undefined,
      reservation: { deviceId: "a", exclave: "main", clone: "app", expiresAt: NOW + 1 },
    });
    expect(sessionChange(reserved, "needs-input", ask)).toMatchObject({ inputReason: "permission", inputTool: "Bash" });
    expect(sessionChange(task(), "needs-input", { deviceId: "b", pane: "%1", reason: "permission" })).toBeNull();
  });

  test("a PR-only event on a standing needs-input strips a wait the event does not carry", () => {
    const waiting = task({ state: "needs-input", inputReason: "permission", inputTool: "Bash" });
    const prUrl = "https://github.com/acme/app/pull/7";
    const written = sessionChange(waiting, "needs-input", FROM_A, prUrl);
    expect(written).toMatchObject({ state: "needs-input", prUrl });
    expect(written).not.toHaveProperty("inputReason");
    expect(written).not.toHaveProperty("inputTool");
  });

  test("a lost task its machine speaks for takes the event's wait, or none when it is back to running", () => {
    const lost = task({ state: "lost", needsInputSince: NOW, inputReason: "permission", inputTool: "Bash" });
    expect(sessionChange(lost, "needs-input", { ...FROM_A, reason: "question" })).toMatchObject({
      state: "needs-input",
      inputReason: "question",
    });
    const running = sessionChange(lost, "busy", FROM_A);
    expect(running?.state).toBe("running");
    expect(running).not.toHaveProperty("inputReason");
    expect(running).not.toHaveProperty("inputTool");
  });

  test("a lost task seen live again returns to needs-input keeping the wait it carried into lost", () => {
    const lost = task({ state: "lost", needsInputSince: NOW, inputReason: "permission", inputTool: "Bash" });
    const entry = { id: "%1", window: "w", repo: "app", path: "/p", taskId: "t" };
    const reply: TaskSessionsReply = { ok: true, sessions: [entry], ledgerSince: NOW - 86_400_000 };
    const at: Observed = { now: NOW + 1, connected: true, reservationTtlMs: 120_000, lostAfterMs: 900_000 };
    expect(settle(lost, reply, at)).toMatchObject({
      state: "needs-input",
      inputReason: "permission",
      inputTool: "Bash",
    });
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

describe("settle a renamed session", () => {
  const observed: Observed = { now: NOW, connected: true, reservationTtlMs: 120_000, lostAfterMs: 900_000 };
  const placed = task({ assignment: { ...ON_A, window: "fix-the-thing" } });
  const listing = (window: string): TaskSessionsReply => ({
    ok: true,
    sessions: [{ id: "%1", window, repo: "app", path: "/p", taskId: "t" }],
  });

  test("a placed task takes the window its machine lists now, keeping its state and the rest of its assignment", () => {
    for (const state of ["running", "needs-input"] as const) {
      expect(settle({ ...placed, state }, listing("login-bug"), observed)).toEqual({
        ...placed,
        state,
        assignment: { ...ON_A, window: "login-bug" },
      });
    }
  });

  test("the same window, or an empty one, is no write", () => {
    expect(settle(placed, listing("fix-the-thing"), observed)).toBeNull();
    expect(settle(placed, listing(""), observed)).toBeNull();
  });
});

describe("the custodian's flag", () => {
  const flag = { reason: "stuck", note: "same error", at: NOW } as const;

  test("a session event never clears it: only the daemon's unflag does", () => {
    const waiting = task({ state: "needs-input", flag, needsInputSince: NOW });
    const busy = sessionChange(waiting, "busy", FROM_A);
    expect(busy).toMatchObject({ state: "running", flag });
    expect(sessionChange(task({ flag }), "busy", FROM_A)).toBeNull();
  });

  test("finishing keeps every reason", () => {
    for (const reason of ["stuck", "look", "dirty", "unpushed"] as const) {
      expect(advance(task({ flag: { reason, at: NOW } }), "done").flag).toEqual({ reason, at: NOW });
    }
  });

  test("a task sent back to ready drops it with the assignment it was raised on", () => {
    const lost = task({ state: "lost", flag, reservedAt: NOW });
    expect(advance(lost, "ready")).not.toHaveProperty("flag");
  });
});
