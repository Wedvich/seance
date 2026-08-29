import { constants } from "node:fs";
import { access, appendFile, chmod, mkdir, open, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import { DEFAULT_EFFORT, DEFAULT_MODEL, quote, type SpawnRequest, type UpdateOutcome } from "@seance/shared";
import type { SpawnOutcome } from "./backend.ts";
import type { Check } from "./check.ts";
import { fingerprintText } from "./hash.ts";
import { formatLine, log } from "./log.ts";
import { logPath } from "./paths.ts";

/**
 * The first question when a line looks unfamiliar. `cli` at 2pm is the human at
 * the keyboard; `relay` at 3am with the phone in a drawer is not. `local` is
 * neither: something on this box drove the daemon over its op socket without
 * touching the relay — in practice a Claude session holding the MCP server, so
 * the `client` tag beside it is the rest of the answer.
 */
export type SpawnOrigin = "relay" | "cli" | "local";

export type AuditSink = (line: string) => void | Promise<void>;

/**
 * Owner-only, like config.json and the sealed PSK blobs — this is the file that
 * records repo paths, device ids and window titles unhashed, and 0644 was only
 * ever the default umask answering for it.
 */
export const AUDIT_LOG_MODE = 0o600;

/** The daemon's stdout — launchd redirects it into the file the CLI appends to. */
export const daemonSink: AuditSink = (line) => log.info(line);

/**
 * `seanced spawn` is a separate process with no launchd redirect, so it appends
 * to the log itself. Never throws: an unwritable log must not fail a spawn the
 * human asked for. Two independent writers is safe while nothing rotates the
 * file — a rename-and-recreate would leave the daemon on the old inode.
 */
export const cliSink: AuditSink = async (line) => {
  const path = logPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${formatLine("info", line)}\n`, { mode: AUDIT_LOG_MODE });
  } catch (err) {
    console.error(`could not write the audit log at ${path}: ${String(err)}`);
  }
};

/**
 * Names the state observed in production: a log the daemon's own user cannot
 * append to, so `seanced spawn` records nothing and the both-paths-audit
 * invariant holds only for `origin=relay`.
 */
export function unwritableLogMessage(path: string, user: string): string {
  return (
    `the audit log at ${path} is not writable by ${user} — spawns typed at this machine go unrecorded. ` +
    `This is what a service redirect opened as root leaves behind: sudo chown ${user} ${path} && sudo chmod 600 ${path}`
  );
}

/**
 * Makes the log exist, owner-only and appendable, before anything writes to it.
 * Returns null when it is, otherwise what the operator has to run — the daemon
 * warns and keeps serving, matching `cliSink`'s posture: a broken audit trail
 * is not a reason to take the machine offline.
 *
 * Repair rather than reinstall, because `install --system` chowns the log once
 * and systemd re-creates it as root — `StandardOutput=append:` is opened before
 * the drop to `User=` — every time it goes missing afterwards. What is not
 * repairable from an unprivileged daemon is the ownership of someone else's
 * file, hence the message.
 *
 * Never renames or truncates: the daemon's redirect holds an fd on this inode
 * and the CLI appends to it by name, so rotating it under them would split the
 * trail across two files (see `cliSink`).
 */
export async function ensureAuditLog(path: string = logPath()): Promise<string | null> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const info = await stat(path).catch(() => null);
    if (info === null) {
      // Created 0600 outright rather than written and chmod'd, as the PSK blobs
      // are; "a" is what makes creating it safe on a file that already exists.
      await (await open(path, "a", AUDIT_LOG_MODE)).close();
    } else if (ownedByUs(info.uid) && (info.mode & 0o777) !== AUDIT_LOG_MODE) {
      // The redirect creates it at the manager's umask, so tightening it is the
      // daemon's job on every start, not the installer's once.
      await chmod(path, AUDIT_LOG_MODE);
    }
  } catch (err) {
    return `could not prepare the audit log at ${path}: ${String(err)} — spawns typed at this machine go unrecorded`;
  }
  return (await writable(path)) ? null : unwritableLogMessage(path, userInfo().username);
}

/** Doctor's audit-log section: writability first — size was never the question worth asking. */
export async function auditLogChecks(path: string = logPath()): Promise<readonly Check[]> {
  const info = await stat(path).catch(() => null);
  if (info === null) return [];
  if (!(await writable(path))) {
    // No size line under the fail: an `ok` verdict on the same broken file reads
    // as re-checked-and-passed — and "consider truncating" a file the user can't
    // write is not advice.
    return [{ level: "fail", message: unwritableLogMessage(path, userInfo().username) }];
  }
  const checks: Check[] = [];
  if ((info.mode & 0o777) !== AUDIT_LOG_MODE) {
    const mode = (info.mode & 0o777).toString(8).padStart(4, "0");
    const exposure = `log is ${mode}, and it records repo paths and window titles`;
    // `seanced restart` repairs the mode only on a file the daemon owns
    // (ensureAuditLog); on someone else's file the honest fix is the chown pair.
    checks.push({
      level: "warn",
      message: ownedByUs(info.uid)
        ? `${exposure} — \`seanced restart\` tightens it to 0600`
        : `${exposure} — owned by another user, so restart can't tighten it: ` +
          `sudo chown ${userInfo().username} ${path} && sudo chmod 600 ${path}`,
    });
  }
  const size = info.size;
  checks.push(
    size > 10 * 1024 * 1024
      ? { level: "warn", message: `log is ${Math.round(size / 1024 / 1024)}MB — consider truncating (${path})` }
      : { level: "ok", message: `log ${Math.round(size / 1024)}KB (${path})` },
  );
  return checks;
}

