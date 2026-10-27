import { describe, expect, test } from "bun:test";
import {
  PR_CHECKS,
  PR_STATES,
  PR_STATUS_STALE_MS,
  QUEUE_MAX_TASKS,
  type ExclaveInfo,
  type IdleTaskRef,
  type Machine,
  type PauseHold,
  type PrStatus,
  type Reason,
  type RelayState,
  type Task,
} from "@seance/shared";
import { armTap, deriveAfterSheet, deriveQueue, disarmRow, primaryAction } from "../src/queue-view.ts";
import { DEFAULT_FORM, RESCAN_IDLE, type QueueState } from "../src/state.ts";
import { BATCH_STRATEGY, CAPABILITIES, reasonText } from "@seance/shared";
import { deriveView, failedBody, type AppState } from "../src/view.ts";

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
    rescan: RESCAN_IDLE,
    verdict: null,
    preview: null,
    sessions: {},
    queue: true,
    wide: false,
    queueView,
    taskAction: null,
    queueNotice: null,
    startNowRefusal: null,
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

function ok(
  tasks: readonly Task[],
  holds: readonly PauseHold[] = [],
  skew = 0,
  idle: readonly IdleTaskRef[] = [],
): QueueState {
  return { kind: "ok", tasks, holds, unreadable: [], idle, at: NOW + skew, skew };
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

  test("Waiting lists oldest first, the order the scheduler routes it", () => {
    const view = deriveQueue(
      state(
        ok([
          task("newest", { createdAt: NOW - 1_000 }),
          task("oldest", { state: "queued", createdAt: NOW - 90_000 }),
          task("middle", { state: "blocked", createdAt: NOW - 30_000 }),
        ]),
      ),
      NOW,
    );
    expect(view.sections[0]?.rows.map((r) => r.id)).toEqual(["oldest", "middle", "newest"]);
  });

  test("tasks on an asleep machine leave Needs you and Running for Asleep, in their own order", () => {
    const awake = machine();
    const asleep = machine({ deviceId: "dev-b", name: "MacBook", connected: false, lastSeen: NOW - 600_000 });
    const onB = { ...placedAt, deviceId: "dev-b" };
    const onGone = { ...placedAt, deviceId: "dev-gone" };
    const view = deriveQueue(
      state(
        ok([
          task("lost", { state: "lost", assignment: onB }),
          task("run", { state: "running", assignment: onB }),
          task("dozing", { state: "needs-input", assignment: onB, escalated: true, needsInputSince: NOW - 3_600_000 }),
          task("starting", { state: "reserved", reservation: { ...onB, expiresAt: NOW } }),
          task("nodding", { state: "needs-input", assignment: onB }),
          task("ask", { state: "needs-input", assignment: placedAt }),
          task("back", { state: "lost", assignment: placedAt }),
          task("nowhere", { state: "lost", assignment: onGone }),
          task("liveRun", { state: "running", assignment: placedAt }),
          task("goneRun", { state: "running", assignment: onGone }),
          task("goneAsk", { state: "needs-input", assignment: onGone }),
          task("w", { state: "ready" }),
          task("merge", { state: "awaiting-merge", assignment: onB }),
          task("done", { state: "done", assignment: onB }),
        ]),
        {},
        { machines: [awake, asleep] },
      ),
      NOW,
    );
    expect(titles(view)).toEqual(["Needs you", "Running", "Waiting", "Asleep", "Awaiting merge", "Finished"]);
    const ids = (title: string): string[] => view.sections.find((s) => s.title === title)?.rows.map((r) => r.id) ?? [];
    // Connected or unlisted machines keep their tasks where they were.
    expect(ids("Needs you")).toEqual(["ask", "goneAsk", "back", "nowhere"]);
    expect(ids("Running")).toEqual(["liveRun", "goneRun"]);
    // needs-input, then running/reserved, then lost; leader order within each.
    expect(ids("Asleep")).toEqual(["dozing", "nodding", "run", "starting", "lost"]);
    expect(ids("Awaiting merge")).toEqual(["merge"]);
    expect(ids("Finished")).toEqual(["done"]);
    expect(view.summary).toBe("2 running · 1 waiting");
    // An escalated task asleep can't be answered now: it lights nothing.
    expect(view.attention).toBe(false);

    const rows = view.sections.find((s) => s.title === "Asleep")?.rows ?? [];
    const settles = "Settles when its machine wakes; cancel or mark done to give up on it";
    expect(rows[4]).toMatchObject({
      headline: "Asleep on MacBook · default — its machine went to sleep 10m ago.",
      body: settles,
    });
    const needs = view.sections.find((s) => s.title === "Needs you")?.rows ?? [];
    expect(needs.map((r) => r.body)).not.toContain(settles);
    // Dots are the leader's verdict, unchanged by the derived sleep.
    expect(rows[0]?.dot).toBe("err");
  });

  test("reserved tasks stay in Running on a connected or an unlisted machine", () => {
    const view = deriveQueue(
      state(
        ok([
          task("here", { state: "reserved", reservation: { ...placedAt, expiresAt: NOW } }),
          task("nowhere", { state: "reserved", reservation: { ...placedAt, deviceId: "dev-gone", expiresAt: NOW } }),
        ]),
      ),
      NOW,
    );
    expect(titles(view)).toEqual(["Running"]);
    expect(view.sections[0]?.rows.map((r) => r.id)).toEqual(["here", "nowhere"]);
  });

  test("when every task is asleep the screen is not empty, and only Asleep shows", () => {
    const asleep = machine({ connected: false, lastSeen: NOW - 600_000 });
    const view = deriveQueue(
      state(ok([task("run", { state: "running", assignment: placedAt })]), {}, { machines: [asleep] }),
      NOW,
    );
    expect(view.empty).toBeNull();
    expect(titles(view)).toEqual(["Asleep"]);
    expect(view.summary).toBe("0 running · 0 waiting");
  });

  test("the Queue chip's attention (queueAttention) skips escalated tasks on asleep machines", () => {
    const asleep = machine({ connected: false, lastSeen: NOW - 600_000 });
    const dozing = task("dozing", { state: "needs-input", assignment: placedAt, escalated: true });
    const live = task("live", { state: "needs-input", escalated: true });
    const relay = { machines: [asleep] };
    expect(deriveView(state(ok([dozing]), {}, relay), NOW).queueAttention).toBe(false);
    expect(deriveView(state(ok([dozing, live]), {}, relay), NOW).queueAttention).toBe(true);
  });

  test("an escalated task an awake machine holds still outranks plain needs-input", () => {
    const awake = machine();
    const view = deriveQueue(
      state(
        ok([
          task("plain", { state: "needs-input", assignment: placedAt }),
          task("stuck", { state: "needs-input", assignment: placedAt, escalated: true }),
        ]),
        {},
        { machines: [awake] },
      ),
      NOW,
    );
    expect(view.sections[0]?.rows.map((r) => r.id)).toEqual(["stuck", "plain"]);
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

  test("a failed session's card says how it ended, from the exit status its failure carries", () => {
    const failure = { code: "session_failed", message: "m", exit: 137 };
    const view = deriveQueue(state(ok([task("f", { state: "failed", failure })])), NOW);
    expect(view.sections[0]?.rows[0]?.body).toBe(failedBody("session_failed", 137));
    expect(view.sections[0]?.rows[0]?.body).toContain("killed (SIGKILL), possibly out of memory");
    const judged = { ...failure, oomKill: true };
    const confirmed = deriveQueue(state(ok([task("f", { state: "failed", failure: judged })])), NOW);
    expect(confirmed.sections[0]?.rows[0]?.body).toContain(
      "killed (SIGKILL), out of memory (the kernel's OOM killer fired as it died),",
    );
  });

  test("a ready card says why it waits, leaving out places cut only for the pin", () => {
    const over = { code: "quota_over_line", window: "5h", projectedPct: 100 } as const;
    const held = task("w", {
      state: "ready",
      decision: {
        at: NOW,
        chosen: null,
        candidates: [
          { deviceId: "full", machine: "FullBox", exclave: "default", rejected: [over] },
          {
            deviceId: "mac",
            machine: "Mac",
            exclave: "default",
            rejected: [{ code: "pin_mismatch", field: "deviceId" }],
          },
        ],
      },
    });
    const body = deriveQueue(state(ok([held])), NOW).sections[0]?.rows[0]?.body;
    expect(body).toContain("Waiting: FullBox · default:");
    expect(body).toContain(reasonText(over));
    expect(body).not.toContain("Mac");
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

  test("a task the leader released idle leaves Running for Idle, says since when on this device's clock, and counts in the summary", () => {
    const at = { deviceId: "dev-a", exclave: "main", clone: "app" };
    const idle = task("idle", { state: "running", assignment: at });
    const busy = task("busy", { state: "running", assignment: at });
    // A reply's idle entry for a task an action since settled: what it now is wins.
    const settled = task("settled", { state: "done", assignment: at });
    const skew = 60_000;
    const released = [
      { taskId: "idle", since: NOW + skew - 20 * 60_000 },
      { taskId: "settled", since: NOW + skew - 20 * 60_000 },
    ];
    const view = deriveQueue(state(ok([idle, busy, settled], [], skew, released)), NOW);
    expect(view.sections.map((s) => [s.title, s.rows.map((r) => r.id)])).toEqual([
      ["Running", ["busy"]],
      ["Idle", ["idle"]],
      ["Finished", ["settled"]],
    ]);
    const row = view.sections.find((s) => s.title === "Idle")?.rows[0];
    expect(row?.body).toBe("Idle at its prompt since 20m ago — its slot is free");
    expect(row?.markDoneEndsSession).toBe(true);
    expect(view.summary).toBe("1 running · 1 idle · 0 waiting");
    expect(deriveQueue(state(ok([busy])), NOW).summary).toBe("1 running · 0 waiting");
  });

  test("unreadable records get a line of their own, counted, and none gets none", () => {
    const listing = (count: number): QueueState => ({
      kind: "ok",
      tasks: [],
      holds: [],
      unreadable: Array.from({ length: count }, (_, i) => ({ taskId: `j${i}`, version: 1, reason: "unopenable" })),
      idle: [],
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
  const batch = { id: "b-1", index: 2, strategy: BATCH_STRATEGY } as const;
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

  test("a batch member shows its place, and nothing about order or limits: a batch has none", () => {
    const member = task("m", { spec: { repo: ORIGIN, mode: "worktree", batch } });
    expect(rowOf([member], "m")?.batch).toBe("Batch #2");
    expect(rowOf([task("n")], "n")?.batch).toBeNull();
  });

  test("a pin and an avoid list read in the verdict's words on every state, by display label", () => {
    const account = "org:acct-1234567890";
    const exclave: ExclaveInfo = {
      id: "work",
      authOk: true,
      accountId: account,
      email: "me@acme.dev",
      extraUsageEnabled: null,
      skills: [],
    };
    const machines = [machine({ exclaves: [exclave] }), machine({ deviceId: "dev-b", name: "WSL" })];
    const placed = (fields: Partial<Task["spec"]>, taskState: Task["state"] = "ready"): string | null | undefined => {
      const t = task("t", { state: taskState, spec: { repo: ORIGIN, mode: "worktree", ...fields } });
      const accounts = { aliases: { [account]: "Acme" }, nameable: true, saving: null, notice: null };
      return deriveQueue(state(ok([t]), { accounts }, { machines }), NOW).sections[0]?.rows[0]?.placement;
    };
    expect(placed({ pin: { deviceId: "dev-b" } })).toBe("Pinned to WSL");
    expect(placed({ pin: { deviceId: "dev-b" } }, "running")).toBe("Pinned to WSL");
    expect(placed({ pin: { deviceId: "dev-a", account } }, "done")).toBe("Pinned to Mac · Acme");
    expect(placed({ avoid: ["dev-b", "ffffffff00001111"] }, "queued")).toBe("Avoids WSL, ffffffff");
    expect(placed({ pin: { deviceId: "dev-a" }, avoid: ["dev-b"] })).toBe("Pinned to Mac. Avoids WSL");
    expect(placed({ pin: { deviceId: "dev-a", account }, avoid: ["dev-b"] })).toBe("Pinned to Mac · Acme. Avoids WSL");
    expect(placed({ avoid: ["dev-b", "a1", "b2", "c3", "d4"] })).toBe("Avoids WSL, a1, b2, +2 more");
    expect(placed({ avoid: [] })).toBeNull();
    expect(placed({ pin: { deviceId: "0123456789abcdef" } })).toBe("Pinned to 01234567");
    expect(placed({})).toBeNull();
  });

  test("an account pin reads by its alias, else by the email a machine reports", () => {
    const account = "org:acct-1234567890";
    const exclave: ExclaveInfo = {
      id: "work",
      authOk: true,
      accountId: account,
      email: "me@acme.dev",
      extraUsageEnabled: null,
      skills: [],
    };
    const pinned = task("t", { spec: { repo: ORIGIN, mode: "worktree", pin: { account } } });
    const row = (aliases: Readonly<Record<string, string>>): string | null | undefined =>
      deriveQueue(
        state(
          ok([pinned]),
          { accounts: { aliases, nameable: true, saving: null, notice: null } },
          { machines: [machine({ exclaves: [exclave] })] },
        ),
        NOW,
      ).sections[0]?.rows[0]?.placement;
    expect(row({ [account]: "Acme" })).toBe("Pinned to Acme");
    expect(row({})).toBe("Pinned to me@acme.dev");
  });

  test("an account pin no machine reports and no alias reads by accountNameIn's short-id fallback", () => {
    const pinned = task("t", { spec: { repo: ORIGIN, mode: "worktree", pin: { account: "org:acct-1234567890" } } });
    const placement = deriveQueue(state(ok([pinned])), NOW).sections[0]?.rows[0]?.placement;
    expect(placement).toBe("Pinned to acct acct-123");
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

describe("continuing a failed task", () => {
  const CAN = [CAPABILITIES.continueTask];
  const failed = task("f", {
    state: "failed",
    failure: { code: "session_failed", message: "the session ended with exit 137" },
    spec: { repo: ORIGIN, mode: "worktree", title: "Fix the thing" },
    assignment: placedAt,
  });
  const continuation = (fields: Partial<Task>): Task =>
    task("c", { spec: { repo: ORIGIN, mode: "continue", continues: { task: "f", at: placedAt } }, ...fields });

  /** The row for `id`, with the leader and the machine it ran on (both dev-a here) advertising `capabilities`. */
  const rowOf = (tasks: readonly Task[], id: string, capabilities?: readonly string[], machines?: readonly Machine[]) =>
    deriveQueue(
      state(
        ok(tasks),
        {},
        { machines: machines ?? [machine({ ...(capabilities === undefined ? {} : { capabilities }) })] },
      ),
      NOW,
    )
      .sections.flatMap((section) => section.rows)
      .find((row) => row.id === id);

  test("offered on a failed session when its machine and the leader both advertise it", () => {
    expect(rowOf([failed], "f", CAN)?.canContinue).toBe(true);
    expect(rowOf([failed], "f")?.canContinue).toBe(false);
  });

  test("a continuation the machine refused shows the daemon's reason", () => {
    const refused = continuation({
      state: "failed",
      failure: { code: "not_continuable", message: "its worktree is locked (on a usb disk)" },
    });
    expect(rowOf([failed, refused], "c", CAN)?.body).toContain("its worktree is locked (on a usb disk)");
  });

  test("not offered when the leader cannot take a continue task, though the machine it ran on can", () => {
    const leader = machine({ deviceId: "dev-leader", name: "Leader" });
    const ran = machine({ capabilities: CAN });
    const relay = { scheduler: { kind: "ready", deviceId: "dev-leader", term: 1 } } as const;
    const row = deriveQueue(state(ok([failed]), {}, { machines: [ran, leader], ...relay }), NOW).sections[0]?.rows[0];
    expect(row?.canContinue).toBe(false);
  });

  test("not offered while the leader is unverified or absent, or when the machine it ran on is gone", () => {
    const unverified = { scheduler: { kind: "unverified", deviceId: "dev-a", term: 2 } } as const;
    expect(
      deriveQueue(state(ok([failed]), {}, { machines: [machine({ capabilities: CAN })], ...unverified }), NOW)
        .sections[0]?.rows[0]?.canContinue,
    ).toBe(false);
    const elsewhere = machine({ deviceId: "dev-z", capabilities: CAN });
    expect(rowOf([failed], "f", CAN, [elsewhere])?.canContinue).toBe(false);
  });

  test("only a failed session: not another failure, a task that ran in place, or one still going", () => {
    const other = task("o", {
      state: "failed",
      failure: { code: "repo_not_found", message: "x" },
      assignment: placedAt,
    });
    const inPlace = { ...failed, id: "p", spec: { repo: ORIGIN, mode: "here" } } satisfies Task;
    const running = task("r", { state: "running", assignment: placedAt });
    for (const t of [other, inPlace, running]) expect(rowOf([t], t.id, CAN)?.canContinue).toBe(false);
  });

  test("withdrawn once a continuation is past the queue in any state; a queued, blocked, failed or cancelled one does not hold it", () => {
    for (const held of ["reserved", "running", "needs-input", "lost", "awaiting-merge", "done"] as const) {
      expect(rowOf([failed, continuation({ state: held })], "f", CAN)?.canContinue, held).toBe(false);
    }
    for (const free of ["queued", "blocked", "ready", "failed", "cancelled"] as const) {
      expect(rowOf([failed, continuation({ state: free })], "f", CAN)?.canContinue).toBe(true);
    }
  });

  test("a cancelled task with an assignment is continuable only on a machine advertising continueCancelled", () => {
    const cancelled = task("x", { state: "cancelled", spec: { repo: ORIGIN, mode: "worktree" }, assignment: placedAt });
    expect(rowOf([cancelled], "x", [...CAN, CAPABILITIES.continueCancelled])?.canContinue).toBe(true);
    expect(rowOf([cancelled], "x", CAN)?.canContinue).toBe(false);
  });

  test("the button moves to a continuation that failed after landing", () => {
    const landed = continuation({
      state: "failed",
      failure: { code: "session_failed", message: "exit 137" },
      assignment: placedAt,
    });
    expect(rowOf([failed, landed], "f", CAN)?.canContinue).toBe(false);
    expect(rowOf([failed, landed], "c", CAN)?.canContinue).toBe(true);
  });

  test("a continuation names what it continues, by title when listed, else by id; other rows carry no such line", () => {
    expect(rowOf([failed, continuation({})], "c", CAN)?.continues).toBe("Continues Fix the thing");
    expect(rowOf([continuation({})], "c", CAN)?.continues).toBe("Continues task f");
    const long = continuation({
      spec: { repo: ORIGIN, mode: "continue", continues: { task: "0123456789abcdef", at: placedAt } },
    });
    expect(rowOf([long], "c", CAN)?.continues).toBe("Continues task 01234567");
    expect(rowOf([failed], "f", CAN)?.continues).toBeNull();
  });
});

describe("run now", () => {
  const CAN = [CAPABILITIES.runNow];
  const GLOBAL: Reason = { code: "cap_reached", inFlight: 8, max: 8 };
  const ACCOUNT: Reason = { code: "cap_reached", inFlight: 4, max: 4, scope: "account" };
  const DISK: Reason = { code: "disk_low", freeMib: 10 };
  const waiting = (rejected: readonly (readonly Reason[])[]): Task =>
    task("w", {
      decision: {
        at: NOW,
        chosen: null,
        candidates: rejected.map((r, i) => ({ deviceId: `d${i}`, machine: `m${i}`, exclave: "main", rejected: r })),
      },
    });
  const canRunNow = (t: Task, capabilities: readonly string[] = CAN): boolean | undefined =>
    deriveQueue(state(ok([t]), {}, { machines: [machine({ capabilities })] }), NOW)
      .sections.flatMap((section) => section.rows)
      .find((row) => row.id === t.id)?.canRunNow;

  test("offered on a ready task some machine turns down for the caps alone, either cap or both", () => {
    expect(canRunNow(waiting([[GLOBAL]]))).toBe(true);
    expect(canRunNow(waiting([[ACCOUNT]]))).toBe(true);
    expect(
      canRunNow(
        waiting([
          [GLOBAL, ACCOUNT],
          [GLOBAL, DISK],
        ]),
      ),
    ).toBe(true);
  });

  test("withheld where it would not place: another reason on every candidate, no decision, or not ready", () => {
    expect(canRunNow(waiting([[GLOBAL, DISK]]))).toBe(false);
    expect(canRunNow(waiting([[]]))).toBe(false);
    expect(canRunNow(task("w"))).toBe(false);
    expect(canRunNow({ ...waiting([[GLOBAL]]), state: "queued" })).toBe(false);
  });

  test("withheld from a leader that does not advertise runNow", () => {
    expect(canRunNow(waiting([[GLOBAL]]), [])).toBe(false);
  });
});

describe("the card's inline action", () => {
  const inline = (t: Task, capabilities: readonly string[] = []) =>
    deriveQueue(state(ok([t]), {}, { machines: [machine({ capabilities })] }), NOW)
      .sections.flatMap((section) => section.rows)
      .find((row) => row.id === t.id)?.inline;

  test("Continue on a failed session that offers it, where Follow up never is", () => {
    const failed = task("f", {
      state: "failed",
      failure: { code: "session_failed", message: "exit 137" },
      assignment: placedAt,
    });
    expect(inline(failed, [CAPABILITIES.continueTask])).toBe("continue");
    expect(inline(failed)).toBeNull();
  });

  test("Run now on a ready task the caps alone hold; Follow up is never inline", () => {
    const capped = task("w", {
      decision: {
        at: NOW,
        chosen: null,
        candidates: [
          { deviceId: "d", machine: "m", exclave: "main", rejected: [{ code: "cap_reached", inFlight: 8, max: 8 }] },
        ],
      },
    });
    expect(inline(capped, [CAPABILITIES.runNow])).toBe("run-now");
    expect(inline(capped)).toBeNull();
    const row = deriveQueue(state(ok([capped])), NOW).sections.flatMap((section) => section.rows)[0];
    expect(row?.canFollowUp).toBe(true);
  });

  test("nothing inline on a running, needing, done or cancelled task, where Follow up is the only act", () => {
    expect(inline(task("r", { state: "running", assignment: placedAt }))).toBeNull();
    expect(inline(task("n", { state: "needs-input", assignment: placedAt }))).toBeNull();
    expect(inline(task("d", { state: "done", doneBy: "session" }))).toBeNull();
    expect(inline(task("x", { state: "cancelled" }))).toBeNull();
  });

  test("nothing inline on a lost task, nor on one whose machine is asleep", () => {
    expect(inline(task("l", { state: "lost", assignment: placedAt }))).toBeNull();
    const asleep = machine({ connected: false, lastSeen: NOW - 600_000 });
    const row = deriveQueue(
      state(ok([task("a", { state: "running", assignment: placedAt })]), {}, { machines: [asleep] }),
      NOW,
    ).sections.flatMap((section) => section.rows)[0];
    expect(row?.canFollowUp).toBe(true);
    expect(row?.inline).toBeNull();
  });

  test("precedence holds whatever else is offered", () => {
    const all = { canContinue: true, canRunNow: true };
    expect(primaryAction(all)).toBe("continue");
    expect(primaryAction({ ...all, canContinue: false })).toBe("run-now");
    expect(primaryAction({ canContinue: false, canRunNow: false })).toBeNull();
  });
});

describe("arming a session-ending act in the card's menu", () => {
  const live = { id: "a", cancelEndsSession: true, markDoneEndsSession: true };
  const queued = { id: "a", cancelEndsSession: false, markDoneEndsSession: false };

  test("a first tap arms and keeps the menu open; the second fires and disarms", () => {
    const first = armTap(live, "cancel", null);
    expect(first).toEqual({ fire: false, armed: "cancel:a" });
    expect(armTap(live, "cancel", first.armed)).toEqual({ fire: true, armed: null });
  });

  test("one act's arm doesn't fire the other, nor another row's, nor Clear's", () => {
    expect(armTap(live, "mark-done", "cancel:a")).toEqual({ fire: false, armed: "mark-done:a" });
    expect(armTap(live, "cancel", "cancel:b")).toEqual({ fire: false, armed: "cancel:a" });
    expect(armTap(live, "cancel", "discard")).toEqual({ fire: false, armed: "cancel:a" });
  });

  test("an act that ends no session fires on the first tap, and the menu closes", () => {
    expect(armTap(queued, "cancel", null)).toEqual({ fire: true, armed: null });
    expect(armTap(queued, "mark-done", "discard")).toEqual({ fire: true, armed: null });
  });

  test("the menu closing disarms only its own row's acts", () => {
    expect(disarmRow("a", "cancel:a")).toBeNull();
    expect(disarmRow("a", "mark-done:a")).toBeNull();
    expect(disarmRow("a", "cancel:b")).toBe("cancel:b");
    expect(disarmRow("a", "discard")).toBe("discard");
    expect(disarmRow("a", null)).toBeNull();
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
