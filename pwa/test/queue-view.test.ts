import { describe, expect, test } from "bun:test";
import {
  PR_CHECKS,
  PR_STATES,
  PR_STATUS_STALE_MS,
  QUEUE_MAX_TASKS,
  type ExclaveInfo,
  type Machine,
  type PauseHold,
  type PrStatus,
  type RelayState,
  type Task,
} from "@seance/shared";
import { deriveAfterSheet, deriveQueue } from "../src/queue-view.ts";
import { DEFAULT_FORM, type QueueState } from "../src/state.ts";
import { CAPABILITIES } from "@seance/shared";
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
      fleetQuota: [],
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
    discarding: false,
    accounts: { aliases: {}, nameable: true, saving: null, notice: null },
    ...overrides,
  };
}

function task(id: string, fields: Partial<Task> = {}): Task {
  return { id, spec: { repo: ORIGIN, mode: "worktree" }, state: "ready", createdAt: NOW - 120_000, ...fields };
}

const placedAt = { deviceId: "dev-a", exclave: "default", clone: "app", window: "w" };

function ok(tasks: readonly Task[], holds: readonly PauseHold[] = [], skew = 0): QueueState {
  return { kind: "ok", tasks, holds, unreadable: [], at: NOW + skew, skew };
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

  test("a reported PR is the row's chip, numbered where its URL names one", () => {
    const prOf = (prUrl?: string) =>
      deriveQueue(state(ok([task("a", { state: "awaiting-merge", ...(prUrl === undefined ? {} : { prUrl }) })])), NOW)
        .sections[0]?.rows[0]?.pr;
    expect(prOf("https://github.com/acme/app/pull/123")).toEqual({
      url: "https://github.com/acme/app/pull/123",
      label: "#123",
      state: null,
      checks: null,
      stale: false,
      description: "Pull request #123",
      accessibleName: "Open pull request #123",
    });
    expect(prOf("https://example.com/review?id=5")?.description).toBe("Pull request");
    expect(prOf("https://gitlab.com/acme/app/-/merge_requests/7/")?.label).toBe("#7");
    expect(prOf("https://github.com/acme/app/pull/123/files")?.label).toBe("#123");
    expect(prOf("https://example.com/review?id=5")?.label).toBe("PR");
    expect(prOf()).toBeNull();
  });

  test("a reported remote session links the row to its claude.ai page", () => {
    const sessionOf = (remoteSession?: string) =>
      deriveQueue(
        state(ok([task("a", { state: "needs-input", ...(remoteSession === undefined ? {} : { remoteSession }) })])),
        NOW,
      ).sections[0]?.rows[0]?.session;
    expect(sessionOf("session_01TuECqfR7Twko9QJm98sWAw")).toBe(
      "https://claude.ai/code/session_01TuECqfR7Twko9QJm98sWAw",
    );
    expect(sessionOf()).toBeNull();
  });

  describe("the leader's forge reading of the PR", () => {
    const URL = "https://github.com/acme/app/pull/123";
    const chip = (pr: PrStatus | undefined, now = NOW, skew = 0) =>
      deriveQueue(
        state(ok([task("a", { state: "awaiting-merge", prUrl: URL, ...(pr === undefined ? {} : { pr }) })], [], skew)),
        now,
      ).sections[0]?.rows[0]?.pr;

    test("each state and check maps through, with the words for the chip's title", () => {
      for (const prState of PR_STATES) expect(chip({ state: prState, at: NOW })?.state).toBe(prState);
      for (const checks of PR_CHECKS) expect(chip({ state: "open", checks, at: NOW })?.checks).toBe(checks);
      expect(chip({ state: "open", at: NOW })?.checks).toBeNull();
      expect(chip({ state: "open", checks: "failing", at: NOW - 3 * 60_000 })).toMatchObject({
        stale: false,
        description: "Pull request #123 · open · checks failing · read 3m ago",
        accessibleName: "Open pull request #123 (open, checks failing, read 3m ago)",
      });
      expect(chip({ state: "draft", at: NOW })?.description).toBe("Pull request #123 · draft · read just now");
    });

    test("a merged chip shows no CI dot, whatever the reading carried", () => {
      expect(chip({ state: "merged", checks: "passing", at: NOW })).toMatchObject({
        state: "merged",
        checks: null,
        description: "Pull request #123 · merged · read just now",
        accessibleName: "Open pull request #123 (merged, read just now)",
      });
    });

    test("a reading is aged by the leader's clock, not the phone's", () => {
      const HOUR = 3_600_000;
      for (const skew of [HOUR, -HOUR]) {
        const at = (ago: number): number => NOW + skew - ago;
        expect(chip({ state: "open", at: at(3 * 60_000) }, NOW, skew)).toMatchObject({
          stale: false,
          description: "Pull request #123 · open · read 3m ago",
        });
        expect(chip({ state: "open", at: at(PR_STATUS_STALE_MS + 1) }, NOW, skew)?.stale).toBe(true);
      }
    });

    test("a reading past the stale threshold is stale, except a merge, which never un-merges", () => {
      expect(chip({ state: "open", at: NOW - PR_STATUS_STALE_MS })?.stale).toBe(false);
      expect(chip({ state: "open", at: NOW - PR_STATUS_STALE_MS - 1 })?.stale).toBe(true);
      expect(chip({ state: "closed", at: NOW - 60 * 60_000 })?.stale).toBe(true);
      expect(chip({ state: "merged", at: NOW - 60 * 60_000 })?.stale).toBe(false);
    });

    test("no reading is today's chip", () => {
      expect(chip(undefined)).toMatchObject({ state: null, checks: null, stale: false, label: "#123" });
    });
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

  test("holds tell apart one email signed in to two orgs, and held accounts no machine reports", () => {
    const signedIn = (accountId: string, email: string): ExclaveInfo => ({
      id: accountId,
      authOk: true,
      accountId,
      email,
      extraUsageEnabled: null,
      skills: [],
    });
    const mac = machine({
      exclaves: [
        signedIn("1a2b3c4d-personal:acct-same", "me@acme.dev"),
        signedIn("9f8e7d6c-team:acct-same", "me@acme.dev"),
      ],
    });
    const view = deriveQueue(
      state(
        ok(
          [],
          [
            { account: "1a2b3c4d-personal:acct-same", until: "resume", at: NOW },
            { account: "9f8e7d6c-team:acct-same", until: "resume", at: NOW },
            // No machine reports either: they read alike unless the hold list counts them.
            { account: "org-p:abcdefgh-1", until: "resume", at: NOW },
            { account: "org-q:abcdefgh-2", until: "resume", at: NOW },
          ],
        ),
        {},
        { machines: [mac] },
      ),
      NOW,
    );
    expect(view.holds.map((h) => h.text)).toEqual([
      "me@acme.dev (org 1a2b3c4d) is paused until resumed",
      "me@acme.dev (org 9f8e7d6c) is paused until resumed",
      "acct abcdefgh (org org-p) is paused until resumed",
      "acct abcdefgh (org org-q) is paused until resumed",
    ]);
  });

  test("a held account shows its alias in place of its email", () => {
    const exclave: ExclaveInfo = {
      id: "work",
      authOk: true,
      accountId: "org:acct-1234567890",
      email: "me@acme.dev",
      extraUsageEnabled: null,
      skills: [],
    };
    const view = deriveQueue(
      state(
        ok([], [{ account: "org:acct-1234567890", until: "resume", at: NOW }]),
        { accounts: { aliases: { "org:acct-1234567890": "Acme" }, nameable: true, saving: null, notice: null } },
        { machines: [machine({ exclaves: [exclave] })] },
      ),
      NOW,
    );
    expect(view.holds.map((h) => h.text)).toEqual(["Acme is paused until resumed"]);
  });

  test("the list stays up while the leader is away, and the empty line says why", () => {
    const list = ok([task("a")]);
    expect(deriveQueue(state(list), NOW)).toMatchObject({ available: true, empty: null });
    const none = deriveQueue(state(list, {}, { scheduler: { kind: "none" } }), NOW);
    expect(none).toMatchObject({ available: false, empty: null });
    expect(none.sections).toHaveLength(1);
    const unverified = deriveQueue(
      state(null, {}, { scheduler: { kind: "unverified", deviceId: "dev-a", term: 2 } }),
      NOW,
    );
    expect(unverified.empty).toContain("Leader unverified");
    const down = deriveQueue(state(null, {}, { status: "retrying" }), NOW);
    expect(down).toMatchObject({ summary: null, available: false });
  });

  test("summary counts running and waiting tasks, null until a list is read", () => {
    const list = ok([
      task("a", { state: "running" }),
      task("b", { state: "reserved" }),
      task("c", { state: "queued" }),
      task("d", { state: "needs-input" }),
    ]);
    expect(deriveQueue(state(list), NOW).summary).toBe("2 running · 1 waiting");
    expect(deriveQueue(state(ok([])), NOW).summary).toBe("0 running · 0 waiting");
    expect(deriveQueue(state(null), NOW).summary).toBeNull();
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

  test("unreadable records get a line of their own, counted, and none gets none", () => {
    const listing = (count: number): QueueState => ({
      kind: "ok",
      tasks: [],
      holds: [],
      unreadable: Array.from({ length: count }, (_, i) => ({ taskId: `j${i}`, version: 1, reason: "unopenable" })),
      at: NOW,
      skew: 0,
    });
    expect(deriveQueue(state(listing(1)), NOW).unreadable).toBe(
      "1 unreadable record holds a queue slot — junk, or sealed under an earlier key",
    );
    expect(deriveQueue(state(listing(4)), NOW).unreadable).toStartWith("4 unreadable records hold queue slots");
    expect(deriveQueue(state(listing(0)), NOW).unreadable).toBeNull();
    // Nothing else on the screen claims the queue is empty of them.
    expect(deriveQueue(state(listing(4)), NOW).empty).toBe("Nothing in the queue.");
  });
});

describe("authoring on a row", () => {
  const batch = { id: "b-1", index: 2, strategy: { mode: "sequential" } } as const;
  const rowOf = (tasks: readonly Task[], id: string) =>
    deriveQueue(state(ok(tasks)), NOW)
      .sections.flatMap((section) => section.rows)
      .find((row) => row.id === id);

  test("what a task waits on reads as the task's title when it is listed, else as a count", () => {
    const base = task("base", { spec: { repo: ORIGIN, mode: "worktree", title: "Add the schema" } });
    const one = task("one", {
      state: "blocked",
      spec: { repo: ORIGIN, mode: "worktree", deps: [{ task: "base", after: "opened" }] },
    });
    const gone = task("gone", {
      state: "blocked",
      spec: { repo: ORIGIN, mode: "worktree", deps: [{ task: "x", after: "merged" }] },
    });
    const two = task("two", {
      state: "blocked",
      spec: {
        repo: ORIGIN,
        mode: "worktree",
        deps: [
          { task: "base", after: "opened" },
          { task: "x", after: "opened" },
        ],
      },
    });
    const mixed = task("mixed", {
      state: "blocked",
      spec: {
        repo: ORIGIN,
        mode: "worktree",
        deps: [
          { task: "base", after: "opened" },
          { task: "x", after: "done" },
        ],
      },
    });
    const tasks = [base, one, gone, two, mixed];
    expect(rowOf(tasks, "one")?.deps).toBe("After Add the schema (opened)");
    expect(rowOf(tasks, "gone")?.deps).toBe("After 1 task (merged)");
    expect(rowOf(tasks, "two")?.deps).toBe("After 2 tasks (opened)");
    // Edges that disagree get no single word.
    expect(rowOf(tasks, "mixed")?.deps).toBe("After 2 tasks");
    expect(rowOf(tasks, "base")?.deps).toBeNull();
  });

  test("a batch member shows its place and strategy", () => {
    const member = task("m", { spec: { repo: ORIGIN, mode: "worktree", batch } });
    expect(rowOf([member], "m")?.batch).toBe("Batch #2 · one at a time");
    expect(
      rowOf(
        [
          task("p", {
            spec: { repo: ORIGIN, mode: "worktree", batch: { ...batch, strategy: { mode: "parallel", max: 3 } } },
          }),
        ],
        "p",
      )?.batch,
    ).toBe("Batch #2 · up to 3 at once");
    expect(rowOf([task("n")], "n")?.batch).toBeNull();
  });

  test("a task can be followed up while it can still be waited on, or once it is done; not after it failed or was cancelled", () => {
    const can = (fields: Partial<Task>): boolean | undefined => rowOf([task("t", fields)], "t")?.canFollowUp;
    expect(can({ state: "queued" })).toBe(true);
    expect(can({ state: "running", assignment: placedAt })).toBe(true);
    expect(can({ state: "awaiting-merge" })).toBe(true);
    expect(can({ state: "done", doneBy: "session" })).toBe(true);
    expect(can({ state: "failed", failure: { code: "repo_not_found", message: "x" } })).toBe(false);
    expect(can({ state: "cancelled" })).toBe(false);
  });
});

describe("deriveAfterSheet", () => {
  const form = { ...DEFAULT_FORM, auto: true };

  test("lists what the leader holds that has not failed or been cancelled, with the edge the form holds on each", () => {
    const view = deriveAfterSheet(
      state(
        ok([
          task("a"),
          task("b", { state: "running", assignment: placedAt }),
          task("c", { state: "failed", failure: { code: "x", message: "y" } }),
          task("d", { state: "cancelled" }),
        ]),
        {
          form: { ...form, after: [{ task: "b", after: "merged" }] },
        },
      ),
      NOW,
    );
    // The chosen one first.
    expect(view.options.map((o) => [o.id, o.when])).toEqual([
      ["b", "merged"],
      ["a", null],
    ]);
    expect(view.note).toBeNull();
    expect(view.full).toBe(false);
  });

  test("an edge on a task the list no longer shows stays, by id, so it can be removed; sixteen edges is full", () => {
    const edges = Array.from({ length: 16 }, (_unused, i) => ({ task: `gone-${i}`, after: "opened" as const }));
    const view = deriveAfterSheet(state(ok([task("a")]), { form: { ...form, after: edges } }), NOW);
    expect(view.full).toBe(true);
    expect(view.options).toHaveLength(17);
    expect(view.options[0]).toMatchObject({ id: "gone-0", when: "opened", headline: "No longer in the queue" });
  });

  test("says why the list is empty, and whether Done is offered", () => {
    expect(deriveAfterSheet(state(null, { form }), NOW).note).toBe("Loading the queue…");
    expect(deriveAfterSheet(state({ kind: "failed", message: "no leader" }, { form }), NOW).note).toBe("no leader");
    expect(deriveAfterSheet(state(ok([]), { form }), NOW).note).toBe("No task in the queue to wait on.");
    expect(deriveAfterSheet(state(ok([]), { form }), NOW).doneAvailable).toBe(false);
    const capable = machine({ capabilities: [CAPABILITIES.reportedDone] });
    expect(deriveAfterSheet(state(ok([]), { form }, { machines: [capable] }), NOW).doneAvailable).toBe(true);
  });
});
