import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "@seance/shared";
import type { CustodianVerb } from "./custodian-frame.ts";
import { writeDurable } from "./durable-write.ts";

/**
 * The round log (docs/custodian.md C40, C42; DESIGN.md, "The custodian frame kind"): one JSON line per round in
 * `stateDir()/custodian/rounds.jsonl`, 0600, the last `ROUNDS_KEPT`. It holds counts and, for a `healthy` round, the
 * summary the round wrote with `done` — the only place that text goes, never a log or an audit line.
 */

export const ROUNDS_KEPT = 20;

export interface VerbCount {
  readonly ok: number;
  readonly refused: number;
}

export interface RoundCounts {
  readonly sessions: VerbCount;
  readonly close: VerbCount;
  readonly notes: VerbCount;
  readonly done: VerbCount;
  readonly worktrees: { readonly removed: number; readonly kept: number };
}

export const ROUND_REASONS = ["done", "deadline", "exited", "lost"] as const;
export type RoundReason = (typeof ROUND_REASONS)[number];

export interface RoundEntry {
  readonly start: number;
  readonly end: number;
  readonly exclave: string;
  readonly outcome: "healthy" | "failed";
  readonly reason: RoundReason;
  readonly counts: RoundCounts;
  readonly summary?: string;
}

export function emptyCounts(): RoundCounts {
  const zero = { ok: 0, refused: 0 };
  return { sessions: zero, close: zero, notes: zero, done: zero, worktrees: { removed: 0, kept: 0 } };
}

/** `counts` with one verb's tally moved by one. */
export function countedVerb(counts: RoundCounts, verb: CustodianVerb, ok: boolean): RoundCounts {
  const was = counts[verb];
  return { ...counts, [verb]: ok ? { ...was, ok: was.ok + 1 } : { ...was, refused: was.refused + 1 } };
}

const wholeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function verbCountOf(raw: unknown): VerbCount | null {
  return isRecord(raw) && wholeNumber(raw["ok"]) && wholeNumber(raw["refused"])
    ? { ok: raw["ok"], refused: raw["refused"] }
    : null;
}

function countsOf(raw: unknown): RoundCounts | null {
  if (!isRecord(raw)) return null;
  const sessions = verbCountOf(raw["sessions"]);
  const close = verbCountOf(raw["close"]);
  const notes = verbCountOf(raw["notes"]);
  const done = verbCountOf(raw["done"]);
  const worktrees = raw["worktrees"];
  if (
    sessions === null ||
    close === null ||
    notes === null ||
    done === null ||
    !isRecord(worktrees) ||
    !wholeNumber(worktrees["removed"]) ||
    !wholeNumber(worktrees["kept"])
  ) {
    return null;
  }
  return { sessions, close, notes, done, worktrees: { removed: worktrees["removed"], kept: worktrees["kept"] } };
}

/** One line, strictly: a line it cannot read is not carried forward. */
export function parseRoundEntry(line: string): RoundEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { start, end, exclave, outcome, reason, summary } = raw;
  const counts = countsOf(raw["counts"]);
  const knownReason = ROUND_REASONS.find((candidate) => candidate === reason);
  if (
    !wholeNumber(start) ||
    !wholeNumber(end) ||
    typeof exclave !== "string" ||
    (outcome !== "healthy" && outcome !== "failed") ||
    knownReason === undefined ||
    counts === null ||
    !(summary === undefined || typeof summary === "string")
  ) {
    return null;
  }
  return {
    start,
    end,
    exclave,
    outcome,
    reason: knownReason,
    counts,
    ...(summary === undefined ? {} : { summary }),
  };
}

/** Oldest first; a missing file is no rounds. */
export async function readRounds(path: string): Promise<readonly RoundEntry[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").flatMap((line) => {
    const entry = line === "" ? null : parseRoundEntry(line);
    return entry === null ? [] : [entry];
  });
}

/** `writeDurable` is not serialized: every write here chains behind the one before. */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Records a round by its start: an entry with the same `start` is replaced only when it is not `healthy`, so a
 * `done` followed by a crash and a deadline end keeps the healthy line. Anything else is appended, and only the
 * last `ROUNDS_KEPT` stay.
 */
export function upsertRound(path: string, entry: RoundEntry): Promise<void> {
  const apply = async (): Promise<void> => {
    const rounds = [...(await readRounds(path))];
    const at = rounds.findIndex((round) => round.start === entry.start);
    const existing = rounds[at];
    if (existing?.outcome === "healthy") return;
    if (at >= 0) rounds[at] = entry;
    else rounds.push(entry);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeDurable(
      path,
      `${rounds
        .slice(-ROUNDS_KEPT)
        .map((round) => JSON.stringify(round))
        .join("\n")}\n`,
      0o600,
    );
  };
  const run = chain.then(apply);
  chain = run.catch(() => {});
  return run;
}
