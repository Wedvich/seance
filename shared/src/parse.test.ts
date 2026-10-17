import { describe, expect, test } from "bun:test";
import { importPsk, seal, toBase64 } from "./crypto.ts";
import {
  isMetricsRequest,
  isStoreKey,
  parseBranchState,
  parseDecision,
  parseExclaveList,
  parseMachineInfo,
  parseMachineStatus,
  parseMetricsReply,
  parseMetricsResponse,
  parsePauseRecord,
  parsePauseReply,
  parsePauseRequest,
  parseQueueChanged,
  parseQueueReply,
  parseRepoEntry,
  parseResumeRequest,
  parseStoreChanged,
  parseStoreReply,
  parseTask,
  parseTaskRecord,
  parseTaskRef,
  parseTaskReply,
  parseTaskRequest,
  parseTaskSpec,
} from "./parse.ts";
import {
  BRANCH_MAX_LENGTH,
  MAX_PAUSE_HOLDS,
  METRICS_MAX_FILTER_LENGTH,
  METRICS_MAX_FILTERS,
  METRICS_MAX_POINTS,
  MAX_TASKS,
  OP_TIMEOUT_MS,
  STORE_KEY_ID_MAX_LENGTH,
  STORE_MAX_CT_LENGTH,
  STORE_PREFIXES,
  TASK_REQUEST_LIMITS,
  TASK_SPEC_LIMITS,
  type BranchState,
  type Candidate,
  type MachineStatus,
  type MetricsSeries,
  type PauseHold,
  type QuotaObservation,
  type Reason,
  type SchedulerError,
  type StoreRecord,
  type StoreReplyFrame,
  type Task,
  type TaskDep,
  type TaskRequest,
  type TaskSpec,
} from "./types.ts";

const repo = { name: "seance", path: "/home/u/seance", defaultBranch: "main" };
const info = { name: "mac", platform: "darwin", repos: [repo], scannedAt: 1_700_000_000_000 };
const exclave = { id: "default", accountId: "org:acct", extraUsageEnabled: true, authOk: true, skills: ["dataviz"] };

describe("parseRepoEntry", () => {
  test("passes exclave and origin through, and leaves them absent when absent", () => {
    expect(parseRepoEntry({ ...repo, exclave: "default", origin: "github.com/wedvich/seance" })).toEqual({
      ...repo,
      exclave: "default",
      origin: "github.com/wedvich/seance",
    });
    expect(parseRepoEntry(repo)).toEqual(repo);
  });

  test("a mistyped exclave or origin invalidates the entry, like defaultBranch", () => {
    expect(parseRepoEntry({ ...repo, exclave: 1 })).toBeNull();
    expect(parseRepoEntry({ ...repo, origin: null })).toBeNull();
  });

  test("an empty exclave or origin is refused — both are keys, and no exclave has an empty id", () => {
    expect(parseRepoEntry({ ...repo, exclave: "" })).toBeNull();
    expect(parseRepoEntry({ ...repo, origin: "" })).toBeNull();
  });
});

describe("parseExclaveList", () => {
  test("accepts a signed-out exclave with nulls", () => {
    const signedOut = { id: "scratch", accountId: null, extraUsageEnabled: null, authOk: false, skills: [] };
    expect(parseExclaveList([exclave, signedOut])).toEqual([exclave, signedOut]);
  });

  test("carries an email when there is one; an old daemon's exclave has none", () => {
    expect(parseExclaveList([{ ...exclave, email: "x@y" }])?.[0]?.email).toBe("x@y");
    expect(parseExclaveList([exclave])?.[0]).not.toHaveProperty("email");
    expect(parseExclaveList([{ ...exclave, email: "" }])?.[0]).not.toHaveProperty("email");
  });

  test("one unreadable exclave invalidates the list — status indexes into it", () => {
    expect(parseExclaveList([exclave, { ...exclave, id: "" }])).toBeNull();
    expect(parseExclaveList([exclave, { ...exclave, skills: "dataviz" }])).toBeNull();
    expect(parseExclaveList([exclave, { ...exclave, authOk: "yes" }])).toBeNull();
    expect(parseExclaveList([exclave, { ...exclave, email: 7 }])).toBeNull();
  });
});

