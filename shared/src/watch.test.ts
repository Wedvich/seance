import { describe, expect, test } from "bun:test";
import { MESSAGE_PUSH_MAX } from "./messages.ts";
import {
  isTerminalKey,
  isWatchKey,
  parseGithubRun,
  parseWatchEvent,
  parseWatchEventResponse,
  parseWatchSet,
  prUrlOf,
  runUrlOf,
  watchJsonBytes,
  watchKeyOf,
  watchNote,
  watchTargetKey,
  WATCH_EVENT_JSON_MAX,
  type WatchTarget,
} from "./watch.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const BOOT = "44444444-4444-4444-8444-444444444444";
const HEAD40 = "a".repeat(40);
const HEAD64 = "b".repeat(64);
const PR_URL = "https://github.com/Octo-Org/widgets/pull/42";
const RUN_URL = "https://github.com/octo-org/widgets/actions/runs/123";

const GEN: unknown = { boot: BOOT, n: 1 };
const set = (watches: unknown[], gen: unknown = GEN): unknown => ({ gen, watches });
const prEntry = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  kind: "pr",
  url: PR_URL,
  seen: [],
  ...extra,
});

describe("parseGithubRun", () => {
  test("accepts a run, dropping the attempt", () => {
    expect(parseGithubRun("https://github.com/o/r/actions/runs/123")).toEqual({ owner: "o", repo: "r", id: "123" });
    expect(parseGithubRun("https://github.com/o/r/actions/runs/123/attempts/2")).toEqual({
      owner: "o",
      repo: "r",
      id: "123",
    });
  });

  test("keeps a 20-digit id as a string", () => {
    expect(parseGithubRun(`https://github.com/o/r/actions/runs/${"9".repeat(20)}`)?.id).toBe("9".repeat(20));
  });

  test.each([
    ["a 21-digit id", `https://github.com/o/r/actions/runs/${"9".repeat(21)}`],
    ["run 0", "https://github.com/o/r/actions/runs/0"],
    ["another host", "https://gitlab.com/o/r/actions/runs/1"],
    ["a trailing slash", "https://github.com/o/r/actions/runs/1/"],
    ["a job", "https://github.com/o/r/actions/runs/1/job/1"],
    ["an owner outside the set", "https://github.com/o_x/r/actions/runs/1"],
    ["a repo outside the set", "https://github.com/o/r%2f/actions/runs/1"],
    ["a PR url", PR_URL],
  ])("refuses %s", (_name, url) => {
    expect(parseGithubRun(url)).toBeNull();
  });
});

describe("rebuilders and keys", () => {
  test("rebuild the url from parts and lowercase the key", () => {
    expect(prUrlOf({ owner: "o", repo: "r", number: 3 })).toBe("https://github.com/o/r/pull/3");
    expect(runUrlOf({ owner: "o", repo: "r", id: "5" })).toBe("https://github.com/o/r/actions/runs/5");
    expect(watchTargetKey({ kind: "pr", pr: { owner: "Octo", repo: "Widgets", number: 3 } })).toBe("pr:octo/widgets#3");
    expect(watchTargetKey({ kind: "run", run: { owner: "Octo", repo: "Widgets", id: "5" } })).toBe(
      "run:octo/widgets/5",
    );
  });
});

describe("isWatchKey", () => {
  test.each([
    `checks:${HEAD40}:pass`,
    `checks:${HEAD64}:fail`,
    `conflict:${HEAD40}`,
    "merged",
    "closed",
    "completed:1",
    "completed:2147483647",
    "unreadable",
    "suspended:limited",
    "suspended:unauthenticated",
  ])("accepts %s", (key) => {
    expect(isWatchKey(key)).toBe(true);
  });

  test.each([
    `checks:${HEAD40.toUpperCase()}:pass`,
    `checks:${"a".repeat(41)}:pass`,
    `checks:${HEAD40}:maybe`,
    "completed:01",
    "completed:",
    "suspended:",
    "suspended:1700000000000",
    "suspended:nope",
    "merged ",
    "MERGED",
    5,
  ])("refuses %p", (key) => {
    expect(isWatchKey(key)).toBe(false);
  });

  test("terminal keys", () => {
    for (const key of ["merged", "closed", "completed:2", "unreadable"]) expect(isTerminalKey(key)).toBe(true);
    for (const key of [`checks:${HEAD40}:pass`, `conflict:${HEAD40}`, "suspended:failed"]) {
      expect(isTerminalKey(key)).toBe(false);
    }
  });

  test("watchKeyOf matches the grammar for every body", () => {
    const bodies = [
      { kind: "checks", outcome: "pass", head: HEAD40 },
      { kind: "conflict", head: HEAD64 },
      { kind: "merged" },
      { kind: "closed" },
      { kind: "completed", attempt: 3, conclusion: "success" },
      { kind: "unreadable" },
      { kind: "suspended", reason: "failed", since: 12 },
    ] as const;
    for (const body of bodies) expect(isWatchKey(watchKeyOf(body))).toBe(true);
  });
});

