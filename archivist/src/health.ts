import { stat } from "node:fs/promises";
import {
  parseArchiveStatusRequest,
  type ArchiveStatusResponse,
  type ArchiveTableStatus,
  type Plain,
} from "@seance/shared";
import { answerApp } from "./answer.ts";
import type { Archive } from "./archive.ts";
import type { IngestClock } from "./ingest-clock.ts";
import type { MetricsArchive } from "./metrics-archive.ts";
import type { RefusalTally } from "./refusal-tally.ts";

/**
 * Counts are taken in the background, never in a request: the sample tiers are
 * tens of millions of rows on a mature fleet, and a request that scanned them
 * would sit on the one event loop the seat socket shares. The card tolerates
 * numbers a few minutes old.
 */
export const COUNT_INTERVAL_MS = 5 * 60_000;

export interface Counted {
  readonly tasks: ArchiveTableStatus;
  readonly events: ArchiveTableStatus;
  /** Null until the first chunked sample count finishes. */
  readonly samples: ArchiveTableStatus | null;
  readonly countedAt: number;
}

export interface CountRefresher {
  /** The last completed (or, on the first pass, partly completed) counts; null before any. */
  readonly snapshot: () => Counted | null;
  /** One pass; a pass already running is joined, never doubled. */
  readonly refresh: () => Promise<void>;
  readonly stop: () => void;
}

export interface RefresherDeps {
  readonly archive: Pick<Archive, "counts">;
  readonly metrics: Pick<MetricsArchive, "countSamples">;
  readonly log: { readonly warn: (line: string) => void };
  readonly intervalMs?: number;
  readonly now?: () => number;
}

/** Starts with a pass at once, then one every interval. A failed pass logs its message and keeps the previous value. */
export function startCountRefresher(deps: RefresherDeps): CountRefresher {
  const { archive, metrics, log } = deps;
  const now = deps.now ?? Date.now;
  let latest: Counted | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  const pass = async (): Promise<void> => {
    try {
      const { tasks, events } = archive.counts();
      // Early publish keeps the older samples, so it keeps their time too: countedAt dates every count in the reply.
      latest = { tasks, events, samples: latest?.samples ?? null, countedAt: latest?.countedAt ?? now() };
      const samples = await metrics.countSamples();
      if (stopped) return;
      latest = { tasks, events, samples, countedAt: now() };
    } catch (err) {
      if (!stopped) log.warn(`archive counts: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    running ??= pass().finally(() => {
      running = null;
    });
    return running;
  };

  void refresh();
  const timer = setInterval(() => void refresh(), deps.intervalMs ?? COUNT_INTERVAL_MS);
  return {
    snapshot: () => latest,
    refresh,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export interface HealthDeps {
  readonly counts: () => Counted | null;
  readonly clock: IngestClock;
  readonly refusals: Pick<RefusalTally, "snapshot">;
  /** Ms the seat socket last registered; null while it is down. */
  readonly onlineSince: () => number | null;
  readonly archivePath: string;
  readonly metricsPath: string;
}

/** A database's size is its file plus its write-ahead log, which holds what the file does not yet. */
async function sizeWithWal(path: string): Promise<number> {
  const main = (await stat(path)).size;
  try {
    return main + (await stat(`${path}-wal`)).size;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return main;
    throw err;
  }
}

/** Takes only `stat` calls and a snapshot read, so it answers well inside the op's deadline. */
export function createStatusAnswer(deps: HealthDeps): () => Promise<ArchiveStatusResponse> {
  return async () => {
    const [archiveBytes, metricsBytes] = await Promise.all([
      sizeWithWal(deps.archivePath),
      sizeWithWal(deps.metricsPath),
    ]);
    const counted = deps.counts();
    return {
      ok: true,
      onlineSince: deps.onlineSince(),
      lastIngest: deps.clock.snapshot(),
      tasks: counted?.tasks ?? null,
      samples: counted?.samples ?? null,
      events: counted?.events ?? null,
      database: { archiveBytes, metricsBytes },
      countedAt: counted?.countedAt ?? null,
      refused: deps.refusals.snapshot(),
    };
  };
}

/** The seat's answer to an `archive-status` request, through `answerApp`'s gate. */
export function answerArchiveStatus(
  plain: Plain,
  from: string,
  answer: () => Promise<ArchiveStatusResponse>,
  log: { readonly warn: (line: string) => void },
): Promise<Plain | null> {
  return answerApp(plain, from, "archive-status", parseArchiveStatusRequest, answer, log);
}
