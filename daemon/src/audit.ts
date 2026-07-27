import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_EFFORT, DEFAULT_MODEL, type SpawnRequest } from "@seance/shared";
import { fingerprintText } from "./hash.ts";
import { formatLine, log } from "./log.ts";
import { logPath } from "./paths.ts";
import type { SpawnOutcome } from "./spawn.ts";

/**
 * The first question when a line looks unfamiliar. `cli` at 2pm is the human at
 * the keyboard; `relay` at 3am with the phone in a drawer is not.
 */
export type SpawnOrigin = "relay" | "cli";

export type AuditSink = (line: string) => void | Promise<void>;

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
    await appendFile(path, `${formatLine("info", line)}\n`);
  } catch (err) {
    console.error(`could not write the audit log at ${path}: ${String(err)}`);
  }
};

/**
 * Quoted, never bare: these values arrive over the wire or off a command line,
 * and an unescaped newline in one would let a caller forge whole audit lines.
 */
export const quote = (value: string): string => JSON.stringify(value);

export interface SpawnAudit {
  readonly request: (request: SpawnRequest) => Promise<void>;
  readonly ok: (outcome: SpawnOutcome) => Promise<void>;
  readonly failed: (code: string) => Promise<void>;
  readonly rejected: (reason: string) => Promise<void>;
}

/**
 * Both spawn paths audit through here so the two never drift into formats that
 * need two greps. The prompt is recorded as a length plus eight hex of SHA-256,
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
      await emit(
        `repo=${quote(request.repo)} mode=${request.mode} title=${quote(request.title ?? "")} ` +
          `model=${quote(request.model ?? DEFAULT_MODEL)} effort=${quote(request.effort ?? DEFAULT_EFFORT)} ` +
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
