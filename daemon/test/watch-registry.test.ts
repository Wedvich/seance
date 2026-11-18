import { describe, expect, test } from "bun:test";
import {
  parseWatchSet,
  watchJsonBytes,
  WATCH_EVENT_JSON_MAX,
  WATCH_FLEET_PRS,
  type ParsedWatchSet,
  type WatchEventRequest,
  type WatchEventResponse,
} from "@seance/shared";
import {
  createWatchRegistry,
  HEAD_GRACE_POLLS,
  WATCH_SET_TTL_MS,
  type PrReading,
  type RunReading,
  type WatchRegistry,
} from "../src/watch-registry.ts";

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BOOT = uuid(9000);
const BOOT_2 = uuid(9001);
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);
const INTERVAL = 1000;

interface Spec {
  readonly id: number;
  readonly pr?: number;
  readonly run?: number;
  readonly head?: string;
  readonly seen?: readonly string[];
  readonly bad?: true;
}

function entryOf(spec: Spec): Record<string, unknown> {
  const url =
    spec.bad === true
      ? "https://example.com/x"
      : spec.run === undefined
        ? `https://github.com/o/r/pull/${spec.pr}`
        : `https://github.com/o/r/actions/runs/${spec.run}`;
  return {
    id: uuid(spec.id),
    kind: spec.run === undefined ? "pr" : "run",
    url,
    seen: spec.seen ?? [],
    ...(spec.head === undefined ? {} : { head: spec.head }),
  };
}

function setOf(n: number, specs: readonly Spec[], boot: string = BOOT): ParsedWatchSet {
  const parsed = parseWatchSet({ gen: { boot, n }, watches: specs.map(entryOf) });
  if (parsed === null) throw new Error("test set did not parse");
  return parsed;
}

const prKey = (n: number): string => `pr:o/r#${n}`;
const runKey = (n: number): string => `run:o/r/${n}`;

const open = (head?: string, extra: Partial<Extract<PrReading, { kind: "open" }>> = {}): PrReading => ({
  kind: "open",
  conflict: false,
  failing: [],
  ...(head === undefined ? {} : { head }),
  ...extra,
});

const prs = (...entries: [number, PrReading][]): { prs: Map<string, PrReading>; runs: Map<string, RunReading> } => ({
  prs: new Map(entries.map(([n, r]) => [prKey(n), r])),
  runs: new Map(),
});

const runs = (...entries: [number, RunReading][]): { prs: Map<string, PrReading>; runs: Map<string, RunReading> } => ({
  prs: new Map(),
  runs: new Map(entries.map(([n, r]) => [runKey(n), r])),
});

/** Every microtask the registry's send chain queued has run once a macrotask has. */
const settle = (): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

interface Fixture {
  readonly registry: WatchRegistry;
  readonly sent: { readonly to: string; readonly request: WatchEventRequest }[];
  readonly logs: { readonly info: string[]; readonly warn: string[] };
  /** Replaces what `send` answers; the default delivers every event. */
  answer: (to: string, request: WatchEventRequest) => Promise<WatchEventResponse | null>;
  canReceive: (id: string) => boolean;
}

const deliverAll = (_to: string, request: WatchEventRequest): Promise<WatchEventResponse | null> =>
  Promise.resolve({ ok: true, delivered: request.events.map((e) => e.id) });
const deliverNone = (): Promise<WatchEventResponse | null> => Promise.resolve({ ok: true, delivered: [] });

function fixture(intervalMs: number = INTERVAL): Fixture {
  const sent: Fixture["sent"][number][] = [];
  const logs: Fixture["logs"] = { info: [], warn: [] };
  const f: Fixture = {
    sent,
    logs,
    answer: deliverAll,
    canReceive: () => true,
    registry: createWatchRegistry({
      send: (to, request) => {
        sent.push({ to, request });
        return f.answer(to, request);
      },
      canReceive: (id) => f.canReceive(id),
      intervalMs,
      log: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) },
    }),
  };
  return f;
}

const eventsOf = (f: Fixture): WatchEventRequest["events"][number][] => f.sent.flatMap((s) => [...s.request.events]);

