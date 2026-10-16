import type {
  DespawnRequest,
  DespawnResponse,
  ErrorResponse,
  MetricsReply,
  MetricsRequest,
  MetricsSeries,
  Plain,
  RepoEntry,
  RescanResponse,
  SessionsResponse,
  SpawnRequest,
  SpawnResponse,
  UpdateAvailable,
} from "@seance/shared";
import { isMetricsRequest, isRecord, isTaskId, quote } from "@seance/shared";
import {
  despawnAudit,
  spawnAudit,
  type AuditSink,
  type DespawnAudit,
  type SpawnAudit,
  type SpawnOrigin,
} from "./audit.ts";
import { DespawnFailure, SpawnFailure, type DespawnResult, type SessionBackend } from "./backend.ts";
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
  /** The local metrics store's read; absent, a `metrics` request is answered with a code, not dropped. */
  readonly metrics?: (request: MetricsRequest) => readonly MetricsSeries[];
  /**
   * Task ids whose sessions ended recently and no live pane runs (`EndedTasks`),
   * for the `sessions` reply's `ended`; absent, the field is left off.
   */
  readonly endedTasks?: () => Promise<readonly string[]>;
  /** Told of every task a spawn here launched, so it reads as ended once its pane is gone. */
  readonly taskLaunched?: (taskId: string) => void;
  /** Present only when self-update is wired; a broadcast with no consumer is dropped here. */
  readonly updateAvailable?: (notice: UpdateAvailable) => void;
}