describe("parseMachineInfo", () => {
  test("an old daemon's blob still parses, with neither exclaves nor capabilities", () => {
    expect(parseMachineInfo(info)).toEqual(info);
  });

  test("carries exclaves and capabilities when well-formed", () => {
    const parsed = parseMachineInfo({ ...info, exclaves: [exclave], capabilities: ["metrics", "later"] });
    expect(parsed?.exclaves).toEqual([exclave]);
    expect(parsed?.capabilities).toEqual(["metrics", "later"]);
  });

  test("a malformed exclave list or capabilities costs the field, not the machine", () => {
    const parsed = parseMachineInfo({ ...info, exclaves: [{ id: "x" }], capabilities: [1] });
    expect(parsed).toEqual(info);
    expect(parsed?.exclaves).toBeUndefined();
    expect(parsed?.capabilities).toBeUndefined();
  });
});

describe("parseMachineStatus", () => {
  const quota: QuotaObservation = {
    x: 0,
    h: 41,
    d: 12,
    hr: 1_700_010_000,
    dr: 1_700_500_000,
    w: [{ m: "Fable", p: 25, r: 1_700_500_000 }],
    s: "cache",
    at: 1_699_999_000,
  };
  const status: MachineStatus = {
    at: 1_700_000_000,
    scan: info.scannedAt,
    cpu: 41,
    mem: 62,
    disk: 30,
    free: 123_456,
    sess: [2, 0],
    quota: [quota],
  };

  test("round-trips a full status and a minimal one", () => {
    expect(parseMachineStatus(status)).toEqual(status);
    expect(parseMachineStatus({ at: 1, scan: 2 })).toEqual({ at: 1, scan: 2 });
  });

  test("every number must be a non-negative integer — floats claim precision nobody has", () => {
    expect(parseMachineStatus({ ...status, cpu: 0.41 })).toBeNull();
    expect(parseMachineStatus({ ...status, free: -1 })).toBeNull();
    expect(parseMachineStatus({ ...status, sess: [1, 0.5] })).toBeNull();
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, h: 41.2 }] })).toBeNull();
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, w: [{ m: "Fable", p: 25.5 }] }] })).toBeNull();
  });

  // `Number.isInteger(1e308)` is true: an integer check alone lets through
  // numbers no counter reaches and on which `at * 1000` stops being exact.
  test("every integer must be safe — top level, in sess and in quota", () => {
    expect(parseMachineStatus({ ...status, free: Number.MAX_SAFE_INTEGER })).not.toBeNull();
    expect(parseMachineStatus({ ...status, free: 1e308 })).toBeNull();
    expect(parseMachineStatus({ ...status, at: 2 ** 60 })).toBeNull();
    expect(parseMachineStatus({ ...status, sess: [1, 1e308] })).toBeNull();
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, dr: 1e308 }] })).toBeNull();
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, w: [{ m: "Fable", p: 25, r: 1e308 }] }] })).toBeNull();
  });

  test("a model-scoped window names its model; one bad window costs the tick", () => {
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, w: [{ m: "Fable", p: 25 }] }] })).not.toBeNull();
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, w: [{ m: "", p: 25 }] }] })).toBeNull();
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, w: [{ p: 25 }] }] })).toBeNull();
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, w: [{ m: "Fable", p: 25, r: -1 }] }] })).toBeNull();
  });

  test("absent is the only unknown: null fields and unknown quota sources are refused", () => {
    expect(parseMachineStatus({ ...status, mem: null })).toBeNull();
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, s: "guess" }] })).toBeNull();
    expect(parseMachineStatus({ ...status, quota: [{ x: 0, s: "session" }] })).toBeNull();
  });

  test("requires the scan stamp that binds indexes to a register blob", () => {
    expect(parseMachineStatus({ at: 1 })).toBeNull();
  });

  test("keeps the trim marker, 0 included, and refuses one that is not a count", () => {
    expect(parseMachineStatus({ ...status, tr: 2 })).toEqual({ ...status, tr: 2 });
    expect(parseMachineStatus({ ...status, tr: 0 })?.tr).toBe(0);
    expect(parseMachineStatus({ ...status, tr: -1 })).toBeNull();
    expect(parseMachineStatus({ ...status, tr: "2" })).toBeNull();
  });

  test("drops the padding filler without reading it", () => {
    expect(parseMachineStatus({ ...status, _: " ".repeat(300) })).toEqual(status);
    expect(parseMachineStatus({ ...status, _: 7 })).toEqual(status);
  });
});