describe("generation", () => {
  test("a lower n on the same boot is ignored, unanswered", async () => {
    const f = fixture();
    expect(f.registry.accept("a", setOf(2, [{ id: 1, pr: 1 }]), 0)).toBe(true);
    await settle();
    expect(f.sent).toHaveLength(1);
    expect(f.registry.accept("a", setOf(1, [{ id: 2, pr: 2 }]), 1)).toBe(false);
    await settle();
    expect(f.sent).toHaveLength(1);
    expect(f.registry.wanted(1).prs.map((p) => p.key)).toEqual([prKey(1)]);
  });

  test("an equal n is re-answered as last computed, without replacing", async () => {
    const f = fixture();
    expect(
      f.registry.accept(
        "a",
        setOf(1, [
          { id: 1, pr: 1 },
          { id: 2, bad: true },
        ]),
        0,
      ),
    ).toBe(true);
    await settle();
    const first = f.sent[0]?.request.set;
    expect(first?.refused).toEqual([{ id: uuid(2), code: "invalid" }]);

    expect(f.registry.accept("a", setOf(1, [{ id: 3, pr: 3 }]), 10)).toBe(true);
    await settle();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]?.request.set).toEqual({ gen: { boot: BOOT, n: 1 }, refused: first?.refused ?? [] });
    expect(f.registry.wanted(10).prs.map((p) => p.key)).toEqual([prKey(1)]);
  });

  test("a higher n replaces and recomputes", async () => {
    const f = fixture();
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    f.registry.accept(
      "a",
      setOf(2, [
        { id: 2, pr: 2 },
        { id: 3, bad: true },
      ]),
      1,
    );
    await settle();
    expect(f.registry.wanted(1).prs.map((p) => p.key)).toEqual([prKey(2)]);
    const last = f.sent.at(-1)?.request.set;
    expect(last?.gen).toEqual({ boot: BOOT, n: 2 });
    expect(last?.refused).toEqual([{ id: uuid(3), code: "invalid" }]);
  });

  test("a new boot replaces the set and retires the old boot", async () => {
    const f = fixture();
    f.registry.accept("a", setOf(5, [{ id: 1, pr: 1 }]), 0);
    await settle();
    expect(f.registry.accept("a", setOf(0, [{ id: 2, pr: 2 }], BOOT_2), 1)).toBe(true);
    await settle();
    expect(f.registry.wanted(1).prs.map((p) => p.key)).toEqual([prKey(2)]);
    const sentBefore = f.sent.length;
    expect(f.registry.accept("a", setOf(9, [{ id: 1, pr: 1 }]), 2)).toBe(false);
    await settle();
    expect(f.sent).toHaveLength(sentBefore);
  });
});

describe("every accepted set is answered", () => {
  test("echoes the generation and refuses what it did not take", async () => {
    const f = fixture();
    const specs: Spec[] = Array.from({ length: 65 }, (_v, i) => ({ id: i + 1, pr: i + 1 }));
    f.registry.accept("a", setOf(1, [...specs, { id: 100, bad: true }]), 0);
    await settle();
    const set = f.sent[0]?.request.set;
    expect(set?.gen).toEqual({ boot: BOOT, n: 1 });
    expect(set?.refused).toEqual([
      { id: uuid(100), code: "invalid" },
      { id: uuid(65), code: "invalid" },
    ]);
    expect(f.registry.wanted(0).prs).toHaveLength(64);
  });

  test("a send with no answer repeats the set until an ok answer", async () => {
    const f = fixture();
    f.answer = () => Promise.resolve(null);
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    f.registry.tick(100, "failed", null);
    await settle();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]?.request.set?.gen).toEqual({ boot: BOOT, n: 1 });
    f.answer = deliverAll;
    f.registry.tick(200, "failed", null);
    await settle();
    expect(f.sent).toHaveLength(3);
    f.registry.tick(300, "failed", null);
    await settle();
    expect(f.sent).toHaveLength(3);
  });
});

