import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isMessageId,
  isRecord,
  isWatchHead,
  isWatchKey,
  parseGithubPr,
  parseGithubRun,
  WATCH_SEEN_MAX,
} from "@seance/shared";
import { writeAtomic } from "./state.ts";

/**
 * The daemon's watch table as the last process left it (`stateDir()/watches.json`, 0600; DESIGN.md, "Watches"), so a
 * self-update does not end every session's watches. Ids, targets (as the URL the grammar rebuilds), event keys and
 * the identity of the session each belongs to: pane id, the pane process and the `claude` process (pid and start
 * time, since tmux reuses `%n` and the kernel reuses pids) and the task. Never a note, a check name or a reading. An
 * entry reloads only while all of that still matches (`watches.ts`).
 */
export interface SavedWatch {
  readonly id: string;
  readonly kind: "pr" | "run";
  readonly url: string;
  readonly head?: string;
  /** The event keys the daemon placed, so a new leader does not repeat them. Never a local note marker. */
  readonly seen: readonly string[];
  readonly pane: string;
  readonly panePid: number;
  readonly paneStart: string;
  /** `<pid>:<start>` of the session's `claude` process. */
  readonly session: string;
  readonly task: string | null;
  readonly madeAt: number;
  readonly expiresAt: number;
  /** The `no_leader` note was sent: once for the watch's life. */
  readonly noLeaderTold: boolean;
  /** The late `fleet_full` note was sent: once for the watch's life. */
  readonly fleetFullTold: boolean;
}

const VERSION = 1;
const PANE_ID = /^%\d+$/u;
const SESSION_KEY = /^\d+:.+$/u;

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function savedEntry(raw: unknown): SavedWatch | null {
  if (!isRecord(raw)) return null;
  const { id, kind, url, head, seen, pane, panePid, paneStart, session, task, madeAt, expiresAt } = raw;
  if (!isMessageId(id) || typeof url !== "string") return null;
  // The URL is re-parsed, never trusted: a hand-edited file must not put a string the poller would not accept in a set.
  if (kind !== "pr" && kind !== "run") return null;
  if ((kind === "pr" ? parseGithubPr(url) : parseGithubRun(url)) === null) return null;
  if (head !== undefined && (kind !== "pr" || !isWatchHead(head))) return null;
  if (!Array.isArray(seen) || seen.length > WATCH_SEEN_MAX) return null;
  const keys: string[] = [];
  for (const key of seen) {
    if (!isWatchKey(key)) return null;
    keys.push(key);
  }
  if (typeof pane !== "string" || !PANE_ID.test(pane)) return null;
  if (typeof panePid !== "number" || !Number.isSafeInteger(panePid) || panePid <= 0) return null;
  if (typeof paneStart !== "string" || paneStart === "") return null;
  if (typeof session !== "string" || !SESSION_KEY.test(session)) return null;
  if (task !== null && typeof task !== "string") return null;
  if (!isTime(madeAt) || !isTime(expiresAt)) return null;
  const { noLeaderTold, fleetFullTold } = raw;
  if (typeof noLeaderTold !== "boolean" || typeof fleetFullTold !== "boolean") return null;
  return {
    id,
    kind,
    url,
    ...(head === undefined ? {} : { head }),
    seen: keys,
    pane,
    panePid,
    paneStart,
    session,
    task,
    madeAt,
    expiresAt,
    noLeaderTold,
    fleetFullTold,
  };
}

/** Null for a file that is not this shape at all; a malformed entry alone is dropped. */
export function parseSavedWatches(raw: unknown): readonly SavedWatch[] | null {
  if (!isRecord(raw) || raw["v"] !== VERSION || !Array.isArray(raw["watches"])) return null;
  return raw["watches"].flatMap((each: unknown) => savedEntry(each) ?? []);
}

/**
 * Empty when missing; an unreadable or corrupt file is warned about and read as empty, never a failed start. The line
 * names the path and nothing of the content.
 */
export async function readSavedWatches(path: string, warn: (line: string) => void): Promise<readonly SavedWatch[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (!(isRecord(err) && err["code"] === "ENOENT")) warn(`watches: could not read ${path}; the table starts empty`);
    return [];
  }
  let parsed: readonly SavedWatch[] | null = null;
  try {
    parsed = parseSavedWatches(JSON.parse(text));
  } catch {
    // Falls through to the warning.
  }
  if (parsed === null) warn(`watches: ${path} is unreadable; the table starts empty`);
  return parsed ?? [];
}

export async function writeSavedWatches(path: string, watches: readonly SavedWatch[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeAtomic(path, { v: VERSION, watches });
}