function ownedByUs(uid: number): boolean {
  const me = process.getuid?.();
  return me === undefined || me === uid;
}

async function writable(path: string): Promise<boolean> {
  return access(path, constants.W_OK).then(
    () => true,
    () => false,
  );
}

export interface SpawnAudit {
  readonly request: (request: SpawnRequest) => Promise<void>;
  readonly ok: (outcome: SpawnOutcome) => Promise<void>;
  readonly failed: (code: string) => Promise<void>;
  readonly rejected: (reason: string) => Promise<void>;
}

/**
 * Every spawn path audits through here so they never drift into formats that
 * need three greps. The prompt is recorded as a length plus eight hex of SHA-256,
 * never quoted — the log is plaintext at rest, and a hash still answers "was
 * that mine?" without turning it into a transcript of everything ever asked.
 */
export function spawnAudit(origin: SpawnOrigin, sink: AuditSink): SpawnAudit {
  const emit = async (rest: string): Promise<void> => {
    await sink(`audit spawn origin=${origin} ${rest}`);
  };
  return {
    request: async (request: SpawnRequest): Promise<void> => {
      const prompt = request.prompt ?? "";
      const promptNote =
        prompt === "" ? "prompt=none" : `promptLen=${prompt.length} promptSha=${await fingerprintText(prompt)}`;
      // First when present, so `origin=relay client=…` reads as one attribution.
      const clientNote = request.client === undefined ? "" : `client=${quote(request.client)} `;
      // Only when on, so every ordinary spawn's line stays byte-identical.
      const planNote = request.plan === true ? "plan=true " : "";
      await emit(
        `${clientNote}repo=${quote(request.repo)} mode=${request.mode} title=${quote(request.title ?? "")} ` +
          `model=${quote(request.model ?? DEFAULT_MODEL)} effort=${quote(request.effort ?? DEFAULT_EFFORT)} ` +
          planNote +
          promptNote,
      );
    },
    ok: async (outcome: SpawnOutcome): Promise<void> => {
      await emit(`ok window=${quote(outcome.window)} path=${quote(outcome.path)}`);
    },
    failed: async (code: string): Promise<void> => {
      await emit(`failed code=${code}`);
    },
    rejected: async (reason: string): Promise<void> => {
      await emit(`rejected ${reason}`);
    },
  };
}

/** What triggered a self-update check: a fleet announce, or this daemon's own register. */
export type UpdateOrigin = "announce" | "register";

export interface UpdateAudit {
  readonly checking: (sha: string) => Promise<void>;
  readonly outcome: (outcome: UpdateOutcome, detail?: string) => Promise<void>;
}

/** Self-updates audit like spawns — same sink, one formatter — so "what changed my machine at 3am" is one grep. */
export function updateAudit(origin: UpdateOrigin, sink: AuditSink): UpdateAudit {
  const emit = async (rest: string): Promise<void> => {
    await sink(`audit update origin=${origin} ${rest}`);
  };
  return {
    checking: (sha: string): Promise<void> => emit(`checking head=${sha.slice(0, 12)}`),
    outcome: (outcome: UpdateOutcome, detail?: string): Promise<void> =>
      emit(`outcome=${outcome}${detail === undefined ? "" : ` detail=${quote(detail)}`}`),
  };
}
