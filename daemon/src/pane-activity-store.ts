import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord, SESSION_STATES } from "@seance/shared";
import type { TrackedState } from "./pane-activity.ts";
import { writeAtomic } from "./state.ts";

/**
 * The custodian's per-pane activity as the last process left it (`custodian/activity.json`; DESIGN.md, "Per-pane
 * retention and the screen sampler"), so a restart does not read every session already at rest as `unobserved`. One
 * entry per pane with a state: the pane id, the pane process (pid and start time, since tmux reuses `%n` after a server
 * restart and the kernel reuses pids), the state facts, and the screen's normalised hash. Never screen text. A reloaded
 * entry proves nothing until the sampler finds the screen still hashing the same (`pane-activity.ts`).
 */
export interface SavedActivity {
  readonly pane: string;
  readonly pid: number;
  readonly start: string;
  readonly state: TrackedState;
  readonly stateSince: number;
  readonly turnEnded: boolean;
  readonly hash: string;
  readonly screenSince: number;
}

const VERSION = 1;
const PANE_ID = /^%\d+$/u;

function savedEntry(raw: unknown): SavedActivity | null {
  if (!isRecord(raw)) return null;
  const { pane, pid, start, state, stateSince, turnEnded, hash, screenSince } = raw;
  if (typeof pane !== "string" || !PANE_ID.test(pane)) return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof start !== "string" || start === "") return null;
  const tracked = SESSION_STATES.find((each): each is TrackedState => each === state && each !== "done");
  if (tracked === undefined) return null;
  if (typeof stateSince !== "number" || !Number.isFinite(stateSince)) return null;
  if (typeof turnEnded !== "boolean" || typeof hash !== "string" || hash === "") return null;
  if (typeof screenSince !== "number" || !Number.isFinite(screenSince)) return null;
  return { pane, pid, start, state: tracked, stateSince, turnEnded, hash, screenSince };
}

/** Null for a file that is not this shape at all; a malformed entry alone is dropped. */
export function parseSavedActivity(raw: unknown): readonly SavedActivity[] | null {
  if (!isRecord(raw) || raw["v"] !== VERSION || !Array.isArray(raw["panes"])) return null;
  return raw["panes"].flatMap((each: unknown) => savedEntry(each) ?? []);
}

/** Empty when missing; an unreadable or corrupt file is warned about and read as empty, never a failed start. */
export async function readSavedActivity(path: string, warn: (line: string) => void): Promise<readonly SavedActivity[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (!(isRecord(err) && err["code"] === "ENOENT"))
      warn(`custodian: could not read ${path}; pane activity starts empty`);
    return [];
  }
  let parsed: readonly SavedActivity[] | null = null;
  try {
    parsed = parseSavedActivity(JSON.parse(text));
  } catch {
    // Falls through to the warning.
  }
  if (parsed === null) warn(`custodian: ${path} is unreadable; pane activity starts empty`);
  return parsed ?? [];
}

export async function writeSavedActivity(path: string, panes: readonly SavedActivity[]): Promise<void> {
  // `writeAtomic` makes a missing dir with the default mode; the custodian dir is 0700 wherever it is made.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeAtomic(path, { v: VERSION, panes });
}
