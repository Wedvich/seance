import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isRemoteSessionId } from "@seance/shared";
import { readSessionFile } from "./agent-session-file.ts";
import { parentLookup } from "./peer.ts";

/**
 * The running round's Remote Control id, for the Machines row's "Open round" link (DESIGN.md, "The custodian's status
 * and the Machines row", "the live link"). The round runs with `--setting-sources project`, so the session-events mod
 * never runs in it and its pane is skipped by every pane reader: no session event will carry this id, and C24 keeps
 * session ids off the custodian frame. The daemon reads it instead.
 *
 * Source: undocumented Claude Code behaviour, observed on 2.1.325: `<configDir>/sessions/<pid>.json` holds `pid`,
 * `startedAt` (ms) and `bridgeSessionId`. Re-verify on Claude Code upgrades; a missing id only means no link.
 *
 * Bound to the round by process: the file's pid is the recorded round pane's pid (Linux `exec`s `claude`) or its direct
 * child (macOS's `caffeinate -is` wrapper), never any descendant, so a leftover file of a killed session whose pid a
 * round's Bash child reuses cannot link another session. Beyond that the file's own `pid` matches its name and its
 * `startedAt` is no earlier than the round's. Only `<digits>.json` names are ever opened: the directory also holds
 * `<pid>.<hash>.key` files. The id is display-only and is never logged, nor is anything that failed.
 */

const SESSION_FILE = /^(\d{1,10})\.json$/u;

export async function roundRemoteId(
  configDir: string,
  round: { readonly panePid: number; readonly startedAt: number },
  parentOf?: (pid: number) => Promise<number | null>,
): Promise<string | null> {
  try {
    const names = (await readdir(join(configDir, "sessions"))).filter((name) => SESSION_FILE.test(name));
    const parent = parentOf ?? (await parentLookup());
    for (const name of names) {
      const pid = Number(SESSION_FILE.exec(name)?.[1]);
      // oxlint-disable-next-line no-await-in-loop -- a handful of files, and the parent read is per candidate
      const bound = pid === round.panePid || (await parent(pid)) === round.panePid;
      if (!bound) continue;
      // oxlint-disable-next-line no-await-in-loop -- as above
      const id = await idOf(join(configDir, "sessions", name), pid, round.startedAt);
      if (id !== null) return id;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The file is the round's Claude Code's to write, and any same-uid process's (4b masks the config dir from the round's
 * Bash, drilled), so it is opened as untrusted (`readSessionFile`).
 */
async function idOf(path: string, pid: number, roundStartedAt: number): Promise<string | null> {
  const raw = await readSessionFile(path);
  if (raw === null || raw["pid"] !== pid) return null;
  const { startedAt, bridgeSessionId } = raw;
  if (typeof startedAt !== "number" || startedAt < roundStartedAt) return null;
  return isRemoteSessionId(bridgeSessionId) ? bridgeSessionId : null;
}
