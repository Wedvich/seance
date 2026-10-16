import { describe, expect, test } from "bun:test";
import {
  isMetricsRequest,
  parseExclaveList,
  parseMachineInfo,
  parseMachineStatus,
  parseMetricsReply,
  parseMetricsResponse,
  parseRepoEntry,
} from "./parse.ts";
import {
  METRICS_MAX_FILTER_LENGTH,
  METRICS_MAX_FILTERS,
  METRICS_MAX_POINTS,
  type MachineStatus,
  type MetricsSeries,
  type QuotaObservation,
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

  test("one unreadable exclave invalidates the list — status indexes into it", () => {
    expect(parseExclaveList([exclave, { ...exclave, id: "" }])).toBeNull();
    expect(parseExclaveList([exclave, { ...exclave, skills: "dataviz" }])).toBeNull();
    expect(parseExclaveList([exclave, { ...exclave, authOk: "yes" }])).toBeNull();
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
