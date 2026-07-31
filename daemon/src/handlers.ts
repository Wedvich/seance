import type {
  ErrorResponse,
  Plain,
  RepoEntry,
  RescanResponse,
  SessionEntry,
  SessionsResponse,
  SpawnRequest,
  SpawnResponse,
} from "@seance/shared";
import { quote } from "@seance/shared";
import { spawnAudit, type AuditSink, type SpawnAudit } from "./audit.ts";
import { SpawnFailure, type SessionBackend } from "./backend.ts";
import { log } from "./log.ts";

export interface HandlerContext {
  readonly backend: SessionBackend;
  readonly getRepos: () => readonly RepoEntry[];
  /** Scan now, persist, re-register if the set changed; returns the fresh list. */
  readonly rescan: () => Promise<readonly RepoEntry[]>;
  /**
   * Where the audit trail goes — the daemon's stdout in production. Only the
   * transport is injectable: the formatter and the `origin=relay` tag are
   * applied below, so nothing a caller supplies can make a spawn quiet or
   * relabel it as the human at the keyboard.
   */
  readonly auditSink: AuditSink;
}

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
 * How long the ack waits for the window it just created to show up in the
 * session list. Detection keys off claude having retitled its process, which
 * can land after the spawn returns — `verifyPaneAlive` proves the pane is
 * alive, not that it is titled yet.
 */
const ACK_SETTLE_MS = 2_000;

/**
 * The app writes this list straight into its cache, so an ack short by the
 * window it just reported would render as "nothing running on that machine"
 * until something else refreshed it. A session that never titles still answers,
 * just with the short list — a late ack is worse than an incomplete one.
 */
async function sessionsIncluding(ctx: HandlerContext, window: string): Promise<readonly SessionEntry[]> {
  const deadline = Bun.nanoseconds() + ACK_SETTLE_MS * 1e6;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling: each check gates the next, nothing to parallelize
    const sessions = await ctx.backend.sessions(ctx.getRepos());
    if (sessions.some((entry) => entry.window === window)) return sessions;
    if (Bun.nanoseconds() >= deadline) return sessions;
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(100);
  }
}

async function handleSpawn(ctx: HandlerContext, audit: SpawnAudit, payload: unknown): Promise<SpawnResponse> {
  if (!isSpawnRequest(payload)) {
    await audit.rejected("malformed request");
    return { ok: false, code: "internal_error", message: "malformed spawn request" };
  }
  await audit.request(payload);
  try {
    const outcome = await ctx.backend.spawn(payload, ctx.getRepos());
    await audit.ok(outcome);
    const sessions = await sessionsIncluding(ctx, outcome.window);
    return { ok: true, ...outcome, sessions };
  } catch (err) {
    if (err instanceof SpawnFailure) {
      await audit.failed(err.code);
      return { ok: false, code: err.code, message: err.message };
    }
    log.error(`spawn crashed: ${String(err)}`);
    return { ok: false, code: "internal_error", message: String(err) };
  }
}

/** Routes decrypted request ops to their implementations and wraps the reply. */
export function createHandler(ctx: HandlerContext): (plain: Plain) => Promise<Plain | null> {
  const audit = spawnAudit("relay", ctx.auditSink);
  return async (plain: Plain): Promise<Plain | null> => {
    // Every op, not just spawn: with a stolen PSK, "something enumerated my
    // sessions at 3am" is the same signal as "something spawned".
    await ctx.auditSink(`audit request op=${quote(plain.op)} id=${quote(plain.id)}`);

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
          const sessions = await ctx.backend.sessions(ctx.getRepos());
          const payload: SessionsResponse = { sessions, at: Date.now() };
          return reply(payload);
        }
        case "spawn":
          return reply(await handleSpawn(ctx, audit, plain.payload));
        case "rescan": {
          const repos = await ctx.rescan();
          const payload: RescanResponse = { repos, scannedAt: Date.now() };
          return reply(payload);
        }
        default:
          log.warn(`ignoring unknown op ${quote(plain.op)}`);
          return null;
      }
    } catch (err) {
      log.error(`handler for ${quote(plain.op)} crashed: ${String(err)}`);
      const payload: ErrorResponse = { ok: false, code: "internal_error", message: String(err) };
      return reply(payload);
    }
  };
}
