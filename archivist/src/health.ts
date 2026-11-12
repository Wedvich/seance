import { stat } from "node:fs/promises";
import {
  APP_ID,
  parseArchiveStatusRequest,
  quote,
  type ArchiveStatusReply,
  type ArchiveStatusResponse,
  type ArchiveTableStatus,
  type Plain,
} from "@seance/shared";
import type { Archive } from "./archive.ts";
import type { IngestClock } from "./ingest-clock.ts";
import type { MetricsArchive } from "./metrics-archive.ts";

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
      latest = { tasks, events, samples: latest?.samples ?? null, countedAt: now() };
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
    };
  };
}

/**
 * The seat's answer to an `archive-status` request: only to one sealed `from`
 * the app and carrying no `re`, parsed by its own parser. The transport has
 * already checked addressing, opening and the replay guard. A drop returns
 * null; the reply goes back as the handler's return value, which the shared
 * client seals to the sender.
 */
export async function answerArchiveStatus(
  plain: Plain,
  from: string,
  answer: () => Promise<ArchiveStatusResponse>,
  log: { readonly warn: (line: string) => void },
): Promise<Plain | null> {
  if (from !== APP_ID || plain.re !== undefined) {
    log.warn(`dropped ${quote(plain.op)} from ${from}: not sealed from the app`);
    return null;
  }
  const reply = async (): Promise<ArchiveStatusReply> => {
    if (parseArchiveStatusRequest(plain.payload) === null) {
      return { ok: false, code: "invalid_request", message: "malformed archive-status request" };
    }
    try {
      return await answer();
    } catch (err) {
      log.warn(`archive status failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, code: "internal_error", message: "archive status failed" };
    }
  };
  return { id: crypto.randomUUID(), ts: Date.now(), op: "archive-status", re: plain.id, payload: await reply() };
}