function withNames(names: readonly string[]): boolean {
  return isMetricsRequest({ from: 10, to: 20, step: 30, names });
}

function withLabels(labels: unknown): boolean {
  return isMetricsRequest({ from: 10, to: 20, step: 30, labels });
}

describe("metrics", () => {
  test("a request names a known step and an ordered range", () => {
    expect(isMetricsRequest({ from: 10, to: 20, step: 30 })).toBe(true);
    expect(isMetricsRequest({ from: 10, to: 10, step: 3600 })).toBe(true);
    expect(isMetricsRequest({ from: 20, to: 10, step: 30 })).toBe(false);
    expect(isMetricsRequest({ from: 10, to: 20, step: 60 })).toBe(false);
    expect(isMetricsRequest({ from: 10.5, to: 20, step: 30 })).toBe(false);
  });

  test("a range spanning more than the point cap is refused before the store reads it", () => {
    const span = (METRICS_MAX_POINTS - 1) * 3600;
    expect(isMetricsRequest({ from: 0, to: span, step: 3600 })).toBe(true);
    expect(isMetricsRequest({ from: 0, to: span + 3600, step: 3600 })).toBe(false);
    expect(isMetricsRequest({ from: 0, to: 2 ** 40, step: 30 })).toBe(false);
    // A zero-width range far past any real clock passed the span check alone.
    expect(isMetricsRequest({ from: 1e308, to: 1e308, step: 3600 })).toBe(false);
  });

  test("names filters by metric, and an empty list is malformed rather than a filter for nothing", () => {
    expect(isMetricsRequest({ from: 10, to: 20, step: 30, names: ["cpu_pct", "not_yet_a_metric"] })).toBe(true);
    expect(isMetricsRequest({ from: 10, to: 20, step: 30, names: [] })).toBe(false);
    expect(isMetricsRequest({ from: 10, to: 20, step: 30, names: "cpu_pct" })).toBe(false);
    expect(isMetricsRequest({ from: 10, to: 20, step: 30, names: [1] })).toBe(false);
    expect(isMetricsRequest({ from: 10, to: 20, step: 30, names: [""] })).toBe(false);
  });

  test("names are bounded like labels, in count and in each name's length", () => {
    const many = Array.from({ length: METRICS_MAX_FILTERS + 1 }, (_, i) => `m${i}`);
    expect(withNames(many.slice(1))).toBe(true);
    expect(withNames(many)).toBe(false);
    const long = "x".repeat(METRICS_MAX_FILTER_LENGTH);
    expect(withNames([long])).toBe(true);
    expect(withNames([`${long}x`])).toBe(false);
  });

  test("labels are bounded string matchers, and an empty set is malformed rather than a filter for everything", () => {
    expect(withLabels({ account: "org:acct" })).toBe(true);
    expect(withLabels({ account: "org:acct", model: "" })).toBe(true);
    expect(withLabels({})).toBe(false);
    expect(withLabels(["account"])).toBe(false);
    expect(withLabels({ account: 1 })).toBe(false);
    expect(withLabels({ "": "x" })).toBe(false);
    const many = Object.fromEntries(Array.from({ length: METRICS_MAX_FILTERS + 1 }, (_, i) => [`l${i}`, "v"]));
    expect(withLabels(Object.fromEntries(Object.entries(many).slice(1)))).toBe(true);
    expect(withLabels(many)).toBe(false);
    const long = "x".repeat(METRICS_MAX_FILTER_LENGTH);
    expect(withLabels({ [long]: long })).toBe(true);
    expect(withLabels({ [`${long}x`]: "v" })).toBe(false);
    expect(withLabels({ account: `${long}x` })).toBe(false);
  });

  test("a reply is the history or a known refusal, and an unknown code is unreadable", () => {
    expect(parseMetricsReply({ series: [] })).toEqual({ series: [] });
    expect(parseMetricsReply({ ok: false, code: "too_large", message: "m" })).toEqual({
      ok: false,
      code: "too_large",
      message: "m",
    });
    expect(parseMetricsReply({ ok: false, code: "nope", message: "m" })).toBeNull();
    expect(parseMetricsReply({ ok: false, code: "too_large" })).toBeNull();
    expect(parseMetricsReply(null)).toBeNull();
  });

  test("a response is a list of labelled series with ascending points", () => {
    const series: MetricsSeries = {
      metric: "cpu",
      labels: { machine: "mac", exclave: "default" },
      points: [
        [1, 0.4],
        [2, 0.5],
      ],
    };
    expect(parseMetricsResponse({ series: [series] })).toEqual({ series: [series] });
    expect(parseMetricsResponse({ series: [] })).toEqual({ series: [] });
  });

  test("one unreadable series invalidates the reply", () => {
    expect(parseMetricsResponse({ series: [{ metric: "", labels: {}, points: [] }] })).toBeNull();
    expect(parseMetricsResponse({ series: [{ metric: "cpu", labels: { a: 1 }, points: [] }] })).toBeNull();
    expect(parseMetricsResponse({ series: [{ metric: "cpu", labels: {}, points: [[1]] }] })).toBeNull();
    expect(parseMetricsResponse({ series: [{ metric: "cpu", labels: {}, points: [["1", 2]] }] })).toBeNull();
    expect(parseMetricsResponse({ series: [{ metric: "cpu", labels: {}, points: [[1, Infinity]] }] })).toBeNull();
    expect(parseMetricsResponse({ series: [{ metric: "cpu", labels: {}, points: [[1, Number.NaN]] }] })).toBeNull();
    expect(parseMetricsResponse({ rows: [] })).toBeNull();
  });
});

