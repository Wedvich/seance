import { describe, expect, test } from "bun:test";
import { importPsk, seal, toBase64 } from "./crypto.ts";
import {
  bindTaskRecord,
  isMetricsRequest,
  isStoreKey,
  isTaskId,
  isTerm,
  parseBranchState,
  parseDecision,
  parseDiscardReply,
  parseDiscardRequest,
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
  parseQueueRequest,
  parseRepoEntry,
  parseResumeRequest,
  parseStoreChanged,
  parseStoreReply,
  parseTask,
  parseTaskRecord,
  parseTaskProgressList,
  parseTaskRef,
  parseTaskReply,
  UPDATE_DETAIL_MAX,
  parseTaskRequest,
  parseTaskSpec,
} from "./parse.ts";
import { REPLAY_WINDOW_MS } from "./crypto.ts";
import {
  BRANCH_MAX_LENGTH,
  CANDIDATE_MAX_REASONS,
  DECISION_MAX_CANDIDATES,
  MAX_PAUSE_HOLDS,
  METRICS_MAX_FILTER_LENGTH,
  METRICS_MAX_FILTERS,
  METRICS_MAX_POINTS,
  MAX_TASKS,
  OP_TIMEOUT_MS,
  QUEUE_MAX_TASKS,
  ROUTING_ID_MAX_LENGTH,
  SESSIONS_MAX_PROGRESS,
  STORE_CREATE_MAX_CT_LENGTH,
  STORE_MAX_CT_LENGTH,
  STORE_PREFIXES,
  TARGET_LIMITS,
  TASK_FAILURE_LIMITS,
  TASK_REQUEST_LIMITS,
  TASK_SPEC_LIMITS,
  type BatchMembership,
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
  type Target,
  type Task,
  type TaskDep,
  type TaskRecord,
  type TaskRequest,
  type TaskSpec,
} from "./types.ts";

const repo = { name: "seance", path: "/home/u/seance", defaultBranch: "main" };
const info = { name: "mac", platform: "darwin", repos: [repo], scannedAt: 1_700_000_000_000 };
const exclave = { id: "default", accountId: "org:acct", extraUsageEnabled: true, authOk: true, skills: ["dataviz"] };

