import { describe, expect, test } from "bun:test";
import { runDirOf } from "./sessions.ts";
import { codexSignals, stateOfStatus } from "./events.ts";

const THREAD = "019a7f3e-5b2c-7d4e-8f6a-1b2c3d4e5f60";
const on = (method: string, params: unknown) => codexSignals({ method, params }, THREAD);

describe("codexSignals: the notifications table (docs/codex.md, State)", () => {
  test("a thread's status reads as the session's state", () => {
    expect(on("thread/status/changed", { threadId: THREAD, status: { type: "active", activeFlags: [] } })).toEqual([
      { kind: "state", state: "busy" },
    ]);
    expect(
      on("thread/status/changed", { threadId: THREAD, status: { type: "active", activeFlags: ["waitingOnApproval"] } }),
    ).toEqual([{ kind: "state", state: "needs-input", reason: "permission" }]);
    expect(
      on("thread/status/changed", {
        threadId: THREAD,
        status: { type: "active", activeFlags: ["waitingOnUserInput"] },
      }),
    ).toEqual([{ kind: "state", state: "needs-input", reason: "question" }]);
    // The status's idle is no turn's end: an idle after a `systemError` is one too.
    expect(on("thread/status/changed", { threadId: THREAD, status: { type: "idle" } })).toEqual([
      { kind: "state", state: "idle" },
    ]);
    expect(on("thread/closed", { threadId: THREAD })).toEqual([{ kind: "state", state: "ended" }]);
  });

  test("a turn's start names it for an interrupt, and its completion, however it ended, is the turn's end", () => {
    expect(on("turn/started", { threadId: THREAD, turn: { id: "turn-1", status: "inProgress" } })).toEqual([
      { kind: "turn", turn: "turn-1" },
    ]);
    for (const status of ["completed", "interrupted", "failed"]) {
      expect(on("turn/completed", { threadId: THREAD, turn: { id: "turn-1", status } })).toEqual([
        { kind: "turn", turn: null },
        { kind: "state", state: "idle", turnEnded: true },
      ]);
    }
    // An id no interrupt could carry is no turn the daemon holds.
    expect(on("turn/started", { threadId: THREAD, turn: { id: "a b" } })).toEqual([{ kind: "turn", turn: null }]);
    expect(on("turn/started", { threadId: THREAD, turn: { id: "x".repeat(129) } })).toEqual([
      { kind: "turn", turn: null },
    ]);
  });

  test("bound by construction: another thread's notification, or one naming none, is dropped", () => {
    const other = "019a7f3e-5b2c-7d4e-8f6a-000000000000";
    expect(on("thread/status/changed", { threadId: other, status: { type: "active", activeFlags: [] } })).toEqual([]);
    expect(on("turn/completed", { threadId: other, turn: { id: "t" } })).toEqual([]);
    expect(on("thread/closed", {})).toEqual([]);
    expect(on("thread/closed", null)).toEqual([]);
  });

  test("the login's rate-limit nudge is the account's, whatever thread; everything else is nothing", () => {
    expect(on("account/rateLimits/updated", { rateLimits: {} })).toEqual([{ kind: "rateLimits" }]);
    expect(on("item/agentMessage/delta", { threadId: THREAD, delta: "text" })).toEqual([]);
    expect(on("thread/goal/cleared", { threadId: THREAD })).toEqual([]);
  });

  test("a status it does not know, or garbage, is no state", () => {
    expect(stateOfStatus({ type: "notLoaded" })).toBeNull();
    expect(stateOfStatus({ type: "systemError" })).toBeNull();
    expect(stateOfStatus({ type: "active" })).toBeNull();
    expect(stateOfStatus("idle")).toBeNull();
    expect(stateOfStatus(null)).toBeNull();
  });
});

describe("runDirOf: a Codex pane's run dir from its start command", () => {
  test("the launch's own command, with or without caffeinate", () => {
    expect(runDirOf("exec caffeinate -is /bin/sh '/tmp/seance-cx-AbC123/run.sh'")).toBe("/tmp/seance-cx-AbC123");
    expect(runDirOf("exec /bin/sh '/tmp/seance-cx-x9Y8z7/run.sh'")).toBe("/tmp/seance-cx-x9Y8z7");
  });

  test("anything else names none", () => {
    expect(runDirOf(undefined)).toBeNull();
    expect(runDirOf("claude")).toBeNull();
    expect(runDirOf("exec /bin/sh '/tmp/seance-cu-AbC123/run.sh'")).toBeNull();
    expect(runDirOf("exec /bin/sh '/tmp/seance-cx-../run.sh'")).toBeNull();
  });
});