describe("parseTaskRequest", () => {
  const minimal: TaskRequest = { repo: "github.com/acme/app", mode: "worktree" };

  test("keeps the spawn fields it knows and nothing else", () => {
    const full = { ...minimal, prompt: "fix it", title: "t", model: "opus", effort: "high", plan: true };
    expect(parseTaskRequest(full)).toEqual(full);
    expect(parseTaskRequest(minimal)).toEqual(minimal);
    // A machine, a task id or anything else the request carries never reaches a task.
    expect(parseTaskRequest({ ...minimal, taskId: "t1", deviceId: "d", pin: { deviceId: "d" } })).toEqual(minimal);
  });

  test("every field is typed, and the keys a spawn acts on are never empty", () => {
    for (const bad of [
      { ...minimal, repo: "" },
      { ...minimal, mode: "elsewhere" },
      { ...minimal, prompt: 1 },
      { ...minimal, plan: "yes" },
      { ...minimal, model: "" },
      { ...minimal, effort: null },
      null,
      [minimal],
    ]) {
      expect(parseTaskRequest(bad)).toBeNull();
    }
  });

  test("each field is bounded, the limit itself allowed", () => {
    for (const field of ["repo", "prompt", "title", "model", "effort"] as const) {
      const limit = TASK_REQUEST_LIMITS[field];
      expect(parseTaskRequest({ ...minimal, [field]: "x".repeat(limit) })).not.toBeNull();
      expect(parseTaskRequest({ ...minimal, [field]: "x".repeat(limit + 1) })).toBeNull();
    }
  });
});