async function sealedLength(task: Task): Promise<number> {
  const key = await importPsk(toBase64(new Uint8Array(32)));
  const plain = { id: crypto.randomUUID(), ts: Date.now(), op: "task", payload: { version: 1, task } } as const;
  return (await seal(key, { to: "scheduler", from: "app" }, plain)).ct.length;
}

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

  test("carries a seat tier when there is one; an old daemon's exclave has none", () => {
    expect(parseExclaveList([{ ...exclave, seatTier: "team_standard" }])?.[0]?.seatTier).toBe("team_standard");
    expect(parseExclaveList([exclave])?.[0]).not.toHaveProperty("seatTier");
    expect(parseExclaveList([{ ...exclave, seatTier: "" }])?.[0]).not.toHaveProperty("seatTier");
    expect(parseExclaveList([{ ...exclave, seatTier: 1 }])).toBeNull();
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

  // The build and the last update report are what the Machines screen and list_machines show.
  test("carries the build and the last update report; a malformed one costs that field alone", () => {
    const source = { sha: "a".repeat(40), commitTs: 1_700_000_000_000, branch: null };
    const lastUpdate = { at: 1_700_000_100_000, outcome: "skipped_dirty" as const, detail: "2 files" };
    expect(parseMachineInfo({ ...info, source, lastUpdate })).toEqual({ ...info, source, lastUpdate });
    expect(parseMachineInfo({ ...info, source: null, lastUpdate: null })).toEqual(info);
    const bad = [
      { source: { ...source, sha: "short" } },
      { source: { ...source, branch: 3 } },
      { lastUpdate: { ...lastUpdate, outcome: "exploded" } },
      { lastUpdate: { ...lastUpdate, at: -1 } },
      // Past Date's range, where toISOString() throws in list_machines.
      { source: { ...source, commitTs: 9e15 } },
      { lastUpdate: { ...lastUpdate, at: 9e15 } },
      { source: { ...source, commitTs: Number.NaN } },
      { lastUpdate: { ...lastUpdate, at: Number.NaN } },
      { lastUpdate: { ...lastUpdate, detail: 7 } },
    ];
    for (const fields of bad) expect(parseMachineInfo({ ...info, ...fields })).toEqual(info);

    // An oversized detail is cut, not refused: the outcome still says what happened.
    const cut = parseMachineInfo({ ...info, lastUpdate: { ...lastUpdate, detail: "x".repeat(5_000) } });
    expect(cut?.lastUpdate?.detail).toHaveLength(UPDATE_DETAIL_MAX);
    expect(cut?.lastUpdate?.outcome).toBe("skipped_dirty");
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
    client: "pwa",
  };

  test("a whole spec round-trips, and fields it does not know stay behind", () => {
    expect(parseTaskSpec(full)).toEqual(full);
    expect(parseTaskSpec({ ...request, taskId: "x", skill: "y" })).toEqual(request);
    for (const strategy of [{ mode: "sequential" }, { mode: "auto" }] as const) {
      expect(parseTaskSpec({ ...request, batch: { id: "b", index: 0, strategy } })?.batch?.strategy).toEqual(strategy);
    }
    const last: BatchMembership = { id: "b", index: TASK_SPEC_LIMITS.batchIndex, strategy: { mode: "sequential" } };
    expect(parseTaskSpec({ ...full, batch: last })?.batch).toEqual(last);
  });

  test("a malformed optional field nulls the spec — a task must not run without the pin or deps it was given", () => {
    for (const bad of [
      { ...full, pin: { exclave: "" } },
      { ...full, lineage: { deviceId: "dev-a" } },
      { ...full, batch: { ...full.batch, id: "has space" } },
      { ...full, batch: { ...full.batch, strategy: { mode: "parallel", max: 0 } } },
      { ...full, batch: { ...full.batch, strategy: { mode: "parallel", max: TASK_SPEC_LIMITS.parallel + 1 } } },
      { ...full, batch: { ...full.batch, strategy: { mode: "round-robin" } } },
      { ...full, batch: { ...full.batch, index: TASK_SPEC_LIMITS.batchIndex + 1 } },
      { ...full, batch: { ...full.batch, index: -1 } },
      { ...full, deps: [{ task: "t-1", after: "pushed" }] },
      { ...full, deps: [{ task: "t 1", after: "opened" }] },
      { ...full, deps: [{ task: "t-1", after: "opened" }, null] },
      { ...full, linear: { issue: "" } },
      { ...full, linear: { issue: "ENG-1", url: "http://linear.app/x" } },
      { ...full, repo: "" },
      { ...full, client: "" },
      { ...full, client: "c".repeat(TASK_SPEC_LIMITS.client + 1) },
      { ...full, client: 7 },
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
    endedAt: 1_700_000_200_000,
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
      { ...task, endedAt: "later" },
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
    const batch: Reason = { ...reason, scope: "batch" };
    expect(parseDecision(decision(batch))?.candidates[0]?.rejected).toEqual([batch]);
    expect(parseDecision(decision({ ...reason, scope: "machine" }))?.candidates[0]?.rejected).toEqual([]);
    const legacy: Reason = { code: "cap_reached", inFlight: 8, max: 8 };
    expect(parseDecision(decision(legacy))?.candidates[0]?.rejected).toEqual([legacy]);
  });

  test("a batch order hold names the member it waits on; an index past the batch bound drops the reason", () => {
    const candidate = { deviceId: "d", machine: "mac", exclave: "default", rejected: [] };
    const decision = (r: unknown) => ({ at: 1, chosen: null, candidates: [{ ...candidate, rejected: [r] }] });
    const order: Reason = { code: "batch_order", index: 3 };
    expect(parseDecision(decision(order))?.candidates[0]?.rejected).toEqual([order]);
    for (const index of [TASK_SPEC_LIMITS.batchIndex + 1, -1, 1.5, "3", undefined]) {
      expect(parseDecision(decision({ code: "batch_order", index }))?.candidates[0]?.rejected).toEqual([]);
    }
  });

  test("a model not included names the gated model; an empty or oversized one drops the reason", () => {
    const candidate = { deviceId: "d", machine: "mac", exclave: "default", rejected: [] };
    const decision = (r: unknown) => ({ at: 1, chosen: null, candidates: [{ ...candidate, rejected: [r] }] });
    const gated: Reason = { code: "model_not_included", model: "fable" };
    expect(parseDecision(decision(gated))?.candidates[0]?.rejected).toEqual([gated]);
    for (const model of ["", "x".repeat(TASK_REQUEST_LIMITS.model + 1), 7, undefined]) {
      expect(parseDecision(decision({ code: "model_not_included", model }))?.candidates[0]?.rejected).toEqual([]);
    }
  });

  test("a pause reads with its scope and how it lifts; a malformed one drops the reason", () => {
    const candidate = { deviceId: "d", machine: "mac", exclave: "default", rejected: [] };
    const decision = (r: unknown) => ({ at: 1, chosen: null, candidates: [{ ...candidate, rejected: [r] }] });
    const paused: Reason = { code: "paused", until: "reset", scope: "account" };
    expect(parseDecision(decision(paused))?.candidates[0]?.rejected).toEqual([paused]);
    for (const bad of [
      { ...paused, until: "never" },
      { ...paused, scope: "machine" },
    ]) {
      expect(parseDecision(decision(bad))?.candidates[0]?.rejected).toEqual([]);
    }
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

  test("their replies are the task, or a refusal — its code kept raw, so a leader ahead still refuses", () => {
    expect(parseTaskReply({ task })).toEqual({ task });
    const refusal: SchedulerError = { ok: false, code: "dispatching", message: "starting" };
    expect(parseTaskReply(refusal)).toEqual(refusal);
    const later: SchedulerError = { ok: false, code: "batch_locked", message: "?" };
    expect(parseTaskReply(later)).toEqual(later);
    expect(parseTaskReply({ ok: false, code: "", message: "?" })).toBeNull();
    expect(parseTaskReply({ ok: false, code: 7, message: "?" })).toBeNull();
    expect(parseTaskReply({ task: { ...task, state: "paused" } })).toBeNull();
  });

  test("queue carries holds when the leader has them; an unread hold is an unread reply", () => {
    expect(parseQueueReply({ tasks: [task], at: 5 })).toEqual({ tasks: [task], at: 5 });
    const holds: readonly PauseHold[] = [{ until: "resume", at: 1 }];
    expect(parseQueueReply({ tasks: [], at: 5, holds })).toEqual({ tasks: [], at: 5, holds });
    expect(parseQueueReply({ tasks: [], at: 5, holds: [{ until: "never", at: 1 }] })).toBeNull();
  });

  test("queue-changed is a stamp and which tasks changed; an unreadable list costs the list, not the nudge", () => {
    expect(parseQueueChanged({ at: 9, tasks: ["t-1"], extra: 1 })).toEqual({ at: 9, tasks: ["t-1"] });
    expect(parseQueueChanged({ at: 9 })).toEqual({ at: 9 });
    expect(parseQueueChanged({ at: 9, tasks: ["t 1"] })).toEqual({ at: 9 });
    expect(parseQueueChanged({ at: 9, tasks: Array.from({ length: QUEUE_MAX_TASKS + 1 }, () => "t") })).toEqual({
      at: 9,
    });
    expect(parseQueueChanged({})).toBeNull();
  });

  test("queue may ask for some tasks only; an unreadable filter is malformed, never everything", () => {
    expect(parseQueueRequest({})).toEqual({});
    expect(parseQueueRequest({ tasks: ["t-1", "t-2"] })).toEqual({ tasks: ["t-1", "t-2"] });
    expect(parseQueueRequest({ tasks: ["t:1"] })).toBeNull();
    expect(parseQueueRequest({ tasks: Array.from({ length: QUEUE_MAX_TASKS + 1 }, () => "t") })).toBeNull();
    expect(parseQueueRequest([])).toBeNull();
  });

  test("queue lists unreadable records, each one alone: a bad entry costs its own discard, too many the reply", () => {
    const junk = { taskId: "t-9", version: 3, reason: "unopenable" };
    const later = { taskId: "t-8", version: 1, reason: "sealed_elsewhere" };
    expect(parseQueueReply({ tasks: [], at: 5, unreadable: [junk, later] })).toEqual({
      tasks: [],
      at: 5,
      unreadable: [junk, later],
    });
    for (const bad of [
      { ...junk, taskId: "t:9" },
      { ...junk, version: 0 },
      { ...junk, reason: "" },
      { ...junk, reason: "r".repeat(TASK_FAILURE_LIMITS.code + 1) },
    ]) {
      expect(parseQueueReply({ tasks: [], at: 5, unreadable: [junk, bad] })?.unreadable).toEqual([junk]);
    }
    expect(parseQueueReply({ tasks: [], at: 5, unreadable: [{ ...junk, version: 0 }] })).toEqual({ tasks: [], at: 5 });
    expect(parseQueueReply({ tasks: [], at: 5, unreadable: junk })).toBeNull();
    expect(
      parseQueueReply({ tasks: [], at: 5, unreadable: Array.from({ length: MAX_TASKS }, () => junk) }),
    ).not.toBeNull();
    expect(
      parseQueueReply({ tasks: [], at: 5, unreadable: Array.from({ length: MAX_TASKS + 1 }, () => junk) }),
    ).toBeNull();
  });

  test("discard names one record at one version and carries nothing else on; its reply is the id, or a refusal", () => {
    expect(parseDiscardRequest({ taskId: "t-1", version: 4, reason: "unopenable" })).toEqual({
      taskId: "t-1",
      version: 4,
    });
    expect(parseDiscardRequest({ taskId: "t-1" })).toBeNull();
    expect(parseDiscardRequest({ taskId: "t-1", version: 0 })).toBeNull();
    expect(parseDiscardRequest({ taskId: "t-1", version: 1.5 })).toBeNull();
    expect(parseDiscardRequest({ taskId: "task:t-1", version: 1 })).toBeNull();
    expect(parseDiscardReply({ taskId: "t-1" })).toEqual({ taskId: "t-1" });
    const refusal: SchedulerError = { ok: false, code: "conflict", message: "changed" };
    expect(parseDiscardReply(refusal)).toEqual(refusal);
    expect(parseDiscardReply({})).toBeNull();
  });

  test("a queue reply holds at most QUEUE_MAX_TASKS", () => {
    const many = (n: number) => ({ tasks: Array.from({ length: n }, () => task), at: 5 });
    expect(parseQueueReply(many(QUEUE_MAX_TASKS))).not.toBeNull();
    expect(parseQueueReply(many(QUEUE_MAX_TASKS + 1))).toBeNull();
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

  // Every field at its bound, two UTF-8 bytes a character wherever a field is free text.
  const device = "A".repeat(43);
  const placement = { deviceId: device, exclave: "x".repeat(TASK_SPEC_LIMITS.placement) };
  const created: Task = {
    id: crypto.randomUUID(),
    state: "queued",
    createdAt: 1_760_000_000_000,
    spec: {
      repo: "r".repeat(TASK_REQUEST_LIMITS.repo),
      mode: "worktree",
      prompt: "ø".repeat(TASK_REQUEST_LIMITS.prompt),
      title: "ø".repeat(TASK_REQUEST_LIMITS.title),
      model: "m".repeat(TASK_REQUEST_LIMITS.model),
      effort: "e".repeat(TASK_REQUEST_LIMITS.effort),
      plan: true,
      pin: placement,
      lineage: placement,
      base: placement,
      batch: { id: crypto.randomUUID(), index: 15, strategy: { mode: "parallel", max: TASK_SPEC_LIMITS.parallel } },
      deps: Array.from({ length: TASK_SPEC_LIMITS.deps }, () => ({
        task: crypto.randomUUID(),
        after: "merged" as const,
      })),
      linear: {
        issue: "E".repeat(TASK_SPEC_LIMITS.linearIssue),
        url: `https://linear.app/acme/issue/${"s".repeat(80)}`,
      },
      client: "ø".repeat(TASK_SPEC_LIMITS.client),
    },
  };
  const target: Target = { ...placement, clone: "c".repeat(TARGET_LIMITS.clone) };
  const written: Task = {
    ...created,
    state: "failed",
    reservation: { ...target, expiresAt: 1_760_000_120_000 },
    assignment: { ...target, window: "ø".repeat(TARGET_LIMITS.window), pane: "%".repeat(ROUTING_ID_MAX_LENGTH) },
    failure: { code: "c".repeat(TASK_FAILURE_LIMITS.code), message: "ø".repeat(TASK_FAILURE_LIMITS.message) },
    prUrl: `https://${"p".repeat(2000)}.example/`,
    branch: "ø".repeat(BRANCH_MAX_LENGTH),
    pushed: true,
    absentSince: 1_760_000_000_000,
    reservedAt: 1_760_000_000_000,
    needsInputSince: 1_760_000_000_000,
    escalated: true,
    endedAt: 1_760_000_000_000,
    leftRunning: true,
  };
  const candidate: Candidate = {
    deviceId: device,
    machine: "macbook-pro",
    exclave: "default",
    clone: "seance",
    rejected: [],
    score: {
      components: { accountPressure: 0.123456789, machinePressure: 0.25, dependencyDistance: 0.5, queuePressure: 3 },
      sticky: 0,
      total: 1.987654321,
    },
    quota: { observedAt: 1_760_000_000, observer: device, source: "session" },
  };

  test("a create with every field at its bound, the prompt two bytes a character, fits the create cap", async () => {
    expect(parseTask(created)).toEqual(created);
    expect(await sealedLength(created)).toBeLessThanOrEqual(STORE_CREATE_MAX_CT_LENGTH);
  });

  test("on top of that, all the leader adds at every bound fits a record with ten candidates beside it", async () => {
    const decided: Task = {
      ...written,
      decision: { at: 1_760_000_000_000, chosen: target, candidates: Array.from({ length: 10 }, () => candidate) },
    };
    expect(parseTask(decided)).toEqual(decided);
    expect(await sealedLength(decided)).toBeLessThanOrEqual(STORE_MAX_CT_LENGTH);
    // …and a full prefix still lists in one frame, under the Workers WebSocket message limit.
    expect(MAX_TASKS * STORE_MAX_CT_LENGTH).toBeLessThan(32 * 1024 * 1024);
  });

  test("keys are a known prefix and a routing id; account records stay reserved until M4", () => {
    for (const { prefix } of Object.values(STORE_PREFIXES)) expect(isStoreKey(`${prefix}x`)).toBe(true);
    expect(isStoreKey(`task:${"a".repeat(ROUTING_ID_MAX_LENGTH)}`)).toBe(true);
    for (const bad of [
      `task:${"a".repeat(ROUTING_ID_MAX_LENGTH + 1)}`,
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

describe("routing ids and terms", () => {
  test("a task id is a routing id, so every one is a store key's id part as it stands", () => {
    for (const id of [crypto.randomUUID(), "t-1", "a".repeat(ROUTING_ID_MAX_LENGTH)]) {
      expect(isTaskId(id)).toBe(true);
      expect(isStoreKey(`${STORE_PREFIXES.task.prefix}${id}`)).toBe(true);
    }
    for (const bad of ["t:1", "", "a".repeat(ROUTING_ID_MAX_LENGTH + 1), "t 1", "t/1"])
      expect(isTaskId(bad)).toBe(false);
  });

  test("a term is a safe non-negative integer", () => {
    expect(isTerm(0)).toBe(true);
    expect(isTerm(31)).toBe(true);
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3", null]) expect(isTerm(bad)).toBe(false);
  });
});

describe("what a leader writes into a task is bounded", () => {
  const target: Target = { deviceId: "d-1", exclave: "default", clone: "seance" };
  const task: Task = {
    id: "t-1",
    spec: { repo: "github.com/acme/app", mode: "worktree" },
    state: "running",
    createdAt: 1,
  };

  test("a target's names: a routing id, an exclave name, a clone name, a window and a pane", () => {
    expect(parseTask({ ...task, assignment: { ...target, window: "", pane: "%3" } })?.assignment?.window).toBe("");
    for (const bad of [
      { ...target, deviceId: "d:1" },
      { ...target, exclave: "x".repeat(TASK_SPEC_LIMITS.placement + 1) },
      { ...target, clone: "" },
      { ...target, clone: "c".repeat(TARGET_LIMITS.clone + 1) },
      { ...target, window: "w".repeat(TARGET_LIMITS.window + 1) },
      { ...target, pane: "%".repeat(ROUTING_ID_MAX_LENGTH + 1) },
    ]) {
      expect(parseTask({ ...task, assignment: bad })).toBeNull();
    }
  });

  test("a failure's code is bounded; its message is cut, so an older leader's long one costs its tail only", () => {
    const long = { code: "launch_error", message: "x".repeat(TASK_FAILURE_LIMITS.message + 10) };
    expect(parseTask({ ...task, state: "failed", failure: long })?.failure?.message).toHaveLength(
      TASK_FAILURE_LIMITS.message,
    );
    const failure = { code: "c".repeat(TASK_FAILURE_LIMITS.code + 1), message: "m" };
    expect(parseTask({ ...task, state: "failed", failure })).toBeNull();
    expect(parseTask({ ...task, state: "failed", failure: { code: "", message: "m" } })).toBeNull();
  });

  test("a decision lists at most DECISION_MAX_CANDIDATES, each with bounded reasons, and says when it was cut", () => {
    const candidate = { deviceId: "d-1", machine: "mac", exclave: "default", rejected: [{ code: "offline" }] };
    const decision = (n: number, extra: object = {}) => ({
      at: 1,
      chosen: null,
      candidates: Array.from({ length: n }, () => candidate),
      ...extra,
    });
    expect(parseDecision(decision(DECISION_MAX_CANDIDATES))).not.toBeNull();
    expect(parseDecision(decision(DECISION_MAX_CANDIDATES + 1))).toBeNull();
    expect(parseDecision(decision(1, { trimmed: 7 }))?.trimmed).toBe(7);
    expect(parseDecision(decision(1, { trimmed: -1 }))).toBeNull();
    const rejected = Array.from({ length: CANDIDATE_MAX_REASONS + 1 }, () => ({ code: "offline" }));
    expect(parseDecision({ at: 1, chosen: null, candidates: [{ ...candidate, rejected }] })).toBeNull();
    expect(parseDecision({ at: 1, chosen: null, candidates: [{ ...candidate, deviceId: "d 1" }] })).toBeNull();
    const named = { ...candidate, machine: "m".repeat(TARGET_LIMITS.machine + 1) };
    expect(parseDecision({ at: 1, chosen: null, candidates: [named] })).toBeNull();
  });
});

describe("bindTaskRecord", () => {
  const now = 1_760_000_000_000;
  const task: Task = {
    id: "t-1",
    spec: { repo: "github.com/acme/app", mode: "worktree" },
    state: "queued",
    createdAt: now,
  };
  const key = "task:t-1";

  test("keeps a record bound to its key and version", () => {
    expect(bindTaskRecord({ version: 1, task }, { key, version: 1 }, now)).toEqual({ version: 1, task });
    const ready: TaskRecord = { version: 2, task: { ...task, state: "ready" } };
    expect(bindTaskRecord(ready, { key, version: 2 }, now)).toEqual(ready);
    const edge = { version: 1, task: { ...task, createdAt: now + REPLAY_WINDOW_MS } };
    expect(bindTaskRecord(edge, { key, version: 1 }, now)).toEqual(edge);
  });

  test("names why it refuses one, so a reader can skip and report it", () => {
    const paused = { version: 1, task: { ...task, state: "paused" } };
    expect(bindTaskRecord(paused, { key, version: 1 }, now)).toBe("malformed");
    // An authentic old blob put back at the current version: version binding.
    expect(bindTaskRecord({ version: 1, task }, { key, version: 3 }, now)).toBe("version_mismatch");
    // Another task's blob re-filed under a fresh key.
    expect(bindTaskRecord({ version: 1, task }, { key: "task:t-2", version: 1 }, now)).toBe("key_mismatch");
    // Only the leader moves a task past `queued`; no create may start it further on.
    const running = { version: 1, task: { ...task, state: "running" } };
    expect(bindTaskRecord(running, { key, version: 1 }, now)).toBe("created_unqueued");
    const ahead = { version: 1, task: { ...task, createdAt: now + REPLAY_WINDOW_MS + 1 } };
    expect(bindTaskRecord(ahead, { key, version: 1 }, now)).toBe("created_ahead");
  });
});

describe("parseTaskProgressList", () => {
  const entry = {
    taskId: "t-1",
    prUrl: "https://github.com/acme/app/pull/7",
    branch: "worktree-fix-it",
    pushed: true,
    merged: true,
    at: 1,
  } as const;

  test("round-trips, a `here` task's entry with no branch included", () => {
    const here = { taskId: "t-2", prUrl: entry.prUrl, at: 2 };
    expect(parseTaskProgressList([entry, here, { taskId: "t-3", at: 3, extra: 1 }])).toEqual([
      entry,
      here,
      { taskId: "t-3", at: 3 },
    ]);
  });

  test("strict: one unreadable entry, or too many, nulls the list — a dropped one would read as no PR", () => {
    for (const bad of [
      { ...entry, prUrl: "http://github.com/acme/app/pull/7" },
      { ...entry, merged: false },
      { ...entry, pushed: "yes" },
      { ...entry, branch: "" },
      { ...entry, taskId: "t:1" },
      { ...entry, at: "now" },
    ]) {
      expect(parseTaskProgressList([entry, bad])).toBeNull();
    }
    expect(parseTaskProgressList(Array.from({ length: SESSIONS_MAX_PROGRESS + 1 }, () => entry))).toBeNull();
  });
});
