import { describe, expect, test } from "bun:test";
import { parseCodexVersion, versionAtLeast } from "@seance/shared";
import {
  codexAccountId,
  creditView,
  parseAccountRead,
  parseRateLimits,
  probeResultOf,
  quotaReadingOf,
  type RpcAnswer,
} from "./probe.ts";

const window = (usedPercent: number, windowDurationMins: number | null, resetsAt: number | null = 1_760_000_000) => ({
  usedPercent,
  windowDurationMins,
  resetsAt,
});

/** A Business login's answer as 0.170.0 gave it in S6, plus the fields its schema lacks. */
const RATE_LIMITS = {
  ordinaryUsageAllowed: true,
  accountId: "acct-1",
  rateLimits: {
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary: window(3, 300, 1_760_010_000),
    secondary: window(41.6, 10_080, 1_760_500_000),
    credits: { hasCredits: false, unlimited: false, balance: null },
    individualLimit: null,
    spendControlReached: null,
    planType: "team",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
  rateLimitUpsell: null,
  workspaceRouting: { anything: true },
};

const ACCOUNT = {
  account: { type: "chatgpt", email: "a@example.com", planType: "team", workspaceName: "Acme" },
  userId: "user-1",
  requiresOpenaiAuth: true,
};

const result = (value: unknown): RpcAnswer => ({ kind: "result", value });

describe("the version floor", () => {
  test("reads the version out of `codex --version` and holds it to 0.170.0 in semver order", () => {
    expect(parseCodexVersion("codex-cli 0.170.0\n")).toBe("0.170.0");
    expect(parseCodexVersion("codex-cli 0.171.0-alpha.2")).toBe("0.171.0-alpha.2");
    expect(parseCodexVersion("no version here")).toBeNull();
    expect(versionAtLeast("0.170.0")).toBe(true);
    expect(versionAtLeast("0.170.1")).toBe(true);
    expect(versionAtLeast("1.0.0")).toBe(true);
    expect(versionAtLeast("0.166.0")).toBe(false);
    expect(versionAtLeast("0.99.9")).toBe(false);
    // A prerelease of the floor comes before it.
    expect(versionAtLeast("0.170.0-alpha.1")).toBe(false);
    expect(versionAtLeast("0.171.0-alpha.1")).toBe(true);
  });
});

describe("the answers' parsers", () => {
  test("keep what they need and ignore any field they do not know", () => {
    expect(parseAccountRead(ACCOUNT)).toEqual({
      userId: "user-1",
      email: "a@example.com",
      plan: "team",
      workspace: "Acme",
    });
    const limits = parseRateLimits(RATE_LIMITS);
    expect(limits?.accountId).toBe("acct-1");
    expect(limits?.ordinaryUsageAllowed).toBe(true);
  });

  test("refuse an answer missing a field they keep; display fields that cannot be shown are dropped, not fatal", () => {
    expect(parseAccountRead({ account: null })).toBeNull();
    expect(parseAccountRead({ userId: 7, account: null })).toBeNull();
    expect(parseAccountRead({ userId: null, account: "x" })).toBeNull();
    // An API-key login has no display fields; the user half is still read.
    expect(parseAccountRead({ userId: "u", account: { type: "apiKey" } })).toEqual({ userId: "u" });
    expect(
      parseAccountRead({ userId: "u", account: { type: "chatgpt", email: "a‮b", planType: "", workspaceName: null } }),
    ).toEqual({ userId: "u" });
    for (const bad of [
      { ...RATE_LIMITS, accountId: 1 },
      { ...RATE_LIMITS, ordinaryUsageAllowed: "no" },
      { ...RATE_LIMITS, rateLimits: null },
      { ...RATE_LIMITS, rateLimits: { ...RATE_LIMITS.rateLimits, primary: { usedPercent: "3" } } },
      { ...RATE_LIMITS, rateLimits: { ...RATE_LIMITS.rateLimits, credits: { hasCredits: 1, unlimited: false } } },
      { ...RATE_LIMITS, rateLimitsByLimitId: { x: null } },
    ]) {
      expect(parseRateLimits(bad)).toBeNull();
    }
  });

  test("the id is both halves, and either missing is unidentified", () => {
    expect(codexAccountId("acct-1", "user-1")).toBe("codex:acct-1:user-1");
    expect(codexAccountId(null, "user-1")).toBeNull();
    expect(codexAccountId("acct-1", null)).toBeNull();
    expect(codexAccountId("", "user-1")).toBeNull();
    expect(codexAccountId("a".repeat(200), "u")).toBeNull();
  });
});

describe("quota and credits", () => {
  test("windows map by length, never position; scoped weeklies join `w` by model slug; `s` is cache", () => {
    const limits = parseRateLimits({
      ...RATE_LIMITS,
      rateLimits: {
        ...RATE_LIMITS.rateLimits,
        primary: window(41.6, 10_080, 1_760_500_000),
        secondary: window(3, 300),
      },
      rateLimitsByLimitId: {
        codex: RATE_LIMITS.rateLimits,
        spark: { ...RATE_LIMITS.rateLimits, normalModelSlug: "gpt-5.3-codex-spark", primary: window(70, 10_080, 9) },
        daily: { ...RATE_LIMITS.rateLimits, normalModelSlug: "other", primary: window(5, 1_440), secondary: null },
      },
    });
    if (limits === null) throw new Error("unparsed");
    expect(quotaReadingOf(limits, 1_759_999_000)).toEqual({
      s: "cache",
      at: 1_759_999_000,
      h: 3,
      hr: 1_760_000_000,
      d: 42,
      dr: 1_760_500_000,
      w: [{ m: "gpt-5.3-codex-spark", p: 70, r: 9 }],
    });
  });

  test("a window of any other length is dropped, and a missing reset leaves only the percent", () => {
    const limits = parseRateLimits({
      ...RATE_LIMITS,
      rateLimits: { ...RATE_LIMITS.rateLimits, primary: window(9, 60), secondary: window(10, 300, null) },
    });
    if (limits === null) throw new Error("unparsed");
    expect(quotaReadingOf(limits, 1)).toEqual({ s: "cache", at: 1, h: 10 });
  });

  test("credits: `c` is the member limit's spent share, else 0 while the account can spend and 100 once it cannot", () => {
    const withCredits = (fields: Record<string, unknown>) => {
      const parsed = parseRateLimits({
        ...RATE_LIMITS,
        rateLimits: {
          ...RATE_LIMITS.rateLimits,
          credits: { hasCredits: true, unlimited: false, balance: "12.5" },
          ...fields,
        },
      });
      if (parsed === null) throw new Error("unparsed");
      return creditView(parsed);
    };
    const none = parseRateLimits(RATE_LIMITS);
    if (none === null) throw new Error("unparsed");
    expect(creditView(none)).toEqual({ credits: false });
    expect(withCredits({})).toEqual({ credits: true, c: 0 });
    expect(withCredits({ spendControlReached: true })).toEqual({ credits: true, c: 100 });
    expect(withCredits({ rateLimitReachedType: "workspace_member_credits_depleted" })).toEqual({
      credits: true,
      c: 100,
    });
    expect(withCredits({ rateLimitReachedType: "rate_limit_reached" })).toEqual({ credits: true, c: 0 });
    expect(withCredits({ individualLimit: { limit: "50", used: "30", remainingPercent: 40, resetsAt: 1 } })).toEqual({
      credits: true,
      c: 60,
    });
    expect(withCredits({ individualLimit: { limit: "50", used: "50", remainingPercent: 0, resetsAt: 1 } })).toEqual({
      credits: true,
      c: 100,
    });
    expect(withCredits({ credits: { hasCredits: false, unlimited: true, balance: null } })).toEqual({
      credits: true,
      c: 0,
    });
  });
});

describe("login health", () => {
  test("ok reads identity, display, quota, credits and the backend's block", () => {
    const blocked = { ...RATE_LIMITS, ordinaryUsageAllowed: false };
    expect(probeResultOf("0.170.0", result(ACCOUNT), result(blocked), 1_759_999_000)).toEqual({
      health: "ok",
      version: "0.170.0",
      accountId: "codex:acct-1:user-1",
      display: { email: "a@example.com", plan: "team", workspace: "Acme" },
      quota: { s: "cache", at: 1_759_999_000, h: 3, hr: 1_760_010_000, d: 42, dr: 1_760_500_000 },
      credits: false,
      blocked: true,
    });
  });

  test("a failed account read leaves the login unidentified, never unknown", () => {
    const failed: RpcAnswer = { kind: "error", code: -32_603, unauthorized: false };
    const read = probeResultOf("0.170.0", failed, result(RATE_LIMITS), 1);
    expect(read.health).toBe("ok");
    expect(read.health === "ok" ? read.accountId : "").toBeNull();
  });

  test("-32600 is signed out, -32603 quoting 401 Unauthorized is expired, anything else unknown", () => {
    const error = (code: number | null, unauthorized = false): RpcAnswer => ({ kind: "error", code, unauthorized });
    expect(probeResultOf("0.170.0", result(ACCOUNT), error(-32_600), 1)).toEqual({
      health: "signed_out",
      version: "0.170.0",
    });
    expect(probeResultOf("0.170.0", result(ACCOUNT), error(-32_603, true), 1)).toEqual({
      health: "expired",
      version: "0.170.0",
    });
    for (const other of [error(-32_603), error(-32_600 + 1, true), error(null)]) {
      expect(probeResultOf("0.170.0", result(ACCOUNT), other, 1)).toEqual({
        health: "unknown",
        version: "0.170.0",
        failure: "refused",
      });
    }
    expect(probeResultOf("0.170.0", result(ACCOUNT), result({}), 1)).toEqual({
      health: "unknown",
      version: "0.170.0",
      failure: "malformed",
    });
  });
});
