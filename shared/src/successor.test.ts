import { describe, expect, test } from "bun:test";
import type { Machine } from "./app-client.ts";
import { importPsk, openAtRest, sealAtRest, toBase64 } from "./crypto.ts";
import {
  bindTaskRecord,
  parsePassReply,
  parsePushBranchRequest,
  parsePushBranchResponse,
  parseTask,
  parseTaskSpec,
} from "./parse.ts";
import { passOffer, successorPreamble, successorPrompt, successorSpec } from "./successor.ts";
import { openTaskRecord, sealTaskRecord, taskKey } from "./task-record.ts";
import { readsPrWhileWaiting, TASK_PHASES, wantsPrReading } from "./task-phase.ts";
import {
  APP_ID,
  CAPABILITIES,
  REQUIRES_DEP_SENTINEL,
  SCHEDULER_ID,
  STORE_CREATE_MAX_CT_LENGTH,
  SUCCESSOR_DEP_SENTINEL,
  SUCCESSOR_PROMPT_BYTES,
  TASK_REQUEST_LIMITS,
  type Assignment,
  type Task,
  type TaskSpec,
} from "./types.ts";

const key = await importPsk(toBase64(new Uint8Array(32).fill(7)));
const NOW = 1_760_000_000_000;
const PR = "https://github.com/acme/app/pull/7";
const assignment: Assignment = { deviceId: "dev-a", exclave: "default", clone: "app", window: "w", pane: "%1" };
const TIP = "a".repeat(40);

function machine(over: Partial<Machine> = {}): Machine {
  return {
    deviceId: "dev-a",
    name: "Box",
    platform: "linux",
    repos: [],
    scannedAt: 0,
    lastSeen: 0,
    connected: true,
    capabilities: [CAPABILITIES.successor],
    ...over,
  };
}

function running(over: Partial<Task> = {}, spec: Partial<TaskSpec> = {}): Task {
  return {
    id: "t-old",
    spec: { repo: "github.com/acme/app", mode: "worktree", prompt: "do it", ...spec },
    state: "running",
    createdAt: NOW,
    assignment,
    ...over,
  };
}

const succeeds = {
  task: "t-old",
  account: "org:a",
  at: { deviceId: "dev-a", exclave: "default", clone: "app" },
  trigger: "manual",
} as const;

function successorTask(spec: Partial<TaskSpec> = {}, over: Partial<Task> = {}): Task {
  return {
    id: "t-new",
    spec: { repo: "github.com/acme/app", mode: "worktree", prompt: "go", succeeds, ...spec },
    state: "queued",
    createdAt: NOW,
    ...over,
  };
}

describe("passOffer", () => {
  const offer = (task: Task, machines = [machine()], leader = true): ReturnType<typeof passOffer> =>
    passOffer(task, machines, leader);

  test("a running worktree task on a capable, connected machine under a capable leader", () => {
    expect(offer(running())).toEqual({ ok: true });
  });

  test("never one that waits on a person, is not running, runs in place, was not placed, or already passed", () => {
    expect(offer(running({ state: "needs-input" }))).toMatchObject({ ok: false });
    for (const state of ["queued", "ready", "lost", "awaiting-merge", "done", "superseded"] as const) {
      expect(offer(running({ state }))).toMatchObject({ ok: false });
    }
    expect(offer(running({}, { mode: "here" }))).toMatchObject({ ok: false });
    const { assignment: _assignment, ...unplaced } = running();
    expect(offer(unplaced)).toMatchObject({ ok: false });
    expect(offer(running({ successor: "t-new" }))).toMatchObject({ ok: false });
  });

  test("not under a leader or on a machine that cannot, or that is gone or away", () => {
    expect(offer(running(), [machine()], false)).toMatchObject({ ok: false });
    expect(offer(running(), [machine({ capabilities: [] })])).toMatchObject({ ok: false });
    expect(offer(running(), [machine({ connected: false })])).toMatchObject({ ok: false });
    expect(offer(running(), [])).toMatchObject({ ok: false });
  });
});

