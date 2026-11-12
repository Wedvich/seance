import { describe, expect, test } from "bun:test";
import type { Machine } from "./app-client.ts";
import { importPsk, openAtRest, sealAtRest, toBase64 } from "./crypto.ts";
import {
  bindTaskRecord,
  parsePassCloseRequest,
  parsePassCloseResponse,
  parsePassReply,
  parsePushBranchRequest,
  parsePushBranchResponse,
  parseSessionPass,
  parseTask,
  parseTaskSpec,
} from "./parse.ts";
import { passOffer, successorPreamble, successorPrompt, successorSpec } from "./successor.ts";
import {
  openTaskRecord,
  REPORT_DONE_INSTRUCTION,
  sealTaskRecord,
  taskKey,
  withReportInstruction,
} from "./task-record.ts";
import { readsPrWhileWaiting, TASK_PHASES, wantsPrReading } from "./task-phase.ts";
import {
  APP_ID,
  CAPABILITIES,
  REQUIRES_DEP_SENTINEL,
  SCHEDULER_ID,
  STORE_CREATE_MAX_CT_LENGTH,
  SUCCESSOR_DEP_SENTINEL,
  SUCCESSOR_PREAMBLE_MAX,
  SUCCESSOR_PROMPT_BYTES,
  SUCCESSOR_RECORD_MAX,
  TASK_PRS_MAX,
  TASK_PRS_MAX_LENGTH,
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

  test("a finished task is worded as finished, and a reserved one as still starting", () => {
    for (const state of ["done", "failed", "cancelled"] as const) {
      expect(offer(running({ state }))).toEqual({ ok: false, reason: "it has already finished" });
    }
    expect(offer(running({ state: "reserved" }))).toEqual({
      ok: false,
      reason: "it is still being started on a machine; try again in a moment",
    });
    // A superseded task carries its successor, which answers first.
    expect(offer(running({ state: "superseded", successor: "t-new" }))).toEqual({
      ok: false,
      reason: "it has already been passed to a successor",
    });
    // The rest of the not-running states keep the old words.
    expect(offer(running({ state: "ready" }))).toEqual({
      ok: false,
      reason: "only a running task can be passed to a successor",
    });
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

  test("since is written only for a quota pass", () => {
    const of = (trigger: "quota" | "manual", since?: number): TaskSpec =>
      successorSpec({ ...running({}), assignment }, "org:a", trigger, undefined, since);
    expect(of("quota", 7).succeeds).toMatchObject({ trigger: "quota", since: 7 });
    expect(of("quota").succeeds).not.toHaveProperty("since");
    expect(of("manual", 7).succeeds).not.toHaveProperty("since");
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
  const fits = (prompt: string): boolean =>
    prompt.length <= TASK_REQUEST_LIMITS.prompt && new TextEncoder().encode(prompt).length <= SUCCESSOR_PROMPT_BYTES;
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

  describe("the report instruction", () => {
    const reported = (prompt: string, over: Partial<TaskSpec> = {}): Task =>
      running({}, { prompt: withReportInstruction(prompt), until: "reported", ...over });
    const endsWithOnce = (prompt: string): boolean =>
      prompt.endsWith(`\n\n${REPORT_DONE_INSTRUCTION}`) && prompt.split(REPORT_DONE_INSTRUCTION).length === 2;

    test("comes last and once when the old prompt fits whole", () => {
      const { prompt } = successorPrompt({ ...input(reported("fix it", { linear: { issue: "PEN-7" } })) });
      expect(endsWithOnce(prompt)).toBe(true);
      expect(prompt).toContain("fix it\n\nLinear issue: PEN-7");
    });

    test("survives the old prompt's cut", () => {
      const { prompt, recordCut } = successorPrompt(input(reported("x".repeat(TASK_REQUEST_LIMITS.prompt))));
      expect(recordCut).toBe(false);
      expect(prompt).toContain("The rest of the original prompt was cut to fit.");
      expect(endsWithOnce(prompt)).toBe(true);
      expect(fits(prompt)).toBe(true);
    });

    test("survives the record's cut", () => {
      const task = reported("y".repeat(5_000), { linear: { issue: "PEN-7" } });
      const { prompt, recordCut } = successorPrompt(input(task, "r".repeat(TASK_REQUEST_LIMITS.prompt)));
      expect(recordCut).toBe(true);
      expect(endsWithOnce(prompt)).toBe(true);
      expect(fits(prompt)).toBe(true);
    });

    test("is added when the old prompt lacks it, and a prompt that merely names the tool is left whole", () => {
      const bare = running({}, { prompt: "call report_task_done when done", until: "reported" });
      const { prompt } = successorPrompt(input(bare));
      expect(prompt).toContain("call report_task_done when done");
      expect(endsWithOnce(prompt)).toBe(true);
    });

    test("a task without until gets none", () => {
      const { prompt } = successorPrompt(input(running({}, { prompt: "fix it" })));
      expect(prompt).not.toContain(REPORT_DONE_INSTRUCTION);
    });

    test("an old prompt that was only the instruction leaves no empty original-prompt section", () => {
      const task = running({}, { prompt: withReportInstruction(""), until: "reported" });
      const { prompt } = successorPrompt(input(task));
      expect(prompt).not.toContain("The original task prompt");
      expect(endsWithOnce(prompt)).toBe(true);
    });
  });

  test("the preamble's fixed wording fits its bound", () => {
    const attached = running(
      {},
      {
        attachments: [
          {
            id: "0b6f0c9e-1a2b-4c3d-8e9f-001122334455",
            name: "a.png",
            type: "image/png",
            size: 1,
            hash: "A".repeat(43),
          },
        ],
      },
    );
    // The fixed wording alone: less the 40-unit tip and the one-unit task id. The PR branch adds the
    // hand-off line, so it is measured too, less the URL it substitutes.
    const bare = successorPreamble({ task: { ...attached, id: "t" }, remoteBranch: "b", tip: TIP });
    expect(bare.length - 40 - 2).toBeLessThanOrEqual(SUCCESSOR_PREAMBLE_MAX);
    for (const until of ["merged", "reported"] as const) {
      const withPr = { ...attached, id: "t", prUrl: PR, spec: { ...attached.spec, until } };
      const preamble = successorPreamble({ task: withPr, remoteBranch: "b", tip: TIP });
      expect(preamble).toContain("hand_off_task");
      expect(preamble.length - 40 - 2 - PR.length).toBeLessThanOrEqual(SUCCESSOR_PREAMBLE_MAX);
    }
  });

  test("the fixed part at its largest still fits, with no record and no old prompt", () => {
    const each = TASK_PRS_MAX_LENGTH / TASK_PRS_MAX;
    const prs = Array.from({ length: TASK_PRS_MAX }, (_, i) => ({ url: `https://${"x".repeat(each - 9 - 1)}${i}` }));
    const { prompt: _prompt, ...noPrompt } = running().spec;
    const task: Task = {
      ...running({ prs, prUrl: prs[0]?.url }),
      spec: { ...noPrompt, until: "reported", linear: { issue: "PEN-1234" } },
    };
    const { prompt, recordCut } = successorPrompt({ task, remoteBranch: "b".repeat(250), tip: TIP });
    expect(recordCut).toBe(false);
    expect(fits(prompt)).toBe(true);
    expect(prompt.endsWith(REPORT_DONE_INSTRUCTION)).toBe(true);
    expect(prompt).not.toContain("was too long");
  });

  test("an inherited pull request tells the successor not to call hand_off_task; a PR-less one does not", () => {
    expect(successorPreamble({ task: running({ prUrl: PR }), remoteBranch: "b", tip: TIP })).toContain(
      "Do not call hand_off_task for the pull request above",
    );
    const waits = successorPreamble({ task: running({ prUrl: PR }), remoteBranch: "b", tip: TIP });
    expect(waits).toContain("the scheduler settles this task when it merges");
    expect(waits).not.toContain("end your turn");
    // Under `reported` a merge settles nothing: the line must not send the session idle before its report.
    const reported = successorPreamble({
      task: running({ prUrl: PR }, { until: "reported" }),
      remoteBranch: "b",
      tip: TIP,
    });
    expect(reported).toContain("a merge alone does not settle this task");
    expect(reported).not.toContain("end your turn");
    expect(reported).not.toContain("settles this task when it merges");
    const bare = successorPreamble({ task: running(), remoteBranch: "b", tip: TIP });
    expect(bare).not.toContain("hand_off_task");
    expect(bare).toContain("Open a pull request once there is something to review.");
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
      { ...successorTask().spec, succeeds: { ...succeeds, trigger: "later" } },
      // `since` is a quota pass's alone, and a time.
      { ...successorTask().spec, succeeds: { ...succeeds, since: 5 } },
      { ...successorTask().spec, succeeds: { ...succeeds, trigger: "session", since: 5 } },
      { ...successorTask().spec, succeeds: { ...succeeds, trigger: "quota", since: -1 } },
      { ...successorTask().spec, succeeds: { ...succeeds, trigger: "quota", since: Number.NaN } },
      { ...successorTask().spec, succeeds: { ...succeeds, trigger: "quota", since: "5" } },
      { ...successorTask().spec, succeeds: { ...succeeds, task: "not a task id!" } },
      { ...successorTask().spec, succeeds: { ...succeeds, at: { deviceId: "dev-a" } } },
    ]) {
      expect(parseTaskSpec(spec)).toBeNull();
    }
  });

  test("a quota pass round-trips with or without its since, and nothing is invented on a reseal", () => {
    for (const since of [{ since: 1_800_000_000_000 }, {}]) {
      const spec = successorTask({ succeeds: { ...succeeds, trigger: "quota", ...since } }).spec;
      expect(parseTaskSpec(spec)).toEqual(spec);
    }
    const manual = successorTask().spec;
    expect(parseTaskSpec(manual)?.succeeds).not.toHaveProperty("since");
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
      {
        prompt: "€".repeat(SUCCESSOR_PROMPT_BYTES / 3 - 1),
        title: "t".repeat(100),
        succeeds: { ...succeeds, trigger: "quota", since: Number.MAX_SAFE_INTEGER },
      },
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

describe("the session's own pass on the wire", () => {
  const pass = { session: "%3", taskId: "t-old", exclave: "default", remoteBranch: "feature/x", tip: TIP, at: NOW };

  test("session-pass: the daemon's fields held hard, the record bounded and never cut", () => {
    expect(parseSessionPass(pass)).toEqual(pass);
    expect(parseSessionPass({ ...pass, record: "done: a; left: b" })).toEqual({ ...pass, record: "done: a; left: b" });
    expect(parseSessionPass({ ...pass, record: "x".repeat(SUCCESSOR_RECORD_MAX) })?.record).toHaveLength(
      SUCCESSOR_RECORD_MAX,
    );
    // The same bound the daemon holds the frame to, counted in UTF-16 units: an over-long one is refused whole.
    for (const bad of [
      { ...pass, record: "x".repeat(SUCCESSOR_RECORD_MAX + 1) },
      { ...pass, record: "" },
      { ...pass, record: 7 },
      { ...pass, remoteBranch: "bad..name" },
      { ...pass, remoteBranch: "-x" },
      { ...pass, tip: "xyz" },
      { ...pass, tip: TIP.toUpperCase() },
      { ...pass, taskId: "../x" },
      { ...pass, session: "" },
      { ...pass, exclave: "e".repeat(300) },
      { ...pass, at: "now" },
      { ...pass, at: Number.NaN },
      null,
      "pass",
    ]) {
      expect(parseSessionPass(bad)).toBeNull();
    }
  });

  test("pass-close: a task id and nothing else carried on", () => {
    expect(parsePassCloseRequest({ taskId: "t-old" })).toEqual({ taskId: "t-old" });
    expect(parsePassCloseRequest({ taskId: "t-old", pane: "%1" })).toEqual({ taskId: "t-old" });
    for (const bad of [{}, { taskId: "../x" }, { taskId: 3 }, null, "t-old"]) {
      expect(parsePassCloseRequest(bad)).toBeNull();
    }
    expect(parsePassCloseResponse({ ok: true })).toEqual({ ok: true });
    expect(parsePassCloseResponse({ ok: false, code: "no_pane", message: "m" })).toEqual({
      ok: false,
      code: "no_pane",
      message: "m",
    });
    for (const bad of [{ ok: false, code: "nope", message: "m" }, { ok: false, code: "no_pane" }, { ok: 1 }, null]) {
      expect(parsePassCloseResponse(bad)).toBeNull();
    }
  });

  test("a machine's capabilities name the two paths apart", () => {
    expect(CAPABILITIES.successorSelf).not.toBe(CAPABILITIES.successor);
  });
});
