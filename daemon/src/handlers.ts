import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  type ErrorResponse,
  type Plain,
  type RepoEntry,
  type RescanResponse,
  type SessionsResponse,
  type SpawnRequest,
  type SpawnResponse,
} from "@seance/shared";
import { fingerprintText } from "./hash.ts";
import { log } from "./log.ts";
import { listClaudeSessions } from "./sessions.ts";
import { SpawnFailure, spawnSession } from "./spawn.ts";

export interface HandlerContext {
  readonly tmuxSession: string;
  readonly getRepos: () => readonly RepoEntry[];
  /** Scan now, persist, re-register if the set changed; returns the fresh list. */
  readonly rescan: () => Promise<readonly RepoEntry[]>;
  readonly spawnWaitMs?: number;
}

/**
 * Quoted, never bare: every value below arrives over the wire, and an
 * unescaped newline in one would let a caller forge whole audit lines.
 */
const q = (value: string): string => JSON.stringify(value);

function isSpawnRequest(payload: unknown): payload is SpawnRequest {
  if (typeof payload !== "object" || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  if (typeof obj["repo"] !== "string" || obj["repo"] === "") return false;
  if (obj["mode"] !== "worktree" && obj["mode"] !== "here") return false;
  for (const key of ["prompt", "title", "model", "effort"]) {
    if (obj[key] !== undefined && typeof obj[key] !== "string") return false;
  }
  return true;
}

/**
 * The prompt is hashed, not logged: this file is plaintext at rest, and a
 * length plus eight hex characters is enough to answer "was that mine?"
 * without turning the log into a transcript.
 */
async function auditSpawnRequest(request: SpawnRequest): Promise<void> {
  const prompt = request.prompt ?? "";
  const promptNote =
    prompt === "" ? "prompt=none" : `promptLen=${prompt.length} promptSha=${await fingerprintText(prompt)}`;
  log.info(
    `audit spawn repo=${q(request.repo)} mode=${request.mode} title=${q(request.title ?? "")} ` +
      `model=${q(request.model ?? DEFAULT_MODEL)} effort=${q(request.effort ?? DEFAULT_EFFORT)} ${promptNote}`,
  );
}

async function handleSpawn(ctx: HandlerContext, payload: unknown): Promise<SpawnResponse> {
  if (!isSpawnRequest(payload)) {
    log.warn("audit spawn rejected: malformed request");
    return { ok: false, code: "internal_error", message: "malformed spawn request" };
  }
  await auditSpawnRequest(payload);
  try {
    const outcome = await spawnSession(payload, ctx.getRepos(), ctx.tmuxSession, {
      ...(ctx.spawnWaitMs !== undefined ? { waitMs: ctx.spawnWaitMs } : {}),
    });
    log.info(`audit spawn ok window=${q(outcome.window)} path=${q(outcome.path)}`);
    const sessions = await listClaudeSessions(ctx.getRepos());
    return { ok: true, ...outcome, sessions };
  } catch (err) {
    if (err instanceof SpawnFailure) {
      log.warn(`audit spawn failed code=${err.code}`);
      return { ok: false, code: err.code, message: err.message };
    }
    log.error(`spawn crashed: ${String(err)}`);
    return { ok: false, code: "internal_error", message: String(err) };
  }
}

/** Routes decrypted request ops to their implementations and wraps the reply. */
export function createHandler(ctx: HandlerContext): (plain: Plain) => Promise<Plain | null> {
  return async (plain: Plain): Promise<Plain | null> => {
    // Every op, not just spawn: with a stolen PSK, "something enumerated my
    // sessions at 3am" is the same signal as "something spawned".
    log.info(`audit request op=${q(plain.op)} id=${q(plain.id)}`);

    const reply = (payload: unknown): Plain => ({
      id: crypto.randomUUID(),
      ts: Date.now(),
      op: plain.op,
      re: plain.id,
      payload,
    });

    try {
      switch (plain.op) {
        case "sessions": {
          const sessions = await listClaudeSessions(ctx.getRepos());
          const payload: SessionsResponse = { sessions, at: Date.now() };
          return reply(payload);
        }
        case "spawn":
          return reply(await handleSpawn(ctx, plain.payload));
        case "rescan": {
          const repos = await ctx.rescan();
          const payload: RescanResponse = { repos, scannedAt: Date.now() };
          return reply(payload);
        }
        default:
          log.warn(`ignoring unknown op ${q(plain.op)}`);
          return null;
      }
    } catch (err) {
      log.error(`handler for ${q(plain.op)} crashed: ${String(err)}`);
      const payload: ErrorResponse = { ok: false, code: "internal_error", message: String(err) };
      return reply(payload);
    }
  };
}