describe("fleet caps", () => {
  const range = (from: number, to: number, kind: "pr" | "run" = "pr", idBase = 0): Spec[] =>
    Array.from({ length: to - from + 1 }, (_v, i) =>
      kind === "pr" ? { id: idBase + from + i, pr: from + i } : { id: idBase + from + i, run: from + i },
    );

  for (const kind of ["pr", "run"] as const) {
    test(`${kind}s: refused when full, admitted free when held by another, re-evaluated on every set`, async () => {
      const f = fixture();
      const keyOf = kind === "pr" ? prKey : runKey;
      f.registry.accept("a", setOf(1, range(1, 64, kind)), 0);
      await settle();
      f.registry.accept("c", setOf(1, range(65, 100, kind, 1000)), 0);
      await settle();
      expect(f.registry.wanted(0)[kind === "pr" ? "prs" : "runs"]).toHaveLength(WATCH_FLEET_PRS);

      const b = [...range(1, 1, kind, 2000), ...range(500, 500, kind, 2000)];
      f.registry.accept("b", setOf(1, b), 0);
      await settle();
      const bSet = f.sent.find((s) => s.to === "b")?.request.set;
      expect(bSet?.refused).toEqual([{ id: uuid(2500), code: "fleet_full" }]);

      // A cap never evicts: A re-sends its 64 and keeps them.
      f.registry.accept("a", setOf(2, range(1, 64, kind)), 1);
      await settle();
      const aSet = f.sent.findLast((s) => s.to === "a")?.request.set;
      expect(aSet?.refused).toEqual([]);

      // C drops one, B re-sends: the refused one is admitted.
      f.registry.accept("c", setOf(2, range(65, 99, kind, 1000)), 2);
      await settle();
      f.registry.accept("b", setOf(2, b), 2);
      await settle();
      const bSet2 = f.sent.findLast((s) => s.to === "b")?.request.set;
      expect(bSet2?.refused).toEqual([]);
      const wanted = f.registry.wanted(2)[kind === "pr" ? "prs" : "runs"].map((w) => w.key);
      expect(wanted).toContain(keyOf(500));
    });
  }
});

describe("expiry", () => {
  test("a set is dropped after 15 minutes without a set", async () => {
    const f = fixture();
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    expect(f.registry.wanted(WATCH_SET_TTL_MS).prs).toHaveLength(1);
    expect(f.registry.wanted(WATCH_SET_TTL_MS + 1).prs).toHaveLength(0);
  });

  test("an equal-generation resend refreshes the 15 minutes", async () => {
    const f = fixture();
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), WATCH_SET_TTL_MS - 1);
    await settle();
    expect(f.registry.wanted(WATCH_SET_TTL_MS + 1000).prs).toHaveLength(1);
    expect(f.registry.wanted(2 * WATCH_SET_TTL_MS).prs).toHaveLength(0);
  });
});

describe("level-triggered events", () => {
  test("merged is sent again until the daemon says delivered, then the watch is done", async () => {
    const f = fixture();
    f.answer = deliverNone;
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    f.registry.read(prs([1, { kind: "merged", stacked: true }]), 10);
    await settle();
    f.registry.read(prs([1, { kind: "merged", stacked: true }]), 20);
    await settle();
    const merged = eventsOf(f).filter((e) => e.key === "merged");
    expect(merged).toHaveLength(2);
    expect(merged[0]?.event).toEqual({ kind: "merged", stacked: true });

    f.answer = deliverAll;
    f.registry.read(prs([1, { kind: "merged", stacked: false }]), 30);
    await settle();
    expect(eventsOf(f).filter((e) => e.key === "merged")).toHaveLength(3);
    f.registry.read(prs([1, { kind: "merged", stacked: false }]), 40);
    await settle();
    expect(eventsOf(f).filter((e) => e.key === "merged")).toHaveLength(3);
    expect(f.registry.wanted(40).prs).toEqual([]);
  });

  test("a key in the set's seen is never sent", async () => {
    const f = fixture();
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1, seen: ["merged"] }]), 0);
    await settle();
    expect(f.registry.wanted(0).prs).toEqual([]);
    f.registry.read(prs([1, { kind: "merged", stacked: false }]), 10);
    await settle();
    expect(eventsOf(f)).toEqual([]);
  });

  test("a closed PR and a completed run send once each", async () => {
    const f = fixture();
    f.registry.accept(
      "a",
      setOf(1, [
        { id: 1, pr: 1 },
        { id: 2, run: 7 },
      ]),
      0,
    );
    await settle();
    const failing = [{ name: "build", job: { run: "7", job: "8" } }];
    f.registry.read(
      {
        prs: new Map<string, PrReading>([[prKey(1), { kind: "closed" }]]),
        runs: new Map<string, RunReading>([[runKey(7), { kind: "completed", attempt: 2, conclusion: "failure", failing }]]),
      },
      10,
    );
    await settle();
    const events = eventsOf(f);
    expect(events.map((e) => e.key)).toEqual(["closed", "completed:2"]);
    expect(events[1]?.event).toEqual({ kind: "completed", attempt: 2, conclusion: "failure", failing });
  });

  test("a passing run carries no failing list, and a running one nothing", async () => {
    const f = fixture();
    f.registry.accept(
      "a",
      setOf(1, [
        { id: 1, run: 1 },
        { id: 2, run: 2 },
      ]),
      0,
    );
    await settle();
    f.registry.read(
      {
        prs: new Map(),
        runs: new Map([
          [runKey(1), { kind: "completed", attempt: 1, conclusion: "success", failing: [{ name: "x" }] }],
          [runKey(2), { kind: "running" }],
        ]),
      },
      10,
    );
    await settle();
    expect(eventsOf(f)).toHaveLength(1);
    expect(eventsOf(f)[0]?.event).toEqual({ kind: "completed", attempt: 1, conclusion: "success" });
  });
});