function deps(n: number): readonly TaskDep[] {
  return Array.from({ length: n }, (_, i) => ({ task: `t-${i}`, after: "opened" }));
}

describe("parseTaskSpec", () => {
  const request: TaskRequest = { repo: "github.com/acme/app", mode: "worktree", prompt: "fix it" };
  const full: TaskSpec = {
    ...request,
    pin: { exclave: "work" },
    lineage: { deviceId: "dev-a", exclave: "default" },
    base: { deviceId: "dev-b", exclave: "work" },
    batch: { id: "batch-1", index: 2, strategy: { mode: "parallel", max: 3 } },
    deps: [
      { task: "t-1", after: "opened" },
      { task: "t-2", after: "merged" },
    ],
    linear: { issue: "ENG-123", url: "https://linear.app/acme/issue/ENG-123" },
  };

  test("a whole spec round-trips, and fields it does not know stay behind", () => {
    expect(parseTaskSpec(full)).toEqual(full);
    expect(parseTaskSpec({ ...request, taskId: "x", skill: "y" })).toEqual(request);
    for (const strategy of [{ mode: "sequential" }, { mode: "auto" }] as const) {
      expect(parseTaskSpec({ ...request, batch: { id: "b", index: 0, strategy } })?.batch?.strategy).toEqual(strategy);
    }
  });

  test("a malformed optional field nulls the spec — a task must not run without the pin or deps it was given", () => {
    for (const bad of [
      { ...full, pin: { exclave: "" } },
      { ...full, lineage: { deviceId: "dev-a" } },
      { ...full, batch: { ...full.batch, id: "has space" } },
      { ...full, batch: { ...full.batch, strategy: { mode: "parallel", max: 0 } } },
      { ...full, batch: { ...full.batch, strategy: { mode: "parallel", max: TASK_SPEC_LIMITS.parallel + 1 } } },
      { ...full, batch: { ...full.batch, strategy: { mode: "round-robin" } } },
      { ...full, deps: [{ task: "t-1", after: "pushed" }] },
      { ...full, deps: [{ task: "t 1", after: "opened" }] },
      { ...full, deps: [{ task: "t-1", after: "opened" }, null] },
      { ...full, linear: { issue: "" } },
      { ...full, linear: { issue: "ENG-1", url: "http://linear.app/x" } },
      { ...full, repo: "" },
    ]) {
      expect(parseTaskSpec(bad)).toBeNull();
    }
  });

  test("deps are bounded, the limit itself allowed", () => {
    expect(parseTaskSpec({ ...request, deps: deps(TASK_SPEC_LIMITS.deps) })).not.toBeNull();
    expect(parseTaskSpec({ ...request, deps: deps(TASK_SPEC_LIMITS.deps + 1) })).toBeNull();
  });
});