describe("parseWatchSet", () => {
  test("a valid set parses, holding parts and never the url", () => {
    const parsed = parseWatchSet(
      set([
        prEntry(A, { head: HEAD40, seen: ["merged", `checks:${HEAD40}:pass`] }),
        { id: B, kind: "run", url: RUN_URL, seen: [] },
      ]),
    );
    expect(parsed).toEqual({
      gen: { boot: BOOT, n: 1 },
      watches: [
        {
          id: A,
          target: { kind: "pr", pr: { owner: "Octo-Org", repo: "widgets", number: 42 } },
          head: HEAD40,
          seen: ["merged", `checks:${HEAD40}:pass`],
        },
        { id: B, target: { kind: "run", run: { owner: "octo-org", repo: "widgets", id: "123" } }, seen: [] },
      ],
      invalid: [],
    });
    expect(JSON.stringify(parsed)).not.toContain("https://");
  });

  test.each([
    ["an unknown top-level key", { gen: { boot: BOOT, n: 1 }, watches: [], extra: 1 }],
    ["a non-record", []],
    ["a gen with an extra key", set([], { boot: BOOT, n: 1, x: 1 })],
    ["a non-uuid boot", set([], { boot: "nope", n: 1 })],
    ["a negative n", set([], { boot: BOOT, n: -1 })],
    ["a fractional n", set([], { boot: BOOT, n: 1.5 })],
    ["watches not an array", { gen: { boot: BOOT, n: 1 }, watches: {} }],
    ["a non-record entry", set(["x"])],
    ["a non-uuid id", set([prEntry("nope")])],
    ["duplicate ids", set([prEntry(A), prEntry(A)])],
  ])("drops the frame for %s", (_name, value) => {
    expect(parseWatchSet(value)).toBeNull();
  });

  test("more than 256 entries drop the frame, 65 do not", () => {
    const many = (n: number): unknown[] =>
      Array.from({ length: n }, (_v, i) => prEntry(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`));
    expect(parseWatchSet(set(many(257)))).toBeNull();
    expect(parseWatchSet(set(many(256)))?.watches).toHaveLength(256);
    expect(parseWatchSet(set(many(65)))?.watches).toHaveLength(65);
  });

  test("entry-level faults land in invalid and the set parses", () => {
    const parsed = parseWatchSet(
      set([
        prEntry(A, { url: "https://example.com/x" }),
        prEntry(B, { url: RUN_URL }),
        { id: C, kind: "run", url: RUN_URL, head: HEAD40, seen: [] },
        prEntry("55555555-5555-4555-8555-555555555555", { seen: Array.from({ length: 9 }, () => "merged") }),
        prEntry("66666666-6666-4666-8666-666666666666", { extra: 1 }),
        prEntry("77777777-7777-4777-8777-777777777777", { seen: ["nope"] }),
        prEntry("88888888-8888-4888-8888-888888888888", { head: "A".repeat(40) }),
        { id: "99999999-9999-4999-8999-999999999999", kind: "other", url: PR_URL, seen: [] },
        prEntry("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      ]),
    );
    expect(parsed?.watches.map((w) => w.id)).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    expect(parsed?.invalid).toEqual([
      A,
      B,
      C,
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888",
      "99999999-9999-4999-8999-999999999999",
    ]);
  });
});

describe("parseWatchEvent", () => {
  const ev = (id: string, event: Record<string, unknown>, key: string): unknown => ({ id, key, event });
  const failing = [{ name: "build", required: true, job: { run: "11", job: "22" } }, { name: "lint" }];

  test("every body kind parses", () => {
    const events = [
      ev(A, { kind: "checks", outcome: "fail", head: HEAD40, headMoved: true, failing }, `checks:${HEAD40}:fail`),
      ev(B, { kind: "checks", outcome: "pass", head: HEAD40 }, `checks:${HEAD40}:pass`),
      ev(C, { kind: "conflict", head: HEAD64 }, `conflict:${HEAD64}`),
      ev("55555555-5555-4555-8555-555555555555", { kind: "merged", stacked: true }, "merged"),
      ev("66666666-6666-4666-8666-666666666666", { kind: "closed" }, "closed"),
      ev(
        "77777777-7777-4777-8777-777777777777",
        { kind: "completed", attempt: 2, conclusion: "failure", failing },
        "completed:2",
      ),
      ev(
        "88888888-8888-4888-8888-888888888888",
        { kind: "completed", attempt: 1, conclusion: "success" },
        "completed:1",
      ),
      ev("99999999-9999-4999-8999-999999999999", { kind: "unreadable" }, "unreadable"),
      ev(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        { kind: "suspended", reason: "limited", since: 5, resetAt: 9 },
        "suspended:limited",
      ),
    ];
    const parsed = parseWatchEvent({
      set: { gen: { boot: BOOT, n: 3 }, refused: [{ id: A, code: "fleet_full" }] },
      events,
    });
    expect(parsed?.events).toHaveLength(9);
    expect(parsed?.set).toEqual({ gen: { boot: BOOT, n: 3 }, refused: [{ id: A, code: "fleet_full" }] });
    expect(parseWatchEvent({ events: [] })).toEqual({ events: [] });
  });

  test.each([
    ["a key mismatch", [ev(A, { kind: "closed" }, "merged")]],
    [
      "failing beside pass",
      [ev(A, { kind: "checks", outcome: "pass", head: HEAD40, failing }, `checks:${HEAD40}:pass`)],
    ],
    [
      "failing beside a passing conclusion",
      [ev(A, { kind: "completed", attempt: 1, conclusion: "neutral", failing }, "completed:1")],
    ],
    [
      "11 failing entries",
      [
        ev(
          A,
          {
            kind: "checks",
            outcome: "fail",
            head: HEAD40,
            failing: Array.from({ length: 11 }, (_v, i) => ({ name: `n${i}` })),
          },
          `checks:${HEAD40}:fail`,
        ),
      ],
    ],
    [
      "a name with a control character",
      [ev(A, { kind: "checks", outcome: "fail", head: HEAD40, failing: [{ name: "a\nb" }] }, `checks:${HEAD40}:fail`)],
    ],
    [
      "a job run of 21 digits",
      [
        ev(
          A,
          {
            kind: "checks",
            outcome: "fail",
            head: HEAD40,
            failing: [{ name: "a", job: { run: "1".repeat(21), job: "2" } }],
          },
          `checks:${HEAD40}:fail`,
        ),
      ],
    ],
    [
      "resetAt beside unauthenticated",
      [ev(A, { kind: "suspended", reason: "unauthenticated", since: 1, resetAt: 2 }, "suspended:unauthenticated")],
    ],
    ["an unknown body key", [ev(A, { kind: "closed", extra: 1 }, "closed")]],
    ["a non-uuid event id", [ev("x", { kind: "closed" }, "closed")]],
  ])("refuses %s", (_name, events) => {
    expect(parseWatchEvent({ events })).toBeNull();
  });

  test("refuses an unknown refusal code and an unknown frame key", () => {
    expect(
      parseWatchEvent({ set: { gen: { boot: BOOT, n: 1 }, refused: [{ id: A, code: "nope" }] }, events: [] }),
    ).toBeNull();
    expect(parseWatchEvent({ events: [], extra: 1 })).toBeNull();
  });

  test("the bound is bytes, not UTF-16 code units", () => {
    // Each event carries 10 failing names of 100 code units: "ø" is two bytes, so equal string length, twice the bytes.
    const frame = (char: string, count: number): unknown => ({
      events: Array.from({ length: count }, (_v, i) =>
        ev(
          `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          {
            kind: "checks",
            outcome: "fail",
            head: HEAD40,
            failing: Array.from({ length: 10 }, () => ({ name: char.repeat(100) })),
          },
          `checks:${HEAD40}:fail`,
        ),
      ),
    });
    const count = 30;
    const ascii = frame("o", count);
    const wide = frame("ø", count);
    const limit = WATCH_EVENT_JSON_MAX + 4096;
    expect(JSON.stringify(ascii).length).toBe(JSON.stringify(wide).length);
    expect(JSON.stringify(wide).length).toBeLessThan(limit);
    expect(watchJsonBytes(wide)).toBeGreaterThan(limit);
    expect(watchJsonBytes(ascii)).toBeLessThanOrEqual(limit);
    expect(parseWatchEvent(ascii)).not.toBeNull();
    expect(parseWatchEvent(wide)).toBeNull();
  });
});

