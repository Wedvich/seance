import { describe, expect, test } from "bun:test";
import { importPsk, seal, toBase64 } from "./crypto.ts";
import {
  bindTaskRecord,
  PR_URL_MAX_LENGTH,
  isBranchName,
  isMetricsRequest,
  isSkillName,
  parseAccountRecord,
  parseFleetQuotaRecord,
  parseContinuedBy,
  parsePrAlertStamp,
  parseQuotaExhaustedStamp,
  parsePushAlert,
  parsePushSubscribeReply,
  parsePushSubscribeRequest,
  parsePushUnsubscribeReply,
  parsePushUnsubscribeRequest,
  parseSettingsRecord,
  pushEndpoint,
  pushServiceVendor,
  isStoreKey,
  isTaskId,
  isTerm,
  parseBranchState,
  parseDecision,
  parseDiscardReply,
  parseDiscardRequest,
  parseExclaveList,
  parseArchiveMetricsRequest,
  parseArchiveStatusReply,
  parseArchiveStatusRequest,
  parseArchiveTasksReply,
  parseArchiveTasksRequest,
  parseArchivistInfo,
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
  parseSessionEvent,
  parseStoreChanged,
  parseStoreReply,
  parsePrStatus,
  parseTask,
  parseTaskRecord,
  parseInterrupted,
  parseTaskProgressList,
  parseTaskRef,
  parseTaskReply,
  UPDATE_DETAIL_MAX,
  parseRoutePreviewRequest,
  parseTaskRequest,
  parseAttachmentManifest,
  parseTaskSpec,
  parseAmendRequest,
} from "./parse.ts";
import { REPLAY_WINDOW_MS } from "./crypto.ts";
import { taskRecordAtRest } from "./task-record.ts";
import {
  ACCOUNT_ALIAS_MAX_LENGTH,
  ARCHIVE_STATUS_ERROR_CODES,
  ARCHIVE_TASKS_ERROR_CODES,
  ARCHIVE_MACHINES_MAX,
  ARCHIVE_TASKS_MAX_PAGE,
  BRANCH_MAX_LENGTH,
  CANDIDATE_MAX_REASONS,
  EXIT_STATUS_MAX,
  FLEET_QUOTA_MAX_ACCOUNTS,
  FLEET_QUOTA_MAX_WINDOWS,
  FLEET_QUOTA_WINDOW_MODEL_MAX_LENGTH,
  AUTH_ALERTS_MAX,
  DISK_ALERTS_MAX,
  LINEAR_KEY_MAX_LENGTH,
  PUSH_ENDPOINT_MAX_LENGTH,
  PUSH_LABEL_MAX_LENGTH,
  PR_FAILING_LIMITS,
  PUSH_ALERT_MAX_BYTES,
  PUSH_MAX_SUBSCRIPTIONS,
  REPO_MAX_SKILLS,
  SKILL_NAME_MAX_LENGTH,
  STATUS_MAX_AUTH_EXPIRED,
  STATUS_MAX_TRAIT_PAIRS,
  DECISION_MAX_CANDIDATES,
  MAX_PAUSE_HOLDS,
  METRICS_MAX_FILTER_LENGTH,
  METRICS_MAX_FILTERS,
  METRICS_MAX_POINTS,
  MAX_TASKS,
  OP_TIMEOUT_MS,
  QUEUE_MAX_TASKS,
  ATTACHMENT_LIMITS,
  ATTACHMENTS_DEP_SENTINEL,
  PIN_SENTINEL,
  REQUIRES_DEP_SENTINEL,
  ROUTING_ID_MAX_LENGTH,
  SESSIONS_MAX_PROGRESS,
  SIGKILL_STATUS,
  STORE_CREATE_MAX_CT_LENGTH,
  STORE_MAX_CT_LENGTH,
  STORE_PREFIXES,
  type StorePrefixRule,
  TARGET_LIMITS,
  TASK_FAILURE_LIMITS,
  TOOL_NAME_MAX_LENGTH,
  TASK_PRS_MAX,
  TASK_PRS_MAX_LENGTH,
  TASK_REQUEST_LIMITS,
  TASK_SPEC_LIMITS,
  type AttachmentRef,
  type BatchMembership,
  type BranchState,
  type Candidate,
  type FleetQuotaRecord,
  type MachineStatus,
  type MetricsSeries,
  type PauseHold,
  type PrStatus,
  type QuotaObservation,
  type QuotaReading,
  type SettingsRecord,
  type WebPushSubscription,
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
import { TRAIT_LIMITS } from "./traits.ts";

const repo = { name: "seance", path: "/home/u/seance", defaultBranch: "main" };
const info = { name: "mac", platform: "darwin", repos: [repo], scannedAt: 1_700_000_000_000 };
const exclave = { id: "default", accountId: "org:acct", extraUsageEnabled: true, authOk: true, skills: ["dataviz"] };

async function sealedLength(task: Task): Promise<number> {
  const key = await importPsk(toBase64(new Uint8Array(32)));
  const plain = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    op: "task",
    payload: taskRecordAtRest({ version: 1, task }),
  } as const;
  return (await seal(key, { to: "scheduler", from: "app" }, plain)).ct.length;
}

