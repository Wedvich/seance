import {
  ARCHIVE_TASKS_PAGE,
  parseArchiveMetricsRequest,
  parseArchiveTasksRequest,
  parseTask,
  REPLY_JSON_BUDGET,
  type ArchivedTask,
  type ArchiveMetricsRequest,
  type ArchiveTasksCursor,
  type ArchiveTasksRequest,
  type ArchiveTasksResponse,
  type MetricsReply,
  type MetricsResponse,
  type Plain,
} from "@seance/shared";
import { answerApp } from "./answer.ts";
import { archivedTask, type Archive, type ArchivedRow } from "./archive.ts";
import type { MetricsArchive } from "./metrics-archive.ts";

type Log = { readonly warn: (line: string) => void };

/** Room a page keeps for its own `ok`, `total` and `next` beside the rows. */
const PAGE_FRAME_BYTES = 512;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * A stored record as the reply carries it: parsed again and passed through
 * `archivedTask` again, so a row an older build or a hand edit left with a
 * prompt, an attachment manifest or a raw account id still sends none (A14).
 * Null for a record this build cannot read.
 */
function archivedEntry(row: ArchivedRow): ArchivedTask | null {
  let record: unknown;
  try {
    record = JSON.parse(row.record);
  } catch {
    return null;
  }
  const task = parseTask(record);
  if (task === null) return null;
  return {
    task: archivedTask(task),
    endedAt: row.endedAt,
    machine: row.machine,
    account: row.account,
    alias: row.alias,
  };
}

function cursorOf(row: ArchivedRow): ArchiveTasksCursor {
  return { endedAt: row.endedAt, createdAt: row.createdAt, id: row.id };
}

/**
 * One page: up to `limit` rows, filled to `REPLY_JSON_BUDGET` (the leader's
 * `queue` budget, which seals inside `ENVELOPE_MAX_CT_LENGTH`), never fewer
 * than one while any match. `next` follows the last row consumed whenever a
 * row is left, so a page cut short by size loses nothing. A record that does
 * not parse is skipped, counted in one warning, and still consumed.
 */
export function createTasksAnswer(
  archive: Pick<Archive, "queryTasks">,
  log: Log,
): (query: ArchiveTasksRequest) => ArchiveTasksResponse {
  return (query) => {
    const limit = query.limit ?? ARCHIVE_TASKS_PAGE;
    const { rows, total } = archive.queryTasks(query, limit + 1);
    let left = REPLY_JSON_BUDGET - PAGE_FRAME_BYTES;
    const tasks: ArchivedTask[] = [];
    let consumed: ArchivedRow | null = null;
    let cut = false;
    let unreadable = 0;
    for (const row of rows.slice(0, limit)) {
      const entry = archivedEntry(row);
      if (entry === null) {
        unreadable += 1;
        consumed = row;
        continue;
      }
      const size = jsonBytes(entry) + 1;
      if (tasks.length > 0 && size > left) {
        cut = true;
        break;
      }
      left -= size;
      tasks.push(entry);
      consumed = row;
    }
    if (unreadable > 0) log.warn(`archive tasks: skipped ${unreadable} unreadable record(s)`);
    const more = cut || rows.length > limit;
    return { ok: true, tasks, total, next: more && consumed !== null ? cursorOf(consumed) : null };
  };
}

export function createMetricsAnswer(
  metrics: Pick<MetricsArchive, "queryArchive">,
): (query: ArchiveMetricsRequest) => MetricsReply {
  return (query) => {
    const reply: MetricsResponse = { series: metrics.queryArchive(query) };
    // Refused here, not left to the transport's bare `too_large`: a year at 1 d over many series is the case, and the message says how to ask.
    if (jsonBytes(reply) <= REPLY_JSON_BUDGET - PAGE_FRAME_BYTES) return reply;
    return {
      ok: false,
      code: "too_large",
      message: "reply too large: ask fewer names, or a shorter range or coarser step",
    };
  };
}

export function answerArchiveTasks(
  plain: Plain,
  from: string,
  answer: (query: ArchiveTasksRequest) => ArchiveTasksResponse,
  log: Log,
): Promise<Plain | null> {
  return answerApp(plain, from, "archive-tasks", parseArchiveTasksRequest, answer, log);
}

export function answerArchiveMetrics(
  plain: Plain,
  from: string,
  answer: ReturnType<typeof createMetricsAnswer>,
  log: Log,
): Promise<Plain | null> {
  return answerApp(plain, from, "archive-metrics", parseArchiveMetricsRequest, answer, log);
}