describe("watchJsonBytes", () => {
  test("counts UTF-8 bytes of the JSON", () => {
    expect(watchJsonBytes("ø")).toBe(4);
    expect(watchJsonBytes("o")).toBe(3);
  });
});

describe("parseWatchEventResponse", () => {
  test("ok with ids", () => {
    expect(parseWatchEventResponse({ ok: true, delivered: [A, B] })).toEqual({ ok: true, delivered: [A, B] });
    expect(parseWatchEventResponse({ ok: true, delivered: [] })).toEqual({ ok: true, delivered: [] });
  });

  test("refuses a non-uuid id and a non-array", () => {
    expect(parseWatchEventResponse({ ok: true, delivered: ["x"] })).toBeNull();
    expect(parseWatchEventResponse({ ok: true, delivered: "x" })).toBeNull();
    expect(parseWatchEventResponse({ ok: true })).toBeNull();
  });

  test("the error shape, and an unknown code", () => {
    expect(parseWatchEventResponse({ ok: false, code: "invalid_request", message: "m" })).toEqual({
      ok: false,
      code: "invalid_request",
      message: "m",
    });
    expect(parseWatchEventResponse({ ok: false, code: "internal_error", message: "m" })?.ok).toBe(false);
    expect(parseWatchEventResponse({ ok: false, code: "nope", message: "m" })).toBeNull();
    expect(parseWatchEventResponse({ ok: false, code: "unsupported" })).toBeNull();
    expect(parseWatchEventResponse(null)).toBeNull();
  });
});