describe("tasks and their records", () => {
  const task: Task = {
    id: "0b6f0c9e-1a2b-4c3d-8e9f-001122334455",
    spec: { repo: "github.com/acme/app", mode: "worktree" },
    state: "awaiting-merge",
    createdAt: 1_700_000_000_000,
    prUrl: "https://github.com/acme/app/pull/7",
    branch: "worktree-fix-it",
    pushed: true,
    needsInputSince: 1_700_000_100_000,
    escalated: true,
  };

  test("M3's states and progress fields round-trip", () => {
    expect(parseTask(task)).toEqual(task);
    for (const state of ["queued", "blocked"] as const) expect(parseTask({ ...task, state })?.state).toBe(state);
    expect(parseTask({ ...task, state: "done", doneBy: "manual" })?.doneBy).toBe("manual");
  });

  test("a progress field that is not exactly its shape nulls the task", () => {
    for (const bad of [
      { ...task, prUrl: "javascript:alert(1)" },
      { ...task, branch: "" },
      { ...task, branch: "b".repeat(BRANCH_MAX_LENGTH + 1) },
      { ...task, pushed: false },
      { ...task, escalated: 1 },
      { ...task, doneBy: "linear" },
      { ...task, needsInputSince: "soon" },
      { ...task, id: "task/with-slash" },
      { ...task, state: "paused" },
    ]) {
      expect(parseTask(bad)).toBeNull();
    }
  });

  test("a record names the version its put produced; 0 is no record's", () => {
    expect(parseTaskRecord({ version: 3, task })).toEqual({ version: 3, task });
    expect(parseTaskRecord({ version: 0, task })).toBeNull();
    expect(parseTaskRecord({ version: 1.5, task })).toBeNull();
    expect(parseTaskRecord({ task })).toBeNull();
    expect(parseTaskRecord({ version: 1, task: { ...task, state: "paused" } })).toBeNull();
  });

  test("a per-account cap survives the decision record; an unknown scope drops the reason, not the candidate", () => {
    const candidate = { deviceId: "d", machine: "mac", exclave: "default", rejected: [] };
    const reason: Reason = { code: "cap_reached", inFlight: 2, max: 2, scope: "account" };
    const decision = (r: unknown) => ({ at: 1, chosen: null, candidates: [{ ...candidate, rejected: [r] }] });
    expect(parseDecision(decision(reason))?.candidates[0]?.rejected).toEqual([reason]);
    expect(parseDecision(decision({ ...reason, scope: "batch" }))?.candidates[0]?.rejected).toEqual([]);
    const legacy: Reason = { code: "cap_reached", inFlight: 8, max: 8 };
    expect(parseDecision(decision(legacy))?.candidates[0]?.rejected).toEqual([legacy]);
  });
});

describe("pause", () => {
  const forever: PauseHold = { until: "resume", at: 1 };
  const untilReset: PauseHold = { until: "reset", account: "org:acct", at: 1, resumeAt: 2 };

  test("a request: `reset` is an account's, `resume` may hold the whole queue", () => {
    expect(parsePauseRequest({ until: "resume" })).toEqual({ until: "resume" });
    expect(parsePauseRequest({ until: "reset", account: "org:acct", extra: 1 })).toEqual({
      until: "reset",
      account: "org:acct",
    });
    expect(parsePauseRequest({ until: "reset" })).toBeNull();
    expect(parsePauseRequest({ until: "tomorrow" })).toBeNull();
    expect(parsePauseRequest({ until: "resume", account: "" })).toBeNull();
    expect(parseResumeRequest({})).toEqual({});
    expect(parseResumeRequest({ account: "org:acct" })).toEqual({ account: "org:acct" });
    expect(parseResumeRequest({ account: 7 })).toBeNull();
  });

  test("a held reset carries the time it lifts; a held resume carries none", () => {
    expect(parsePauseRecord({ version: 1, holds: [forever, untilReset] })).toEqual({
      version: 1,
      holds: [forever, untilReset],
    });
    for (const bad of [
      { until: "reset", account: "org:acct", at: 1 },
      { until: "reset", at: 1, resumeAt: 2 },
      { ...forever, resumeAt: 2 },
    ]) {
      expect(parsePauseRecord({ version: 1, holds: [bad] })).toBeNull();
    }
  });

  test("holds are bounded, and one unreadable hold nulls them all", () => {
    expect(
      parsePauseRecord({ version: 1, holds: Array.from({ length: MAX_PAUSE_HOLDS }, () => forever) }),
    ).not.toBeNull();
    expect(
      parsePauseRecord({ version: 1, holds: Array.from({ length: MAX_PAUSE_HOLDS + 1 }, () => forever) }),
    ).toBeNull();
    expect(parsePauseReply({ holds: [forever, { until: "resume" }] })).toBeNull();
    expect(parsePauseReply({ holds: [untilReset] })).toEqual({ holds: [untilReset] });
  });
});

