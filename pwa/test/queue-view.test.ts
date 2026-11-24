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
import {
  armTap,
  deriveAfterSheet,
  deriveQueue,
  disarmRow,
  idleClause,
  LIMITS_UNREADABLE,
  parseLimitDraft,
  primaryAction,
} from "../src/queue-view.ts";
import { NEEDS_INPUT_SCREEN_MS, nextReveal } from "../src/input-debounce.ts";
import { plain as lineText } from "../src/timed.ts";
import {
  AVAILABILITY_IDLE,
  CUSTODIAN_CONTROL_IDLE,
  CLOSED_OLDER,
  DEFAULT_FORM,
  RESCAN_IDLE,
  type QueueState,
} from "../src/state.ts";
import { CAPABILITIES, FLEET_LIMIT_MAX, reasonText, WORKTREE_AND_BRANCH_GONE, type SessionEntry } from "@seance/shared";
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
      archivist: null,
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
    autonomy: "checkpoint",
    notBefore: null,
    ref: { ref: "", url: "" },
    labelling: null,
    promptUndo: null,
    sheet: null,
    settings: false,
    machines: false,
    history: null,
    spawning: false,
    rescan: RESCAN_IDLE,
    availability: AVAILABILITY_IDLE,
    custodian: CUSTODIAN_CONTROL_IDLE,
    verdict: null,
    held: [],
    preview: null,
    sessions: {},
    queue: true,
    wide: false,
    queueView,
    focusedTask: null,
    taskAction: null,
    queueNotice: null,
    startNowRefusal: null,
    pausing: false,
    accountOpen: null,
    limiting: false,
    discarding: false,
    accounts: { aliases: {}, nameable: true, saving: null, renaming: null, notice: null },
    attachments: [],
    attachNotice: null,
    heldDropped: [],
    awaitingUploads: false,
    archiveStatus: null,
    older: CLOSED_OLDER,
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
  globalMax?: number,
): QueueState {
  return {
    kind: "ok",
    tasks,
    holds,
    unreadable: [],
    idle,
    at: NOW + skew,
    skew,
    ...(globalMax === undefined ? {} : { globalMax }),
  };
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
      headline: ["Asleep on MacBook · default — its machine went to sleep ", { text: "10m ago", at: NOW - 600_000 }],
      body: [settles],
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
    expect(view.sections[0]?.rows[0]).toMatchObject({
      dot: "err",
      body: ["Waiting for input since ", { text: "3h ago", at: NOW - 3 * 3_600_000 }],
    });
    expect(view.attention).toBe(true);
    const quiet = deriveQueue(state(ok([task("ask", { state: "needs-input" })])), NOW);
    expect(quiet.attention).toBe(false);
    expect(quiet.sections[0]?.rows[0]?.body).toBeNull();
  });

  test("a failed task is worded by failedBody, including the codes the scheduler sets itself", () => {
    for (const code of ["lost_expired", "merge_expired", "repo_not_found", "queue_expired"]) {
      const view = deriveQueue(state(ok([task("f", { state: "failed", failure: { code, message: "m" } })])), NOW);
      expect(view.sections[0]?.rows[0]?.body).toEqual([failedBody(code)]);
      expect(view.sections[0]?.rows[0]?.dot).toBe("err");
    }
  });

  test("a failed session's card says how it ended, from the exit status its failure carries", () => {
    const failure = { code: "session_failed", message: "m", exit: 137 };
    const view = deriveQueue(state(ok([task("f", { state: "failed", failure })])), NOW);
    expect(view.sections[0]?.rows[0]?.body).toEqual([failedBody("session_failed", 137)]);
    expect(lineText(view.sections[0]?.rows[0]?.body ?? [])).toContain("killed (SIGKILL), possibly out of memory");
    const judged = { ...failure, oomKill: true };
    const confirmed = deriveQueue(state(ok([task("f", { state: "failed", failure: judged })])), NOW);
    expect(lineText(confirmed.sections[0]?.rows[0]?.body ?? [])).toContain(
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
    const body = lineText(deriveQueue(state(ok([held])), NOW).sections[0]?.rows[0]?.body ?? []);
    expect(body).toContain("Waiting: FullBox · default:");
    expect(body).toContain(reasonText(over));
    expect(body).not.toContain("Mac");
  });

  test("a row's title is the task's, else its window (unless it is the daemon's `session` fallback), else its prompt's first line cut to 80, else its repo", () => {
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
          task("j", {
            state: "done",
            doneBy: "session",
            spec: { repo: ORIGIN, mode: "worktree", prompt: "Can you fix the flaky test?" },
            assignment: { ...placedAt, window: "can-you-fix-the-flaky-test" },
          }),
          task("k", {
            state: "done",
            doneBy: "session",
            spec: { repo: ORIGIN, mode: "worktree", prompt: "Take notes" },
            assignment: { ...placedAt, window: "session-3" },
          }),
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
      ["j", "can-you-fix-the-flaky-test"],
      ["k", "Take notes"],
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
      blocked: null,
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

  test("the live session's `agent.remote` wins over the task's `remoteSession`, which stays the fallback", () => {
    const live = "session_01LiveLiveLiveLiveLiveLive";
    const stored = "session_01TuECqfR7Twko9QJm98sWAw";
    const linkOf = (tags: SessionEntry["tags"], sessions?: AppState["sessions"]) =>
      deriveQueue(
        state(ok([task("a", { state: "running", assignment: placedAt, remoteSession: stored })]), {
          sessions: sessions ?? {
            [placedAt.deviceId]: {
              at: NOW,
              sessions: [
                {
                  id: "%1",
                  window: "w",
                  repo: "app",
                  path: "/w",
                  taskId: "a",
                  ...(tags === undefined ? {} : { tags }),
                },
              ],
            },
          },
        }),
        NOW,
      ).sections[0]?.rows[0]?.session;
    expect(linkOf({ "agent.remote": { value: live, at: NOW, scope: "process" } })).toBe(
      `https://claude.ai/code/${live}`,
    );
    // A malformed id, or one at a scope `agent.remote` does not live at, is dropped at parse.
    expect(linkOf({ "agent.remote": { value: "session_../x", at: NOW, scope: "process" } })).toBe(
      `https://claude.ai/code/${stored}`,
    );
    expect(linkOf({ "agent.remote": { value: live, at: NOW, scope: "conversation" } })).toBe(
      `https://claude.ai/code/${stored}`,
    );
    expect(linkOf(undefined, { [placedAt.deviceId]: "unknown" })).toBe(`https://claude.ai/code/${stored}`);
    expect(linkOf(undefined, {})).toBe(`https://claude.ai/code/${stored}`);
  });

  test("Answer in Claude is offered only on a task waiting for input with a session link", () => {
    const SESSION = "session_01TuECqfR7Twko9QJm98sWAw";
    const answerOf = (fields: Partial<Task>) =>
      deriveQueue(state(ok([task("a", fields)])), NOW).sections[0]?.rows[0]?.answer;
    expect(answerOf({ state: "needs-input", needsInputSince: NOW - 60_000, remoteSession: SESSION })).toBe(
      `https://claude.ai/code/${SESSION}`,
    );
    // Under the screen debounce it reads as running: nothing to answer yet.
    expect(answerOf({ state: "needs-input", needsInputSince: NOW, remoteSession: SESSION })).toBeNull();
    expect(answerOf({ state: "needs-input", needsInputSince: NOW - 60_000 })).toBeNull();
    expect(answerOf({ state: "running", assignment: placedAt, remoteSession: SESSION })).toBeNull();
    expect(answerOf({ state: "lost", assignment: placedAt, needsInputSince: NOW, remoteSession: SESSION })).toBeNull();
  });

  test("the autonomy chip names a level off the default; plan alone reads as steer", () => {
    const chipOf = (spec: Partial<Task["spec"]>) =>
      deriveQueue(state(ok([task("a", { spec: { repo: ORIGIN, mode: "worktree", ...spec } })])), NOW).sections[0]
        ?.rows[0]?.autonomy;
    expect(chipOf({})).toBeNull();
    expect(chipOf({ autonomy: "checkpoint" })).toBeNull();
    expect(chipOf({ plan: false })).toBeNull();
    expect(chipOf({ autonomy: "steer", plan: true })).toBe("Steer");
    expect(chipOf({ plan: true })).toBe("Steer");
    expect(chipOf({ autonomy: "auto" })).toBe("Auto");
  });

  test("the agent chip names Codex, and a Claude task, the default, shows none", () => {
    const agentOf = (spec: Partial<Task["spec"]>) =>
      deriveQueue(state(ok([task("a", { spec: { repo: ORIGIN, mode: "worktree", ...spec } })])), NOW).sections[0]
        ?.rows[0]?.agent;
    expect(agentOf({})).toBeNull();
    expect(agentOf({ agent: "codex", autonomy: "auto" })).toBe("Codex");
  });

  test("a custodian flag shows a fixed label per reason and the note as written, and no flag shows none", () => {
    const flagOf = (flag: Task["flag"]) =>
      deriveQueue(state(ok([task("a", flag === undefined ? {} : { flag })])), NOW).sections[0]?.rows[0]?.flag;
    expect(flagOf(undefined)).toBeNull();
    expect(flagOf({ reason: "stuck", note: "same error four times", at: 1 })).toEqual({
      label: "Custodian: looks stuck",
      note: "same error four times",
    });
    expect(flagOf({ reason: "look", at: 1 })).toEqual({ label: "Custodian: take a look", note: null });
    expect(flagOf({ reason: "dirty", at: 1 })?.label).toBe("Custodian: kept its worktree (uncommitted changes)");
    expect(flagOf({ reason: "unpushed", at: 1 })?.label).toBe("Custodian: kept its worktree (unpushed commits)");
  });

  test("a flag moves neither the section nor the actions of its task", () => {
    const rowFor = (fields: Partial<Task>) =>
      deriveQueue(state(ok([task("a", { state: "running", ...fields })])), NOW).sections.map((section) => [
        section.title,
        section.rows.map((row) => [row.canCancel, row.canMarkDone, row.canFollowUp, row.dot]),
      ]);
    expect(rowFor({ flag: { reason: "stuck", at: 1 } })).toEqual(rowFor({}));
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
      expect(chip({ state: "open", checks: "unrun", at: NOW })?.description).toBe(
        "Pull request #123 · open · a check never ran · read just now",
      );
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

    test("an awaiting-merge task's blocked reason is a chip word and part of the title, and no other task shows one", () => {
      const HEAD = "0".repeat(40);
      const blockedOf = (pr: PrStatus, fields: Partial<Task> = {}) =>
        deriveQueue(state(ok([task("a", { state: "awaiting-merge", prUrl: URL, pr, ...fields })])), NOW).sections[0]
          ?.rows[0]?.pr;
      const reasons: readonly (readonly [Partial<PrStatus>, string])[] = [
        [{ required: "failing", failing: ["test"] }, "check failing"],
        [{ merge: "dirty" }, "conflict"],
        [{ merge: "behind" }, "behind"],
        [{ required: "passing", merge: "clean" }, "not set to merge"],
      ];
      for (const [over, word] of reasons) {
        const chipOf = blockedOf({ state: "open", head: HEAD, at: NOW, ...over });
        expect(chipOf?.blocked).toBe(word);
        expect(chipOf?.description).toBe(`Pull request #123 · open · ${word} · read just now`);
      }
      expect(blockedOf({ state: "open", at: NOW, merge: "clean" })?.blocked).toBeNull();
      expect(blockedOf({ state: "merged", at: NOW, merge: "dirty" })?.blocked).toBeNull();
      const reported = { spec: { repo: ORIGIN, mode: "worktree", until: "reported" } } satisfies Partial<Task>;
      expect(blockedOf({ state: "open", at: NOW, merge: "dirty" }, reported)?.blocked).toBeNull();
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
    expect(view.holds.map((h) => lineText(h.text))).toEqual([
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
    expect(view.holds.map((h) => lineText(h.text))).toEqual([
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
        {
          accounts: {
            aliases: { "org:acct-1234567890": "Acme" },
            nameable: true,
            saving: null,
            renaming: null,
            notice: null,
          },
        },
        { machines: [machine({ exclaves: [exclave] })] },
      ),
      NOW,
    );
    expect(view.holds.map((h) => lineText(h.text))).toEqual(["Acme is paused until resumed"]);
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
    // The cap is the denominator, and a run-now task can push the numerator past it.
    const running = [
      task("a", { state: "running", assignment: placedAt }),
      task("b", { state: "running", assignment: placedAt }),
    ];
    expect(deriveQueue(state(ok(running, [], 0, [], 2)), NOW).summary).toBe("2/2 running · 0 waiting");
    expect(deriveQueue(state(ok(running, [], 0, [], 1)), NOW).summary).toBe("2/1 running · 0 waiting");
    expect(deriveQueue(state(null), NOW).summary).toBeNull();
  });

  test("the limit is offered only by a verified leader that keeps one, and null there is none", () => {
    const keeps = { machines: [machine({ capabilities: [CAPABILITIES.limits] })] };
    expect(deriveQueue(state(ok([])), NOW).limit).toBeNull();
    expect(deriveQueue(state(ok([]), {}, keeps), NOW).limit).toEqual({ fleet: null });
    expect(deriveQueue(state(ok([], [], 0, [], 3), {}, keeps), NOW).limit).toEqual({ fleet: 3 });
    // Nothing read yet, or no leader to send it to: nothing to change.
    expect(deriveQueue(state(null, {}, keeps), NOW).limit).toBeNull();
    expect(deriveQueue(state(ok([]), {}, { ...keeps, scheduler: { kind: "none" } }), NOW).limit).toBeNull();
  });

  test("an unreadable limit is a banner, whether or not it can be set from here", () => {
    const read = ok([]);
    const unreadable: QueueState = read.kind === "ok" ? { ...read, limitsUnreadable: true } : read;
    expect(deriveQueue(state(ok([])), NOW).limitsUnreadable).toBeNull();
    expect(deriveQueue(state(unreadable), NOW).limitsUnreadable).toBe(LIMITS_UNREADABLE);
  });

  test("the limit field reads empty as none and refuses what is no limit", () => {
    expect(parseLimitDraft("")).toBeNull();
    expect(parseLimitDraft("  ")).toBeNull();
    expect(parseLimitDraft(" 8 ")).toBe(8);
    expect(parseLimitDraft(String(FLEET_LIMIT_MAX))).toBe(FLEET_LIMIT_MAX);
    for (const bad of ["0", "-1", "1.5", "8x", "1e2", String(FLEET_LIMIT_MAX + 1)]) {
      expect(parseLimitDraft(bad)).toBeUndefined();
    }
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
    expect(lineText(row?.body ?? [])).toBe("Idle at its prompt since 20m ago — its slot is free");
    expect(row?.markDoneEndsSession).toBe(true);
    expect(view.summary).toBe("1 running · 1 idle · 0 waiting");
    expect(deriveQueue(state(ok([busy])), NOW).summary).toBe("1 running · 0 waiting");
  });

  test("an idle task says what its last turn left: its background work by kind, else the API error that ended it", () => {
    const at = { deviceId: "dev-a", exclave: "main", clone: "app" };
    const watching = task("idle", { state: "running", assignment: at });
    const released = [{ taskId: "idle", since: NOW - 5 * 60_000, background: { shell: 1, wakeup: 2 } }];
    const row = deriveQueue(state(ok([watching], [], 0, released)), NOW).sections.find((s) => s.title === "Idle")
      ?.rows[0];
    expect(lineText(row?.body ?? [])).toBe(
      "Idle, waiting on its background work (1 shell, 2 scheduled wake-ups) since 5m ago — its slot is free",
    );
    expect(idleClause({ taskId: "t", since: 0, background: { agent: 2, monitor: 1, other: 1 } })).toBe(
      "Idle, waiting on its background work (2 subagents, 1 monitor, 1 other task)",
    );
    expect(idleClause({ taskId: "t", since: 0, stopError: "rate_limit" })).toBe("Stopped on an API error (rate limit)");
    expect(idleClause({ taskId: "t", since: 0, background: {} })).toBe("Idle at its prompt");
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
  const batch = { id: "b-1", index: 2 } as const;
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

  test("a task carrying files never shows their names", () => {
    const ref = (name: string, i: number) => ({
      id: `0000000${i}-0000-4000-8000-000000000000`,
      name,
      type: "image/png",
      size: 1,
      hash: "h".repeat(43),
    });
    const attached = task("f", {
      spec: { repo: ORIGIN, mode: "worktree", attachments: [ref("secret.png", 1), ref("b.png", 2)] },
    });
    expect(JSON.stringify(rowOf([attached], "f"))).not.toContain("secret.png");
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
      const accounts = { aliases: { [account]: "Acme" }, nameable: true, saving: null, renaming: null, notice: null };
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

  test("what a task requires reads after its pin and avoid list, with the machines that declare each trait", () => {
    const withTraits = (m: Machine, traits: readonly string[]): Machine => ({
      ...m,
      exclaves: [{ id: "x", authOk: true, accountId: "org:x", extraUsageEnabled: null, skills: [], traits }],
    });
    const machines = [withTraits(machine(), ["atlas"]), machine({ deviceId: "dev-b", name: "WSL" })];
    const placed = (fields: Partial<Task["spec"]>): string | null | undefined => {
      const t = task("t", { state: "ready", spec: { repo: ORIGIN, mode: "worktree", ...fields } });
      return deriveQueue(state(ok([t]), {}, { machines }), NOW).sections[0]?.rows[0]?.placement;
    };
    expect(placed({ requires: ["atlas"] })).toBe("Needs atlas (on Mac)");
    expect(placed({ requires: ["atlas", "gone"], avoid: ["dev-b"] })).toBe(
      "Avoids WSL. Needs atlas (on Mac) · Needs gone — no machine has it",
    );
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
          { accounts: { aliases, nameable: true, saving: null, renaming: null, notice: null } },
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

  test("a task can be followed up only while it can still be waited on, not once it has finished", () => {
    const can = (fields: Partial<Task>): boolean | undefined => rowOf([task("t", fields)], "t")?.canFollowUp;
    expect(can({ state: "queued" })).toBe(true);
    expect(can({ state: "running", assignment: placedAt })).toBe(true);
    expect(can({ state: "awaiting-merge" })).toBe(true);
    expect(can({ state: "done", doneBy: "session" })).toBe(false);
    expect(can({ state: "failed", failure: { code: "repo_not_found", message: "x" } })).toBe(false);
    expect(can({ state: "cancelled" })).toBe(false);
  });
});

describe("continuing a failed task", () => {
  const CAN = [CAPABILITIES.continueTask, CAPABILITIES.continueSession];
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
    expect(lineText(rowOf([failed, refused], "c", CAN)?.body ?? [])).toContain(
      "its worktree is locked (on a usb disk)",
    );
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

  test("withdrawn while a continuation waits or once one is past the queue; a failed or unplaced cancelled one gives it back", () => {
    for (const held of [
      "queued",
      "blocked",
      "ready",
      "reserved",
      "running",
      "needs-input",
      "lost",
      "awaiting-merge",
      "done",
    ] as const) {
      expect(rowOf([failed, continuation({ state: held })], "f", CAN)?.canContinue, held).toBe(false);
    }
    const refused = continuation({ state: "failed", failure: { code: "not_continuable", message: "m" } });
    for (const free of [refused, continuation({ state: "failed" }), continuation({ state: "cancelled" })]) {
      expect(rowOf([failed, free], "f", CAN)?.canContinue, free.failure?.code ?? free.state).toBe(true);
    }
  });

  test("a waiting continuation shows on the earlier card by its title, pointing at its row; nowhere else", () => {
    const waiting = continuation({
      spec: { repo: ORIGIN, mode: "continue", title: "Fix the thing again", continues: { task: "f", at: placedAt } },
    });
    for (const held of ["queued", "blocked", "ready"] as const) {
      expect(rowOf([failed, { ...waiting, state: held }], "f", CAN)?.continuing, held).toEqual({
        text: "Continuing as Fix the thing again · waiting",
        reveal: "c",
      });
    }
    expect(rowOf([failed, waiting], "c", CAN)?.continuing).toBeNull();
    const refused = continuation({ state: "failed", failure: { code: "not_continuable", message: "m" } });
    const landed = continuation({ state: "running", assignment: placedAt });
    for (const y of [refused, landed, continuation({ state: "cancelled" })]) {
      expect(rowOf([failed, y], "f", CAN)?.continuing, y.state).toBeNull();
    }
    // A landed continuation outranks a waiting one, as in continueOffer: the line would name a task that can't take over.
    const taker = task("y1", {
      state: "failed",
      failure: { code: "session_failed", message: "m" },
      assignment: placedAt,
      spec: { repo: ORIGIN, mode: "continue", continues: { task: "f", at: placedAt } },
    });
    expect(rowOf([failed, taker, waiting], "f", CAN)?.continuing).toBeNull();
    // Past QUEUE_MAX_TASKS the continuation isn't listed: nothing to name, and the offer stands.
    expect(rowOf([failed], "f", CAN)?.continuing).toBeNull();
  });

  test("a continuation refused because the worktree and branch are gone withdraws it for good, and says so", () => {
    const gone = continuation({
      state: "failed",
      failure: {
        code: "not_continuable",
        message: `its worktree /r/.claude/worktrees/x ${WORKTREE_AND_BRANCH_GONE} (merged and swept by reap, or deleted)`,
      },
    });
    const row = rowOf([failed, gone], "f", CAN);
    expect(row?.canContinue).toBe(false);
    // No reveal: a failed card may sit in Older, where a tap would scroll to nothing.
    expect(row?.continuing).toEqual({ text: "Can't continue: its worktree and its branch are gone", reveal: null });
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

describe("continuing an awaiting-merge task whose PR is blocked", () => {
  const HANDOFF = [CAPABILITIES.continueTask, CAPABILITIES.continueSession, CAPABILITIES.continueHandoff];
  const blocked = task("w", {
    state: "awaiting-merge",
    spec: { repo: ORIGIN, mode: "worktree", title: "Fix the thing" },
    assignment: placedAt,
    prUrl: "https://github.com/acme/app/pull/7",
    pr: { state: "open", required: "failing", failing: ["test"], merge: "blocked", at: NOW },
  });
  const rowOf = (t: Task, capabilities: readonly string[]) =>
    deriveQueue(state(ok([t]), {}, { machines: [machine({ capabilities })] }), NOW)
      .sections.flatMap((section) => section.rows)
      .find((row) => row.id === t.id);

  test("Continue is the card's primary act when the leader and machine advertise continueHandoff", () => {
    expect(rowOf(blocked, HANDOFF)).toMatchObject({ canContinue: true, inline: "continue", inlinePrimary: true });
  });

  test("an older leader or machine, a clean PR, or an until-reported task offers nothing", () => {
    const plain = [CAPABILITIES.continueTask, CAPABILITIES.continueSession];
    expect(rowOf(blocked, plain)).toMatchObject({ canContinue: false, inlinePrimary: false });
    const clean = { ...blocked, pr: { state: "open" as const, merge: "clean" as const, at: NOW } };
    expect(rowOf(clean, HANDOFF)).toMatchObject({ canContinue: false, inlinePrimary: false });
    const reported = { ...blocked, spec: { ...blocked.spec, until: "reported" as const } };
    expect(rowOf(reported, HANDOFF)).toMatchObject({ canContinue: false, inlinePrimary: false });
  });

  test("the blocked task's card names a continuation waiting on its newest landed link", () => {
    const landed = task("c1", {
      state: "running",
      assignment: placedAt,
      spec: { repo: ORIGIN, mode: "continue", continues: { task: "w", at: placedAt } },
    });
    const waiting = task("c2", {
      state: "queued",
      spec: { repo: ORIGIN, mode: "continue", title: "Unblock PR #7", continues: { task: "c1", at: placedAt } },
    });
    const pointed = { ...blocked, continuedBy: { task: "c1", createdAt: NOW } };
    const row = deriveQueue(
      state(ok([pointed, landed, waiting]), {}, { machines: [machine({ capabilities: HANDOFF })] }),
      NOW,
    )
      .sections.flatMap((section) => section.rows)
      .find((r) => r.id === "w");
    expect(row?.continuing).toEqual({ text: "Continuing as Unblock PR #7 · waiting", reveal: "c2" });
  });

  test("Unblock is withdrawn once a continuation of the session it would resume was refused as gone", () => {
    const gone = task("c1", {
      state: "failed",
      failure: { code: "not_continuable", message: `its worktree /p ${WORKTREE_AND_BRANCH_GONE}` },
      spec: { repo: ORIGIN, mode: "continue", continues: { task: "w", at: placedAt } },
    });
    const row = deriveQueue(state(ok([blocked, gone]), {}, { machines: [machine({ capabilities: HANDOFF })] }), NOW)
      .sections.flatMap((section) => section.rows)
      .find((r) => r.id === "w");
    expect(row).toMatchObject({ canContinue: false, inlinePrimary: false });
    expect(row?.continuing?.text).toBe("Can't continue: its worktree and its branch are gone");
  });

  test("a failed task's Continue stays the quiet one", () => {
    const failed = task("f", {
      state: "failed",
      failure: { code: "session_failed", message: "exit 137" },
      assignment: placedAt,
    });
    expect(rowOf(failed, HANDOFF)).toMatchObject({ canContinue: true, inline: "continue", inlinePrimary: false });
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
    expect(inline(failed, [CAPABILITIES.continueTask, CAPABILITIES.continueSession])).toBe("continue");
    expect(inline(failed)).toBeNull();
  });

  test("never Start now, even on a ready task the caps alone hold, nor Follow up", () => {
    const capped = task("w", {
      decision: {
        at: NOW,
        chosen: null,
        candidates: [
          { deviceId: "d", machine: "m", exclave: "main", rejected: [{ code: "cap_reached", inFlight: 8, max: 8 }] },
        ],
      },
    });
    expect(inline(capped, [CAPABILITIES.runNow])).toBeNull();
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

  test("Continue whenever it is offered, nothing otherwise", () => {
    expect(primaryAction({ canContinue: true })).toBe("continue");
    expect(primaryAction({ canContinue: false })).toBeNull();
  });
});

describe("passing a running task to a successor", () => {
  const CAN = [CAPABILITIES.successor];
  const running = task("r", {
    state: "running",
    spec: { repo: ORIGIN, mode: "worktree", title: "Fix the thing" },
    assignment: placedAt,
  });

  const rowOf = (tasks: readonly Task[], id: string, capabilities?: readonly string[]) =>
    deriveQueue(
      state(ok(tasks), {}, { machines: [machine({ ...(capabilities === undefined ? {} : { capabilities }) })] }),
      NOW,
    )
      .sections.flatMap((section) => section.rows)
      .find((row) => row.id === id);

  test("offered on a running task when the leader and its machine both advertise it", () => {
    expect(rowOf([running], "r", CAN)?.canPass).toBe(true);
    expect(rowOf([running], "r")?.canPass).toBe(false);
  });

  test("never inline: the menu alone carries it", () => {
    expect(rowOf([running], "r", CAN)?.inline).toBeNull();
  });

  test("not offered for a task in place, one waiting on a person or a merge, one already passed, or a finished one", () => {
    const refused = [
      task("here", { state: "running", spec: { repo: ORIGIN, mode: "here" }, assignment: placedAt }),
      task("input", { state: "needs-input", assignment: placedAt }),
      task("merge", { state: "awaiting-merge", assignment: placedAt }),
      task("passed", { state: "running", successor: "n", assignment: placedAt }),
      task("done", { state: "done", assignment: placedAt }),
      task("queued", { state: "queued" }),
    ];
    for (const t of refused) expect(rowOf([t], t.id, CAN)?.canPass, t.id).toBe(false);
  });

  test("a superseded task and its successor name each other", () => {
    const old = task("old", {
      state: "superseded",
      successor: "next",
      spec: { repo: ORIGIN, mode: "worktree", title: "Old work" },
      assignment: placedAt,
    });
    const next = task("next", {
      state: "blocked",
      spec: {
        repo: ORIGIN,
        mode: "worktree",
        title: "New work",
        succeeds: { task: "old", account: "acct", at: placedAt, trigger: "manual" },
      },
    });
    expect(rowOf([old, next], "old", CAN)).toMatchObject({
      passedTo: { text: "Passed to New work", reveal: null },
      canPass: false,
    });
    expect(rowOf([old, next], "next", CAN)?.carriesOn?.text).toBe("Carries on Old work");
    expect(rowOf([old], "old", CAN)?.passedTo?.text).toBe("Passed to task next");
  });

  test("a stacked task names what its worktree started from", () => {
    const placed = { deviceId: "d", exclave: "main", clone: "seance" };
    const pred = task("pred", {
      state: "awaiting-merge",
      spec: { repo: ORIGIN, mode: "worktree", title: "Base work" },
    });
    const deps = [{ task: "pred", after: "opened" as const }];
    const stacked = (on: "branch" | "merged" | "nothing", id = "pred") =>
      task("next", {
        state: "running",
        assignment: placed,
        spec: { repo: ORIGIN, mode: "worktree", deps },
        stack: { task: id, on },
      });
    expect(rowOf([pred, stacked("branch")], "next", CAN)?.stackedOn).toEqual({
      text: "Stacked on Base work",
      reveal: null,
    });
    expect(rowOf([pred, stacked("merged")], "next", CAN)?.stackedOn?.text).toBe(
      "Started from the default branch: Base work had merged",
    );
    expect(rowOf([pred, stacked("nothing")], "next", CAN)?.stackedOn?.text).toBe(
      "Started from the default branch: Base work left nothing to stack on",
    );
    // The holder after a pass, which the queue may no longer show: its short id.
    expect(rowOf([stacked("branch", "successor-of-pred")], "next", CAN)?.stackedOn?.text).toBe(
      "Stacked on task successo",
    );
    // Not yet dispatched: the leader has written no stack, and the deps line says what it waits on.
    const waiting = task("next", { state: "blocked", spec: { repo: ORIGIN, mode: "worktree", deps } });
    expect(rowOf([pred, waiting], "next", CAN)?.stackedOn).toBeNull();
  });

  test("a successor of a quota pass says its predecessor's usage ran out", () => {
    const old = task("old", {
      state: "superseded",
      successor: "next",
      spec: { repo: ORIGIN, mode: "worktree", title: "Old work" },
      assignment: placedAt,
    });
    const next = task("next", {
      state: "blocked",
      spec: {
        repo: ORIGIN,
        mode: "worktree",
        succeeds: { task: "old", account: "acct", at: placedAt, trigger: "quota", since: 5 },
      },
    });
    expect(rowOf([old, next], "next", CAN)?.carriesOn?.text).toBe("Carries on Old work after its usage ran out");
  });

  test("a drain's successor says its machine closed", () => {
    const placed = { deviceId: "d", exclave: "main", clone: "seance" };
    const old = task("old", { spec: { repo: ORIGIN, mode: "worktree", title: "Old work" }, assignment: placed });
    const next = task("next", {
      state: "blocked",
      spec: {
        repo: ORIGIN,
        mode: "worktree",
        succeeds: { task: "old", account: "acct", at: placed, trigger: "drain", since: 5 },
      },
    });
    expect(rowOf([old, next], "next", CAN)?.carriesOn?.text).toBe("Carries on Old work after its machine closed");
  });

  test("a pass always asks twice, and its arm is disarmed with the row's menu", () => {
    const row = { id: "a", cancelEndsSession: false, markDoneEndsSession: false };
    const first = armTap(row, "pass", null);
    expect(first).toEqual({ fire: false, armed: "pass:a" });
    expect(armTap(row, "pass", first.armed)).toEqual({ fire: true, armed: null });
    expect(disarmRow("a", "pass:a")).toBeNull();
    expect(disarmRow("a", "pass:b")).toBe("pass:b");
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

  test("a superseded task is not offered, its successor is, and an edge the form already holds on it stays", () => {
    const tasks = [
      task("old", { state: "superseded", successor: "new" }),
      task("new", { state: "running", assignment: placedAt }),
    ];
    const offered = deriveAfterSheet(state(ok(tasks), { form }), NOW);
    expect(offered.options.map((o) => o.id)).toEqual(["new"]);

    const held = deriveAfterSheet(
      state(ok(tasks), { form: { ...form, after: [{ task: "old", after: "done" }] } }),
      NOW,
    );
    expect(held.options.map((o) => [o.id, o.when])).toEqual([
      ["old", "done"],
      ["new", null],
    ]);
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

describe("the Start now menu item", () => {
  const CAN = [CAPABILITIES.runNow];
  const capped: Reason = { code: "cap_reached", inFlight: 8, max: 8 };
  const disk: Reason = { code: "disk_low", freeMib: 10 };
  const rejecting = (reason: Reason): Task =>
    task("w", {
      decision: {
        at: NOW,
        chosen: null,
        candidates: [{ deviceId: "d", machine: "m", exclave: "main", rejected: [reason] }],
      },
    });
  const item = (t: Task, capabilities: readonly string[] = CAN) =>
    deriveQueue(state(ok([t]), {}, { machines: [machine({ capabilities })] }), NOW)
      .sections.flatMap((section) => section.rows)
      .find((row) => row.id === t.id)?.startNow;

  test("on a waiting task, enabled as the split button's menu is", () => {
    expect(item(rejecting(capped))?.enabled).toBe(true);
    expect(item(task("w"))?.enabled).toBe(true);
  });

  test("a task the queue's pause alone holds: enabled when the leader lifts the pause, else greyed saying so", () => {
    const paused: Reason = { code: "paused", until: "resume", scope: "queue" };
    expect(item(rejecting(paused), [...CAN, CAPABILITIES.runNowPaused])).toEqual({
      sub: "Skip the queue — spawn on m · main",
      enabled: true,
    });
    expect(item(rejecting(paused))).toEqual({ sub: "The queue is paused", enabled: false });
  });

  test("shown but disabled where nothing could take it, or the leader lacks runNow", () => {
    expect(item(rejecting(disk))?.enabled).toBe(false);
    expect(item(rejecting(capped), [])?.enabled).toBe(false);
  });

  test("shown but disabled, saying why, before the task is ready: the leader would refuse it", () => {
    expect(item(task("w", { state: "blocked" }))).toEqual({
      sub: "Waiting on the tasks it depends on",
      enabled: false,
    });
    expect(item(task("w", { state: "queued" }))).toEqual({ sub: "Waiting for the scheduler", enabled: false });
    // Not even a decision that would let it past the caps lifts it: run-now refuses a task that isn't ready.
    expect(item({ ...rejecting(capped), state: "blocked" })?.enabled).toBe(false);
  });

  test("absent once the task is not waiting", () => {
    expect(item({ ...task("w"), state: "failed" })).toBeNull();
  });
});

describe("the screen debounce on needs-input", () => {
  const HOUR = 3_600_000;
  const waiting = (fields: Partial<Task> = {}, skew = 0): Task =>
    task("w", { state: "needs-input", assignment: placedAt, needsInputSince: NOW + skew - 10_000, ...fields });
  const view = (t: Task, skew = 0) => deriveQueue(state(ok([t], [], skew)), NOW);

  test("a young stay shows as running: Running section, running headline, no Answer, counted as running", () => {
    const v = view(waiting({ remoteSession: "session_01TuECqfR7Twko9QJm98sWAw" }));
    expect(titles(v)).toEqual(["Running"]);
    expect(v.sections[0]?.rows[0]).toMatchObject({
      headline: [expect.stringMatching(/^It's running/u)],
      answer: null,
      dot: "ok",
    });
    expect(v.summary).toContain("1 running");
  });

  test("once past the threshold it is under Needs you, worded by its reason", () => {
    const v = view(
      waiting({ needsInputSince: NOW - NEEDS_INPUT_SCREEN_MS - 1_000, inputReason: "permission", inputTool: "Bash" }),
    );
    expect(titles(v)).toEqual(["Needs you"]);
    expect(lineText(v.sections[0]?.rows[0]?.headline ?? [])).toMatch(
      /^It may be waiting for permission to use Bash on /u,
    );
  });

  test("the comparison is on the leader's clock, whatever the device's", () => {
    for (const skew of [HOUR, -HOUR]) {
      expect(titles(view(waiting({}, skew), skew))).toEqual(["Running"]);
      const old = waiting({ needsInputSince: NOW + skew - 31_000 }, skew);
      expect(titles(view(old, skew))).toEqual(["Needs you"]);
    }
  });

  test("a question, an alerted or escalated stay, or one with no clock shows at once", () => {
    expect(titles(view(waiting({ inputReason: "question" })))).toEqual(["Needs you"]);
    expect(titles(view(waiting({ inputAlerted: true })))).toEqual(["Needs you"]);
    expect(titles(view(waiting({ escalated: true })))).toEqual(["Needs you"]);
    const { needsInputSince: _since, ...clockless } = waiting();
    expect(titles(view(clockless))).toEqual(["Needs you"]);
  });

  test("the escalated body says why, and a question reads as one", () => {
    const body = (fields: Partial<Task>) =>
      lineText(
        view(waiting({ escalated: true, needsInputSince: NOW - 31 * 60_000, ...fields })).sections[0]?.rows[0]?.body ??
          [],
      );
    expect(body({ inputReason: "permission", inputTool: "Bash" })).toBe(
      "May be waiting for permission to use Bash since 31m ago",
    );
    expect(body({ inputReason: "question" })).toBe("Asking a question since 31m ago");
    expect(body({ inputReason: "elicitation" })).toBe("Waiting for an answer to an MCP server since 31m ago");
    expect(body({})).toBe("Waiting for input since 31m ago");
  });

  test("a stamp well ahead of the leader's clock (another leader's) shows at once; a hair ahead still settles", () => {
    expect(titles(view(waiting({ needsInputSince: NOW + 10 * 60_000 })))).toEqual(["Needs you"]);
    expect(titles(view(waiting({ needsInputSince: NOW + 1_000 })))).toEqual(["Running"]);
  });

  test("the escalated body ages a leader-clock stamp against the device's", () => {
    const skew = HOUR;
    const t = waiting({ escalated: true, needsInputSince: NOW + skew - 31 * 60_000 }, skew);
    expect(lineText(view(t, skew).sections[0]?.rows[0]?.body ?? [])).toBe("Waiting for input since 31m ago");
  });

  test("the After sheet headlines a settling task as the Queue screen does", () => {
    const sheet = deriveAfterSheet(state(ok([waiting({ inputReason: "permission", inputTool: "Bash" })])), NOW);
    expect(sheet.options[0]?.headline).toMatch(/^It's running/u);
  });

  test("nextReveal names the earliest device-clock crossing, and null when nothing settles", () => {
    const skew = 5_000;
    const a = waiting({ needsInputSince: NOW + skew - 20_000 }, skew);
    const b = { ...waiting({ needsInputSince: NOW + skew - 5_000 }, skew), id: "b" };
    expect(nextReveal([b, a], NOW, skew)).toBe(NOW + skew - 20_000 + NEEDS_INPUT_SCREEN_MS - skew);
    expect(
      nextReveal([waiting({ inputReason: "question" }, skew), task("r", { state: "running" })], NOW, skew),
    ).toBeNull();
    expect(nextReveal([], NOW, 0)).toBeNull();
  });
});

describe("a task deferred by its not-before time", () => {
  const LATER = NOW + 3_600_000;
  const stale = (): Task =>
    task("w", {
      spec: { repo: ORIGIN, mode: "worktree", notBefore: LATER },
      decision: {
        at: NOW - 1000,
        chosen: { deviceId: "dev-a", exclave: "default", clone: "app" },
        candidates: [{ deviceId: "dev-a", machine: "m", exclave: "default", rejected: [] }],
      },
    });
  const rowAt = (t: Task, skew = 0) =>
    deriveQueue(state(ok([t], [], skew), {}, { machines: [machine({ capabilities: [CAPABILITIES.runNow] })] }), NOW)
      .sections.flatMap((section) => section.rows)
      .find((row) => row.id === t.id);

  test("says until when, in place of the decision's headline and body, and Start now names no machine", () => {
    const row = rowAt(stale());
    expect(lineText(row?.headline ?? [])).toMatch(/^Queued — until /u);
    expect(lineText(row?.body ?? [])).toMatch(/^Not placed before /u);
    expect(row?.startNow).toEqual({ sub: "Skip the queue", enabled: true });
  });

  test("a blocked task keeps its dependency headline and still shows the time in its body", () => {
    const blocked = task("b", { state: "blocked", spec: { repo: ORIGIN, mode: "worktree", notBefore: LATER } });
    const row = rowAt(blocked);
    expect(lineText(row?.headline ?? [])).not.toMatch(/^Queued — until /u);
    expect(lineText(row?.body ?? [])).toMatch(/^Not placed before /u);
  });

  test("says nothing once the leader's clock, by the skew, is past it", () => {
    const row = rowAt(stale(), 3_600_001);
    expect(lineText(row?.headline ?? [])).not.toContain("until");
    expect(lineText(row?.body ?? [])).not.toContain("Not placed before");
  });
});

describe("a task's tags on its row", () => {
  const rowOf = (t: Task, capabilities: readonly string[] = [CAPABILITIES.taskTags]) =>
    deriveQueue(state(ok([t]), {}, { machines: [machine({ capabilities })] }), NOW)
      .sections.flatMap((section) => section.rows)
      .find((row) => row.id === t.id);

  const tagged = task("t", {
    spec: {
      repo: ORIGIN,
      mode: "worktree",
      title: "Fix the thing",
      tags: {
        "creator.ref": "linear:ENG-1",
        "creator.ref-url": "https://linear.app/x/issue/ENG-1",
        "owner.label": "Mine",
      },
    },
  });

  test("the label names the card in place of the title, which it keeps, and the ref links to its https URL", () => {
    expect(rowOf(tagged)).toMatchObject({
      title: "Fix the thing",
      name: "Mine",
      label: "Mine",
      ref: { text: "linear:ENG-1", url: "https://linear.app/x/issue/ENG-1" },
    });
  });

  test("a task with no tags has no label and no ref", () => {
    const row = rowOf(task("t"));
    expect(row).toMatchObject({ label: null, ref: null });
    expect(row?.name).toBe(row?.title);
  });

  test("a ref URL that is not https is text only, and control characters are cut from every value", () => {
    const hostile = task("t", {
      spec: {
        repo: ORIGIN,
        mode: "worktree",
        tags: { "creator.ref": "linear:ENG-1", "creator.ref-url": "javascript:alert(1)", "owner.label": "a\nb" },
      },
    });
    const row = rowOf(hostile);
    expect(row?.ref).toEqual({ text: "linear:ENG-1", url: null });
    expect(row?.label).not.toContain("\n");
  });

  test("a legacy `linear` reads as the ref, and a ref of its own wins over it", () => {
    const legacy = task("t", {
      spec: { repo: ORIGIN, mode: "worktree", linear: { issue: "ENG-9", url: "https://linear.app/x/issue/ENG-9" } },
    });
    expect(rowOf(legacy)?.ref).toEqual({ text: "linear:ENG-9", url: "https://linear.app/x/issue/ENG-9" });
    const both = task("t", {
      spec: {
        repo: ORIGIN,
        mode: "worktree",
        linear: { issue: "ENG-9" },
        tags: { "creator.ref": "gh:42" },
      },
    });
    expect(rowOf(both)?.ref).toEqual({ text: "gh:42", url: null });
  });

  test("labelling is offered on any task, finished included, only while the verified leader takes task tags", () => {
    for (const s of ["queued", "running", "done", "failed"] as const) {
      expect(rowOf(task("t", { state: s, assignment: placedAt }))?.canLabel, s).toBe(true);
      expect(rowOf(task("t", { state: s, assignment: placedAt }), [])?.canLabel, s).toBe(false);
    }
  });
});

describe("sessions on the queue screen", () => {
  const conversation = "1a2b3c4d-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  const REMOTE = "session_01TuECqfR7Twko9QJm98sWAw";
  const at = { deviceId: "dev-a", exclave: "main", clone: "app", window: "w" };
  const entry = (id: string, fields: Partial<SessionEntry> = {}): SessionEntry => ({
    id,
    window: `win-${id}`,
    repo: "app",
    path: "/x",
    ...fields,
  });
  const live = (kind: "busy" | "idle" | "needs-input", ago: number, extra: object = {}) => ({
    state: kind,
    since: NOW - ago,
    ...extra,
  });
  const read = (entries: readonly SessionEntry[], deviceId = "dev-a"): AppState["sessions"] => ({
    [deviceId]: { at: NOW, sessions: entries },
  });
  const viewOf = (
    tasks: readonly Task[] | null,
    sessions: AppState["sessions"],
    machines: readonly Machine[] = [machine()],
    idle: readonly IdleTaskRef[] = [],
  ) => deriveQueue(state(tasks === null ? null : ok(tasks, [], 0, idle), { sessions }, { machines }), NOW);
  const placement = (view: ReturnType<typeof deriveQueue>) =>
    view.sections.map((s) => [s.title, [...s.rows.map((r) => r.id), ...s.sessions.map((r) => r.id)]]);

  test("a tasked session folds into its task's row, adding Close and its tags, and makes no row of its own", () => {
    const view = viewOf(
      [task("t", { state: "running", assignment: at })],
      read([entry("%1", { taskId: "t", tags: { "self.doing": { value: "on it", at: NOW, scope: "process" } } })]),
    );
    expect(placement(view)).toEqual([["Running", ["t"]]]);
    const row = view.sections[0]?.rows[0];
    expect(row?.close).toEqual({ deviceId: "dev-a", pane: "%1" });
    expect(row?.sessionTags.map((g) => [g.namespace, g.tags.map((t) => t.value)])).toEqual([["self", ["on it"]]]);
    // No session read: no Close, no tags.
    const bare = viewOf([task("t", { state: "running", assignment: at })], {}).sections[0]?.rows[0];
    expect([bare?.close, bare?.sessionTags]).toEqual([null, []]);
  });

  test("an untasked session is a row named as the machine card names it, with where it runs, its mark and its state", () => {
    const view = viewOf(
      [],
      read([
        entry("%2", {
          tags: {
            "owner.label": { value: "Triage", at: NOW, scope: "conversation" },
            "agent.remote": { value: REMOTE, at: NOW, scope: "process" },
          },
          live: live("needs-input", 3 * 60_000, { reason: "permission" }),
        }),
        entry("%3", { repo: null, live: live("idle", 12 * 60_000) }),
      ]),
    );
    const rows = view.sections.flatMap((s) => s.sessions);
    expect(
      rows.map((r) => [r.id, r.name, r.nameMark, r.kind, r.where, lineText(r.state), r.session, r.tasked]),
    ).toEqual([
      [
        "session:dev-a:%2",
        "Triage",
        null,
        "Not a task",
        "Mac · app",
        "Waiting on you: permission since 3m ago",
        `https://claude.ai/code/${REMOTE}`,
        false,
      ],
      ["session:dev-a:%3", "win-%3", "(window)", "Not a task", "Mac", "Idle since 12m ago", null, false],
    ]);
    expect(view.empty).toBeNull();
  });

  test("a session row is placed by live: needs-input, busy, idle, none (Running, unknown), and Asleep off a sleeping machine", () => {
    const view = viewOf(
      [],
      {
        ...read([
          entry("%1", { live: live("needs-input", 1000) }),
          entry("%2", { live: live("busy", 1000) }),
          entry("%3", { live: live("idle", 1000) }),
          entry("%4"),
        ]),
        ...read([entry("%9", { live: live("busy", 1000) })], "dev-b"),
      },
      [machine(), machine({ deviceId: "dev-b", name: "Box", connected: false })],
    );
    expect(placement(view)).toEqual([
      ["Needs you", ["session:dev-a:%1"]],
      ["Running", ["session:dev-a:%2", "session:dev-a:%4"]],
      ["Idle", ["session:dev-a:%3"]],
      ["Asleep", ["session:dev-b:%9"]],
    ]);
    const unknown = view.sections[1]?.sessions[1];
    expect(lineText(unknown?.state ?? [])).toBe("State unknown");
  });

  test("a running task is placed by its session's live when read, else by the leader's idle list", () => {
    const tasks = ["busy", "idle", "asks", "fallback", "nolive"].map((id) =>
      task(id, { state: "running", assignment: at }),
    );
    const sessions = read([
      // Live wins over the leader's idle list, both ways.
      entry("%1", { taskId: "busy", live: live("busy", 1000) }),
      entry("%2", { taskId: "idle", live: live("idle", 5 * 60_000) }),
      entry("%3", { taskId: "asks", live: live("needs-input", 2 * 60_000, { reason: "question" }) }),
      entry("%5", { taskId: "nolive" }),
    ]);
    const released = [
      { taskId: "busy", since: NOW - 60_000 },
      { taskId: "fallback", since: NOW - 60_000 },
    ];
    const view = viewOf(tasks, sessions, [machine()], released);
    expect(placement(view)).toEqual([
      ["Needs you", ["asks"]],
      ["Running", ["busy", "nolive"]],
      ["Idle", ["idle", "fallback"]],
    ]);
    const asks = view.sections[0]?.rows[0];
    expect(lineText(asks?.body ?? [])).toBe("Waiting on you: a question since 2m ago");
    // An asleep machine keeps its last read, but its live no longer places a task.
    const asleep = viewOf(tasks.slice(0, 1), read([entry("%1", { taskId: "busy", live: live("idle", 1000) })]), [
      machine({ connected: false }),
    ]);
    expect(placement(asleep)).toEqual([["Asleep", ["busy"]]]);
  });

  test("a session whose task the list leaves out stays a session row, marked so, and waits for a list to say so", () => {
    const sessions = read([entry("%1", { taskId: "gone", live: live("busy", 1000) })]);
    const view = viewOf([], sessions);
    const [row] = view.sections.flatMap((s) => s.sessions);
    expect([row?.kind, row?.tasked, row?.rename]).toEqual(["Task not listed", true, null]);
    expect(view.summary).toBe("1 running · 0 waiting");
    // Before a list is read, every tasked session would read as unlisted.
    expect(viewOf(null, sessions).sections).toEqual([]);
  });

  test("the summary counts untasked sessions apart, and the fleet cap counts tasks only", () => {
    const view = deriveQueue(
      state(ok([task("t", { state: "running", assignment: at })], [], 0, [], 3), {
        sessions: read([entry("%1", { live: live("busy", 1000) }), entry("%2", { live: live("idle", 1000) })]),
      }),
      NOW,
    );
    expect(view.summary).toBe("1/3 running · 0 waiting · 2 sessions");
    expect(viewOf([], read([entry("%1")])).summary).toBe("0 running · 0 waiting · 1 session");
  });

  test("a session row offers Rename only with sessionTag over an open relay, and Close only on a connected machine", () => {
    const verified: SessionEntry["tags"] = {
      "agent.session": { value: conversation, at: NOW, scope: "conversation", verified: true },
    };
    const rowWith = (machines: readonly Machine[], relay: Partial<RelayState> = {}) =>
      deriveQueue(
        state(ok([]), { sessions: read([entry("%1", { tags: verified })]) }, { machines, ...relay }),
        NOW,
      ).sections.flatMap((s) => s.sessions)[0];
    const tagging = machine({ capabilities: [CAPABILITIES.sessionTag] });
    expect(rowWith([tagging])?.rename).toEqual({ pane: "%1", session: conversation, label: "" });
    expect(rowWith([tagging])?.close).toEqual({ deviceId: "dev-a", pane: "%1" });
    expect(rowWith([machine()])?.rename).toBeNull();
    const closed = rowWith([tagging], { status: "connecting" });
    expect([closed?.rename, closed?.close]).toEqual([null, null]);
    const asleep = rowWith([machine({ capabilities: [CAPABILITIES.sessionTag], connected: false })]);
    expect([asleep?.rename, asleep?.close]).toEqual([null, null]);
  });

  test("Close always asks twice, and the row's menu closing disarms it", () => {
    const first = armTap({ id: "session:dev-a:%1" }, "close", null);
    expect(first.fire).toBe(false);
    expect(armTap({ id: "session:dev-a:%1" }, "close", first.armed)).toEqual({ fire: true, armed: null });
    expect(disarmRow("session:dev-a:%1", first.armed)).toBeNull();
    expect(disarmRow("other", first.armed)).toBe(first.armed);
  });
});
