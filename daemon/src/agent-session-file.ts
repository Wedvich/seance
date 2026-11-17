import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isAgentSessionId, isRecord, isRemoteSessionId } from "@seance/shared";

/**
 * `<configDir>/sessions/<pid>.json`, the file Claude Code writes for each running process past the trust dialog
 * (docs/tags.md §4.1, spikes S1–S3): `pid`, `sessionId`, `procStart` and, while Remote Control is on,
 * `bridgeSessionId`. It is the daemon's own witness of which conversation a `claude` process is in, read to verify an
 * `agent.session` claim and never taken as a claim itself. Undocumented behaviour, observed on Claude Code 2.1.326:
 * re-verified on upgrades, and a missing or changed file only means "claimed", never a failure. Nothing read here is
 * logged.
 */

const SESSION_FILE = /^(\d{1,10})\.json$/u;
const MAX_FILE_BYTES = 64 * 1024;

/**
 * The file is Claude Code's to write, and any same-uid process's, so it is opened as untrusted: no symlink followed,
 * no blocking on a FIFO, and only a regular file read, at most `MAX_FILE_BYTES` of it — all checked on the opened
 * descriptor. Null for anything else, a parse failure included. The custodian round's link reads through it too.
 */
export async function readSessionFile(path: string): Promise<Record<string, unknown> | null> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, flags).catch(() => null);
  if (handle === null) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_FILE_BYTES) return null;
    const raw: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** The pids that have a `<pid>.json` in a config dir's `sessions/`: only those names, never its `<pid>.<hash>.key` files. */
export async function sessionFilePids(configDir: string): Promise<readonly number[]> {
  const names = await readdir(join(configDir, "sessions")).catch((): string[] => []);
  return names.flatMap((name) => {
    const pid = SESSION_FILE.exec(name)?.[1];
    return pid === undefined ? [] : [Number(pid)];
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CTIME = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u;

/** A zone-less `ctime` string (`Tue Nov 17 09:03:05 2026`) read as UTC, in whole seconds; null for any other shape. */
export function ctimeUtcSeconds(text: string): number | null {
  const match = CTIME.exec(text);
  if (match === null) return null;
  const [, month, day, hh, mm, ss, year] = match;
  const monthIndex = MONTHS.indexOf(month ?? "");
  if (monthIndex < 0) return null;
  const ms = Date.UTC(Number(year), monthIndex, Number(day), Number(hh), Number(mm), Number(ss));
  // A day the month lacks rolls over in `Date.UTC`: refused rather than matched to a neighbouring second.
  const back = new Date(ms);
  if (back.getUTCDate() !== Number(day) || back.getUTCMonth() !== monthIndex) return null;
  return ms / 1000;
}

/**
 * Whether a file's `procStart` names the same process start as `processStart` (`peer.ts`), read by the platform this
 * daemon runs on, never guessed from its shape (S3). Linux: both are `/proc/<pid>/stat`'s start in clock ticks since
 * boot, so equal strings, exact to the tick. macOS: `procStart` is the kernel's start second as a UTC `ctime` string,
 * `processStart` is `sec.usec` (the microseconds unpadded, so two integers, never a decimal): equal seconds. No other
 * platform matches.
 */
export function procStartMatches(
  procStart: unknown,
  start: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (typeof procStart !== "string") return false;
  if (platform === "linux") return /^\d+$/u.test(procStart) && procStart === start;
  if (platform !== "darwin") return false;
  const seconds = /^(\d+)\.\d+$/u.exec(start)?.[1];
  const read = ctimeUtcSeconds(procStart);
  return seconds !== undefined && read !== null && read === Number(seconds);
}

export type AgentSessionRead =
  | { readonly kind: "found"; readonly sessionId: string; readonly bridge?: string }
  | { readonly kind: "none" }
  /** More than one config dir holds a matching file: no verification. */
  | { readonly kind: "ambiguous" };

/**
 * What the file says of one `claude` process: searched in every config dir given (the default one included), a file
 * matching only when its `pid` is `pid`, its `procStart` denotes `start` and its `sessionId` is a conversation id, and
 * exactly one match required. A file for another pid or an older process (a `SIGKILL` leaves its file behind for a pid
 * the kernel may reuse) is no match.
 */
export async function readAgentSession(
  pid: number,
  start: string,
  configDirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<AgentSessionRead> {
  const reads = await Promise.all(
    [...new Set(configDirs)].map((dir) => readSessionFile(join(dir, "sessions", `${pid}.json`))),
  );
  const found = reads.flatMap((raw) => {
    if (raw === null || raw["pid"] !== pid || !procStartMatches(raw["procStart"], start, platform)) return [];
    const { sessionId, bridgeSessionId } = raw;
    if (!isAgentSessionId(sessionId)) return [];
    return [{ sessionId, ...(isRemoteSessionId(bridgeSessionId) ? { bridge: bridgeSessionId } : {}) }];
  });
  if (found.length > 1) return { kind: "ambiguous" };
  const [one] = found;
  return one === undefined ? { kind: "none" } : { kind: "found", ...one };
}