describe("successorSpec", () => {
  test("carries what shapes and settles the session, and nothing that places or orders it", () => {
    const old = running(
      {},
      {
        title: "fix it",
        model: "opus",
        effort: "high",
        skill: "review",
        avoid: ["dev-z"],
        requires: ["atlas"],
        until: "reported",
        linear: { issue: "PEN-1" },
        pin: { account: "org:x" },
        deps: [{ task: "t-dep", after: "done" }],
        base: { deviceId: "dev-b", exclave: "default" },
        lineage: { deviceId: "dev-b", exclave: "default" },
        batch: { id: crypto.randomUUID(), index: 1 },
      },
    );
    const spec = successorSpec({ ...old, assignment }, "org:a", "manual", "the prompt");
    expect(spec).toEqual({
      repo: "github.com/acme/app",
      mode: "worktree",
      prompt: "the prompt",
      title: "fix it",
      model: "opus",
      effort: "high",
      skill: "review",
      avoid: ["dev-z"],
      requires: ["atlas"],
      until: "reported",
      linear: { issue: "PEN-1" },
      succeeds: {
        task: "t-old",
        account: "org:a",
        at: { deviceId: "dev-a", exclave: "default", clone: "app" },
        trigger: "manual",
      },
    });
  });

  test("a steered task's successor runs at checkpoint with no plan; auto and checkpoint stay", () => {
    const of = (spec: Partial<TaskSpec>): TaskSpec =>
      successorSpec({ ...running({}, spec), assignment }, "org:a", "manual");
    expect(of({ autonomy: "steer", plan: true })).toMatchObject({ autonomy: "checkpoint" });
    expect(of({ autonomy: "steer", plan: true }).plan).toBeUndefined();
    expect(of({ plan: true })).toMatchObject({ autonomy: "checkpoint" });
    expect(of({ autonomy: "auto", plan: true })).toMatchObject({ autonomy: "auto", plan: true });
    expect(of({ autonomy: "checkpoint" })).toMatchObject({ autonomy: "checkpoint" });
  });
});