async function sealedRecordLength(op: "quota" | "settings", payload: unknown): Promise<number> {
  const key = await importPsk(toBase64(new Uint8Array(32)));
  const plain = { id: crypto.randomUUID(), ts: Date.now(), op, payload } as const;
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

  test("traits are read leniently: bad names, repeats and the excess dropped, an unreadable list as none, the exclave kept", () => {
    expect(parseExclaveList([{ ...exclave, traits: ["atlas", "gpu"] }])?.[0]?.traits).toEqual(["atlas", "gpu"]);
    expect(parseExclaveList([exclave])?.[0]).not.toHaveProperty("traits");
    expect(parseExclaveList([{ ...exclave, traits: ["atlas", "Bad Name", "atlas", 7, "-x"] }])?.[0]?.traits).toEqual([
      "atlas",
    ]);
    const many = Array.from({ length: TRAIT_LIMITS.perMachine + 3 }, (_, i) => `t${i}`);
    expect(parseExclaveList([{ ...exclave, traits: many }])?.[0]?.traits).toEqual(
      many.slice(0, TRAIT_LIMITS.perMachine),
    );
    for (const traits of ["atlas", [], ["Bad"], { atlas: true }, null]) {
      const [read] = parseExclaveList([{ ...exclave, traits }]) ?? [];
      expect(read).toEqual(exclave);
    }
  });

  test("keepFree keeps only names that are also traits, deduplicated, and reads as none when empty or unreadable", () => {
    const read = (keepFree: unknown, traits: unknown = ["atlas", "gpu"]) =>
      parseExclaveList([{ ...exclave, traits, keepFree }])?.[0];
    expect(read(["gpu", "atlas", "gpu"])?.keepFree).toEqual(["gpu", "atlas"]);
    expect(read(["gpu", "nowhere", "Bad Name", 7])?.keepFree).toEqual(["gpu"]);
    expect(parseExclaveList([exclave])?.[0]).not.toHaveProperty("keepFree");
    for (const keepFree of ["gpu", [], ["nowhere"], { gpu: true }, null]) {
      expect(read(keepFree)).toEqual({ ...exclave, traits: ["atlas", "gpu"] });
    }
    // A keepFree beside no traits means nothing.
    expect(parseExclaveList([{ ...exclave, keepFree: ["gpu"] }])?.[0]).toEqual(exclave);
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

  test("credit amounts come both or neither, and only beside the percent", () => {
    const credits = { c: 82, cu: 4104, cl: 5000 };
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, ...credits }] })?.quota?.[0]).toEqual({
      ...quota,
      ...credits,
    });
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, c: 82 }] })).not.toBeNull();
    const { c: _c, ...amounts } = credits;
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, ...amounts }] })).toBeNull();
    const { cl: _cl, ...uncapped } = credits;
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, ...uncapped }] })).toBeNull();
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, ...credits, cu: 41.5 }] })).toBeNull();
  });

  test("absent is the only unknown: null fields and unknown quota sources are refused", () => {
    expect(parseMachineStatus({ ...status, mem: null })).toBeNull();
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, s: "guess" }] })).toBeNull();
    expect(parseMachineStatus({ ...status, quota: [{ x: 0, s: "session" }] })).toBeNull();
    // Reserved for an OAuth poll that was never built, and never emitted.
    expect(parseMachineStatus({ ...status, quota: [{ ...quota, s: "oauth" }] })).toBeNull();
  });

  test("a session-sourced reading from a daemon that predates the /usage refresh still parses", () => {
    const legacy: MachineStatus = { ...status, quota: [{ ...quota, s: "session" }] };
    expect(parseMachineStatus(legacy)).toEqual(legacy);
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

describe("parseRoutePreviewRequest", () => {
  const minimal: TaskRequest = { repo: "github.com/acme/app", mode: "worktree" };

  test("keeps the attachments flag only as true; a manifest or anything else is malformed", () => {
    expect(parseRoutePreviewRequest(minimal)).toEqual(minimal);
    expect(parseRoutePreviewRequest({ ...minimal, attachments: true })).toEqual({ ...minimal, attachments: true });
    for (const attachments of [false, [attachment(0)], "yes", 1])
      expect(parseRoutePreviewRequest({ ...minimal, attachments })).toBeNull();
    expect(parseRoutePreviewRequest({ ...minimal, mode: "continue", attachments: true })).toBeNull();
  });

  test("keeps `requires` as a spec holds it; a malformed list is a malformed request", () => {
    expect(parseRoutePreviewRequest({ ...minimal, requires: ["atlas", "gpu"] })).toEqual({
      ...minimal,
      requires: ["atlas", "gpu"],
    });
    expect(parseRoutePreviewRequest({ ...minimal, attachments: true, requires: ["atlas"] })).toEqual({
      ...minimal,
      attachments: true,
      requires: ["atlas"],
    });
    for (const requires of [[], ["Atlas"], ["a", "a"], "atlas", ["a", "b", "c", "d", "e"]])
      expect(parseRoutePreviewRequest({ ...minimal, requires })).toBeNull();
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

  test("autonomy is kept, and steer always carries plan, for a leader that drops the level", () => {
    expect(parseTaskRequest({ ...minimal, autonomy: "auto" })).toEqual({ ...minimal, autonomy: "auto" });
    expect(parseTaskRequest({ ...minimal, autonomy: "checkpoint", plan: false })).toEqual({
      ...minimal,
      autonomy: "checkpoint",
      plan: false,
    });
    expect(parseTaskRequest({ ...minimal, autonomy: "steer" })).toEqual({ ...minimal, autonomy: "steer", plan: true });
  });

  test("every field is typed, and the keys a spawn acts on are never empty", () => {
    for (const bad of [
      { ...minimal, repo: "" },
      { ...minimal, mode: "elsewhere" },
      // A route preview has no target to continue at: only a stored spec carries the mode.
      { ...minimal, mode: "continue" },
      { ...minimal, prompt: 1 },
      { ...minimal, plan: "yes" },
      { ...minimal, autonomy: "yolo" },
      { ...minimal, autonomy: "" },
      // Two answers to one question: plan mode is `steer`, so neither may win silently.
      { ...minimal, autonomy: "auto", plan: true },
      { ...minimal, autonomy: "checkpoint", plan: true },
      { ...minimal, autonomy: "steer", plan: false },
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
    pin: { deviceId: "dev-a", account: "org-1:acct-1" },
    avoid: ["dev-b", "dev-c"],
    lineage: { deviceId: "dev-a", exclave: "default" },
    base: { deviceId: "dev-b", exclave: "work" },
    batch: { id: "batch-1", index: 2 },
    deps: [
      { task: "t-1", after: "opened" },
      { task: "t-2", after: "merged" },
    ],
    linear: { issue: "ENG-123", url: "https://linear.app/acme/issue/ENG-123" },
    client: "pwa",
  };

  test("a whole spec round-trips, and fields it does not know stay behind", () => {
    expect(parseTaskSpec(full)).toEqual(full);
    expect(parseTaskSpec({ ...request, taskId: "x", deviceId: "y" })).toEqual(request);
    const last: BatchMembership = { id: "b", index: TASK_SPEC_LIMITS.batchIndex };
    expect(parseTaskSpec({ ...full, batch: last })?.batch).toEqual(last);
  });

  test("a batch's stored strategy, whatever an older writer put there, is read and dropped", () => {
    for (const strategy of [
      { mode: "auto" },
      { mode: "sequential" },
      { mode: "parallel", max: 3 },
      { mode: "parallel", max: 0 },
      { mode: "round-robin" },
      "sequential",
      undefined,
    ]) {
      const batch = parseTaskSpec({ ...request, batch: { id: "b", index: 1, strategy } })?.batch;
      expect(batch).toEqual({ id: "b", index: 1 });
      expect(batch).not.toHaveProperty("strategy");
    }
  });

  test("a malformed optional field nulls the spec — a task must not run without the pin or deps it was given", () => {
    for (const bad of [
      { ...full, pin: { account: "" } },
      { ...full, pin: { account: "a".repeat(TASK_SPEC_LIMITS.account + 1) } },
      { ...full, pin: { deviceId: "has space" } },
      { ...full, pin: "dev-a" },
      { ...full, avoid: ["dev-b", "dev-b"] },
      { ...full, avoid: ["has space"] },
      { ...full, avoid: "dev-b" },
      { ...full, avoid: Array.from({ length: TASK_SPEC_LIMITS.avoid + 1 }, (_, i) => `dev-${i}`) },
      { ...full, lineage: { deviceId: "dev-a" } },
      { ...full, batch: { ...full.batch, id: "has space" } },
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

  describe("a continuation", () => {
    const at = { deviceId: "dev-a", exclave: "default", clone: "app" };
    const spec: TaskSpec = { ...request, mode: "continue", continues: { task: "t-old", at } };

    test("round-trips: the mode and the field travel together", () => {
      expect(parseTaskSpec(spec)).toEqual(spec);
      expect(parseTaskSpec({ ...spec, continues: { task: "t-old", at, extra: 1 } })).toEqual(spec);
    });

    test("the field without the mode, or the mode without the field, is no spec", () => {
      expect(parseTaskSpec({ ...spec, mode: "worktree" })).toBeNull();
      expect(parseTaskSpec({ ...spec, mode: "here" })).toBeNull();
      expect(parseTaskSpec({ ...request, mode: "continue" })).toBeNull();
    });

    test("a bad task id or target nulls the spec", () => {
      for (const continues of [
        { task: "has space", at },
        { task: "", at },
        { task: 7, at },
        { task: "t-old" },
        { task: "t-old", at: { ...at, exclave: "" } },
        { task: "t-old", at: { ...at, clone: "c".repeat(TARGET_LIMITS.clone + 1) } },
        { task: "t-old", at: { ...at, deviceId: "has space" } },
        { task: "t-old", at: { deviceId: "dev-a", exclave: "default" } },
        "t-old",
        null,
      ]) {
        expect(parseTaskSpec({ ...spec, continues })).toBeNull();
      }
    });

    test("a lineage beside it is still read as lineage", () => {
      const lineage = { deviceId: "dev-b", exclave: "work" };
      expect(parseTaskSpec({ ...spec, lineage })).toEqual({ ...spec, lineage });
    });
  });

  test("an exclave in a pin is read by no one: a legacy exclave pin, or the sentinel, parses without it", () => {
    expect(parseTaskSpec({ ...request, pin: { exclave: "work" } })).toEqual(request);
    expect(parseTaskSpec({ ...request, pin: { deviceId: "dev-a", exclave: "work" } })?.pin).toEqual({
      deviceId: "dev-a",
    });
    // Once refused as malformed; now there is nothing to refuse.
    expect(parseTaskSpec({ ...request, pin: { exclave: "" } })).toEqual(request);
    expect(parseTaskSpec({ ...full, pin: { ...full.pin, exclave: PIN_SENTINEL } })).toEqual(full);
    expect(parseTaskSpec({ ...request, pin: {} })).toEqual(request);
  });

  test("an account and the avoid list are bounded, the limits themselves allowed", () => {
    const account = "a".repeat(TASK_SPEC_LIMITS.account);
    expect(parseTaskSpec({ ...request, pin: { account } })?.pin).toEqual({ account });
    const avoid = Array.from({ length: TASK_SPEC_LIMITS.avoid }, (_, i) => `dev-${i}`);
    expect(parseTaskSpec({ ...request, avoid })?.avoid).toEqual(avoid);
    expect(parseTaskSpec({ ...request, avoid: [] })?.avoid).toEqual([]);
  });

  test("deps are bounded, the limit itself allowed", () => {
    expect(parseTaskSpec({ ...request, deps: deps(TASK_SPEC_LIMITS.deps) })).not.toBeNull();
    expect(parseTaskSpec({ ...request, deps: deps(TASK_SPEC_LIMITS.deps + 1) })).toBeNull();
  });

  describe("requires", () => {
    const spec: TaskSpec = { ...request, requires: ["atlas", "gpu"] };

    test("one to the bound of unique trait names, round-tripping beside every other field", () => {
      expect(parseTaskSpec(spec)).toEqual(spec);
      const both = { ...full, requires: spec.requires };
      expect(parseTaskSpec(both)).toEqual(both);
      const bound = Array.from({ length: TASK_SPEC_LIMITS.requires }, (_, i) => `${i}`.padEnd(32, "x"));
      expect(parseTaskSpec({ ...request, requires: bound })?.requires).toEqual(bound);
    });

    test("a malformed list nulls the spec, never drops the field", () => {
      const tooMany = Array.from({ length: TASK_SPEC_LIMITS.requires + 1 }, (_, i) => `t${i}`);
      for (const requires of [[], tooMany, ["a", "a"], ["Atlas"], ["-a"], ["a".repeat(33)], [7], "atlas", null])
        expect(parseTaskSpec({ ...request, requires })).toBeNull();
    });

    test("the dep sentinel is dropped beside `requires`; without it the spec still reads", () => {
      expect(parseTaskSpec({ ...spec, deps: [REQUIRES_DEP_SENTINEL] })).toEqual(spec);
      expect(parseTaskSpec(spec)).toEqual(spec);
      const sealed = { ...spec, deps: [...deps(TASK_SPEC_LIMITS.deps), REQUIRES_DEP_SENTINEL] };
      expect(parseTaskSpec(sealed)?.deps).toEqual(deps(TASK_SPEC_LIMITS.deps));
    });

    test("the sentinel without `requires` nulls the spec: a record something stripped the requirement from", () => {
      expect(parseTaskSpec({ ...request, deps: [REQUIRES_DEP_SENTINEL] })).toBeNull();
      expect(parseTaskSpec({ ...request, deps: deps(2).concat([REQUIRES_DEP_SENTINEL]) })).toBeNull();
      // The attachments sentinel does not stand in for it, nor the reverse.
      expect(parseTaskSpec({ ...spec, deps: [ATTACHMENTS_DEP_SENTINEL] })).toBeNull();
    });

    test("both sentinels beside both fields are dropped; either alone still nulls the spec", () => {
      const both: TaskSpec = { ...request, attachments: [attachment(0)], requires: ["atlas"] };
      expect(parseTaskSpec({ ...both, deps: [ATTACHMENTS_DEP_SENTINEL, REQUIRES_DEP_SENTINEL] })).toEqual(both);
      expect(parseTaskSpec({ ...both, deps: [REQUIRES_DEP_SENTINEL, ATTACHMENTS_DEP_SENTINEL] })).toEqual(both);
      const realDeps = deps(2);
      expect(
        parseTaskSpec({ ...both, deps: [...realDeps, ATTACHMENTS_DEP_SENTINEL, REQUIRES_DEP_SENTINEL] })?.deps,
      ).toEqual(realDeps);
      expect(parseTaskSpec({ ...request, requires: ["atlas"], deps: [ATTACHMENTS_DEP_SENTINEL] })).toBeNull();
    });
  });

  describe("attachments", () => {
    const spec: TaskSpec = { ...request, attachments: [attachment(0), attachment(1)] };

    test("round-trip beside every other field, and fields an entry does not know stay behind", () => {
      expect(parseTaskSpec(spec)).toEqual(spec);
      const both = { ...full, attachments: spec.attachments };
      expect(parseTaskSpec(both)).toEqual(both);
      const extra = { ...attachment(0), path: "/etc/passwd" };
      expect(parseTaskSpec({ ...request, attachments: [extra] })?.attachments).toEqual([attachment(0)]);
    });

    test("a malformed manifest nulls the spec, never drops the field", () => {
      expect(parseTaskSpec({ ...request, attachments: [{ ...attachment(0), hash: "short" }] })).toBeNull();
      expect(parseTaskSpec({ ...request, attachments: [] })).toBeNull();
      expect(parseTaskSpec({ ...request, attachments: "a.png" })).toBeNull();
    });

    test("never with a continuation", () => {
      const at = { deviceId: "dev-a", exclave: "default", clone: "app" };
      expect(parseTaskSpec({ ...spec, mode: "continue", continues: { task: "t-old", at } })).toBeNull();
    });

    test("take the lower prompt bound, the bound itself allowed", () => {
      const prompt = (n: number): string => "p".repeat(n);
      expect(parseTaskSpec({ ...spec, prompt: prompt(ATTACHMENT_LIMITS.prompt) })).not.toBeNull();
      expect(parseTaskSpec({ ...spec, prompt: prompt(ATTACHMENT_LIMITS.prompt + 1) })).toBeNull();
      expect(parseTaskSpec({ ...request, prompt: prompt(ATTACHMENT_LIMITS.prompt + 1) })).not.toBeNull();
    });

    test("the dep sentinel is dropped beside a manifest, before the deps bound; without one it nulls the spec", () => {
      const sealed = { ...spec, deps: [...deps(TASK_SPEC_LIMITS.deps), ATTACHMENTS_DEP_SENTINEL] };
      expect(parseTaskSpec(sealed)?.deps).toEqual(deps(TASK_SPEC_LIMITS.deps));
      expect(parseTaskSpec({ ...spec, deps: [ATTACHMENTS_DEP_SENTINEL] })).toEqual(spec);
      // A sentinel with no manifest is a record something stripped the files from.
      expect(parseTaskSpec({ ...request, deps: [ATTACHMENTS_DEP_SENTINEL] })).toBeNull();
      // Only the sentinel itself: any other malformed dep still nulls the spec.
      expect(parseTaskSpec({ ...spec, deps: [{ task: "", after: "opened" }] })).toBeNull();
      expect(parseTaskSpec({ ...spec, deps: [{ task: "", after: "merged", extra: 1 }] })).toEqual(spec);
    });
  });
});

function attachment(i: number, over: Partial<AttachmentRef> = {}): AttachmentRef {
  return {
    id: `0b6f0c9e-1a2b-4c3d-8e9f-${i.toString(16).padStart(12, "0")}`,
    name: `screenshot ${i}.png`,
    type: "image/png",
    size: 1024,
    hash: "A".repeat(43),
    ...over,
  };
}

describe("parseAttachmentManifest", () => {
  const files = (n: number, over: Partial<AttachmentRef> = {}): readonly AttachmentRef[] =>
    Array.from({ length: n }, (_, i) => attachment(i, over));

  test("every bound itself is allowed", () => {
    const largest = files(ATTACHMENT_LIMITS.files, { size: Math.floor(ATTACHMENT_LIMITS.totalBytes / 10) });
    expect(parseAttachmentManifest(largest)).toEqual(largest);
    const one = [
      attachment(0, {
        size: ATTACHMENT_LIMITS.fileBytes,
        name: "ø".repeat(ATTACHMENT_LIMITS.name),
        type: `application/${"x".repeat(ATTACHMENT_LIMITS.type - "application/".length)}`,
        hash: "Az09_-".repeat(7) + "b",
      }),
    ];
    expect(parseAttachmentManifest(one)).toEqual(one);
    expect(parseAttachmentManifest([attachment(0, { size: 0, type: "application/vnd.ms-excel+xml" })])).not.toBeNull();
  });

  test("counts and sizes past their bounds are refused", () => {
    expect(parseAttachmentManifest(files(ATTACHMENT_LIMITS.files + 1))).toBeNull();
    expect(parseAttachmentManifest([])).toBeNull();
    expect(parseAttachmentManifest([attachment(0, { size: ATTACHMENT_LIMITS.fileBytes + 1 })])).toBeNull();
    // Each file under its own bound, the sum one byte over.
    const size = Math.floor(ATTACHMENT_LIMITS.totalBytes / 4);
    const over = [...files(3, { size: ATTACHMENT_LIMITS.fileBytes }), attachment(3, { size })];
    expect(over.reduce((sum, ref) => sum + ref.size, 0)).toBeGreaterThan(ATTACHMENT_LIMITS.totalBytes);
    expect(parseAttachmentManifest(over)).toBeNull();
    const exact = [...files(3, { size: ATTACHMENT_LIMITS.fileBytes }), attachment(3, { size: 10 * 1024 * 1024 })];
    expect(parseAttachmentManifest(exact)).not.toBeNull();
  });

  test("a malformed entry refuses the whole manifest", () => {
    for (const bad of [
      { id: "0B6F0C9E-1A2B-4C3D-8E9F-000000000000" },
      { id: "0b6f0c9e-1a2b-3c3d-8e9f-000000000000" },
      { id: "../../etc/passwd" },
      { id: 7 },
      { name: "" },
      { name: "ø".repeat(ATTACHMENT_LIMITS.name + 1) },
      { name: "two\nlines" },
      { name: "tab\there" },
      { name: "del\u007F" },
      { name: "c1\u0085" },
      { name: "sep " },
      { type: "" },
      { type: "Image/PNG" },
      { type: "text/plain; charset=utf-8" },
      { type: "image" },
      { type: "image/png/x" },
      { type: "/png" },
      { type: `application/${"x".repeat(ATTACHMENT_LIMITS.type)}` },
      { size: -1 },
      { size: 1.5 },
      { size: "1024" },
      { hash: "A".repeat(42) },
      { hash: `${"A".repeat(42)}=` },
      { hash: `${"A".repeat(42)}+` },
    ]) {
      expect(parseAttachmentManifest([attachment(0), { ...attachment(1), ...bad }])).toBeNull();
    }
    expect(parseAttachmentManifest([attachment(0), null])).toBeNull();
  });

  test("ids are unique within a manifest", () => {
    expect(parseAttachmentManifest([attachment(0), attachment(0, { name: "other.png" })])).toBeNull();
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
    expect(parseTask({ ...task, state: "done", doneBy: "linear" })?.doneBy).toBe("linear");
  });

  test("a recorded merge and a `reported` settle round-trip; a merge that is not `true` nulls the task", () => {
    const reported = { ...task, merged: true, state: "done", doneBy: "reported" } as const;
    expect(parseTask(reported)).toEqual(reported);
    expect(parseTask({ ...task, merged: false })).toBeNull();
    expect(parseTask({ ...task, merged: "yes" })).toBeNull();
  });

  test("a remote session round-trips; one that could bend the claude.ai path is dropped, not the task", () => {
    const remoteSession = "session_01TuECqfR7Twko9QJm98sWAw";
    expect(parseTask({ ...task, remoteSession })).toEqual({ ...task, remoteSession });
    for (const bad of ["session_01/../x", "session_01?x=1", "session_", "01TuECqf", "https://evil.test", 7]) {
      expect(parseTask({ ...task, remoteSession: bad })).toEqual(task);
    }
  });

  test("a wait reason and tool round-trip; a bad one is dropped, never the task", () => {
    const stay = { ...task, state: "needs-input" } as const;
    const waiting = { ...stay, inputReason: "permission", inputTool: "Bash" } as const;
    expect(parseTask(waiting)).toEqual(waiting);
    const question = { ...stay, inputReason: "question" } as const;
    expect(parseTask(question)).toEqual(question);
    expect(parseTask({ ...waiting, inputReason: "elicitation" })).toEqual(stay);
    expect(parseTask({ ...waiting, inputReason: 3 })).toEqual(stay);
    for (const inputTool of ["rm -rf /", "a/b", "", "t".repeat(65), 4]) {
      expect(parseTask({ ...waiting, inputTool })).toEqual({ ...stay, inputReason: "permission" });
    }
    expect(parseTask({ ...question, inputTool: "Bash" })).toEqual(question);
    expect(parseTask({ ...stay, inputTool: "Bash" })).toEqual(stay);
  });

  test("a wait reason is kept into `lost` and dropped on every other state", () => {
    const fields = { inputReason: "permission", inputTool: "Bash" } as const;
    expect(parseTask({ ...task, state: "lost", ...fields })).toEqual({ ...task, state: "lost", ...fields });
    for (const state of ["running", "reserved", "failed", "done", "awaiting-merge"] as const) {
      expect(parseTask({ ...task, state, ...fields })).toEqual({ ...task, state });
    }
  });

  test("a forge reading round-trips, with or without checks", () => {
    const at = 1_700_000_300_000;
    expect(parseTask({ ...task, pr: { state: "open", checks: "passing", at } })?.pr).toEqual({
      state: "open",
      checks: "passing",
      at,
    });
    const bare = parseTask({ ...task, pr: { state: "merged", at } });
    expect(bare?.pr).toEqual({ state: "merged", at });
    expect(bare?.pr).not.toHaveProperty("checks");
    expect(bare?.pr).not.toHaveProperty("stacked");
  });

  test("a merge into a non-default branch round-trips as `stacked`", () => {
    const at = 1_700_000_300_000;
    expect(parseTask({ ...task, pr: { state: "merged", stacked: true, at } })?.pr).toEqual({
      state: "merged",
      stacked: true,
      at,
    });
  });

  test("a malformed forge reading drops `pr` and never the task", () => {
    for (const pr of [
      { state: "stacked", at: 1 },
      { state: "open", checks: "flaky", at: 1 },
      { state: "merged", stacked: false, at: 1 },
      { state: "merged", stacked: "yes", at: 1 },
      { state: "open", at: Number.POSITIVE_INFINITY },
      { state: "open", at: "now" },
      { state: "open" },
      "open",
      null,
    ]) {
      const parsed = parseTask({ ...task, pr });
      expect(parsed).toEqual(task);
      expect(parsed).not.toHaveProperty("pr");
    }
  });

  test("parsePrStatus returns a fresh object holding only its fields", () => {
    const input = { state: "draft", checks: "pending", at: 5, extra: "x" };
    const parsed = parsePrStatus(input);
    expect(parsed).toEqual({ state: "draft", checks: "pending", at: 5 });
    expect(parsed).not.toBe(input);
    expect(parsePrStatus({ state: "open", checks: undefined, at: 5 })).toEqual({ state: "open", at: 5 });
    expect(parsePrStatus({ state: "merged", stacked: true, at: 5 })).toEqual({ state: "merged", stacked: true, at: 5 });
  });

  test("parsePrStatus round-trips the blocked-state fields, and one malformed value nulls the reading", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const wide: PrStatus = {
      state: "open",
      checks: "failing",
      head,
      required: "failing",
      failing: ["test (ubuntu-latest)", "test (macos-latest)"],
      merge: "has_hooks",
      armed: true,
      reviewRequested: true,
      at: 5,
    };
    expect(parsePrStatus(wide)).toEqual(wide);
    expect(parsePrStatus({ ...wide, head: "0".repeat(64) })).toEqual({ ...wide, head: "0".repeat(64) });
    expect(parsePrStatus({ state: "open", required: "passing", merge: "clean", at: 5 })).toEqual({
      state: "open",
      required: "passing",
      merge: "clean",
      at: 5,
    });
    for (const bad of [
      { ...wide, head: "0123" },
      { ...wide, head: head.toUpperCase() },
      { ...wide, required: "red" },
      { ...wide, failing: ["a", "b", "c", "d", "e", "f"] },
      { ...wide, failing: ["x".repeat(PR_FAILING_LIMITS.length + 1)] },
      { ...wide, failing: ["bad\u0007name"] },
      { ...wide, failing: [""] },
      { ...wide, failing: [] },
      { ...wide, failing: "a" },
      { ...wide, required: "passing" },
      { ...wide, merge: "DIRTY" },
      { ...wide, armed: false },
      { ...wide, reviewRequested: false },
    ]) {
      expect(parsePrStatus(bad)).toBeNull();
    }
    const { required: _required, ...noRequired } = wide;
    expect(parsePrStatus(noRequired)).toBeNull();
  });

  test("a task's prAlert survives a parse, and a malformed stamp is dropped while the task stays readable", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const stamped: Task = { ...task, state: "awaiting-merge", prAlert: { reason: "unarmed", head, at: 9 } };
    expect(parseTask(stamped)).toEqual(stamped);
    const { prAlert: _prAlert, ...bare } = stamped;
    for (const bad of [
      { reason: "slow", head, at: 9 },
      { reason: "checks", head: "abc", at: 9 },
      { reason: "checks", head, at: "now" },
      { reason: "checks", head },
      { reason: "checks", head, at: 9, extra: 1 },
      "checks",
      null,
    ]) {
      const parsed = parseTask({ ...stamped, prAlert: bad });
      expect(parsed).toEqual(bare);
      expect(parsePrAlertStamp(bad)).toBeNull();
    }
  });

  test("a task's quotaExhausted survives a parse, and a malformed stamp is dropped while the task stays readable", () => {
    const stamp = { accountId: "org:a", window: "7d sonnet", reset: 0, at: 9 };
    const stamped: Task = { ...task, state: "running", quotaExhausted: stamp };
    expect(parseTask(stamped)).toEqual(stamped);
    const retrying: Task = { ...stamped, quotaExhausted: { ...stamp, since: 3, retry: true } };
    expect(parseTask(retrying)).toEqual(retrying);
    const waiting: Task = { ...stamped, quotaExhausted: { ...stamp, waiting: true } };
    expect(parseTask(waiting)).toEqual(waiting);
    const { quotaExhausted: _stamp, ...bare } = stamped;
    for (const bad of [
      { ...stamp, extra: 1 },
      { ...stamp, retry: false },
      { ...stamp, waiting: false },
      { ...stamp, since: -1 },
      { ...stamp, window: "" },
      { ...stamp, window: "w".repeat(65) },
      { ...stamp, accountId: "" },
      { ...stamp, reset: -1 },
      { ...stamp, at: Number.NaN },
      { ...stamp, at: "now" },
      "5h",
      null,
    ]) {
      expect(parseTask({ ...stamped, quotaExhausted: bad })).toEqual(bare);
      expect(parseQuotaExhaustedStamp(bad)).toBeNull();
    }
  });

  test("a task's continuedBy survives a parse, and a malformed pointer is dropped while the task stays readable", () => {
    const pointed: Task = { ...task, state: "awaiting-merge", continuedBy: { task: "c-1", createdAt: 9 } };
    expect(parseTask(pointed)).toEqual(pointed);
    const live: Task = { ...pointed, continuedBy: { task: "c-1", createdAt: 9, live: true } };
    expect(parseTask(live)).toEqual(live);
    const { continuedBy: _continuedBy, ...bare } = pointed;
    for (const bad of [
      { task: "a b", createdAt: 9 },
      { task: "c-1", createdAt: "now" },
      { task: "c-1", createdAt: Number.NaN },
      { task: "c-1" },
      { task: "c-1", createdAt: 9, live: false },
      { task: "c-1", createdAt: 9, extra: 1 },
      "c-1",
      null,
    ]) {
      expect(parseTask({ ...pointed, continuedBy: bad })).toEqual(bare);
      expect(parseContinuedBy(bad)).toBeNull();
    }
  });

  test("a running task's idleRelease survives a parse; a malformed one, or one on another state, is dropped and the task stays readable", () => {
    const released: Task = { ...task, state: "running", idleRelease: { since: 9, deviceId: "a" } };
    expect(parseTask(released)).toEqual(released);
    const { idleRelease: _idleRelease, ...bare } = released;
    for (const bad of [
      { since: "now", deviceId: "a" },
      { since: Number.NaN, deviceId: "a" },
      { since: 9 },
      { since: 9, deviceId: "" },
      { since: 9, deviceId: "a", extra: 1 },
      9,
      null,
    ]) {
      expect(parseTask({ ...released, idleRelease: bad })).toEqual(bare);
    }
    const { idleRelease: _waiting, ...waiting } = { ...released, state: "needs-input" as const };
    expect(parseTask({ ...waiting, idleRelease: { since: 9, deviceId: "a" } })).toEqual(waiting);
  });

  test("a progress field that is not exactly its shape nulls the task", () => {
    for (const bad of [
      { ...task, prUrl: "javascript:alert(1)" },
      { ...task, branch: "" },
      { ...task, branch: "b".repeat(BRANCH_MAX_LENGTH + 1) },
      { ...task, pushed: false },
      { ...task, escalated: 1 },
      { ...task, doneBy: "deploy" },
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
    // An older leader's batch scope reads as unknown since batches stopped scheduling.
    for (const scope of ["batch", "machine"]) {
      expect(parseDecision(decision({ ...reason, scope }))?.candidates[0]?.rejected).toEqual([]);
    }
    const legacy: Reason = { code: "cap_reached", inFlight: 8, max: 8 };
    expect(parseDecision(decision(legacy))?.candidates[0]?.rejected).toEqual([legacy]);
  });

  test("a score's keepFree component round-trips, is optional (an older leader omits it) and is dropped, not the score, when not finite", () => {
    const components = { accountPressure: 0.1, machinePressure: 0.2, dependencyDistance: 0, queuePressure: 0 };
    const decision = (score: unknown) => ({
      at: 1,
      chosen: null,
      candidates: [{ deviceId: "d", machine: "mac", exclave: "default", rejected: [], score }],
    });
    const kept = { components: { ...components, keepFree: 1 }, sticky: 0, total: 4.3 };
    expect(parseDecision(decision(kept))?.candidates[0]?.score).toEqual(kept);
    const plain = { components, sticky: 0, total: 0.3 };
    const read = parseDecision(decision(plain))?.candidates[0]?.score;
    expect(read).toEqual(plain);
    expect(read?.components).not.toHaveProperty("keepFree");
    // Lenient on purpose, unlike the other components: `total` carries the penalty, and a later build's
    // reshaped component must not leave this build holding the record unreadable.
    for (const keepFree of [Number.NaN, Infinity, "1", null, [1], { value: 1 }]) {
      const dropped = parseDecision(decision({ ...kept, components: { ...components, keepFree } }))?.candidates[0]
        ?.score;
      expect(dropped).toEqual({ components, sticky: 0, total: 4.3 });
      expect(dropped?.components).not.toHaveProperty("keepFree");
    }
    // The other components stay strict: one bad one still voids the decision.
    expect(parseDecision(decision({ ...kept, components: { ...components, queuePressure: "1" } }))).toBeNull();
  });

  test("an over-the-line reason may say its credits are spent; any other value drops the reason", () => {
    const candidate = { deviceId: "d", machine: "mac", exclave: "default", rejected: [] };
    const decision = (r: unknown) => ({ at: 1, chosen: null, candidates: [{ ...candidate, rejected: [r] }] });
    const over: Reason = { code: "quota_over_line", window: "5h", projectedPct: 100 };
    expect(parseDecision(decision(over))?.candidates[0]?.rejected).toEqual([over]);
    const spent: Reason = { ...over, creditsSpent: true };
    expect(parseDecision(decision(spent))?.candidates[0]?.rejected).toEqual([spent]);
    expect(parseDecision(decision({ ...over, creditsSpent: false }))?.candidates[0]?.rejected).toEqual([]);
  });

  test("a spill may say it is spending; any other value voids the decision", () => {
    const candidate = { deviceId: "d", machine: "mac", exclave: "default", rejected: [] };
    const decision = (spill: unknown) => ({ at: 1, chosen: null, candidates: [{ ...candidate, spill }] });
    const forecast = { window: "5h", projectedPct: 93 };
    expect(parseDecision(decision(forecast))?.candidates[0]?.spill).toEqual(forecast);
    const spending = parseDecision(decision({ ...forecast, spending: true }))?.candidates[0]?.spill;
    expect(spending).toEqual({ ...forecast, spending: true });
    expect(parseDecision(decision({ ...forecast, spending: false }))).toBeNull();
  });

  test("an older leader's batch order hold drops the reason, never the candidate or the decision", () => {
    const candidate = { deviceId: "d", machine: "mac", exclave: "default", rejected: [] };
    const decision = {
      at: 1,
      chosen: null,
      candidates: [{ ...candidate, rejected: [{ code: "batch_order", index: 3 }] }],
    };
    expect(parseDecision(decision)?.candidates).toEqual([{ ...candidate, rejected: [] }]);
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

  test("a pin mismatch names the machine or the account; an exclave one, from an older leader, drops the reason", () => {
    const candidate = { deviceId: "d", machine: "mac", exclave: "default", rejected: [] };
    const decision = (r: unknown) => ({ at: 1, chosen: null, candidates: [{ ...candidate, rejected: [r] }] });
    const reasons: readonly Reason[] = [
      { code: "pin_mismatch", field: "deviceId" },
      { code: "pin_mismatch", field: "account" },
      { code: "avoided" },
    ];
    for (const reason of reasons) expect(parseDecision(decision(reason))?.candidates[0]?.rejected).toEqual([reason]);
    expect(parseDecision(decision({ code: "pin_mismatch", field: "exclave" }))?.candidates[0]?.rejected).toEqual([]);
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

  test("queue carries the leader's cap; one that is not a positive integer is dropped, not the reply", () => {
    expect(parseQueueReply({ tasks: [], at: 5, globalMax: 8 })).toEqual({ tasks: [], at: 5, globalMax: 8 });
    for (const bad of [0, -1, 1.5, "8", null]) {
      expect(parseQueueReply({ tasks: [], at: 5, globalMax: bad })).toEqual({ tasks: [], at: 5 });
    }
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

  test("queue lists idle-released tasks, each one alone: a bad entry shows its task running, too many cost the reply", () => {
    const idle = { taskId: "t-1", since: 4 };
    expect(parseQueueReply({ tasks: [], at: 5, idle: [idle, { taskId: "t:2", since: 4 }, { taskId: "t-3" }] })).toEqual(
      {
        tasks: [],
        at: 5,
        idle: [idle],
      },
    );
    expect(parseQueueReply({ tasks: [], at: 5, idle: [] })).toEqual({ tasks: [], at: 5 });
    expect(parseQueueReply({ tasks: [], at: 5, idle: {} })).toBeNull();
    expect(parseQueueReply({ tasks: [], at: 5, idle: Array.from({ length: MAX_TASKS + 1 }, () => idle) })).toBeNull();
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
      expect(parseQueueReply({ tasks: [], at: 5, unreadable: [junk, bad] })).toEqual({
        tasks: [],
        at: 5,
        unreadable: [junk],
      });
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

describe("parseSessionEvent", () => {
  const event = {
    session: "%3",
    taskId: "0b6f0c9e-1a2b-4c3d-8e9f-001122334455",
    exclave: "default",
    state: "needs-input",
    at: 1_700_000_000_000,
  } as const;

  test("a remote session round-trips; a malformed one is dropped and the state kept", () => {
    const remoteSession = "session_01TuECqfR7Twko9QJm98sWAw";
    expect(parseSessionEvent({ ...event, remoteSession })).toEqual({ ...event, remoteSession });
    expect(parseSessionEvent({ ...event, remoteSession: "session_01#frag" })).toEqual(event);
    // A PR URL is the event's own fate: it would otherwise become an href unchecked.
    expect(parseSessionEvent({ ...event, prUrl: "javascript:alert(1)" })).toBeNull();
  });

  test("a question reason rides needs-input only; elsewhere, or unknown, it is dropped and the event kept", () => {
    expect(parseSessionEvent({ ...event, reason: "question" })).toEqual({ ...event, reason: "question" });
    expect(parseSessionEvent({ ...event, state: "busy", reason: "question" })).toEqual({ ...event, state: "busy" });
    expect(parseSessionEvent({ ...event, reason: "elicitation" })).toEqual(event);
    expect(parseSessionEvent({ ...event, reason: true })).toEqual(event);
  });

  test("a permission reason carries its tool only when it is a tool name; a bad tool is dropped, reason and event kept", () => {
    const permission = { ...event, reason: "permission" } as const;
    expect(parseSessionEvent(permission)).toEqual(permission);
    expect(parseSessionEvent({ ...permission, tool: "Bash" })).toEqual({ ...permission, tool: "Bash" });
    expect(parseSessionEvent({ ...permission, tool: "mcp__github__create_issue" })).toEqual({
      ...permission,
      tool: "mcp__github__create_issue",
    });
    for (const tool of ["rm -rf /", "a/b", "a=b", 'a"b', "", "t".repeat(65), 7]) {
      expect(parseSessionEvent({ ...permission, tool })).toEqual(permission);
    }
    expect(parseSessionEvent({ ...permission, tool: "t".repeat(64) })).toEqual({
      ...permission,
      tool: "t".repeat(64),
    });
    expect(TOOL_NAME_MAX_LENGTH).toBe(64);
    expect(parseSessionEvent({ ...event, reason: "question", tool: "Bash" })).toEqual({ ...event, reason: "question" });
    expect(parseSessionEvent({ ...event, tool: "Bash" })).toEqual(event);
    expect(parseSessionEvent({ ...event, state: "busy", reason: "permission", tool: "Bash" })).toEqual({
      ...event,
      state: "busy",
    });
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
      skill: "s".repeat(SKILL_NAME_MAX_LENGTH),
      requires: Array.from({ length: TASK_SPEC_LIMITS.requires }, (_, i) => `${i}`.padEnd(32, "t")),
      // The longest account id and every avoid slot at its longest id: the sentinel rides along too.
      pin: { deviceId: device, account: "ø".repeat(TASK_SPEC_LIMITS.account) },
      avoid: Array.from({ length: TASK_SPEC_LIMITS.avoid }, (_, i) => `${i}`.padEnd(ROUTING_ID_MAX_LENGTH, "A")),
      lineage: placement,
      base: placement,
      batch: { id: crypto.randomUUID(), index: 15 },
      deps: Array.from({ length: TASK_SPEC_LIMITS.deps }, () => ({
        task: crypto.randomUUID(),
        after: "merged" as const,
      })),
      linear: {
        issue: "E".repeat(TASK_SPEC_LIMITS.linearIssue),
        url: `https://linear.app/acme/issue/${"s".repeat(80)}`,
      },
      client: "ø".repeat(TASK_SPEC_LIMITS.client),
      until: "reported",
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
    inputAlerted: true,
    spillAlert: { accountId: "a".repeat(128), window: "ø".repeat(64), reset: 1_760_000_000_000, at: 1_760_000_000_000 },
    endedAt: 1_760_000_000_000,
    leftRunning: true,
  };
  const components = { accountPressure: 0.123456789, machinePressure: 0.25, dependencyDistance: 0.5, queuePressure: 3 };
  // Every candidate penalised: the worst case the eight-candidate bounds below are measured at.
  const candidate: Candidate = {
    deviceId: device,
    machine: "macbook-pro",
    exclave: "default",
    clone: "seance",
    rejected: [],
    score: { components: { ...components, keepFree: 1 }, sticky: 0, total: 1.987654321 },
    quota: { observedAt: 1_760_000_000, observer: device, source: "session" },
  };

  test("a create with every field at its bound, the prompt two bytes a character, fits the create cap", async () => {
    expect(parseTask(created)).toEqual(created);
    expect(await sealedLength(created)).toBeLessThanOrEqual(STORE_CREATE_MAX_CT_LENGTH);
  });

  test("on top of that, all the leader adds at every bound fits a record with eight candidates beside it", async () => {
    const decided: Task = {
      ...written,
      decision: { at: 1_760_000_000_000, chosen: target, candidates: Array.from({ length: 8 }, () => candidate) },
    };
    expect(parseTask(decided)).toEqual(decided);
    expect(await sealedLength(decided)).toBeLessThanOrEqual(STORE_MAX_CT_LENGTH);
    // …and a full prefix still lists in one frame, under the Workers WebSocket message limit.
    expect(MAX_TASKS * STORE_MAX_CT_LENGTH).toBeLessThan(32 * 1024 * 1024);
  });

  test("a needs-input record carrying its wait at every bound, in place of the failure, fits beside eight candidates", async () => {
    const { failure: _failure, ...unfailed } = written;
    const waiting: Task = {
      ...unfailed,
      state: "needs-input",
      inputReason: "permission",
      inputTool: "t".repeat(TOOL_NAME_MAX_LENGTH),
      decision: { at: 1_760_000_000_000, chosen: target, candidates: Array.from({ length: 8 }, () => candidate) },
    };
    expect(parseTask(waiting)).toEqual(waiting);
    expect(await sealedLength(waiting)).toBeLessThanOrEqual(STORE_MAX_CT_LENGTH);
  });

  test("a running record carrying its idle release stamp, the deviceId at its bound, fits beside eight candidates", async () => {
    const { failure: _failure, ...unfailed } = written;
    const running: Task = {
      ...unfailed,
      state: "running",
      idleRelease: { since: 1_760_000_000_000, deviceId: "d".repeat(ROUTING_ID_MAX_LENGTH) },
      decision: { at: 1_760_000_000_000, chosen: target, candidates: Array.from({ length: 8 }, () => candidate) },
    };
    expect(parseTask(running)).toEqual(running);
    expect(await sealedLength(running)).toBeLessThanOrEqual(STORE_MAX_CT_LENGTH);
  });

  test("a PR list at its bound, its primary as prUrl, costs no more than a prUrl at its own: the same record fits", async () => {
    const each = TASK_PRS_MAX_LENGTH / TASK_PRS_MAX;
    const prs = Array.from({ length: TASK_PRS_MAX }, (_, i) => ({
      url: `https://${`${i}`.padEnd(each - 17, "g")}.example/`,
      closed: true as const,
    }));
    expect(prs.reduce((sum, pr) => sum + pr.url.length, 0)).toBe(TASK_PRS_MAX_LENGTH);
    expect(2 * TASK_PRS_MAX_LENGTH).toBeLessThan(PR_URL_MAX_LENGTH);
    const decided: Task = {
      ...written,
      prUrl: prs.at(-1)?.url ?? "",
      prs,
      decision: { at: 1_760_000_000_000, chosen: target, candidates: Array.from({ length: 8 }, () => candidate) },
    };
    expect(parseTask(decided)).toEqual(decided);
    expect(await sealedLength(decided)).toBeLessThanOrEqual(STORE_MAX_CT_LENGTH);
  });

  test("an awaiting-merge task, its blocked-state reading and alert stamp at every bound, fits beside eight candidates", async () => {
    // What `advance` and `inputClock` keep for this state: no failure, reservation or needs-input clock beside a reading.
    const {
      failure: _failure,
      reservation: _reservation,
      absentSince: _absent,
      reservedAt: _reserved,
      ...kept
    } = written;
    const { needsInputSince: _since, escalated: _escalated, inputAlerted: _alerted, ...waiting } = kept;
    const each = TASK_PRS_MAX_LENGTH / TASK_PRS_MAX;
    const prs = Array.from({ length: TASK_PRS_MAX }, (_, i) => ({
      url: `https://${`${i}`.padEnd(each - 17, "g")}.example/`,
      closed: true as const,
    }));
    const head = "f".repeat(64);
    const awaiting: Task = {
      ...waiting,
      state: "awaiting-merge",
      prUrl: prs.at(-1)?.url ?? "",
      prs,
      pr: {
        state: "open",
        checks: "failing",
        head,
        required: "failing",
        failing: Array.from({ length: PR_FAILING_LIMITS.names }, (_, i) =>
          `${i}`.padEnd(PR_FAILING_LIMITS.length, "ø"),
        ),
        merge: "has_hooks",
        armed: true,
        reviewRequested: true,
        at: 1_760_000_000_000,
      },
      prAlert: { reason: "unarmed", head, at: 1_760_000_000_000 },
      continuedBy: { task: "c".repeat(64), createdAt: 1_760_000_000_000, live: true },
      decision: { at: 1_760_000_000_000, chosen: target, candidates: Array.from({ length: 8 }, () => candidate) },
    };
    expect(parseTask(awaiting)).toEqual(awaiting);
    expect(await sealedLength(awaiting)).toBeLessThanOrEqual(STORE_MAX_CT_LENGTH);
  });

  test("a task's PR list survives a parse; a malformed one is dropped and the task stands on prUrl", () => {
    const url = (n: number): string => `https://github.com/acme/app/pull/${n}`;
    const listed: Task = {
      ...created,
      state: "awaiting-merge",
      prUrl: url(5),
      prs: [{ url: url(5) }, { url: url(6), closed: true }],
    };
    expect(parseTask(listed)).toEqual(listed);
    // A lone PR read closed keeps its flag.
    const lone: Task = { ...listed, prs: [{ url: url(5), closed: true }] };
    expect(parseTask(lone)).toEqual(lone);
    const { prs: _prs, ...bare } = listed;
    const long = (n: number): string => `https://${"x".repeat(TASK_PRS_MAX_LENGTH / 2)}.example/${n}`;
    for (const prs of [
      [{ url: url(5) }, { url: url(6), closed: false }],
      [{ url: url(5) }, { url: "http://github.com/acme/app/pull/6" }],
      [{ url: url(5) }, { url: url(5) }],
      [{ url: url(6) }],
      [],
      Array.from({ length: TASK_PRS_MAX + 1 }, (_, i) => ({ url: url(i === 0 ? 5 : 100 + i) })),
      [{ url: url(5) }, { url: long(1) }, { url: long(2) }],
      { url: url(5) },
      [url(5)],
    ]) {
      expect(parseTask({ ...listed, prs })).toEqual(bare);
    }
    // Without a primary there is no list to keep.
    const { prUrl: _prUrl, ...unprimaried } = listed;
    const { prs: _gone, ...neither } = unprimaried;
    expect(parseTask(unprimaried)).toEqual(neither);
  });

  test("the alert stamps survive a parse, and a malformed one voids the task", () => {
    const stamp = { accountId: "org:acct", window: "7d", reset: 0, at: 1_760_000_000_000 };
    const stamped: Task = { ...created, state: "needs-input", inputAlerted: true, spillAlert: stamp };
    expect(parseTask(stamped)).toEqual(stamped);
    const spending: Task = { ...stamped, spillAlert: { ...stamp, spending: true } };
    expect(parseTask(spending)).toEqual(spending);
    for (const bad of [
      { ...stamped, inputAlerted: false },
      { ...stamped, spillAlert: { accountId: "org:acct", window: "7d", reset: 0 } },
      { ...stamped, spillAlert: { accountId: "org:acct", window: "7d", at: 1 } },
      { ...stamped, spillAlert: { accountId: "", window: "7d", reset: 0, at: 1 } },
      { ...stamped, spillAlert: { accountId: "org:acct", window: "7d", reset: -1, at: 1 } },
      { ...stamped, spillAlert: { accountId: "org:acct", window: "7d", reset: 0, at: -1 } },
      { ...stamped, spillAlert: "7d" },
      { ...stamped, spillAlert: { accountId: "org:acct", window: "7d", reset: 0, at: 1, spending: false } },
    ]) {
      expect(parseTask(bad)).toBeNull();
    }
  });

  describe("a full manifest", () => {
    // Every entry at its longest: a two-byte name, the longest type, a size as many digits as the largest.
    const size = ATTACHMENT_LIMITS.totalBytes / ATTACHMENT_LIMITS.files;
    expect(String(size).length).toBe(String(ATTACHMENT_LIMITS.fileBytes).length);
    const manifest = Array.from({ length: ATTACHMENT_LIMITS.files }, (_, i) =>
      attachment(i, {
        name: "ø".repeat(ATTACHMENT_LIMITS.name),
        type: `application/${"x".repeat(ATTACHMENT_LIMITS.type - "application/".length)}`,
        size,
      }),
    );
    const attached = (task: Task, prompt: number): Task => ({
      ...task,
      spec: { ...task.spec, prompt: "ø".repeat(prompt), attachments: manifest },
    });

    test("fits the create cap beside every other field at its bound, the dep sentinel included, at the lower prompt bound", async () => {
      const task = attached(created, ATTACHMENT_LIMITS.prompt);
      expect(parseTask(task)).toEqual(task);
      expect(await sealedLength(task)).toBeLessThanOrEqual(STORE_CREATE_MAX_CT_LENGTH);
      // Why the lower bound exists: at the general one the same create does not fit.
      expect(await sealedLength(attached(created, TASK_REQUEST_LIMITS.prompt))).toBeGreaterThan(
        STORE_CREATE_MAX_CT_LENGTH,
      );
    });

    test("with all the leader adds at every bound and ten candidates, a record still carrying it fits", async () => {
      // Unfinished: the write that finishes a task drops the manifest (`lean`), so no failure or end beside it.
      const { failure: _failure, endedAt: _endedAt, leftRunning: _leftRunning, ...running } = written;
      // Each penalised candidate adds about 18 bytes of `ct` against a margin of 132 here, so from about eight of
      // ten penalised the record overflows (all ten: 44 past the cap). The leader trims such a record to its
      // winner (`trimmed`); this fixture measures the unpenalised bound.
      const unpenalised: Candidate = { ...candidate, score: { components, sticky: 0, total: 1.987654321 } };
      const decided: Task = {
        ...attached({ ...running, state: "running" }, ATTACHMENT_LIMITS.prompt),
        decision: { at: 1_760_000_000_000, chosen: target, candidates: Array.from({ length: 10 }, () => unpenalised) },
      };
      expect(parseTask(decided)).toEqual(decided);
      expect(await sealedLength(decided)).toBeLessThanOrEqual(STORE_MAX_CT_LENGTH);
    });
  });

  test("a decision's candidate basis sourced `session` still parses, for records an older leader wrote; `oauth` is refused", () => {
    const decision = { at: 1_760_000_000_000, chosen: target, candidates: [candidate] };
    expect(parseDecision(decision)).toEqual(decision);
    const oauth = { ...candidate, quota: { observedAt: 1_760_000_000, observer: device, source: "oauth" } };
    expect(parseDecision({ ...decision, candidates: [oauth] })).toBeNull();
  });

  test("keys are a known prefix and a routing id; an unknown prefix is no key", () => {
    for (const rule of Object.values<StorePrefixRule>(STORE_PREFIXES))
      expect(isStoreKey(rule.key ?? `${rule.prefix}x`)).toBe(true);
    for (const bad of ["queue:x", "queue:pause2", "quota:x", "quota:"]) expect(isStoreKey(bad)).toBe(false);
    expect(isStoreKey(`task:${"a".repeat(ROUTING_ID_MAX_LENGTH)}`)).toBe(true);
    for (const bad of [
      `task:${"a".repeat(ROUTING_ID_MAX_LENGTH + 1)}`,
      "task:",
      "task:a:b",
      "task:a/b",
      "push:abc",
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

  test("a failure's exit status is kept in range and dropped outside it, never costing the failure or the task", () => {
    const failed = (failure: object) => parseTask({ ...task, state: "failed", failure })?.failure;
    const base = { code: "session_failed", message: "m" };
    expect(failed({ ...base, exit: 137 })).toEqual({ ...base, exit: 137 });
    expect(failed({ ...base, exit: EXIT_STATUS_MAX })).toEqual({ ...base, exit: EXIT_STATUS_MAX });
    // An older leader's record: no field, read as before.
    expect(failed(base)).toEqual(base);
    for (const exit of [0, EXIT_STATUS_MAX + 1, 1.5, -1, "137", null]) expect(failed({ ...base, exit })).toEqual(base);
    // Only a session_failed has one to word.
    expect(failed({ code: "merge_expired", message: "m", exit: 137 })).toEqual({ code: "merge_expired", message: "m" });
  });

  test("a failure's OOM verdict is kept only beside a SIGKILL status, and a bad one costs only the field", () => {
    const failed = (failure: object) => parseTask({ ...task, state: "failed", failure })?.failure;
    const killed = { code: "session_failed", message: "m", exit: SIGKILL_STATUS };
    expect(failed({ ...killed, oomKill: true })).toEqual({ ...killed, oomKill: true });
    expect(failed({ ...killed, oomKill: false })).toEqual({ ...killed, oomKill: false });
    for (const oomKill of ["true", 1, null]) expect(failed({ ...killed, oomKill })).toEqual(killed);
    expect(failed({ ...killed, exit: 1, oomKill: true })).toEqual({ ...killed, exit: 1 });
    // An out-of-range status is dropped, and the verdict with it.
    expect(failed({ ...killed, exit: "137", oomKill: true })).toEqual({ code: "session_failed", message: "m" });
    expect(failed({ code: "merge_expired", message: "m", exit: 137, oomKill: true })).toEqual({
      code: "merge_expired",
      message: "m",
    });
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

  test("a task that continues itself is never kept, so it never dispatches; one that continues another is", () => {
    const at = { deviceId: "dev-a", exclave: "default", clone: "app" };
    const continuing = (of: string): TaskRecord => ({
      version: 1,
      task: { ...task, spec: { repo: "github.com/acme/app", mode: "continue", continues: { task: of, at } } },
    });
    expect(bindTaskRecord(continuing("t-1"), { key, version: 1 }, now)).toBe("malformed");
    expect(bindTaskRecord(continuing("t-0"), { key, version: 1 }, now)).toEqual(continuing("t-0"));
  });
});

describe("parseTaskProgressList", () => {
  const entry = {
    taskId: "t-1",
    prUrl: "https://github.com/acme/app/pull/7",
    branch: "worktree-fix-it",
    pushed: true,
    merged: true,
    exit: 0,
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

  test("a session's report is kept", () => {
    const reported = { taskId: "t-4", reported: true, at: 4 } as const;
    expect(parseTaskProgressList([reported])).toEqual([reported]);
  });

  test("an OOM verdict rides only with a SIGKILL status, and a bad one costs the field, never the entry", () => {
    const killed = { taskId: "t-5", exit: SIGKILL_STATUS, at: 5 };
    expect(parseTaskProgressList([{ ...killed, oomKill: true }])).toEqual([{ ...killed, oomKill: true }]);
    expect(parseTaskProgressList([{ ...killed, oomKill: false }])).toEqual([{ ...killed, oomKill: false }]);
    for (const oomKill of ["yes", 1, null]) {
      expect(parseTaskProgressList([entry, { ...killed, oomKill }])).toEqual([entry, killed]);
    }
    expect(parseTaskProgressList([{ ...killed, exit: 1, oomKill: true }])).toEqual([{ ...killed, exit: 1 }]);
    expect(parseTaskProgressList([{ taskId: "t-5", oomKill: true, at: 5 }])).toEqual([{ taskId: "t-5", at: 5 }]);
  });

  test("vanished is kept when true, and an entry without it parses", () => {
    expect(parseTaskProgressList([{ taskId: "t-6", vanished: true, at: 6 }])).toEqual([
      { taskId: "t-6", vanished: true, at: 6 },
    ]);
    expect(parseTaskProgressList([{ taskId: "t-6", at: 6 }])).toEqual([{ taskId: "t-6", at: 6 }]);
  });

  test("strict: one unreadable entry, or too many, nulls the list — a dropped one would read as no PR", () => {
    for (const bad of [
      { ...entry, prUrl: "http://github.com/acme/app/pull/7" },
      { ...entry, merged: false },
      { ...entry, reported: false },
      { ...entry, reported: "yes" },
      { ...entry, vanished: false },
      { ...entry, vanished: "yes" },
      { ...entry, pushed: "yes" },
      { ...entry, branch: "" },
      { ...entry, taskId: "t:1" },
      { ...entry, at: "now" },
      { ...entry, exit: EXIT_STATUS_MAX + 1 },
      { ...entry, exit: -1 },
      { ...entry, exit: 1.5 },
    ]) {
      expect(parseTaskProgressList([entry, bad])).toBeNull();
    }
    expect(parseTaskProgressList(Array.from({ length: SESSIONS_MAX_PROGRESS + 1 }, () => entry))).toBeNull();
  });
});

describe("parseInterrupted", () => {
  test("keeps only valid task ids that are in ended", () => {
    expect(parseInterrupted(["t-1", "t-2", "t-3", 7, "bad id!", ""], ["t-1", "t-3", "t-9"])).toEqual(["t-1", "t-3"]);
  });

  test("is undefined for a non-array value or ended, a list over the cap, and an empty result", () => {
    expect(parseInterrupted("t-1", ["t-1"])).toBeUndefined();
    expect(parseInterrupted(["t-1"], undefined)).toBeUndefined();
    expect(parseInterrupted(["t-1"], "t-1")).toBeUndefined();
    const many = Array.from({ length: SESSIONS_MAX_PROGRESS + 1 }, (_, i) => `t-${i}`);
    expect(parseInterrupted(many, many)).toBeUndefined();
    expect(parseInterrupted([], ["t-1"])).toBeUndefined();
    expect(parseInterrupted(["t-2"], ["t-1"])).toBeUndefined();
  });
});

/** base64url of `bytes` bytes, padded or not. */
function b64url(bytes: number, pad = false): string {
  const text = btoa(String.fromCharCode(...new Uint8Array(bytes).fill(0xfb)))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  return pad ? text : text.replace(/=+$/u, "");
}

describe("M4 shapes", () => {
  const decide = (r: unknown) => ({
    at: 1,
    chosen: null,
    candidates: [{ deviceId: "d", machine: "mac", exclave: "default", rejected: [r] }],
  });

  test("a branch name is held to check-ref-format, and to what git would read as anything else", () => {
    for (const good of [
      "main",
      "martin/pen-1-stack",
      "v1.2",
      "a@b",
      "ø".repeat(BRANCH_MAX_LENGTH / 2),
      `${"x".repeat(BRANCH_MAX_LENGTH - 2)}ø`,
    ]) {
      expect(isBranchName(good)).toBe(true);
    }
    for (const bad of [
      "",
      "-x",
      "HEAD",
      "@",
      "a..b",
      "a@{1}",
      "a.lock",
      "a/b.lock/c",
      "a/.b",
      ".a",
      "a/",
      "/a",
      "a//b",
      "a.",
      "a b",
      "a~1",
      "a^",
      "a:b",
      "a?",
      "a*",
      "a[",
      "a\\b",
      "a\u0001",
      "a\u007F",
      "x".repeat(BRANCH_MAX_LENGTH + 1),
      // Within BRANCH_MAX_LENGTH UTF-16 units, past it in UTF-8 bytes: git limits the filename's bytes.
      "ø".repeat(BRANCH_MAX_LENGTH),
      `${"x".repeat(BRANCH_MAX_LENGTH - 1)}ø`,
      7,
      null,
    ]) {
      expect(isBranchName(bad)).toBe(false);
    }
  });

  test("a skill name is one path segment and one prompt token, bounded", () => {
    expect(isSkillName("dataviz")).toBe(true);
    expect(isSkillName("plugin:skill")).toBe(true);
    expect(isSkillName("s".repeat(SKILL_NAME_MAX_LENGTH))).toBe(true);
    for (const bad of [
      "",
      ".hidden",
      "a/b",
      "a b",
      "a\tb",
      "a\u0000",
      "a\\b",
      "a*",
      "a?",
      'a"b',
      "a<b",
      "a>b",
      "a|b",
      "a\u0085b",
      "a\u0080",
      "a\u009F",
      "a\u007F",
      "s".repeat(SKILL_NAME_MAX_LENGTH + 1),
      7,
    ]) {
      expect(isSkillName(bad)).toBe(false);
    }
  });

  test("a task declares one skill; an unreadable one nulls the request, and an old app's has none", () => {
    const minimal: TaskRequest = { repo: "github.com/acme/app", mode: "worktree" };
    expect(parseTaskRequest({ ...minimal, skill: "ship" })).toEqual({ ...minimal, skill: "ship" });
    expect(parseTaskRequest(minimal)).not.toHaveProperty("skill");
    for (const skill of ["", "a/b", "two words", 7]) expect(parseTaskRequest({ ...minimal, skill })).toBeNull();
  });

  test("a repo's skills are carried when readable; a bad list costs the field, never the entry", () => {
    expect(parseRepoEntry({ ...repo, skills: ["ship", "plan"] })).toEqual({ ...repo, skills: ["ship", "plan"] });
    expect(parseRepoEntry(repo)).toEqual(repo);
    const tooMany = Array.from({ length: REPO_MAX_SKILLS + 1 }, (_, i) => `s${i}`);
    for (const skills of [tooMany, ["ok", "a/b"], "ship", [7]]) {
      expect(parseRepoEntry({ ...repo, skills })).toEqual(repo);
    }
    expect(parseRepoEntry({ ...repo, skills: tooMany.slice(1) })?.skills).toHaveLength(REPO_MAX_SKILLS);
    const given = ["ship"];
    expect(parseRepoEntry({ ...repo, skills: given })?.skills).not.toBe(given);
  });

  test("a status names its expired exclaves by index, bounded; an old daemon's names none", () => {
    expect(parseMachineStatus({ at: 1, scan: 2, ax: [0, 3] })).toEqual({ at: 1, scan: 2, ax: [0, 3] });
    expect(parseMachineStatus({ at: 1, scan: 2 })).not.toHaveProperty("ax");
    const full = Array.from({ length: STATUS_MAX_AUTH_EXPIRED }, (_, i) => i);
    expect(parseMachineStatus({ at: 1, scan: 2, ax: full })?.ax).toEqual(full);
    for (const ax of [[...full, STATUS_MAX_AUTH_EXPIRED], [-1], [1.5], [2, 2], "0", null]) {
      expect(parseMachineStatus({ at: 1, scan: 2, ax })).toBeNull();
    }
    const given = [1];
    const sess = [2];
    const parsed = parseMachineStatus({ at: 1, scan: 2, ax: given, sess });
    expect(parsed?.ax).not.toBe(given);
    expect(parsed?.sess).not.toBe(sess);
  });

  test("a status carries expiring and unreadable exclaves beside ax: disjoint, bounded together", () => {
    const status = { at: 1, scan: 2, ax: [0], ae: [[1, 1_760_000_000]], au: [2] } as const;
    expect(parseMachineStatus(status)).toEqual(status);
    expect(parseMachineStatus({ at: 1, scan: 2 })).not.toHaveProperty("ae");
    expect(parseMachineStatus({ at: 1, scan: 2 })).not.toHaveProperty("au");
    const full = Array.from({ length: STATUS_MAX_AUTH_EXPIRED }, (_, i) => i);
    expect(parseMachineStatus({ at: 1, scan: 2, ae: full.map((i) => [i, 5]) })?.ae).toHaveLength(full.length);
    expect(parseMachineStatus({ at: 1, scan: 2, au: full })?.au).toEqual(full);
    for (const bad of [
      { ae: [[1]] },
      { ae: [[1, 2, 3]] },
      { ae: [[-1, 5]] },
      { ae: [[1.5, 5]] },
      { ae: [[1, -5]] },
      { ae: [[1, 5.5]] },
      { ae: [1, 5] },
      { ae: "x" },
      { au: [-1] },
      { au: [1.5] },
      { au: [2, 2] },
      { ax: [1], au: [1] },
      { ax: [1], ae: [[1, 5]] },
      { ae: [[1, 5]], au: [1] },
      {
        ae: [
          [1, 5],
          [1, 6],
        ],
      },
      { ax: full.slice(0, 6), ae: full.slice(6, 12).map((i) => [i, 5]), au: [...full.slice(12), 99] },
    ]) {
      expect(parseMachineStatus({ at: 1, scan: 2, ...bad })).toBeNull();
    }
    const given = [[1, 5]];
    expect(parseMachineStatus({ at: 1, scan: 2, ae: given })?.ae).not.toBe(given);
  });

  test("a status carries failing and unknown trait probes: disjoint, bounded together, absent stays absent", () => {
    const status = {
      at: 1,
      scan: 2,
      tf: [[0, 1]],
      tu: [
        [0, 0],
        [2, 3],
      ],
    } as const;
    expect(parseMachineStatus(status)).toEqual(status);
    expect(parseMachineStatus({ at: 1, scan: 2 })).not.toHaveProperty("tf");
    expect(parseMachineStatus({ at: 1, scan: 2 })).not.toHaveProperty("tu");
    const full = Array.from({ length: STATUS_MAX_TRAIT_PAIRS }, (_, i) => [i, 0]);
    expect(parseMachineStatus({ at: 1, scan: 2, tf: full })?.tf).toHaveLength(full.length);
    expect(parseMachineStatus({ at: 1, scan: 2, tf: full.slice(0, 9), tu: full.slice(9) })?.tu).toHaveLength(7);
    for (const bad of [
      { tf: [[1]] },
      { tf: [[1, 2, 3]] },
      { tf: [[-1, 0]] },
      { tf: [[0, 1.5]] },
      { tu: [[0, -1]] },
      { tf: [0, 1] },
      { tu: "x" },
      {
        tf: [
          [0, 1],
          [0, 1],
        ],
      },
      {
        tu: [
          [0, 1],
          [0, 1],
        ],
      },
      { tf: [[0, 1]], tu: [[0, 1]] },
      { tf: [...full, [99, 0]] },
      { tf: full.slice(0, 9), tu: [...full.slice(9), [99, 0]] },
    ]) {
      expect(parseMachineStatus({ at: 1, scan: 2, ...bad })).toBeNull();
    }
  });

  test("a status says its launch gate is closed only as `drn: true`; an open gate or an old daemon says nothing", () => {
    expect(parseMachineStatus({ at: 1, scan: 2, drn: true })).toEqual({ at: 1, scan: 2, drn: true });
    expect(parseMachineStatus({ at: 1, scan: 2 })).not.toHaveProperty("drn");
    for (const drn of [false, 1, "true", null]) expect(parseMachineStatus({ at: 1, scan: 2, drn })).toBeNull();
    expect(parseDecision(decide({ code: "draining" }))?.candidates[0]?.rejected).toEqual([{ code: "draining" }]);
  });

  test("a spec settles until merged or reported, absent read as merged; an edge may wait for done", () => {
    const request: TaskRequest = { repo: "github.com/acme/app", mode: "worktree" };
    const spec: TaskSpec = { ...request, until: "reported", deps: [{ task: "t-1", after: "done" }] };
    expect(parseTaskSpec(spec)).toEqual(spec);
    expect(parseTaskSpec({ ...request, until: "merged" })?.until).toBe("merged");
    expect(parseTaskSpec(request)).not.toHaveProperty("until");
    for (const bad of [
      { ...spec, until: "closed" },
      { ...spec, until: null },
      { ...spec, deps: [{ task: "t-1", after: "ended" }] },
    ]) {
      expect(parseTaskSpec(bad)).toBeNull();
    }
  });

  test("the M4 routing reasons read back; a skill reason without a readable skill drops the reason", () => {
    const reasons: readonly Reason[] = [
      { code: "auth_expired" },
      { code: "base_unpushed" },
      { code: "skill_absent", skill: "ship" },
      { code: "trait_absent", trait: "atlas" },
      { code: "trait_unhealthy", trait: "atlas" },
      { code: "continue_elsewhere" },
      { code: "continue_unsupported" },
      { code: "attachments_unsupported" },
    ];
    for (const reason of reasons) expect(parseDecision(decide(reason))?.candidates[0]?.rejected).toEqual([reason]);
    for (const skill of [undefined, "", "a/b"]) {
      expect(parseDecision(decide({ code: "skill_absent", skill }))?.candidates[0]?.rejected).toEqual([]);
    }
    for (const trait of [undefined, "", "Atlas", "a/b"]) {
      expect(parseDecision(decide({ code: "trait_absent", trait }))?.candidates[0]?.rejected).toEqual([]);
      expect(parseDecision(decide({ code: "trait_unhealthy", trait }))?.candidates[0]?.rejected).toEqual([]);
    }
  });

  test("an account record names its account and an alias, null when cleared", () => {
    const record = { version: 2, accountId: "org:acct", alias: "Work" };
    expect(parseAccountRecord(record)).toEqual(record);
    expect(parseAccountRecord({ ...record, alias: null, extra: 1 })).toEqual({ ...record, alias: null });
    expect(parseAccountRecord({ ...record, alias: "a".repeat(ACCOUNT_ALIAS_MAX_LENGTH) })).not.toBeNull();
    for (const bad of [
      { ...record, alias: "a".repeat(ACCOUNT_ALIAS_MAX_LENGTH + 1) },
      { ...record, alias: "" },
      // Only the writer trims: a record with an untrimmed or blank alias is not one it wrote.
      { ...record, alias: " Work" },
      { ...record, alias: "Work\n" },
      { ...record, alias: "   " },
      { ...record, alias: undefined },
      { ...record, version: 0 },
      { ...record, accountId: "" },
    ]) {
      expect(parseAccountRecord(bad)).toBeNull();
    }
  });

  test("the fleet quota record holds one reading per account, strict, without the exclave index", () => {
    const reading: QuotaReading = { h: 40, d: 10, s: "cache", at: 1_700_000_000 };
    const entry = { accountId: "org:acct", observer: "dev-a", reading };
    const record = { version: 1, accounts: [entry, { ...entry, accountId: "org:other" }] };
    expect(parseFleetQuotaRecord(record)).toEqual(record);
    expect(parseFleetQuotaRecord({ version: 1, accounts: [{ ...entry, reading: { ...reading, x: 3 } }] })).toEqual({
      version: 1,
      accounts: [entry],
    });
    const many = Array.from({ length: FLEET_QUOTA_MAX_ACCOUNTS + 1 }, (_, i) => ({ ...entry, accountId: `a:${i}` }));
    for (const bad of [
      { version: 1, accounts: [entry, entry] },
      { version: 1, accounts: many },
      { version: 1, accounts: [entry, { ...entry, reading: { ...reading, s: "oauth" } }] },
      { version: 1, accounts: [{ ...entry, observer: "a/b" }] },
      { version: 0, accounts: [] },
      { version: 1 },
    ]) {
      expect(parseFleetQuotaRecord(bad)).toBeNull();
    }
  });

  test("a fleet entry's scoped windows are bounded in the record, not in a status", () => {
    const reading: QuotaReading = { s: "cache", at: 1_700_000_000 };
    const entry = { accountId: "org:acct", observer: "dev-a" };
    const window = (m: string) => ({ m, p: 10 });
    const fits = Array.from({ length: FLEET_QUOTA_MAX_WINDOWS }, () =>
      window("m".repeat(FLEET_QUOTA_WINDOW_MODEL_MAX_LENGTH)),
    );
    const good = { version: 1, accounts: [{ ...entry, reading: { ...reading, w: fits } }] };
    expect(parseFleetQuotaRecord(good)).toEqual(good);
    for (const w of [[...fits, window("x")], [window("m".repeat(FLEET_QUOTA_WINDOW_MODEL_MAX_LENGTH + 1))]]) {
      expect(parseFleetQuotaRecord({ version: 1, accounts: [{ ...entry, reading: { ...reading, w } }] })).toBeNull();
      expect(parseMachineStatus({ at: 1, scan: 2, quota: [{ x: 0, ...reading, w }] })?.quota).toHaveLength(1);
    }
  });

  test("a fleet quota record with every field at its bound seals under the store's cap", async () => {
    const full: FleetQuotaRecord = {
      version: 1,
      accounts: Array.from({ length: FLEET_QUOTA_MAX_ACCOUNTS }, (_, i) => ({
        accountId: `${String(i).padStart(2, "0")}${"ø".repeat(126)}`,
        observer: "o".repeat(ROUTING_ID_MAX_LENGTH),
        reading: {
          s: "session",
          at: 1_760_000_000,
          h: 100,
          d: 100,
          hr: 1_760_000_000,
          dr: 1_760_000_000,
          c: 100,
          cu: 1_000_000,
          cl: 1_000_000,
          w: Array.from({ length: FLEET_QUOTA_MAX_WINDOWS }, () => ({
            m: "ø".repeat(FLEET_QUOTA_WINDOW_MODEL_MAX_LENGTH),
            p: 100,
            r: 1_760_000_000,
          })),
        },
      })),
    };
    expect(parseFleetQuotaRecord(full)).toEqual(full);
    expect(await sealedRecordLength("quota", full)).toBeLessThanOrEqual(STORE_MAX_CT_LENGTH);
  });

  test("a push endpoint is https on a push service's host, on its default port", () => {
    for (const good of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QGh",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect(pushEndpoint(good)).toBe(good);
    }
    expect(pushEndpoint("https://FCM.googleapis.com")).toBe("https://fcm.googleapis.com/");
    const atBound = `https://fcm.googleapis.com/${"e".repeat(PUSH_ENDPOINT_MAX_LENGTH - 27)}`;
    expect(pushEndpoint(atBound)).toBe(atBound);
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://notify.windows.com/w",
      "https://.notify.windows.com/x",
      "https://a..notify.windows.com/x",
      `https://fcm.googleapis.com/${"e".repeat(PUSH_ENDPOINT_MAX_LENGTH)}`,
      "https://evilnotify.windows.com/w",
      "https://fcm.googleapis.com.evil.example/x",
      "https://user@fcm.googleapis.com/x",
      "https://example.com/push",
      "fcm.googleapis.com/x",
      7,
    ]) {
      expect(pushEndpoint(bad)).toBeNull();
    }
  });

  test("push-subscribe carries a subscription built field by field; its reply is the endpoint, or a refusal", () => {
    const subscription: WebPushSubscription = {
      endpoint: "https://web.push.apple.com/QGh",
      keys: { p256dh: b64url(65), auth: b64url(16) },
    };
    expect(parsePushSubscribeRequest({ ...subscription, expirationTime: null })).toEqual(subscription);
    const padded = { ...subscription, keys: { p256dh: b64url(65, true), auth: b64url(16, true) } };
    expect(parsePushSubscribeRequest(padded)).toEqual(padded);
    for (const bad of [
      { ...subscription, endpoint: "https://example.com/x" },
      { ...subscription, keys: { ...subscription.keys, p256dh: b64url(64) } },
      { ...subscription, keys: { ...subscription.keys, auth: b64url(17) } },
      { ...subscription, keys: { ...subscription.keys, auth: `${b64url(16).slice(1)}+` } },
      { endpoint: subscription.endpoint },
    ]) {
      expect(parsePushSubscribeRequest(bad)).toBeNull();
    }
    expect(parsePushSubscribeReply({ endpoint: subscription.endpoint })).toEqual({ endpoint: subscription.endpoint });
    const full = { ok: false, code: "subscriptions_full", message: "full" } as const;
    expect(parsePushSubscribeReply(full)).toEqual(full);
    expect(parsePushSubscribeReply({ endpoint: "https://example.com/x" })).toBeNull();
  });

  test("push-unsubscribe carries only a fresh, normalized endpoint the allowlist accepts; its reply is the endpoint, or a refusal", () => {
    const endpoint = "https://web.push.apple.com/QGh";
    expect(parsePushUnsubscribeRequest({ endpoint })).toEqual({ endpoint });
    // Built from the endpoint alone: nothing else the sender put there rides along.
    const extra = parsePushUnsubscribeRequest({ endpoint, keys: { auth: "x" }, note: "y" });
    expect(extra).toEqual({ endpoint });
    expect(Object.keys(extra ?? {})).toEqual(["endpoint"]);
    expect(parsePushUnsubscribeRequest({ endpoint: "https://FCM.googleapis.com/fcm/send/a" })).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/a",
    });
    for (const bad of [
      { endpoint: "https://example.com/x" },
      { endpoint: "https://fcm.googleapis.com:8443/x" },
      { endpoint: `https://fcm.googleapis.com/${"e".repeat(PUSH_ENDPOINT_MAX_LENGTH)}` },
      { endpoint: 7 },
      {},
      endpoint,
      null,
    ]) {
      expect(parsePushUnsubscribeRequest(bad)).toBeNull();
    }
    expect(parsePushUnsubscribeReply({ endpoint })).toEqual({ endpoint });
    const conflict = { ok: false, code: "conflict", message: "again" } as const;
    expect(parsePushUnsubscribeReply(conflict)).toEqual(conflict);
    expect(parsePushUnsubscribeReply({ endpoint: "https://example.com/x" })).toBeNull();
  });

  test("the settings record is strict: a part dropped on read would be lost on the next write", () => {
    const subscription: WebPushSubscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: b64url(65), auth: b64url(16) },
    };
    const settings: SettingsRecord = {
      version: 4,
      vapid: { publicKey: b64url(65), privateKey: b64url(32) },
      linearKey: "k".repeat(LINEAR_KEY_MAX_LENGTH),
      subscriptions: [{ ...subscription, label: "Firefox · Linux", addedAt: 1_760_000_000_000 }],
      diskAlerts: [{ deviceId: "dev-1", at: 1_760_000_000_000 }],
      authAlerts: [
        { deviceId: "dev-1", exclave: "default", state: "expired", at: 1_760_000_000_000 },
        { deviceId: "dev-1", exclave: "work", state: "expiring", at: 1_760_000_000_001 },
      ],
      archivistSilence: { state: "alerted", since: 1_760_000_000_002 },
    };
    expect(parseSettingsRecord(settings)).toEqual(settings);
    for (const archivistSilence of [{ state: "present" }, { state: "absent", since: 1 }] as const) {
      expect(parseSettingsRecord({ ...settings, archivistSilence })).toEqual({ ...settings, archivistSilence });
    }
    expect(parseSettingsRecord({ version: 1 })).toEqual({ version: 1 });
    const many = Array.from({ length: PUSH_MAX_SUBSCRIPTIONS + 1 }, (_, i) => ({
      ...subscription,
      endpoint: `${subscription.endpoint}${i}`,
    }));
    expect(parseSettingsRecord({ version: 1, subscriptions: many.slice(1) })?.subscriptions).toHaveLength(
      PUSH_MAX_SUBSCRIPTIONS,
    );
    for (const bad of [
      { ...settings, vapid: { publicKey: b64url(65), privateKey: b64url(31) } },
      { ...settings, linearKey: "k".repeat(LINEAR_KEY_MAX_LENGTH + 1) },
      { ...settings, linearKey: "" },
      { ...settings, subscriptions: many },
      { ...settings, vapid: { publicKey: b64url(65, true), privateKey: b64url(32) } },
      { ...settings, vapid: { publicKey: b64url(65), privateKey: b64url(32, true) } },
      { ...settings, subscriptions: [subscription, { ...subscription }] },
      { ...settings, version: 0 },
      {
        ...settings,
        diskAlerts: [
          { deviceId: "dev-1", at: 1 },
          { deviceId: "dev-1", at: 2 },
        ],
      },
      { ...settings, authAlerts: [{ deviceId: "dev-1", exclave: "x", state: "ok", at: 1 }] },
      { ...settings, authAlerts: [{ deviceId: "dev-1", exclave: "x/y", state: "expired", at: 1 }] },
      { ...settings, authAlerts: [{ deviceId: "dev-1", exclave: "x", state: "expired" }] },
      {
        ...settings,
        authAlerts: [
          { deviceId: "dev-1", exclave: "x", state: "expired", at: 1 },
          { deviceId: "dev-1", exclave: "x", state: "expiring", at: 2 },
        ],
      },
      {
        ...settings,
        authAlerts: Array.from({ length: AUTH_ALERTS_MAX + 1 }, (_, i) => ({
          deviceId: "dev-1",
          exclave: `x${i}`,
          state: "expired",
          at: 1,
        })),
      },
      { ...settings, archivistSilence: { state: "absent" } },
      { ...settings, archivistSilence: { state: "alerted", since: "1" } },
      { ...settings, archivistSilence: { state: "gone", since: 1 } },
      { ...settings, archivistSilence: "present" },
      { ...settings, archivistSilence: { state: "present", since: 1 } },
      { ...settings, archivistSilence: { state: "absent", since: 1, extra: true } },
      { ...settings, archivistSilence: { state: "absent", since: -1 } },
      { ...settings, archivistSilence: { state: "absent", since: 1.5 } },
      { ...settings, archivistSilence: { state: "alerted", since: 8.64e15 + 1 } },
      { ...settings, diskAlerts: [{ deviceId: "dev/1", at: 1 }] },
      { ...settings, diskAlerts: [{ deviceId: "dev-1" }] },
      {
        ...settings,
        diskAlerts: Array.from({ length: DISK_ALERTS_MAX + 1 }, (_, i) => ({ deviceId: `dev-${i}`, at: 1 })),
      },
    ]) {
      expect(parseSettingsRecord(bad)).toBeNull();
    }
  });

  test("a bad label or date drops that field, never the subscription", () => {
    const subscription: WebPushSubscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: b64url(65), auth: b64url(16) },
    };
    const other = { ...subscription, endpoint: `${subscription.endpoint}2`, label: "Chrome · Windows", addedAt: 5 };
    const vapid = { publicKey: b64url(65), privateKey: b64url(32) };
    const read = (entry: object) =>
      parseSettingsRecord({ version: 1, vapid, subscriptions: [{ ...subscription, ...entry }, other] })?.subscriptions;
    for (const label of ["", " Chrome", "x".repeat(PUSH_LABEL_MAX_LENGTH + 1), 7]) {
      expect(read({ label, addedAt: 9 })).toEqual([{ ...subscription, addedAt: 9 }, other]);
    }
    for (const addedAt of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(read({ label: "Safari · iOS", addedAt })).toEqual([{ ...subscription, label: "Safari · iOS" }, other]);
    }
    expect(read({})).toEqual([subscription, other]);
  });

  test("a push-subscribe label is kept when good and refuses the request when bad; addedAt is never taken", () => {
    const subscription: WebPushSubscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: b64url(65), auth: b64url(16) },
    };
    expect(parsePushSubscribeRequest({ ...subscription, label: "Firefox · Linux" })).toEqual({
      ...subscription,
      label: "Firefox · Linux",
    });
    const plain = parsePushSubscribeRequest(subscription);
    expect(plain).toEqual(subscription);
    expect(Object.keys(plain ?? {})).not.toContain("label");
    expect(parsePushSubscribeRequest({ ...subscription, addedAt: 5 })).toEqual(subscription);
    expect(parsePushSubscribeRequest({ ...subscription, label: "x".repeat(PUSH_LABEL_MAX_LENGTH) })).not.toBeNull();
    for (const label of [
      "",
      " Chrome",
      "Chrome ",
      "x".repeat(PUSH_LABEL_MAX_LENGTH + 1),
      7,
      null,
      "a\u0001b",
      "a\u0085b",
      "a\uD800b",
      "a\u202Eb",
      "a\u200Bb",
      "a\uFEFFb",
    ]) {
      expect(parsePushSubscribeRequest({ ...subscription, label })).toBeNull();
    }
    // The record reads a bad label leniently: the subscription stays, the label goes.
    const vapid = { publicKey: b64url(65), privateKey: b64url(32) };
    for (const label of ["a\u0001b", "a\u0085b", "a\uD800b", "a\u202Eb", "a\u200Bb", "a\uFEFFb"]) {
      const read = parseSettingsRecord({ version: 1, vapid, subscriptions: [{ ...subscription, label }] });
      expect(read?.subscriptions).toEqual([subscription]);
    }
  });

  test("a push endpoint's vendor is its push service's browser family", () => {
    expect(pushServiceVendor("https://fcm.googleapis.com/fcm/send/a")).toBe("Chrome/Android");
    expect(pushServiceVendor("https://updates.push.services.mozilla.com/wpush/v2/a")).toBe("Firefox");
    expect(pushServiceVendor("https://web.push.apple.com/QGh")).toBe("Safari");
    expect(pushServiceVendor("https://wns2-par02p.notify.windows.com/w")).toBe("Edge");
    expect(pushServiceVendor("https://notify.windows.com/w")).toBeNull();
    expect(pushServiceVendor("https://example.com/x")).toBeNull();
  });

  test("a subscription the parser no longer accepts is dropped, and the rest of the record reads", () => {
    const subscription: WebPushSubscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: b64url(65), auth: b64url(16) },
    };
    const vapid = { publicKey: b64url(65), privateKey: b64url(32) };
    const offList = { ...subscription, endpoint: "https://push.example.com/x" };
    const dropped = [offList, { ...subscription, keys: { ...subscription.keys, auth: b64url(17) } }, "junk", null];
    const read = parseSettingsRecord({
      version: 2,
      vapid,
      linearKey: "k",
      subscriptions: [offList, subscription, ...dropped.slice(1)],
    });
    expect(read).toEqual({ version: 2, vapid, linearKey: "k", subscriptions: [subscription] });
    expect(parseSettingsRecord({ version: 2, vapid, subscriptions: dropped })?.subscriptions).toEqual([]);
    // The cap counts what is stored, so a record of dropped entries past it is still refused.
    const past = Array.from({ length: PUSH_MAX_SUBSCRIPTIONS + 1 }, () => offList);
    expect(parseSettingsRecord({ version: 2, vapid, subscriptions: past })).toBeNull();
    // A subscription that parses but repeats an endpoint is not a host problem and still refuses.
    expect(parseSettingsRecord({ version: 2, vapid, subscriptions: [subscription, { ...subscription }] })).toBeNull();
  });

  test("a settings record with every field at its bound seals under the store's cap", async () => {
    const full: SettingsRecord = {
      version: 1,
      vapid: { publicKey: b64url(65), privateKey: b64url(32) },
      // The costliest character `linearKey` admits, as for a label: three bytes once JSON-encoded.
      linearKey: "€".repeat(LINEAR_KEY_MAX_LENGTH),
      subscriptions: Array.from({ length: PUSH_MAX_SUBSCRIPTIONS }, (_, i) => ({
        endpoint: `https://fcm.googleapis.com/${"e".repeat(PUSH_ENDPOINT_MAX_LENGTH - 29)}${String(i).padStart(2, "0")}`,
        keys: { p256dh: b64url(65, true), auth: b64url(16, true) },
        // The costliest character a label admits once JSON-encoded and UTF-8'd: three bytes.
        label: "€".repeat(PUSH_LABEL_MAX_LENGTH),
        addedAt: Number.MAX_SAFE_INTEGER,
      })),
      diskAlerts: Array.from({ length: DISK_ALERTS_MAX }, (_, i) => ({
        deviceId: `${"d".repeat(ROUTING_ID_MAX_LENGTH - 2)}${String(i).padStart(2, "0")}`,
        at: 1_760_000_000_000,
      })),
      authAlerts: Array.from({ length: AUTH_ALERTS_MAX }, (_, i) => ({
        deviceId: "d".repeat(ROUTING_ID_MAX_LENGTH),
        exclave: `${"x".repeat(ROUTING_ID_MAX_LENGTH - 2)}${String(i).padStart(2, "0")}`,
        state: "expiring" as const,
        at: 1_760_000_000_000,
      })),
      archivistSilence: { state: "alerted", since: 8.64e15 },
    };
    expect(parseSettingsRecord(full)).toEqual(full);
    expect(await sealedRecordLength("settings", full)).toBeLessThanOrEqual(STORE_MAX_CT_LENGTH);
  });

  test("a linearKey with a control, format or lone-surrogate character is refused, as a label is", () => {
    const base = { version: 1, vapid: { publicKey: b64url(65), privateKey: b64url(32) } };
    for (const linearKey of ["a\u0001b", "a\u200Bb", "a\uD800b", "a\uDC00b", "\u202Eabc"]) {
      expect(parseSettingsRecord({ ...base, linearKey })).toBeNull();
    }
    expect(parseSettingsRecord({ ...base, linearKey: "lin_api_key" })).not.toBeNull();
  });
});

describe("parsePushAlert", () => {
  const spill = { v: 1, kind: "spill", at: 5, taskId: "t-1", window: "7d", projectedPct: 91 } as const;
  const input = { v: 1, kind: "needs-input", at: 5, taskId: "t-1", since: 3, escalated: true } as const;
  const disk = { v: 1, kind: "disk", at: 5, deviceId: "dev-1", diskPct: 93, freeMib: 400 } as const;

  test("accepts each kind as built, with a disk alert's readings optional", () => {
    const bare = { v: 1, kind: "disk", at: 5, deviceId: "dev-1" } as const;
    const spending = { ...spill, spending: true } as const;
    const question = { ...input, escalated: false, question: true } as const;
    const auth = { v: 1, kind: "auth", at: 5, deviceId: "dev-1", exclave: "default", state: "expired" } as const;
    const expiring = { ...auth, state: "expiring" } as const;
    const archivist = { v: 1, kind: "archivist", at: 5, since: 3 } as const;
    for (const alert of [spill, spending, input, question, disk, bare, auth, expiring, archivist]) {
      expect(parsePushAlert(alert)).toEqual(alert);
    }
  });

  test("accepts a pr-blocked alert and refuses an unknown reason, a key it does not name and a bad id", () => {
    const blocked = { v: 1, kind: "pr-blocked", at: 5, taskId: "t-1", reason: "unarmed" } as const;
    for (const reason of ["checks", "conflict", "behind", "unarmed"] as const) {
      expect(parsePushAlert({ ...blocked, reason })).toEqual({ ...blocked, reason });
    }
    for (const bad of [
      { ...blocked, reason: "slow" },
      { ...blocked, reason: undefined },
      { ...blocked, head: "0".repeat(40) },
      { ...blocked, prUrl: "https://github.com/a/b/pull/1" },
      { ...blocked, taskId: "../x" },
    ]) {
      expect(parsePushAlert(bad)).toBeNull();
    }
  });

  test("accepts quota-exhausted and pass-refused, and refuses an unknown reason, a key it does not name and a bad id", () => {
    const quota = { v: 1, kind: "quota-exhausted", at: 5, taskId: "t-1", window: "5h" } as const;
    for (const alert of [
      quota,
      { ...quota, reason: "dirty" as const },
      { ...quota, reason: "branch" as const },
      { ...quota, window: "7d sonnet" },
    ]) {
      expect(parsePushAlert(alert)).toEqual(alert);
    }
    const refused = { v: 1, kind: "pass-refused", at: 5, taskId: "t-1" } as const;
    expect(parsePushAlert(refused)).toEqual(refused);
    for (const bad of [
      { ...quota, reason: "slow" },
      { ...quota, window: "" },
      { ...quota, window: "w".repeat(65) },
      { ...quota, taskId: "../x" },
      { ...quota, accountId: "org:a" },
      { ...quota, projectedPct: 91 },
      { ...refused, taskId: "../x" },
      { ...refused, code: "push_failed" },
      { ...refused, window: "5h" },
    ]) {
      expect(parsePushAlert(bad)).toBeNull();
    }
  });

  test("refuses an unknown kind or version, a key it does not name, a bad id and non-finite numbers", () => {
    for (const bad of [
      { ...spill, kind: "minted-later" },
      { ...spill, v: 2 },
      { ...spill, title: "free text" },
      { ...input, prompt: "free text" },
      { ...disk, accountId: "acc" },
      { ...spill, taskId: "../x" },
      { ...input, escalated: "yes" },
      { ...spill, projectedPct: Number.NaN },
      { ...spill, spending: false },
      { ...input, question: false },
      { ...disk, deviceId: "a/b" },
      { ...disk, freeMib: "400" },
      { v: 1, kind: "auth", at: 5, deviceId: "dev-1", exclave: "default", state: "ok" },
      { v: 1, kind: "auth", at: 5, deviceId: "dev-1", exclave: "default", state: "expired", account: "a" },
      { v: 1, kind: "auth", at: 5, deviceId: "dev-1", exclave: "a/b", state: "expired" },
      { v: 1, kind: "auth", at: 5, deviceId: "dev-1", state: "expired" },
      { v: 1, kind: "archivist", at: 5 },
      { v: 1, kind: "archivist", at: 5, since: "3" },
      { v: 1, kind: "archivist", at: 5, since: 3, deviceId: "arch" },
      { v: 1, kind: "archivist", at: 5, since: 3, name: "free text" },
      null,
      "spill",
    ]) {
      expect(parsePushAlert(bad)).toBeNull();
    }
  });

  test("refuses a payload past the byte bound", () => {
    expect(parsePushAlert({ ...spill, window: "w".repeat(PUSH_ALERT_MAX_BYTES) })).toBeNull();
  });
});

describe("parseAmendRequest", () => {
  const basis = "a".repeat(64);
  const append = { taskId: "t-1", prompt: { mode: "append", text: "also" }, basis } as const;

  test("takes a prompt with its basis, and title, model and effort, each alone or together", () => {
    expect(parseAmendRequest(append)).toEqual(append);
    expect(parseAmendRequest({ ...append, prompt: { mode: "replace", text: "" } })).toEqual({
      ...append,
      prompt: { mode: "replace", text: "" },
    });
    expect(parseAmendRequest({ taskId: "t-1", title: "" })).toEqual({ taskId: "t-1", title: "" });
    expect(parseAmendRequest({ taskId: "t-1", title: null, model: null, effort: "high" })).toEqual({
      taskId: "t-1",
      title: null,
      model: null,
      effort: "high",
    });
  });

  test("is built afresh", () => {
    const parsed = parseAmendRequest({ ...append });
    expect(parsed).toEqual(append);
    expect(parsed?.prompt).not.toBe(append.prompt);
  });

  test("refuses a key it does not know, at the top or in the prompt, so a newer field never half-applies", () => {
    expect(parseAmendRequest({ ...append, deps: [] })).toBeNull();
    expect(parseAmendRequest({ ...append, state: "running" })).toBeNull();
    expect(parseAmendRequest({ ...append, prompt: { ...append.prompt, extra: 1 } })).toBeNull();
  });

  test("refuses a missing or malformed task id", () => {
    expect(parseAmendRequest({ title: "x" })).toBeNull();
    expect(parseAmendRequest({ taskId: "", title: "x" })).toBeNull();
    expect(parseAmendRequest({ taskId: 7, title: "x" })).toBeNull();
    expect(parseAmendRequest(null)).toBeNull();
    expect(parseAmendRequest("t-1")).toBeNull();
  });

  test("refuses a basis without a prompt, a prompt without one, and a malformed basis", () => {
    expect(parseAmendRequest({ taskId: "t-1", title: "x", basis })).toBeNull();
    expect(parseAmendRequest({ taskId: "t-1", prompt: append.prompt })).toBeNull();
    expect(parseAmendRequest({ ...append, basis: "A".repeat(64) })).toBeNull();
    expect(parseAmendRequest({ ...append, basis: "a".repeat(63) })).toBeNull();
  });

  test("refuses an unknown mode, a non-string text, an oversized one and an append of only whitespace", () => {
    expect(parseAmendRequest({ ...append, prompt: { mode: "prepend", text: "x" } })).toBeNull();
    expect(parseAmendRequest({ ...append, prompt: { mode: "append", text: 3 } })).toBeNull();
    expect(parseAmendRequest({ ...append, prompt: "also" })).toBeNull();
    const max = TASK_REQUEST_LIMITS.prompt;
    expect(parseAmendRequest({ ...append, prompt: { mode: "replace", text: "x".repeat(max) } })).not.toBeNull();
    expect(parseAmendRequest({ ...append, prompt: { mode: "replace", text: "x".repeat(max + 1) } })).toBeNull();
    expect(parseAmendRequest({ ...append, prompt: { mode: "append", text: " \n\t" } })).toBeNull();
    expect(parseAmendRequest({ ...append, prompt: { mode: "append", text: "" } })).toBeNull();
  });

  test("refuses an empty model or effort, an oversized field and a wrong type", () => {
    expect(parseAmendRequest({ taskId: "t-1", model: "" })).toBeNull();
    expect(parseAmendRequest({ taskId: "t-1", effort: "" })).toBeNull();
    expect(parseAmendRequest({ taskId: "t-1", model: "m".repeat(TASK_REQUEST_LIMITS.model + 1) })).toBeNull();
    expect(parseAmendRequest({ taskId: "t-1", title: "t".repeat(TASK_REQUEST_LIMITS.title + 1) })).toBeNull();
    expect(parseAmendRequest({ taskId: "t-1", title: 5 })).toBeNull();
    // One bad field spoils the rest.
    expect(parseAmendRequest({ ...append, effort: "" })).toBeNull();
  });

  test("refuses an amendment of nothing", () => {
    expect(parseAmendRequest({ taskId: "t-1" })).toBeNull();
    expect(parseAmendRequest({ taskId: "t-1", other: "x" })).toBeNull();
  });
});

describe("archive-status", () => {
  const good = {
    ok: true,
    onlineSince: 5,
    lastIngest: { store: 1, registry: null, status: 3, pull: 4 },
    tasks: { rows: 2, oldest: 10 },
    samples: { rows: 0, oldest: null },
    events: null,
    database: { archiveBytes: 100, metricsBytes: 200 },
    countedAt: 9,
  } as const;

  test("a good reply parses, including a table still unread", () => {
    expect(parseArchiveStatusReply(good)).toEqual(good);
  });

  test("each error code parses, an unknown one is unreadable", () => {
    for (const code of ARCHIVE_STATUS_ERROR_CODES) {
      expect(parseArchiveStatusReply({ ok: false, code, message: "m" })).toEqual({ ok: false, code, message: "m" });
    }
    expect(parseArchiveStatusReply({ ok: false, code: "nope", message: "m" })).toBeNull();
    expect(parseArchiveStatusReply(null)).toBeNull();
  });

  test("a missing source counts as null and an extra one is ignored", () => {
    const parsed = parseArchiveStatusReply({ ...good, lastIngest: { store: 1, later: 7 } });
    expect(parsed).toEqual({ ...good, lastIngest: { store: 1, registry: null, status: null, pull: null } });
  });

  test("a negative row count, a bad size or a non-record is unreadable", () => {
    expect(parseArchiveStatusReply({ ...good, tasks: { rows: -1, oldest: null } })).toBeNull();
    expect(parseArchiveStatusReply({ ...good, database: { archiveBytes: -1, metricsBytes: 0 } })).toBeNull();
    expect(parseArchiveStatusReply({ ...good, lastIngest: "x" })).toBeNull();
  });

  test("the request is any record", () => {
    expect(parseArchiveStatusRequest({ later: 1 })).toEqual({});
    expect(parseArchiveStatusRequest([])).toBeNull();
    expect(parseArchiveStatusRequest(null)).toBeNull();
  });

  test("the archivist's blob keeps the card when its source is bad, and refuses archivist: false", () => {
    const source = { sha: "a".repeat(40), commitTs: 1_700_000_000_000, branch: null };
    const base = { archivist: true, name: "n", platform: "linux" } as const;
    expect(parseArchivistInfo(base)).toEqual(base);
    expect(parseArchivistInfo({ ...base, source })).toEqual({ ...base, source });
    expect(parseArchivistInfo({ ...base, source: { sha: "x" } })).toEqual(base);
    expect(parseArchivistInfo({ ...base, archivist: false })).toBeNull();
  });
});

describe("archive-metrics", () => {
  const account = `${STORE_PREFIXES.account.prefix}${"ab".repeat(32)}`;
  const day = 86_400;

  test("a machine or an account target parses into a fresh value; never both, never neither", () => {
    const names = ["quota_5h_pct"];
    const labels = { exclave: "default" };
    const request = { from: 0, to: 3600, step: 300, names, labels, machine: "dev-1", later: 1 };
    const parsed = parseArchiveMetricsRequest(request);
    expect(parsed).toEqual({ from: 0, to: 3600, step: 300, names, labels, machine: "dev-1" });
    expect(parsed !== null && "names" in parsed ? parsed.names : null).not.toBe(names);
    expect(parseArchiveMetricsRequest({ from: 0, to: 60, step: 30, account })).toEqual({
      from: 0,
      to: 60,
      step: 30,
      account,
    });
    expect(parseArchiveMetricsRequest({ from: 0, to: 60, step: 30, machine: "dev-1", account })).toBeNull();
    expect(parseArchiveMetricsRequest({ from: 0, to: 60, step: 30 })).toBeNull();
  });

  test("an account is its store key, never a raw id or another prefix's key", () => {
    expect(parseArchiveMetricsRequest({ from: 0, to: 60, step: 30, account: "org:acct" })).toBeNull();
    expect(parseArchiveMetricsRequest({ from: 0, to: 60, step: 30, account: "task:abc" })).toBeNull();
    expect(parseArchiveMetricsRequest({ from: 0, to: 60, step: 30, machine: "has space" })).toBeNull();
  });

  test("a year fits at a day and 90 days at 6 h; the points cap holds at every step", () => {
    expect(parseArchiveMetricsRequest({ from: 0, to: 365 * day, step: day, machine: "m" })).not.toBeNull();
    expect(parseArchiveMetricsRequest({ from: 0, to: 90 * day, step: 21_600, machine: "m" })).not.toBeNull();
    expect(parseArchiveMetricsRequest({ from: 0, to: METRICS_MAX_POINTS * day, step: day, machine: "m" })).toBeNull();
    expect(parseArchiveMetricsRequest({ from: 0, to: 90 * day, step: 3600, machine: "m" })).toBeNull();
    expect(parseArchiveMetricsRequest({ from: 0, to: 60, step: 60, machine: "m" })).toBeNull();
    expect(parseArchiveMetricsRequest({ from: 10, to: 0, step: 30, machine: "m" })).toBeNull();
  });

  test("names and labels keep the metrics op's bounds", () => {
    const base = { from: 0, to: 60, step: 30, machine: "m" };
    expect(parseArchiveMetricsRequest({ ...base, names: [] })).toBeNull();
    expect(parseArchiveMetricsRequest({ ...base, names: Array.from({ length: 9 }, (_, i) => `n${i}`) })).toBeNull();
    expect(parseArchiveMetricsRequest({ ...base, labels: { a: 1 } })).toBeNull();
    expect(
      parseArchiveMetricsRequest({ ...base, labels: { a: "x".repeat(METRICS_MAX_FILTER_LENGTH + 1) } }),
    ).toBeNull();
  });
});

describe("archive-tasks", () => {
  const account = `${STORE_PREFIXES.account.prefix}${"cd".repeat(32)}`;
  const cursor = { endedAt: 2_000, createdAt: 1_000, id: "t-1" };

  test("every filter parses into a fresh value, unknown keys dropped", () => {
    const request = {
      limit: 20,
      before: cursor,
      repo: "seance",
      outcome: "failed" as const,
      machine: "dev-1",
      account,
      since: 1,
      until: 5,
      title: "50%_off",
      later: true,
    };
    const { later: _later, ...expected } = request;
    const parsed = parseArchiveTasksRequest(request);
    expect(parsed).toEqual(expected);
    expect(parsed?.before).not.toBe(cursor);
    expect(parseArchiveTasksRequest({})).toEqual({});
    expect(parseArchiveTasksRequest(null)).toBeNull();
  });

  test("each bound refuses the whole request", () => {
    for (const bad of [
      { limit: 0 },
      { limit: ARCHIVE_TASKS_MAX_PAGE + 1 },
      { limit: 1.5 },
      { before: { ...cursor, id: "" } },
      { before: { ...cursor, endedAt: -1 } },
      { outcome: "running" },
      { repo: "" },
      { repo: "r".repeat(513) },
      { machine: "has space" },
      { account: "org:acct" },
      { since: -1 },
      { until: "soon" },
      { title: "" },
      { title: "t".repeat(201) },
    ]) {
      expect(parseArchiveTasksRequest(bad)).toBeNull();
    }
  });

  test("a reply keeps the rows it can read and drops the rest; a bad cursor or total is unreadable", () => {
    const task = { id: "t-1", spec: { repo: "seance", mode: "worktree" }, state: "done", createdAt: 1_000 } as const;
    const row = { task, endedAt: 2_000, machine: "dev", account, alias: null };
    const reply = { ok: true, tasks: [row, { ...row, task: { ...task, state: "later" } }], total: 2, next: cursor };
    expect(parseArchiveTasksReply(reply)).toEqual({ ok: true, tasks: [row], total: 2, next: cursor });
    expect(parseArchiveTasksReply({ ...reply, next: null })?.ok).toBe(true);
    expect(parseArchiveTasksReply({ ...reply, next: { id: "t-1" } })).toBeNull();
    expect(parseArchiveTasksReply({ ...reply, total: -1 })).toBeNull();
    expect(parseArchiveTasksReply({ ...reply, ok: undefined })).toBeNull();
  });

  test("machines stay absent from an older archivist, drop a bad entry, and refuse the reply when not a bounded list", () => {
    const reply = { ok: true, tasks: [], total: 0, next: null } as const;
    expect(parseArchiveTasksReply(reply)).toEqual(reply);
    const gone = { deviceId: "dev-gone", name: "old-box", lastSeen: 2_000 };
    const unnamed = { deviceId: "dev-x", name: null, lastSeen: 1_000 };
    expect(
      parseArchiveTasksReply({
        ...reply,
        machines: [gone, unnamed, { ...gone, deviceId: "has space" }, { ...gone, lastSeen: -1 }, { ...gone, name: 1 }],
      }),
    ).toEqual({ ...reply, machines: [gone, unnamed] });
    expect(parseArchiveTasksReply({ ...reply, machines: {} })).toBeNull();
    expect(
      parseArchiveTasksReply({ ...reply, machines: Array.from({ length: ARCHIVE_MACHINES_MAX + 1 }, () => gone) }),
    ).toBeNull();
  });

  test("each error code parses, an unknown one is unreadable", () => {
    for (const code of ARCHIVE_TASKS_ERROR_CODES) {
      expect(parseArchiveTasksReply({ ok: false, code, message: "m" })).toEqual({ ok: false, code, message: "m" });
    }
    expect(parseArchiveTasksReply({ ok: false, code: "nope", message: "m" })).toBeNull();
  });
});