describe("unreadable", () => {
  test("two consecutive nulls give unreadable, one or a broken streak gives none", async () => {
    const f = fixture();
    f.registry.accept(
      "a",
      setOf(1, [
        { id: 1, pr: 1 },
        { id: 2, pr: 2 },
      ]),
      0,
    );
    await settle();
    f.registry.read(prs([1, { kind: "unreadable" }], [2, { kind: "unreadable" }]), 10);
    await settle();
    expect(eventsOf(f)).toEqual([]);
    f.registry.read(prs([1, { kind: "unreadable" }], [2, open(HEAD_A)]), 20);
    await settle();
    expect(eventsOf(f).map((e) => [e.id, e.key])).toEqual([[uuid(1), "unreadable"]]);
    f.registry.read(prs([2, { kind: "unreadable" }]), 30);
    await settle();
    expect(eventsOf(f)).toHaveLength(1);
    expect(f.registry.wanted(30).prs.map((p) => p.key)).toEqual([prKey(2)]);
  });

  test("a run answered null twice is unreadable too", async () => {
    const f = fixture();
    f.registry.accept("a", setOf(1, [{ id: 1, run: 1 }]), 0);
    await settle();
    f.registry.read(runs([1, { kind: "unreadable" }]), 10);
    f.registry.read(runs([1, { kind: "unreadable" }]), 20);
    await settle();
    expect(eventsOf(f).map((e) => e.key)).toEqual(["unreadable"]);
  });
});

describe("head tracking", () => {
  const checks = (head: string, extra: Partial<Extract<PrReading, { kind: "open" }>> = {}): PrReading =>
    open(head, { checks: "pass", ...extra });

  test("a set without head adopts the first head, and a later head emits with headMoved", async () => {
    const f = fixture();
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    f.registry.read(prs([1, checks(HEAD_A)]), 10);
    await settle();
    expect(eventsOf(f)[0]?.event).toEqual({ kind: "checks", outcome: "pass", head: HEAD_A });
    f.registry.read(prs([1, checks(HEAD_B)]), 20);
    await settle();
    expect(eventsOf(f)[1]?.event).toEqual({ kind: "checks", outcome: "pass", head: HEAD_B, headMoved: true });
  });

  test("a set with head ignores a different head for the grace, then follows", async () => {
    const f = fixture();
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1, head: HEAD_A }]), 0);
    await settle();
    for (let i = 1; i < HEAD_GRACE_POLLS; i++) {
      f.registry.read(prs([1, checks(HEAD_B)]), i * 10);
      await settle();
    }
    expect(eventsOf(f)).toEqual([]);
    f.registry.read(prs([1, checks(HEAD_B)]), HEAD_GRACE_POLLS * 10);
    await settle();
    expect(eventsOf(f)[0]?.event).toEqual({ kind: "checks", outcome: "pass", head: HEAD_B, headMoved: true });
  });

  test("a set with head, once confirmed, follows a new head at once", async () => {
    const f = fixture();
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1, head: HEAD_A }]), 0);
    await settle();
    f.registry.read(prs([1, checks(HEAD_A)]), 10);
    await settle();
    expect(eventsOf(f)[0]?.event).toEqual({ kind: "checks", outcome: "pass", head: HEAD_A });
    f.registry.read(prs([1, checks(HEAD_C, { conflict: true })]), 20);
    await settle();
    expect(eventsOf(f).map((e) => e.event)).toEqual([
      { kind: "checks", outcome: "pass", head: HEAD_A },
      { kind: "checks", outcome: "pass", head: HEAD_C, headMoved: true },
      { kind: "conflict", head: HEAD_C, headMoved: true },
    ]);
  });

  test("a failing check carries its names, and an open reading with no head emits nothing", async () => {
    const f = fixture();
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    f.registry.read(prs([1, open(undefined, { checks: "fail", conflict: true })]), 10);
    await settle();
    expect(eventsOf(f)).toEqual([]);
    const failing = [{ name: "lint", required: true as const }];
    f.registry.read(prs([1, open(HEAD_A, { checks: "fail", failing })]), 20);
    await settle();
    expect(eventsOf(f)[0]?.event).toEqual({ kind: "checks", outcome: "fail", head: HEAD_A, failing });
  });
});

