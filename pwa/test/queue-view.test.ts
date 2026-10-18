import { describe, expect, test } from "bun:test";
import {
  QUEUE_MAX_TASKS,
  type Decision,
  type ExclaveInfo,
  type Machine,
  type PauseHold,
  type RelayState,
  type Task,
} from "@seance/shared";
import { deriveQueue } from "../src/queue-view.ts";
import { DEFAULT_FORM, type QueueState } from "../src/state.ts";
import { failedBody, type AppState } from "../src/view.ts";

const NOW = 1_800_000_000_000;
const ORIGIN = "github.com/acme/app";

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    deviceId: "dev-a",
    name: "Mac",
    platform: "darwin",
    repos: [],
    scannedAt: NOW,
    lastSeen: NOW,
    connected: true,
    ...overrides,
  };
}

function state(
  queueView: QueueState | null,
  overrides: Partial<AppState> = {},
  relay: Partial<RelayState> = {},
): AppState {
  const machines = relay.machines ?? [machine()];
  return {
    relay: {
      status: "open",
      rejection: null,
      machines,
      registrySize: machines.length,
      ignored: 0,
      unbound: 0,
      skewed: 0,
      settling: false,
      registrySettled: true,
      scheduler: { kind: "ready", deviceId: "dev-a", term: 1 },
      ...relay,
    },
    form: DEFAULT_FORM,
    promptUndo: null,
    sheet: null,
    settings: false,
    machines: false,
    history: null,
    spawning: false,
    rescanning: false,
    rescan: "idle",
    verdict: null,
    preview: null,
    sessions: {},
    queue: true,
    wide: false,
    queueView,
    taskAction: null,
    queueNotice: null,
    pausing: false,
    ...overrides,
  };
}

function task(id: string, fields: Partial<Task> = {}): Task {
  return { id, spec: { repo: ORIGIN, mode: "worktree" }, state: "ready", createdAt: NOW - 120_000, ...fields };
}

const placedAt = { deviceId: "dev-a", exclave: "default", clone: "app", window: "w" };
const decision: Decision = { at: NOW, chosen: null, candidates: [] };

function ok(tasks: readonly Task[], holds: readonly PauseHold[] = []): QueueState {
  return { kind: "ok", tasks, holds, at: NOW };
}

function titles(view: ReturnType<typeof deriveQueue>): string[] {
  return view.sections.map((section) => section.title);
}