describe("successorPrompt", () => {
  const input = (task: Task, record?: string) => ({
    task,
    remoteBranch: "feature/x",
    tip: TIP,
    ...(record === undefined ? {} : { record }),
  });

  test("names the pushed branch and tip, the fixed git steps, the old prompt and the Linear key", () => {
    const { prompt, recordCut } = successorPrompt(
      input(running({ prUrl: PR }, { prompt: "fix the login bug", linear: { issue: "PEN-7" } })),
    );
    expect(recordCut).toBe(false);
    expect(prompt).toContain(`feature/x on origin at ${TIP}`);
    expect(prompt).toContain("git fetch origin feature/x");
    expect(prompt).toContain("git reset --hard origin/feature/x");
    expect(prompt).toContain("git branch --set-upstream-to=origin/feature/x");
    expect(prompt).toContain("git push origin HEAD:feature/x");
    expect(prompt).toContain(PR);
    expect(prompt).toContain("fix the login bug");
    expect(prompt).toContain("PEN-7");
    // The remote branch's own name, never a switch to it under that name.
    expect(prompt).not.toContain("git switch");
    expect(prompt).not.toContain("git checkout");
  });

  test("a branch name no shell would take bare is quoted", () => {
    const { prompt } = successorPrompt({ task: running(), remoteBranch: "x$(id)", tip: TIP });
    expect(prompt).toContain("git fetch origin 'x$(id)'");
    expect(prompt).not.toContain("fetch origin x$(id)");
  });

  test("says so when the original task had attachments, which the successor does not get", () => {
    const attachments = [
      { id: "0b6f0c9e-1a2b-4c3d-8e9f-001122334455", name: "a.png", type: "image/png", size: 1, hash: "A".repeat(43) },
    ];
    expect(successorPreamble({ task: running({}, { attachments }), remoteBranch: "b", tip: TIP })).toContain(
      "attached files",
    );
  });

  test("the old prompt is cut first, from its end, both bounds held and the preamble whole", () => {
    const big = "x".repeat(TASK_REQUEST_LIMITS.prompt);
    const task = running({}, { prompt: big });
    const { prompt, recordCut } = successorPrompt(input(task));
    expect(recordCut).toBe(false);
    expect(prompt.length).toBeLessThanOrEqual(TASK_REQUEST_LIMITS.prompt);
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(SUCCESSOR_PROMPT_BYTES);
    expect(prompt.startsWith(successorPreamble(input(task)))).toBe(true);
    expect(prompt).toContain("The rest of the original prompt was cut to fit.");
  });

  test("three-byte text is held to the byte bound, not only the unit bound", () => {
    const wide = "€".repeat(TASK_REQUEST_LIMITS.prompt);
    const { prompt } = successorPrompt(input(running({}, { prompt: wide })));
    expect(prompt.length).toBeLessThanOrEqual(TASK_REQUEST_LIMITS.prompt);
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(SUCCESSOR_PROMPT_BYTES);
  });

  test("a record is kept whole while the old prompt makes room, and cut at its end only as the last resort", () => {
    const task = running({}, { prompt: "y".repeat(5_000) });
    const room = successorPrompt(input(task, "r".repeat(2_000)));
    expect(room.recordCut).toBe(false);
    expect(room.prompt).toContain("r".repeat(2_000));

    const huge = successorPrompt(input(task, "r".repeat(TASK_REQUEST_LIMITS.prompt)));
    expect(huge.recordCut).toBe(true);
    expect(huge.prompt.length).toBeLessThanOrEqual(TASK_REQUEST_LIMITS.prompt);
    expect(new TextEncoder().encode(huge.prompt).length).toBeLessThanOrEqual(SUCCESSOR_PROMPT_BYTES);
    expect(huge.prompt).not.toContain("The original task prompt");
    expect(huge.prompt.startsWith(successorPreamble(input(task)))).toBe(true);
  });

  test("a cut never splits a surrogate pair", () => {
    const emoji = "😀".repeat(TASK_REQUEST_LIMITS.prompt);
    const { prompt } = successorPrompt(input(running({}, { prompt: emoji })));
    expect(prompt.isWellFormed()).toBe(true);
  });
});