describe("suspension", () => {
  test("a watch unread for more than two intervals is suspended once, with the reset", async () => {
    const f = fixture();
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    f.registry.tick(2 * INTERVAL, "limited", 99_000);
    await settle();
    expect(eventsOf(f)).toEqual([]);
    f.registry.tick(2 * INTERVAL + 1, "limited", 99_000);
    await settle();
    expect(eventsOf(f)).toEqual([
      { id: uuid(1), key: "suspended:0", event: { kind: "suspended", reason: "limited", since: 0, resetAt: 99_000 } },
    ]);
    f.registry.tick(5 * INTERVAL, "limited", 99_000);
    await settle();
    expect(eventsOf(f)).toHaveLength(1);
  });

  test("a read clears it, and a later stop is a new suspension", async () => {
    const f = fixture();
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    f.registry.tick(3 * INTERVAL, "reserve", 5000);
    await settle();
    f.registry.read(prs([1, open(HEAD_A)]), 4 * INTERVAL);
    await settle();
    f.registry.tick(7 * INTERVAL, "limited", 8000);
    await settle();
    expect(eventsOf(f).map((e) => e.key)).toEqual(["suspended:0", `suspended:${4 * INTERVAL}`]);
  });

  test("unauthenticated and failed carry no resetAt", async () => {
    const f = fixture();
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    f.registry.tick(3 * INTERVAL, "unauthenticated", 5000);
    await settle();
    expect(eventsOf(f)[0]?.event).toEqual({ kind: "suspended", reason: "unauthenticated", since: 0 });
  });

  test("failed suspends only the watch that went unread, not one read in the same window", async () => {
    const f = fixture();
    f.registry.accept(
      "a",
      setOf(1, [
        { id: 1, pr: 1 },
        { id: 2, pr: 2 },
      ]),
      0,
    );
    await settle();
    f.registry.read(prs([2, open(HEAD_A)]), 2 * INTERVAL);
    await settle();
    f.registry.tick(3 * INTERVAL, "failed", null);
    await settle();
    expect(eventsOf(f).map((e) => [e.id, e.key])).toEqual([[uuid(1), "suspended:0"]]);
  });

  test("an unacknowledged suspension is sent again", async () => {
    const f = fixture();
    f.answer = deliverNone;
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    f.registry.tick(3 * INTERVAL, "failed", null);
    await settle();
    f.registry.tick(4 * INTERVAL, "failed", null);
    await settle();
    expect(eventsOf(f).filter((e) => e.key === "suspended:0")).toHaveLength(2);
  });
});