describe("deriveQueue", () => {
  test("groups by what each task needs, in a fixed order, dropping empty sections and keeping the leader's order within one", () => {
    const view = deriveQueue(
      state(
        ok([
          task("done", { state: "done", doneBy: "session" }),
          task("w1", { state: "queued" }),
          task("run", { state: "running", assignment: placedAt }),
          task("merge", { state: "awaiting-merge" }),
          task("lost", { state: "lost" }),
          task("w2", { state: "blocked" }),
          task("ask", { state: "needs-input", assignment: placedAt }),
          task("starting", { state: "reserved" }),
          task("stuck", {
            state: "needs-input",
            assignment: placedAt,
            escalated: true,
            needsInputSince: NOW - 3_600_000,
          }),
          task("bad", { state: "failed", failure: { code: "repo_not_found", message: "no" } }),
          task("gone", { state: "cancelled" }),
        ]),
      ),
      NOW,
    );
    expect(titles(view)).toEqual(["Needs you", "Running", "Waiting", "Awaiting merge", "Finished"]);
    const ids = (title: string): string[] => view.sections.find((s) => s.title === title)?.rows.map((r) => r.id) ?? [];
    // Escalated first, then the rest of needs-input, then lost.
    expect(ids("Needs you")).toEqual(["stuck", "ask", "lost"]);
    expect(ids("Running")).toEqual(["run", "starting"]);
    expect(ids("Waiting")).toEqual(["w1", "w2"]);
    expect(ids("Awaiting merge")).toEqual(["merge"]);
    expect(ids("Finished")).toEqual(["done", "bad", "gone"]);

    const only = deriveQueue(state(ok([task("w1")])), NOW);
    expect(titles(only)).toEqual(["Waiting"]);
  });

  test("an escalated task says how long it has waited, and attention follows it", () => {
    const stuck = task("stuck", { state: "needs-input", escalated: true, needsInputSince: NOW - 3 * 3_600_000 });
    const view = deriveQueue(state(ok([stuck])), NOW);
    expect(view.sections[0]?.rows[0]).toMatchObject({ dot: "err", body: "Waiting for input since 3h ago" });
    expect(view.attention).toBe(true);
    const quiet = deriveQueue(state(ok([task("ask", { state: "needs-input" })])), NOW);
    expect(quiet.attention).toBe(false);
    expect(quiet.sections[0]?.rows[0]?.body).toBeNull();
  });

  test("a failed task is worded by failedBody, including the codes the scheduler sets itself", () => {
    for (const code of ["lost_expired", "merge_expired", "repo_not_found", "queue_expired"]) {
      const view = deriveQueue(state(ok([task("f", { state: "failed", failure: { code, message: "m" } })])), NOW);
      expect(view.sections[0]?.rows[0]?.body).toBe(failedBody(code));
      expect(view.sections[0]?.rows[0]?.dot).toBe("err");
    }
  });

  test("a row's title is the task's, else its prompt's first line cut to 80, else its window (unless it is the daemon's `session` fallback), else its repo", () => {
    const rows = deriveQueue(
      state(
        ok([
          task("a", { spec: { repo: ORIGIN, mode: "worktree", title: "Fix the thing", prompt: "ignored" } }),
          task("b", { spec: { repo: ORIGIN, mode: "worktree", prompt: `\n${"x".repeat(100)}\nsecond` } }),
          task("c", { spec: { repo: ORIGIN, mode: "worktree", prompt: "first\nsecond" } }),
          task("d"),
          task("e", { state: "done", doneBy: "session", assignment: { ...placedAt, window: "fix-the-flaky-test" } }),
          task("f", { state: "cancelled" }),
          task("g", { state: "done", doneBy: "session", assignment: { ...placedAt, window: "session" } }),
          task("h", { state: "done", doneBy: "session", assignment: { ...placedAt, window: "session-12" } }),
          task("i", { state: "done", doneBy: "session", assignment: { ...placedAt, window: "session-notes" } }),
        ]),
      ),
      NOW,
    ).sections.flatMap((section) => section.rows);
    expect(rows.map((r) => [r.id, r.title])).toEqual([
      ["a", "Fix the thing"],
      ["b", `${"x".repeat(79)}…`],
      ["c", "first"],
      ["d", "acme/app"],
      ["e", "fix-the-flaky-test"],
      ["f", "acme/app"],
      ["g", "acme/app"],
      ["h", "acme/app"],
      ["i", "session-notes"],
    ]);
  });

  test("cancel and mark done are offered unless the task is dispatching or finished; only a placed one's cancel ends a session", () => {
    const rowOf = (fields: Partial<Task>): ReturnType<typeof deriveQueue>["sections"][number]["rows"][number] => {
      const row = deriveQueue(state(ok([task("t", fields)])), NOW).sections[0]?.rows[0];
      if (row === undefined) throw new Error("no row");
      return row;
    };
    for (const stateName of [
      "queued",
      "blocked",
      "ready",
      "running",
      "needs-input",
      "lost",
      "awaiting-merge",
    ] as const) {
      expect(rowOf({ state: stateName })).toMatchObject({ canCancel: true, canMarkDone: true });
    }
    for (const stateName of ["reserved", "done", "failed", "cancelled"] as const) {
      expect(rowOf({ state: stateName })).toMatchObject({ canCancel: false, canMarkDone: false });
    }
    expect(rowOf({ state: "running" }).cancelEndsSession).toBe(true);
    expect(rowOf({ state: "ready" }).cancelEndsSession).toBe(false);
    expect(rowOf({ state: "needs-input" }).markDoneEndsSession).toBe(true);
    expect(rowOf({ state: "lost" }).markDoneEndsSession).toBe(true);
  });

  test("a row's decision is placed ('did') by its assignment, so a waiting task marked done never reads as placed", () => {
    const waitingDone = task("a", { state: "done", doneBy: "manual", decision });
    const running = task("b", { state: "running", assignment: placedAt, decision });
    const view = deriveQueue(state(ok([waitingDone, running])), NOW);
    const [finished, runningSection] = [
      view.sections.find((s) => s.title === "Finished"),
      view.sections.find((s) => s.title === "Running"),
    ];
    expect(finished?.rows[0]?.decision?.tense).toBe("would");
    expect(finished?.rows[0]?.headline).toBe("Marked done.");
    expect(runningSection?.rows[0]?.decision?.tense).toBe("did");
    expect(deriveQueue(state(ok([task("n")])), NOW).sections[0]?.rows[0]?.decision).toBeNull();
  });

  test("a row is busy while its action is in flight", () => {
    const view = deriveQueue(state(ok([task("a"), task("b")]), { taskAction: { taskId: "b", op: "cancel" } }), NOW);
    expect(view.sections[0]?.rows.map((r) => r.busy)).toEqual([false, true]);
  });

  test("holds read whole or per account, by the account's own name, with a reset's time", () => {
    const exclave: ExclaveInfo = {
      id: "work",
      authOk: true,
      accountId: "org:acct-1234567890",
      email: "me@acme.dev",
      extraUsageEnabled: null,
      skills: [],
    };
    const mac = machine({ exclaves: [exclave] });
    const view = deriveQueue(
      state(
        ok(
          [],
          [
            { until: "resume", at: NOW },
            { account: "org:acct-1234567890", until: "reset", at: NOW, resumeAt: NOW + 3 * 3_600_000 },
            { account: "org:unknown-account", until: "resume", at: NOW },
          ],
        ),
        {},
        { machines: [mac] },
      ),
      NOW,
    );
    expect(view.paused).toBe(true);
    expect(view.holds.map((h) => h.text)).toEqual([
      "The whole queue is paused until resumed",
      "me@acme.dev is paused until its quota resets (in 3h)",
      "acct unknown- is paused until resumed",
    ]);
    expect(view.holds.map((h) => h.account)).toEqual([undefined, "org:acct-1234567890", "org:unknown-account"]);
    const accountOnly = deriveQueue(state(ok([], [{ account: "x", until: "resume", at: NOW }])), NOW);
    expect(accountOnly.paused).toBe(false);
  });

  test("status names the leader or why nobody answers, and the list stays up while it is away", () => {
    const list = ok([task("a")]);
    expect(deriveQueue(state(list), NOW)).toMatchObject({ status: "Scheduler on Mac", available: true, empty: null });
    const none = deriveQueue(state(list, {}, { scheduler: { kind: "none" } }), NOW);
    expect(none).toMatchObject({ status: "No scheduler is leading right now", available: false, empty: null });
    expect(none.sections).toHaveLength(1);
    const unverified = deriveQueue(
      state(null, {}, { scheduler: { kind: "unverified", deviceId: "dev-a", term: 2 } }),
      NOW,
    );
    expect(unverified.status).toContain("Leader unverified");
    expect(unverified.empty).toContain("Leader unverified");
    const down = deriveQueue(state(null, {}, { status: "retrying" }), NOW);
    expect(down).toMatchObject({ status: "Not connected to the relay", available: false });
  });

  test("an empty screen says why: loading, failed, or nothing", () => {
    expect(deriveQueue(state(null), NOW).empty).toBe("Loading…");
    expect(deriveQueue(state({ kind: "loading" }), NOW).empty).toBe("Loading…");
    expect(deriveQueue(state({ kind: "failed", message: "Taking over." }), NOW).empty).toBe("Taking over.");
    expect(deriveQueue(state(ok([])), NOW).empty).toBe("Nothing in the queue.");
  });

  test("a full reply says it is partial", () => {
    const many = Array.from({ length: QUEUE_MAX_TASKS }, (_, i) => task(`t${i}`));
    expect(deriveQueue(state(ok(many)), NOW).partial).toBe(`Showing the ${QUEUE_MAX_TASKS} most relevant tasks`);
    expect(deriveQueue(state(ok(many.slice(1))), NOW).partial).toBeNull();
  });
});
