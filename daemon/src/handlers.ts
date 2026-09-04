import type {
  ErrorResponse,
  Plain,
  RepoEntry,
  RescanResponse,
  SessionEntry,
  SessionsResponse,
  SpawnRequest,
  SpawnResponse,
  UpdateAvailable,
} from "@seance/shared";
import { quote } from "@seance/shared";
import { spawnAudit, type AuditSink, type SpawnAudit, type SpawnOrigin } from "./audit.ts";
import { SpawnFailure, type SessionBackend } from "./backend.ts";
import { log } from "./log.ts";

export interface HandlerContext {
  readonly backend: SessionBackend;
  readonly getRepos: () => readonly RepoEntry[];
  /** Scan now, persist, re-register if the set changed; returns the fresh list. */
  readonly rescan: () => Promise<readonly RepoEntry[]>;
  /**
   * Where the audit trail goes — the daemon's stdout in production. Only the
   * transport is injectable: the formatter is applied below, and the origin is
   * a parameter of `createHandler` rather than of the context, so nothing a
   * wire-supplied payload can carry will make a spawn quiet or relabel it as
   * the human at the keyboard.
   */
  readonly auditSink: AuditSink;
  /** Present only when self-update is wired; a broadcast with no consumer is dropped here. */
  readonly updateAvailable?: (notice: UpdateAvailable) => void;
}

function isSpawnRequest(payload: unknown): payload is SpawnRequest {
  if (typeof payload !== "object" || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  if (typeof obj["repo"] !== "string" || obj["repo"] === "") return false;
  if (obj["mode"] !== "worktree" && obj["mode"] !== "here") return false;
  for (const key of ["prompt", "title", "model", "effort", "client"]) {
    if (obj[key] !== undefined && typeof obj[key] !== "string") return false;
  }
  if (obj["plan"] !== undefined && typeof obj["plan"] !== "boolean") return false;
  return true;
}

function isUpdateAvailable(payload: unknown): payload is UpdateAvailable {
  if (typeof payload !== "object" || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  return typeof obj["sha"] === "string" && obj["sha"] !== "" && typeof obj["commitTs"] === "number";
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
async function sessionsIncluding(ctx: HandlerContext, window: string): Promise<AckSessions> {
  const deadline = Bun.nanoseconds() + ACK_SETTLE_MS * 1e6;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling: each check gates the next, nothing to parallelize
    const sessions = await ctx.backend.sessions(ctx.getRepos());
    if (sessions.some((entry) => entry.window === window)) return { sessions, found: true };
    if (Bun.nanoseconds() >= deadline) return { sessions, found: false };
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(100);
  }
}

interface AckSessions {
  readonly sessions: readonly SessionEntry[];
  /** Whether the spawned window ever appeared — see `stuckNote` for why the miss is worth reporting. */
  readonly found: boolean;
}

/**
 * The spawn worked and the process is alive, yet it never registered: the
 * fingerprint of a startup gate no remote can answer (a trust or approval
 * dialog), which otherwise reaches the phone as a machine that simply has no
 * sessions. The screen is the only place that says *which* gate, so it rides
 * back on the ack — and only there: the seed prompt renders in that pane, and
 * prompt text is never logged.
 */
async function stuckNote(ctx: HandlerContext, handle: string | undefined): Promise<string> {
  const base = "started but never registered — it may be waiting on a prompt on that machine";
  if (handle === undefined || ctx.backend.capture === undefined) return base;
  const screen = await ctx.backend.capture(handle).catch(() => null);
  return screen === null ? base : `${base}:\n${screen}`;
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
    const { sessions, found } = await sessionsIncluding(ctx, outcome.window);
    const notes = [outcome.note, found ? undefined : await stuckNote(ctx, outcome.handle)];
    const note = notes.filter((n) => n !== undefined).join("\n\n");
    // Field by field rather than a spread: `handle` is backend-scoped and must not reach the wire.
    return {
      ok: true,
      window: outcome.window,
      path: outcome.path,
      ...(note === "" ? {} : { note }),
      ...(found ? {} : { pending: true as const }),
      sessions,
    };
  } catch (err) {
    if (err instanceof SpawnFailure) {
      await audit.failed(err.code);
      return { ok: false, code: err.code, message: err.message };
    }
    log.error(`spawn crashed: ${String(err)}`);
    return { ok: false, code: "internal_error", message: String(err) };
  }
}

/**
 * Routes decrypted request ops to their implementations and wraps the reply.
 * `origin` tags everything this handler audits; the daemon builds one per
 * inbound surface over a single shared context, so the relay and the local op
 * socket run the same code and stay distinguishable in the log.
 */
export function createHandler(
  ctx: HandlerContext,
  origin: SpawnOrigin = "relay",
): (plain: Plain) => Promise<Plain | null> {
  const audit = spawnAudit(origin, ctx.auditSink);
  return async (plain: Plain): Promise<Plain | null> => {
    // Every op, not just spawn: with a stolen PSK, "something enumerated my
    // sessions at 3am" is the same signal as "something spawned" — and the
    // origin is on this line for the same reason it is on the spawn lines.
    await ctx.auditSink(`audit request origin=${origin} op=${quote(plain.op)} id=${quote(plain.id)}`);

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
        case "update-available": {
          // Fire-and-forget: never replied to. The payload is advisory — the
          // updater verifies against its own origin — so shape is all to check.
          if (isUpdateAvailable(plain.payload)) ctx.updateAvailable?.(plain.payload);
          else log.warn("dropped malformed update-available payload");
          return null;
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
