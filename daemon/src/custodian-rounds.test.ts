import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countedVerb,
  emptyCounts,
  parseRoundEntry,
  readRounds,
  ROUNDS_KEPT,
  upsertRound,
  type RoundEntry,
} from "./custodian-rounds.ts";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-rounds-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (start: number, over: Partial<RoundEntry> = {}): RoundEntry => ({
  start,
  end: start + 1,
  exclave: "default",
  outcome: "failed",
  reason: "deadline",
  counts: emptyCounts(),
  ...over,
});

describe("countedVerb", () => {
  test("moves one verb's tally by one and leaves the rest", () => {
    const once = countedVerb(emptyCounts(), "close", true);
    const twice = countedVerb(countedVerb(once, "close", false), "sessions", true);
    expect(twice.close).toEqual({ ok: 1, refused: 1 });
    expect(twice.sessions).toEqual({ ok: 1, refused: 0 });
    expect(twice.notes).toEqual({ ok: 0, refused: 0 });
    expect(countedVerb(emptyCounts(), "flag", false).flag).toEqual({ ok: 0, refused: 1 });
    expect(emptyCounts().flagged).toBe(0);
    expect(emptyCounts().close).toEqual({ ok: 0, refused: 0 });
  });
});

describe("parseRoundEntry", () => {
  test("round-trips an entry with and without a summary", () => {
    for (const each of [entry(1), entry(2, { outcome: "healthy", reason: "done", summary: "closed two" })]) {
      expect(parseRoundEntry(JSON.stringify(each))).toEqual(each);
    }
  });

  test("a line written before custodian 6 has no flag tally or flagged count, and reads as zero", () => {
    const { flag: _flag, flagged: _flagged, ...old } = emptyCounts();
    const line = JSON.stringify({ ...entry(1), counts: old });
    expect(parseRoundEntry(line)).toEqual(entry(1));
  });

  test("a line written before custodian 8 has no nudge or interrupt tally, and reads as zero", () => {
    const { nudge: _nudge, interrupt: _interrupt, ...old } = emptyCounts();
    const read = parseRoundEntry(JSON.stringify({ ...entry(1), counts: old }));
    expect(read?.counts.nudge).toEqual({ ok: 0, refused: 0 });
    expect(read?.counts.interrupt).toEqual({ ok: 0, refused: 0 });
    expect(parseRoundEntry(JSON.stringify({ ...entry(1), counts: { ...emptyCounts(), nudge: null } }))).toBeNull();
    expect(
      parseRoundEntry(JSON.stringify({ ...entry(1), counts: { ...emptyCounts(), interrupt: { ok: 1 } } })),
    ).toBeNull();
    expect(countedVerb(emptyCounts(), "interrupt", true).interrupt).toEqual({ ok: 1, refused: 0 });
  });

  test("a flag tally or flagged count that is present and malformed refuses the line", () => {
    for (const counts of [
      { ...emptyCounts(), flag: { ok: -1, refused: 0 } },
      { ...emptyCounts(), flag: null },
      { ...emptyCounts(), flagged: -1 },
      { ...emptyCounts(), flagged: 1.5 },
      { ...emptyCounts(), flagged: "1" },
    ]) {
      expect(parseRoundEntry(JSON.stringify({ ...entry(1), counts }))).toBeNull();
    }
    expect(
      parseRoundEntry(JSON.stringify({ ...entry(1), counts: { ...emptyCounts(), flagged: 3 } }))?.counts.flagged,
    ).toBe(3);
  });

  test("a line that is not exactly an entry is refused", () => {
    expect(parseRoundEntry("not json")).toBeNull();
    expect(parseRoundEntry("[]")).toBeNull();
    for (const bad of [
      { ...entry(1), start: -1 },
      { ...entry(1), start: 1.5 },
      { ...entry(1), outcome: "ok" },
      { ...entry(1), reason: "because" },
      { ...entry(1), exclave: 3 },
      { ...entry(1), summary: 3 },
      { ...entry(1), counts: { ...emptyCounts(), close: { ok: -1, refused: 0 } } },
      { ...entry(1), counts: { ...emptyCounts(), worktrees: { removed: 0 } } },
      { ...entry(1), counts: null },
    ]) {
      expect(parseRoundEntry(JSON.stringify(bad))).toBeNull();
    }
  });
});

describe("upsertRound", () => {
  test("appends in order 0600 under a 0700 dir, and reads back what it wrote", async () => {
    const path = join(dir, "a", "rounds.jsonl");
    await upsertRound(path, entry(1));
    await upsertRound(path, entry(2, { outcome: "healthy", reason: "done", summary: "s" }));
    expect((await readRounds(path)).map((round) => round.start)).toEqual([1, 2]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "a"))).mode & 0o777).toBe(0o700);
  });

  test("keeps only the last ROUNDS_KEPT", async () => {
    const path = join(dir, "b.jsonl");
    for (let start = 1; start <= ROUNDS_KEPT + 3; start += 1) await upsertRound(path, entry(start));
    const kept = await readRounds(path);
    expect(kept).toHaveLength(ROUNDS_KEPT);
    expect(kept[0]?.start).toBe(4);
    expect(kept.at(-1)?.start).toBe(ROUNDS_KEPT + 3);
  });

  test("a round's later failed end replaces an earlier failed one but never a healthy one", async () => {
    const path = join(dir, "c.jsonl");
    await upsertRound(path, entry(1, { reason: "exited" }));
    await upsertRound(path, entry(1, { reason: "deadline" }));
    expect((await readRounds(path)).map((round) => round.reason)).toEqual(["deadline"]);
    await upsertRound(path, entry(2, { outcome: "healthy", reason: "done", summary: "kept" }));
    await upsertRound(path, entry(2, { reason: "lost" }));
    expect((await readRounds(path)).at(-1)).toMatchObject({ outcome: "healthy", summary: "kept" });
  });

  test("concurrent writes all land: none overwrites another's", async () => {
    const path = join(dir, "d.jsonl");
    await Promise.all([1, 2, 3, 4, 5].map((start) => upsertRound(path, entry(start))));
    expect((await readRounds(path)).map((round) => round.start).toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  test("a file it cannot read is an error, never no rounds: the history is not rewritten away", async () => {
    const path = join(dir, "f.jsonl");
    await mkdir(path);
    await expect(readRounds(path)).rejects.toThrow();
    await expect(upsertRound(path, entry(1))).rejects.toThrow();
    expect((await stat(path)).isDirectory()).toBe(true);
  });

  test("a line it cannot read is not carried forward, and a missing file is no rounds", async () => {
    const path = join(dir, "e.jsonl");
    expect(await readRounds(path)).toEqual([]);
    await writeFile(path, `garbage\n${JSON.stringify(entry(1))}\n`);
    await upsertRound(path, entry(2));
    expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(entry(1))}\n${JSON.stringify(entry(2))}\n`);
  });
});