describe("scheduler ops", () => {
  const task: Task = {
    id: "t-1",
    spec: { repo: "github.com/acme/app", mode: "here" },
    state: "cancelled",
    createdAt: 1,
  };

  test("cancel and mark-done name one task and carry nothing else on", () => {
    expect(parseTaskRef({ taskId: "t-1", state: "done" })).toEqual({ taskId: "t-1" });
    expect(parseTaskRef({ taskId: "t 1" })).toBeNull();
    expect(parseTaskRef({})).toBeNull();
  });

  test("their replies are the task, or a refusal this build can word", () => {
    expect(parseTaskReply({ task })).toEqual({ task });
    const refusal: SchedulerError = { ok: false, code: "dispatching", message: "starting" };
    expect(parseTaskReply(refusal)).toEqual(refusal);
    expect(parseTaskReply({ ok: false, code: "nope", message: "?" })).toBeNull();
    expect(parseTaskReply({ task: { ...task, state: "paused" } })).toBeNull();
  });

  test("queue carries holds when the leader has them; an unread hold is an unread reply", () => {
    expect(parseQueueReply({ tasks: [task], at: 5 })).toEqual({ tasks: [task], at: 5 });
    const holds: readonly PauseHold[] = [{ until: "resume", at: 1 }];
    expect(parseQueueReply({ tasks: [], at: 5, holds })).toEqual({ tasks: [], at: 5, holds });
    expect(parseQueueReply({ tasks: [], at: 5, holds: [{ until: "never", at: 1 }] })).toBeNull();
  });

  test("queue-changed is a stamp and nothing else", () => {
    expect(parseQueueChanged({ at: 9, tasks: ["t-1"] })).toEqual({ at: 9 });
    expect(parseQueueChanged({})).toBeNull();
  });

  test("cancel's deadline clears the despawn it may wait on", () => {
    expect(OP_TIMEOUT_MS.cancel).toBeGreaterThan(OP_TIMEOUT_MS.despawn);
  });
});

describe("parseBranchState", () => {
  const event: BranchState = {
    taskId: "t-1",
    repo: "github.com/acme/app",
    branch: "worktree-fix-it",
    pushed: true,
    merged: false,
    at: 1_700_000_000_000,
  };

  test("round-trips, dropping anything it does not know", () => {
    expect(parseBranchState({ ...event, prUrl: "https://x" })).toEqual(event);
  });

  test("merged releases dependents, so the booleans must be booleans and the names bounded", () => {
    for (const bad of [
      { ...event, merged: "yes" },
      { ...event, pushed: 1 },
      { ...event, branch: "" },
      { ...event, branch: "b".repeat(BRANCH_MAX_LENGTH + 1) },
      { ...event, repo: "" },
      { ...event, taskId: "t;1" },
      { ...event, at: Number.NaN },
    ]) {
      expect(parseBranchState(bad)).toBeNull();
    }
  });
});