export function isSpawnRequest(payload: unknown): payload is SpawnRequest {
  if (typeof payload !== "object" || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  if (typeof obj["repo"] !== "string" || obj["repo"] === "") return false;
  if (obj["mode"] !== "worktree" && obj["mode"] !== "here") return false;
  for (const key of ["prompt", "title", "model", "effort", "client"]) {
    if (obj[key] !== undefined && typeof obj[key] !== "string") return false;
  }
  if (obj["plan"] !== undefined && typeof obj["plan"] !== "boolean") return false;
  // Bounded, not just typed: it is written to the pane and echoed into every session list.
  if (obj["taskId"] !== undefined && !isTaskId(obj["taskId"])) return false;
  return true;
}

/** Shape only: what the id may name is the backend's to decide, and it does. */
export function isDespawnRequest(payload: unknown): payload is DespawnRequest {
  if (typeof payload !== "object" || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  if (typeof obj["id"] !== "string" || obj["id"] === "") return false;
  if (obj["force"] !== undefined && typeof obj["force"] !== "boolean") return false;
  if (obj["client"] !== undefined && typeof obj["client"] !== "string") return false;
  return true;
}

function isUpdateAvailable(payload: unknown): payload is UpdateAvailable {
  if (typeof payload !== "object" || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  return typeof obj["sha"] === "string" && obj["sha"] !== "" && typeof obj["commitTs"] === "number";
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
    if (payload.taskId !== undefined) ctx.taskLaunched?.(payload.taskId);
    await audit.ok(outcome);
    // The app writes this list straight into its cache, so it is read only now,
    // after the backend has watched the new window register (or give up): a
    // list sampled before that is short by the very window this ack announces.
    const found = outcome.registered;
    const sessions = await ctx.backend.sessions(ctx.getRepos());
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
      await audit.failed(err.code, err.id);
      return { ok: false, code: err.code, message: err.message, ...(err.id === undefined ? {} : { id: err.id }) };
    }
    log.error(`spawn crashed: ${String(err)}`);
    return { ok: false, code: "internal_error", message: String(err) };
  }
}

async function handleDespawn(ctx: HandlerContext, audit: DespawnAudit, payload: unknown): Promise<DespawnResponse> {
  if (!isDespawnRequest(payload)) {
    await audit.rejected("malformed request");
    return { ok: false, code: "internal_error", message: "malformed despawn request" };
  }
  await audit.request(payload);
  if (ctx.backend.despawn === undefined) {
    await audit.failed("internal_error");
    return { ok: false, code: "internal_error", message: "this machine's session backend cannot despawn" };
  }
  let result: DespawnResult;
  try {
    result = await ctx.backend.despawn(payload.id, { force: payload.force === true });
  } catch (err) {
    if (err instanceof DespawnFailure) {
      await audit.failed(err.code);
      return { ok: false, code: err.code, message: err.message };
    }
    log.error(`despawn crashed: ${String(err)}`);
    await audit.failed("internal_error");
    return { ok: false, code: "internal_error", message: String(err) };
  }
  await audit.ok(result);
  // After the outcome, so the list the caller caches no longer holds the window.
  // Outside the try: a listing that fails must not audit a done despawn as failed.
  const sessions = await ctx.backend.sessions(ctx.getRepos());
  return { ok: true, window: result.window, outcome: result.outcome, sessions };
}

/**
 * One decimal: the units are whole percent, MiB and KiB/s, and a rollup's
 * average otherwise serializes to seventeen digits — a third of the reply.
 */
function roundedPoint([ts, value]: readonly [number, number]): readonly [number, number] {
  return [ts, Math.round(value * 10) / 10];
}

function rounded(series: readonly MetricsSeries[]): readonly MetricsSeries[] {
  return series.map((s) => ({ ...s, points: s.points.map(roundedPoint) }));
}

function handleMetrics(ctx: HandlerContext, payload: unknown): MetricsReply {
  if (!isMetricsRequest(payload)) {
    return { ok: false, code: "invalid_request", message: "malformed metrics request" };
  }
  if (ctx.metrics === undefined) {
    return { ok: false, code: "internal_error", message: "this daemon keeps no metrics" };
  }
  return { series: rounded(ctx.metrics(payload)) };
}

/**
 * Every op, not just spawn: with a stolen PSK, "something enumerated my
 * sessions at 3am" is the same signal as "something spawned" — and the origin
 * is on this line for the same reason it is on the spawn lines.
 */
async function auditRequest(ctx: HandlerContext, origin: SpawnOrigin, op: string, id: string): Promise<void> {
  await ctx.auditSink(`audit request origin=${origin} op=${quote(op)} id=${quote(id)}`);
}

async function listSessions(ctx: HandlerContext): Promise<SessionsResponse> {
  const [sessions, ended] = await Promise.all([
    ctx.backend.sessions(ctx.getRepos()),
    ctx.endedTasks?.() ?? Promise.resolve(undefined),
  ]);
  return { sessions, at: Date.now(), ...(ended === undefined || ended.length === 0 ? {} : { ended }) };
}

/** The three ops the scheduler dispatches, typed, for a caller inside this process. */
export interface LocalOps {
  readonly sessions: () => Promise<SessionsResponse | ErrorResponse>;
  readonly spawn: (payload: unknown) => Promise<SpawnResponse | ErrorResponse>;
  readonly despawn: (payload: unknown) => Promise<DespawnResponse | ErrorResponse>;
}

/**
 * The leader reaching its own machine (`leader.ts`): the same validation,
 * backend and audit lines as `createHandler`, under the caller's origin. No
 * `Plain` goes in, so nothing but these three ops can be asked for.
 */
export function createLocalOps(ctx: HandlerContext, origin: SpawnOrigin): LocalOps {
  const audit = spawnAudit(origin, ctx.auditSink);
  const despawnTrail = despawnAudit(origin, ctx.auditSink);
  // No `Plain` id to join on: a spawn's request line carries its task id, which the
  // spawn lines after it and the scheduler's task both name; the rest get a fresh one.
  const run = async <T>(op: string, id: string, body: () => Promise<T>): Promise<T | ErrorResponse> => {
    await auditRequest(ctx, origin, op, id);
    return guarded(op, body);
  };
  return {
    sessions: () => run("sessions", crypto.randomUUID(), () => listSessions(ctx)),
    spawn: (payload) => {
      const taskId = isRecord(payload) && isTaskId(payload["taskId"]) ? payload["taskId"] : crypto.randomUUID();
      return run("spawn", taskId, () => handleSpawn(ctx, audit, payload));
    },
    despawn: (payload) => run("despawn", crypto.randomUUID(), () => handleDespawn(ctx, despawnTrail, payload)),
  };
}

/** A handler that throws still answers, with a code — for the relay leg and local ops alike. */
async function guarded<T>(op: string, body: () => Promise<T>): Promise<T | ErrorResponse> {
  try {
    return await body();
  } catch (err) {
    log.error(`handler for ${quote(op)} crashed: ${String(err)}`);
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
  const despawnTrail = despawnAudit(origin, ctx.auditSink);
  return async (plain: Plain): Promise<Plain | null> => {
    await auditRequest(ctx, origin, plain.op, plain.id);

    const reply = (payload: unknown): Plain => ({
      id: crypto.randomUUID(),
      ts: Date.now(),
      op: plain.op,
      re: plain.id,
      payload,
    });

    // Null is "no reply at all"; anything else is wrapped as the op's answer.
    const answer = async (): Promise<{ readonly payload: unknown } | null> => {
      switch (plain.op) {
        case "sessions":
          return { payload: await listSessions(ctx) };
        case "spawn":
          return { payload: await handleSpawn(ctx, audit, plain.payload) };
        case "despawn":
          return { payload: await handleDespawn(ctx, despawnTrail, plain.payload) };
        case "metrics":
          return { payload: handleMetrics(ctx, plain.payload) };
        case "rescan": {
          const repos = await ctx.rescan();
          const payload: RescanResponse = { repos, scannedAt: Date.now() };
          return { payload };
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
    };
    const out = await guarded(plain.op, answer);
    if (out === null) return null;
    return reply("payload" in out ? out.payload : out);
  };
}