describe("a successor's record", () => {
  test("a spec with succeeds parses, and reads back as it was", () => {
    const task = successorTask();
    expect(parseTaskSpec(task.spec)).toEqual(task.spec);
  });

  test("succeeds is refused beside a mode other than worktree, a continuation or attachments, and with a bad part", () => {
    for (const spec of [
      { ...successorTask().spec, mode: "here" },
      { ...successorTask().spec, mode: "continue", continues: { task: "t-x", at: succeeds.at } },
      { ...successorTask().spec, continues: { task: "t-x", at: succeeds.at } },
      {
        ...successorTask().spec,
        attachments: [
          { id: "0b6f0c9e-1a2b-4c3d-8e9f-001122334455", name: "a", type: "image/png", size: 1, hash: "A".repeat(43) },
        ],
      },
      { ...successorTask().spec, succeeds: { ...succeeds, trigger: "quota" } },
      { ...successorTask().spec, succeeds: { ...succeeds, task: "not a task id!" } },
      { ...successorTask().spec, succeeds: { ...succeeds, at: { deviceId: "dev-a" } } },
    ]) {
      expect(parseTaskSpec(spec)).toBeNull();
    }
  });

  test("the dep sentinel is dropped beside succeeds, and refused without it", () => {
    const spec = successorTask().spec;
    expect(parseTaskSpec({ ...spec, deps: [SUCCESSOR_DEP_SENTINEL] })).toEqual(spec);
    expect(parseTaskSpec({ ...spec, deps: [SUCCESSOR_DEP_SENTINEL, { task: "t-x", after: "done" }] })).toEqual({
      ...spec,
      deps: [{ task: "t-x", after: "done" }],
    });
    const { succeeds: _succeeds, ...plain } = spec;
    expect(parseTaskSpec({ ...plain, deps: [SUCCESSOR_DEP_SENTINEL] })).toBeNull();
  });

  test("sealed with the sentinel an older leader refuses, and opened without it", async () => {
    const task = successorTask();
    const env = await sealTaskRecord(key, APP_ID, { version: 1, task });
    const { payload } = await openAtRest(key, env, "task");
    const deps = (payload as { task: { spec: { deps?: unknown[] } } }).task.spec.deps;
    expect(deps).toEqual([SUCCESSOR_DEP_SENTINEL]);
    expect(await openTaskRecord(key, { key: taskKey(task.id), version: 1, env }, NOW)).toEqual({ version: 1, task });
  });

  test("a stored record carrying succeeds without the sentinel is held unreadable", async () => {
    const task = successorTask();
    // Sealed past the one sealer: what an older leader would run beside the still-running predecessor.
    const env = await sealAtRest(key, { to: SCHEDULER_ID, from: APP_ID }, "task", { version: 1, task });
    expect(await openTaskRecord(key, { key: taskKey(task.id), version: 1, env }, NOW)).toBe("malformed");
  });

  test("a successor carrying requires seals both sentinels, and each is tied to its own field", async () => {
    const task = successorTask({ requires: ["atlas"] });
    const env = await sealTaskRecord(key, APP_ID, { version: 1, task });
    const { payload } = await openAtRest(key, env, "task");
    const deps = (payload as { task: { spec: { deps?: unknown[] } } }).task.spec.deps;
    expect(deps).toEqual([REQUIRES_DEP_SENTINEL, SUCCESSOR_DEP_SENTINEL]);
    expect(await openTaskRecord(key, { key: taskKey(task.id), version: 1, env }, NOW)).toEqual({ version: 1, task });

    // Each sentinel beside only the other field is a record something stripped a gate from.
    const { succeeds: _succeeds, ...required } = task.spec;
    expect(parseTaskSpec({ ...required, deps: [SUCCESSOR_DEP_SENTINEL] })).toBeNull();
    const { requires: _requires, ...succeeding } = task.spec;
    expect(parseTaskSpec({ ...succeeding, deps: [REQUIRES_DEP_SENTINEL] })).toBeNull();
    expect(parseTaskSpec({ ...task.spec, deps: [SUCCESSOR_DEP_SENTINEL, REQUIRES_DEP_SENTINEL] })).toEqual(task.spec);

    // Sealed past the one sealer with only the requirement's gate: an older leader would run it beside its predecessor.
    const partial = await sealAtRest(key, { to: SCHEDULER_ID, from: APP_ID }, "task", {
      version: 1,
      task: { ...task, spec: { ...task.spec, deps: [REQUIRES_DEP_SENTINEL] } },
    });
    expect(await openTaskRecord(key, { key: taskKey(task.id), version: 1, env: partial }, NOW)).toBe("malformed");
  });

  test("a successor at the largest prompt still seals under the create bound", async () => {
    const task = successorTask(
      { prompt: "€".repeat(SUCCESSOR_PROMPT_BYTES / 3 - 1), title: "t".repeat(100) },
      {
        prUrl: PR,
      },
    );
    const env = await sealTaskRecord(key, APP_ID, { version: 1, task });
    expect(env.ct.length).toBeLessThanOrEqual(STORE_CREATE_MAX_CT_LENGTH);
  });

  test("a task cannot succeed itself", () => {
    const task = successorTask({ succeeds: { ...succeeds, task: "t-new" } });
    expect(bindTaskRecord({ version: 1, task }, { key: taskKey(task.id), version: 1 }, NOW)).toBe("malformed");
  });
});