describe("send discipline", () => {
  test("no second send to a device while one is in flight", async () => {
    const f = fixture();
    let release: (r: WatchEventResponse) => void = () => undefined;
    f.answer = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    f.registry.read(prs([1, { kind: "closed" }]), 10);
    f.registry.tick(20, "failed", null);
    expect(f.sent).toHaveLength(1);
    release({ ok: true, delivered: [] });
    await settle();
    f.registry.tick(30, "failed", null);
    await settle();
    expect(f.sent.length).toBeGreaterThan(1);
  });

  test("a failed send warns once per stay, and the next success logs once", async () => {
    const f = fixture();
    f.answer = () => Promise.resolve(null);
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    f.registry.tick(10, "failed", null);
    await settle();
    f.registry.tick(20, "failed", null);
    await settle();
    expect(f.logs.warn.filter((l) => l.includes("watch-event"))).toHaveLength(1);
    expect(f.logs.info).toEqual([]);
    f.answer = deliverAll;
    f.registry.tick(30, "failed", null);
    await settle();
    expect(f.logs.info).toHaveLength(1);
    f.registry.tick(40, "failed", null);
    await settle();
    expect(f.logs.info).toHaveLength(1);
  });

  test("an error answer counts as a failure, and a throw does too", async () => {
    const f = fixture();
    f.answer = () => Promise.resolve({ ok: false, code: "invalid_request", message: "no" });
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    expect(f.logs.warn.some((l) => l.includes("invalid_request"))).toBe(true);
    const g = fixture();
    g.answer = () => Promise.reject(new Error("boom"));
    g.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    expect(g.logs.warn.some((l) => l.includes("unreachable"))).toBe(true);
  });

  test("a device that cannot receive is sent nothing", async () => {
    const f = fixture();
    f.canReceive = () => false;
    f.registry.accept("a", setOf(1, [{ id: 1, pr: 1 }]), 0);
    await settle();
    f.registry.read(prs([1, { kind: "closed" }]), 10);
    await settle();
    expect(f.sent).toEqual([]);
  });

  test("an oversized due list is cut in bytes and the rest goes next poll", async () => {
    const f = fixture();
    const count = 30;
    f.registry.accept(
      "a",
      setOf(
        1,
        Array.from({ length: count }, (_v, i) => ({ id: i + 1, run: i + 1 })),
      ),
      0,
    );
    await settle();
    const failing = Array.from({ length: 10 }, () => ({ name: "ø".repeat(100) }));
    const readings = new Map<string, RunReading>(
      Array.from(
        { length: count },
        (_v, i) => [runKey(i + 1), { kind: "completed", attempt: 1, conclusion: "failure", failing }] as const,
      ),
    );
    f.registry.read({ prs: new Map(), runs: readings }, 10);
    await settle();
    const first = f.sent.at(-1)?.request;
    if (first === undefined) throw new Error("nothing sent");
    // By `.length` the whole list would fit, by bytes it does not.
    expect(JSON.stringify({ events: eventsOf(f) }).length).toBeLessThan(WATCH_EVENT_JSON_MAX);
    expect(first.events.length).toBeLessThan(count);
    expect(first.events.length).toBeGreaterThan(0);
    expect(watchJsonBytes(first)).toBeLessThanOrEqual(WATCH_EVENT_JSON_MAX);
    let total = first.events.length;
    for (let poll = 2; total < count && poll < 10; poll++) {
      f.registry.read({ prs: new Map(), runs: readings }, poll * 10);
      await settle();
      const request = f.sent.at(-1)?.request;
      expect(watchJsonBytes(request)).toBeLessThanOrEqual(WATCH_EVENT_JSON_MAX);
      total += request?.events.length ?? 0;
    }
    expect(total).toBe(count);
  });
});

describe("logging", () => {
  test("no log line names a url, owner, head or watch id", async () => {
    const f = fixture();
    f.answer = () => Promise.resolve(null);
    const full = Array.from({ length: WATCH_FLEET_PRS }, (_v, i) => ({ id: i + 1, pr: i + 1 }));
    f.registry.accept("a", setOf(1, full.slice(0, 64)), 0);
    await settle();
    f.registry.accept("c", setOf(1, full.slice(64)), 0);
    await settle();
    f.registry.accept(
      "b",
      setOf(1, [
        { id: 500, pr: 500, head: HEAD_A },
        { id: 501, bad: true },
      ]),
      0,
    );
    await settle();
    f.registry.tick(10, "failed", null);
    await settle();
    const text = [...f.logs.info, ...f.logs.warn].join("\n");
    expect(f.logs.warn.length).toBeGreaterThan(0);
    for (const secret of ["github.com", "o/r", HEAD_A, uuid(500), uuid(501), uuid(1)]) {
      expect(text).not.toContain(secret);
    }
  });
});