describe("watchNote", () => {
  const pr: WatchTarget = { kind: "pr", pr: { owner: "octo-org", repo: "widgets", number: 42 } };
  const run: WatchTarget = { kind: "run", run: { owner: "octo-org", repo: "widgets", id: "123" } };
  const note = (
    events: Parameters<typeof watchNote>[0]["events"],
    target: WatchTarget = pr,
  ): ReturnType<typeof watchNote> => watchNote({ id: A, target, events });
  const OPENING = `Automated note from séance, not written by the user: watch ${A} on `;

  test("opens with the fixed line naming the id and the rebuilt url", () => {
    expect(note([{ kind: "closed" }]).text.startsWith(`${OPENING}https://github.com/octo-org/widgets/pull/42.\n`)).toBe(
      true,
    );
    expect(
      note([{ kind: "unreadable" }], run).text.startsWith(
        `${OPENING}https://github.com/octo-org/widgets/actions/runs/123.\n`,
      ),
    ).toBe(true);
  });

  test("each event kind has its fixed paragraph", () => {
    expect(note([{ kind: "checks", outcome: "pass", head: HEAD40 }]).text).toContain(
      `Checks passed on head \`${HEAD40}\`.`,
    );
    expect(note([{ kind: "checks", outcome: "fail", head: HEAD40, headMoved: true }]).text).toContain(
      `A check failed on head \`${HEAD40}\`. The PR's head moved from the one you watched: someone else pushed.`,
    );
    expect(note([{ kind: "conflict", head: HEAD64, headMoved: true }]).text).toContain("someone else pushed.");
    expect(note([{ kind: "merged" }]).text).toContain("The PR was merged. This watch has ended.");
    expect(note([{ kind: "merged", stacked: true }]).text).toContain("(a stacked PR)");
    expect(note([{ kind: "closed" }]).text).toContain("closed without merging. This watch has ended.");
    expect(note([{ kind: "completed", attempt: 2, conclusion: "success" }], run).text).toContain(
      "The run completed: success (attempt 2).\nThis watch has ended.",
    );
    expect(note([{ kind: "unreadable" }]).text).toContain("two polls in a row");
    expect(note([{ kind: "suspended", reason: "failed", since: 1 }]).text).toContain(
      "Poll the target yourself at 30 s or slower",
    );
    expect(note([{ kind: "no_leader" }]).text).toContain("for 10 minutes");
    expect(note([{ kind: "expired" }]).text).toContain("expired 24 h");
    expect(note([{ kind: "invalid" }]).text).toContain("refused this watch as invalid");
    expect(note([{ kind: "fleet_full" }]).text).toContain("capacity for GitHub watches is full");
  });

  test("a spent budget and the reserve name the reset as HH:MM UTC, or say it is unknown", () => {
    const resetAt = Date.UTC(2026, 10, 18, 13, 5, 30);
    expect(note([{ kind: "suspended", reason: "limited", since: 1, resetAt }]).text).toContain(
      "is spent until 13:05 UTC; this watch resumes then; do not poll GitHub yourself meanwhile.",
    );
    expect(note([{ kind: "suspended", reason: "reserve", since: 1, resetAt }]).text).toContain(
      "is held back for tasks' reads until 13:05 UTC",
    );
    expect(note([{ kind: "suspended", reason: "limited", since: 1 }]).text).toContain(
      "is spent until GitHub resets it;",
    );
  });

  test("wakes unless every event is a limited or reserve suspension", () => {
    const limited = { kind: "suspended", reason: "limited", since: 1 } as const;
    const reserve = { kind: "suspended", reason: "reserve", since: 1 } as const;
    expect(note([limited]).wake).toBe(false);
    expect(note([limited, reserve]).wake).toBe(false);
    expect(note([limited, { kind: "merged" }]).wake).toBe(true);
    expect(note([{ kind: "suspended", reason: "failed", since: 1 }]).wake).toBe(true);
    expect(note([{ kind: "suspended", reason: "unauthenticated", since: 1 }]).wake).toBe(true);
    for (const kind of ["no_leader", "expired", "invalid", "fleet_full"] as const) {
      expect(note([{ kind }]).wake).toBe(true);
    }
  });

  test("the failing block fences names, marks required, rebuilds the job link and says how to read the log", () => {
    const text = note([
      {
        kind: "checks",
        outcome: "fail",
        head: HEAD40,
        failing: [{ name: "build", required: true, job: { run: "9", job: "77" } }, { name: "lint" }],
      },
    ]).text;
    expect(text).toContain(
      "```\nbuild (required)  job: https://github.com/octo-org/widgets/actions/runs/9/job/77\nlint\n```",
    );
    expect(text).toContain("`gh api repos/octo-org/widgets/actions/jobs/<job id>/logs`");
  });

  test("no log line when no entry has a job", () => {
    const text = note([{ kind: "completed", attempt: 1, conclusion: "failure", failing: [{ name: "x" }] }], run).text;
    expect(text).not.toContain("gh api");
  });

  test("a name with backticks is fenced by a longer fence", () => {
    const text = note([{ kind: "checks", outcome: "fail", head: HEAD40, failing: [{ name: "a ```` b" }] }]).text;
    expect(text).toContain("`````\na ```` b\n`````");
  });

  test("the largest failing list stays under the push bound", () => {
    const failing = Array.from({ length: 10 }, (_, i) => ({
      name: `${i}`.repeat(100),
      required: true as const,
      job: { run: "9".repeat(20), job: "8".repeat(20) },
    }));
    const forPr = note([{ kind: "checks", outcome: "fail", head: HEAD64, headMoved: true, failing }]).text;
    const forRun = note([{ kind: "completed", attempt: 1, conclusion: "failure", failing }], run).text;
    expect(Buffer.byteLength(forPr)).toBeLessThan(MESSAGE_PUSH_MAX);
    expect(Buffer.byteLength(forRun)).toBeLessThan(MESSAGE_PUSH_MAX);
  });

  test("several events for one watch are one note", () => {
    const text = note([
      { kind: "checks", outcome: "pass", head: HEAD40 },
      { kind: "conflict", head: HEAD40 },
    ]).text;
    expect(text.split("\n")).toHaveLength(3);
  });
});