describe("store", () => {
  const env = { v: 1, to: "scheduler", from: "app", iv: "aXY=", ct: "Y3Q=" };
  const record: StoreRecord = { key: "task:t-1", version: 2, env };

  test("a task at the prompt limit, two bytes a character, with a 15-candidate decision, seals into one record", async () => {
    const id = "A".repeat(43);
    const candidate: Candidate = {
      deviceId: id,
      machine: "macbook-pro",
      exclave: "default",
      clone: "seance",
      rejected: [],
      score: {
        components: { accountPressure: 0.123456789, machinePressure: 0.25, dependencyDistance: 0.5, queuePressure: 3 },
        sticky: 0,
        total: 1.987654321,
      },
      quota: { observedAt: 1_760_000_000, observer: id, source: "session" },
    };
    const task: Task = {
      id: crypto.randomUUID(),
      spec: {
        repo: "github.com/acme/app",
        mode: "worktree",
        prompt: "ø".repeat(TASK_REQUEST_LIMITS.prompt),
        title: "t".repeat(TASK_REQUEST_LIMITS.title),
      },
      state: "reserved",
      createdAt: 1_760_000_000_000,
      reservation: { deviceId: id, exclave: "default", clone: "seance", expiresAt: 1_760_000_120_000 },
      decision: { at: 1_760_000_000_000, chosen: null, candidates: Array.from({ length: 15 }, () => candidate) },
    };
    const key = await importPsk(toBase64(new Uint8Array(32)));
    const plain = { id: crypto.randomUUID(), ts: Date.now(), op: "task", payload: { version: 1, task } } as const;
    const sealed = await seal(key, { to: "scheduler", from: "app" }, plain);
    expect(sealed.ct.length).toBeLessThanOrEqual(STORE_MAX_CT_LENGTH);
    // …and a full prefix still lists in one frame, under the Workers WebSocket message limit.
    expect(MAX_TASKS * STORE_MAX_CT_LENGTH).toBeLessThan(32 * 1024 * 1024);
  });

  test("keys are a known prefix and a routing id; account records stay reserved until M4", () => {
    for (const { prefix } of Object.values(STORE_PREFIXES)) expect(isStoreKey(`${prefix}x`)).toBe(true);
    expect(isStoreKey(`task:${"a".repeat(STORE_KEY_ID_MAX_LENGTH)}`)).toBe(true);
    for (const bad of [
      `task:${"a".repeat(STORE_KEY_ID_MAX_LENGTH + 1)}`,
      "task:",
      "task:a:b",
      "task:a/b",
      "account:abc",
      "device:abc",
      "scheduler:term",
      "TASK:a",
      7,
    ]) {
      expect(isStoreKey(bad)).toBe(false);
    }
  });

  test("each reply kind round-trips", () => {
    const replies: readonly StoreReplyFrame[] = [
      { t: "store-listed", re: "r1", records: [record] },
      { t: "store-record", re: "r2", record },
      { t: "store-record", re: "r2", record: null },
      { t: "store-written", re: "r3", version: 1 },
      { t: "store-refused", re: "r4", code: "version_conflict" },
    ];
    for (const reply of replies) {
      expect(parseStoreReply(reply)).toEqual(reply);
    }
  });

  test("one unreadable record nulls the list — a takeover must not miss a task", () => {
    for (const bad of [
      { ...record, version: 0 },
      { ...record, key: "task:a b" },
      { ...record, env: { ...env, ct: 1 } },
    ]) {
      expect(parseStoreReply({ t: "store-listed", re: "r1", records: [record, bad] })).toBeNull();
      expect(parseStoreReply({ t: "store-record", re: "r2", record: bad })).toBeNull();
    }
  });

  test("a paged list is refused, never read as the whole queue — so paging can come later", () => {
    expect(parseStoreReply({ t: "store-listed", re: "r1", records: [record], next: "task:t-1" })).toBeNull();
  });

  test("a refusal keeps a code minted later, so the request settles instead of timing out", () => {
    expect(parseStoreReply({ t: "store-refused", re: "r", code: "tombstoned" })).toEqual({
      t: "store-refused",
      re: "r",
      code: "tombstoned",
    });
    expect(parseStoreReply({ t: "store-refused", re: "r" })).toBeNull();
    expect(parseStoreReply({ t: "store-written", version: 1 })).toBeNull();
    expect(parseStoreReply({ t: "store-moved", re: "r" })).toBeNull();
  });

  test("store-changed names a key and its version, 0 when it was deleted", () => {
    expect(parseStoreChanged({ t: "store-changed", key: "task:t-1", version: 0 })).toEqual({
      t: "store-changed",
      key: "task:t-1",
      version: 0,
    });
    expect(parseStoreChanged({ t: "store-changed", key: "task:t-1", version: -1 })).toBeNull();
    expect(parseStoreChanged({ t: "store-changed", key: "nope", version: 1 })).toBeNull();
  });
});