describe("a task carrying successor", () => {
  test("only while it holds or may hold a session, or once superseded", () => {
    for (const state of ["running", "needs-input"] as const) {
      expect(parseTask(running({ state, successor: "t-new" }))?.successor).toBe("t-new");
    }
    expect(parseTask({ ...running({ state: "lost" }), absentSince: NOW, successor: "t-new" })?.successor).toBe("t-new");
    for (const state of ["queued", "done", "failed", "cancelled", "awaiting-merge"] as const) {
      expect(parseTask(running({ state, successor: "t-new" }))).toBeNull();
    }
    expect(parseTask(running({ state: "superseded", successor: "t-new" }))).toMatchObject({
      state: "superseded",
      successor: "t-new",
    });
  });

  test("superseded without it is unreadable, as is a successor that is no task id", () => {
    expect(parseTask(running({ state: "superseded" }))).toBeNull();
    expect(parseTask(running({ successor: "not a task id!" }))).toBeNull();
  });

  test("superseded is a finished state", () => {
    expect(TASK_PHASES.superseded).toBe("finished");
  });
});

describe("a waiting successor's PR is read", () => {
  const waiting = (state: Task["state"], spec: Partial<TaskSpec> = {}): Pick<Task, "state" | "prUrl" | "spec"> => ({
    state,
    prUrl: PR,
    spec: { repo: "r", mode: "worktree", ...spec },
  });

  test("only a waiting task that carries succeeds and a PR", () => {
    for (const state of ["queued", "blocked", "ready"] as const) {
      expect(readsPrWhileWaiting(waiting(state, { succeeds }))).toBe(true);
      expect(wantsPrReading(waiting(state, { succeeds }))).toBe(true);
      expect(wantsPrReading(waiting(state))).toBe(false);
    }
    expect(readsPrWhileWaiting({ state: "ready", spec: { repo: "r", mode: "worktree", succeeds } })).toBe(false);
    // A reserved task's spawn is in flight; once placed, the existing rule applies.
    expect(readsPrWhileWaiting(waiting("reserved", { succeeds }))).toBe(false);
  });
});

describe("push-branch and pass on the wire", () => {
  test("a request names a task and, optionally, a branch", () => {
    expect(parsePushBranchRequest({ taskId: "t-old" })).toEqual({ taskId: "t-old" });
    expect(parsePushBranchRequest({ taskId: "t-old", expect: "feature/x" })).toEqual({
      taskId: "t-old",
      expect: "feature/x",
    });
    for (const bad of [
      null,
      {},
      { taskId: "t-old", expect: "-x" },
      { taskId: "t-old", expect: "a..b" },
      { taskId: "t-old", expect: 3 },
      { taskId: "not a task id!" },
    ]) {
      expect(parsePushBranchRequest(bad)).toBeNull();
    }
  });

  test("a response carries a valid branch and commit, or a known refusal", () => {
    expect(parsePushBranchResponse({ ok: true, remoteBranch: "feature/x", tip: TIP, pushed: true })).toEqual({
      ok: true,
      remoteBranch: "feature/x",
      tip: TIP,
      pushed: true,
    });
    expect(parsePushBranchResponse({ ok: false, code: "dirty_worktree", message: "m" })).toMatchObject({
      ok: false,
      code: "dirty_worktree",
    });
    for (const bad of [
      { ok: true, remoteBranch: "-rf", tip: TIP, pushed: true },
      { ok: true, remoteBranch: "feature/x", tip: "xyz", pushed: true },
      { ok: true, remoteBranch: "feature/x", tip: TIP },
      { ok: false, code: "made_up", message: "m" },
      { ok: false, code: "push_failed" },
    ]) {
      expect(parsePushBranchResponse(bad)).toBeNull();
    }
  });

  test("a pass reply is the old task, the successor's id and the successor or null, or an error", () => {
    const old = running({ state: "superseded", successor: "t-new" });
    expect(parsePassReply({ task: old, successorId: "t-new", successor: null })).toEqual({
      task: old,
      successorId: "t-new",
      successor: null,
    });
    expect(parsePassReply({ task: old, successorId: "t-new", successor: successorTask() })).toMatchObject({
      successor: { id: "t-new" },
    });
    expect(parsePassReply({ ok: false, code: "dirty_worktree", message: "m" })).toMatchObject({ ok: false });
    expect(parsePassReply({ task: old, successorId: "bad id!", successor: null })).toBeNull();
    expect(parsePassReply({ task: { id: "x" }, successorId: "t-new", successor: null })).toBeNull();
  });
});
