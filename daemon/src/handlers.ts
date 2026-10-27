import { stat } from "node:fs/promises";
import { join, sep } from "node:path";
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
  SessionEntry,
  SessionsResponse,
  SpawnRequest,
  SpawnResponse,
  TaskProgress,
  UpdateAvailable,
} from "@seance/shared";
import {
  isMetricsRequest,
  isRecord,
  isTaskId,
  quote,
  REPLY_JSON_BUDGET,
  SCHEDULER_CLIENT,
  SCHEDULER_ID,
} from "@seance/shared";
import {
  despawnAudit,
  spawnAudit,
  type AuditSink,
  type DespawnAudit,
  type SpawnAudit,
  type SpawnOrigin,
} from "./audit.ts";
import { DespawnFailure, SpawnFailure, type DespawnResult, type SessionBackend, type SpawnOutcome } from "./backend.ts";
import { canonical } from "./gitdir.ts";
import { log } from "./log.ts";
import type { SettleLaunch } from "./session-events.ts";

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
   * Task launches (`EndedTasks`): a spawn with a task id is recorded here before
   * it runs, and the `sessions` reply's `ended` and `ledgerSince` come from it.
   * Absent, spawns record nothing and neither field is sent.
   */
  readonly tasks?: TaskLaunches;
  /** Present only when self-update is wired; a broadcast with no consumer is dropped here. */
  readonly updateAvailable?: (notice: UpdateAvailable) => void;
}

/** What the handlers need of `EndedTasks` (`session-events.ts`). */
export interface TaskLaunches {
  /** Write-ahead: throws when the task cannot be recorded, and the spawn then must not run. */
  readonly launch: (taskId: string) => Promise<SettleLaunch>;
  /** The ledger holds the task as launched here, and no launch of it is in flight. */
  readonly launched: (taskId: string) => boolean;
  /**
   * Where the ledger noted `taskId`'s worktree, for a continuation; `refused` says why there
   * is none. Never from the wire: the request names a task, this machine says where it ran.
   */
  readonly continuation: (
    taskId: string,
  ) => { readonly repo: string; readonly path: string } | { readonly refused: string };
  /** Resolves once no launch is in flight. */
  readonly settled: () => Promise<void>;
  /** What the ledger holds of each launched task's PR and branch, for the scheduler's `sessions`. */
  readonly progress: () => readonly TaskProgress[];
  /**
   * Notes each dead task pane's exit status, then closes the pane (`exit-status.ts`).
   * Never throws. Absent, a dead pane stays until reap.
   */
  readonly harvestExits?: () => Promise<void>;
  readonly report: (carried: ReadonlySet<string>) => {
    readonly ended: readonly string[];
    readonly ledgerSince: number;
  };
}

export function isSpawnRequest(payload: unknown): payload is SpawnRequest {
  if (typeof payload !== "object" || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  if (typeof obj["repo"] !== "string" || obj["repo"] === "") return false;
  if (obj["mode"] !== "worktree" && obj["mode"] !== "here" && obj["mode"] !== "continue") return false;
  for (const key of ["prompt", "title", "model", "effort", "client"]) {
    if (obj[key] !== undefined && typeof obj[key] !== "string") return false;
  }
  if (obj["plan"] !== undefined && typeof obj["plan"] !== "boolean") return false;
  // Bounded, not just typed: it is written to the pane and echoed into every session list.
  if (obj["taskId"] !== undefined && !isTaskId(obj["taskId"])) return false;
  // Fail closed until stacking lands: a spawn that silently started from the default branch
  // is the hazard the `baseBranch` capability exists for. Stacking lifts this refusal and
  // holds the name to `isBranchName` instead.
  if (obj["baseBranch"] !== undefined) return false;
  // `continues` is the one field of a continuation and only of one. It is a ledger key: the
  // worktree comes from this machine's own record of that task, never from the request.
  if (obj["continues"] !== undefined && !isTaskId(obj["continues"])) return false;
  // The rules a well-formed continuation can still break (the scheduler's client, a task id, not itself)
  // are `continuationRefusal`'s: a malformed request answers `internal_error`, a transport code that
  // leaves the leader's task reserved, where `not_continuable` settles it.
  return (obj["mode"] === "continue") === (obj["continues"] !== undefined);
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

/**
 * The list a spawn or despawn ack carries. The op already ran, so a read that
 * fails costs the list, never the answer: an error there would read as the op
 * having failed, or (a transport code) as maybe never having run.
 */
async function sessionsAfter(ctx: HandlerContext, op: string): Promise<readonly SessionEntry[]> {
  try {
    return await ctx.backend.sessions(ctx.getRepos());
  } catch (err) {
    log.warn(`${op} ran, but the session list after it could not be read: ${String(err)}`);
    return [];
  }
}

/**
 * A scheduler spawn for a task the ledger holds as launched here (DESIGN.md,
 * threat model, "Relay compromise"). A leader re-dispatches a task only on this
 * machine's proof that it never landed, so a second spawn is a dispatch made
 * from a record a relay rolled back, and nothing runs. A session still carrying
 * the id is answered `task_running` as the spawn itself would, so the leader
 * records where it runs rather than failing it.
 */
async function relaunchRefusal(
  ctx: HandlerContext,
  request: SpawnRequest,
): Promise<Extract<SpawnResponse, { readonly ok: false }> | null> {
  const { taskId } = request;
  if (request.client !== SCHEDULER_CLIENT || taskId === undefined || ctx.tasks?.launched(taskId) !== true) return null;
  const running = (await ctx.backend.sessions(ctx.getRepos())).find((s) => s.taskId === taskId);
  if (running !== undefined) {
    return { ok: false, code: "task_running", message: `task ${taskId} is already running`, id: running.id };
  }
  log.warn(`spawn refused: task ${quote(taskId)} already launched here — not run again`);
  return {
    ok: false,
    code: "task_launched",
    message: `task ${taskId} already ran on this machine, so it was not started again`,
  };
}

type SpawnRefusal = Extract<SpawnResponse, { readonly ok: false }>;

function notContinuable(message: string): SpawnRefusal {
  return { ok: false, code: "not_continuable", message };
}

/**
 * Who may continue, and what a continuation names: only the scheduler's own task spawn, which
 * always carries its task id, and never the task it continues. Before the ledger is read or
 * anything recorded.
 */
function continuationRefusal(request: SpawnRequest, scheduler: boolean): SpawnRefusal | null {
  if (!scheduler || request.client !== SCHEDULER_CLIENT)
    return notContinuable("only the scheduler continues a session");
  if (request.taskId === undefined) return notContinuable("a continuation needs the id of the task that carries it");
  if (request.continues === request.taskId) return notContinuable("a task cannot continue itself");
  return null;
}

/**
 * The worktree a continuation resumes in, from this machine's launch ledger and checked
 * before anything is recorded or run (DESIGN.md, Daemon, "Continuing a failed task"): the
 * clone `repo` resolved to is the one the ledger noted, and the path is canonical and under
 * that clone's `.claude/worktrees/`, so a ledger written by anything else cannot aim a
 * session at an arbitrary directory.
 */
async function continuationSite(
  ctx: HandlerContext,
  request: SpawnRequest,
  repos: readonly RepoEntry[],
): Promise<{ readonly path: string } | SpawnRefusal> {
  const site = request.continues === undefined ? undefined : ctx.tasks?.continuation(request.continues);
  if (site === undefined) return notContinuable("this machine keeps no launch record to continue from");
  if ("refused" in site) return notContinuable(site.refused);
  const entry = repos.find((r) => r.name === request.repo);
  if (entry === undefined) {
    return { ok: false, code: "repo_not_found", message: `no repo named "${request.repo}" — try a rescan` };
  }
  if (entry.path !== site.repo) {
    return notContinuable(`it ran in another clone of ${request.repo} (${site.repo}), not this one`);
  }
  const real = await canonical(site.path);
  const present = await stat(real).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!present) return notContinuable(`its worktree ${site.path} is gone (removed or reaped)`);
  if (real !== site.path || !real.startsWith(join(entry.path, ".claude", "worktrees") + sep)) {
    return notContinuable(`its noted path ${site.path} is not a worktree of ${request.repo}`);
  }
  return { path: real };
}

async function handleSpawn(
  ctx: HandlerContext,
  audit: SpawnAudit,
  payload: unknown,
  scheduler: boolean,
): Promise<SpawnResponse> {
  if (!isSpawnRequest(payload)) {
    await audit.rejected("malformed request");
    return { ok: false, code: "internal_error", message: "malformed spawn request" };
  }
  await audit.request(payload);
  // `from` says who sealed the request; `client` is free text anyone can write, so it is not the gate.
  if (payload.mode === "continue") {
    const refusal = continuationRefusal(payload, scheduler);
    if (refusal !== null) {
      await audit.failed("not_continuable");
      return refusal;
    }
  }
  const refused = await relaunchRefusal(ctx, payload);
  if (refused !== null) {
    await audit.failed(refused.code, refused.id);
    return refused;
  }
  // Read once: a rescan in between must not pair the spawn with another clone.
  const repos = ctx.getRepos();
  let continuation: { readonly path: string } | undefined;
  if (payload.mode === "continue") {
    const site = await continuationSite(ctx, payload, repos);
    if ("code" in site) {
      await audit.failed(site.code);
      return site;
    }
    continuation = site;
  }
  let settle: SettleLaunch | undefined;
  if (payload.taskId !== undefined && ctx.tasks !== undefined) {
    try {
      settle = await ctx.tasks.launch(payload.taskId);
    } catch (err) {
      // Launched unrecorded, a lost reply could later read as proof it never ran.
      log.error(`spawn refused: could not record task ${quote(payload.taskId)} before launching it: ${String(err)}`);
      await audit.failed("launch_error");
      return {
        ok: false,
        code: "launch_error",
        message: `could not record the task before launching it: ${String(err)}`,
      };
    }
  }
  try {
    let outcome: SpawnOutcome;
    try {
      outcome = await ctx.backend.spawn(payload, repos, continuation);
    } catch (err) {
      // A refusal launched nothing, except `task_running`: its session is an earlier launch of this task.
      // Neither it nor a crash starts a note: the earlier launch's stays.
      await settle?.(!(err instanceof SpawnFailure) || err.code === "task_running");
      throw err;
    }
    // Only a worktree has a branch of its own to watch; `here` runs in the clone itself.
    // A continuation watches the worktree it resumed, under its new task id.
    const entry = payload.mode !== "here" ? repos.find((r) => r.name === payload.repo) : undefined;
    await settle?.(true, entry === undefined ? {} : { site: { repo: entry.path, worktree: outcome.path } });
    await audit.ok(outcome);
    // The app writes this list straight into its cache, so it is read only now,
    // after the backend has watched the new window register (or give up): a
    // list sampled before that is short by the very window this ack announces.
    const found = outcome.registered;
    const sessions = await sessionsAfter(ctx, "spawn");
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
  const sessions = await sessionsAfter(ctx, "despawn");
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

/**
 * `ended` is reckoned from this reply's own `sessions`, not a second tmux read:
 * a session ending between two reads would otherwise be in neither, which is
 * what proves a spawn never landed.
 *
 * Only the scheduler waits out a launch in flight, which is what makes the two
 * fields a proof (DESIGN.md, "Session events"), and only it gets them. A spawn
 * can run for a minute; a PWA refresh or an MCP `get_sessions` behind it would
 * time out at `OP_TIMEOUT_MS.sessions` for fields it never reads. `progress`
 * is the leader's to read too, and is sent on the same side, trimmed to fit.
 *
 * Dead task panes are harvested after the listing and before `progress` is
 * read, for every caller. A dead pane is not listed (tmux gives it no cwd), so
 * a pane dying before the listing is harvested, its exit in `progress`; one
 * dying after was listed alive. Harvested first instead, a pane dying between
 * the two reads would be in neither — the leader would settle it `done`.
 */
async function listSessions(ctx: HandlerContext, scheduler: boolean): Promise<SessionsResponse> {
  if (scheduler) await ctx.tasks?.settled();
  const sessions = await ctx.backend.sessions(ctx.getRepos());
  await ctx.tasks?.harvestExits?.();
  const at = Date.now();
  if (ctx.tasks === undefined || !scheduler) return { sessions, at };
  const { ended, ledgerSince } = ctx.tasks.report(new Set(sessions.flatMap((s) => s.taskId ?? [])));
  const base: SessionsResponse = { sessions, at, ...(ended.length === 0 ? {} : { ended }), ledgerSince };
  return fitProgress(base, ctx.tasks.progress());
}

const PROGRESS_KEY_BYTES = Buffer.byteLength(',"progress":[]', "utf8");
const TRIMMED_KEY_BYTES = Buffer.byteLength(',"progressTrimmed":', "utf8");

/**
 * `base` with `progress`, dropped to fit `budget` and the count recorded in
 * `progressTrimmed`. `at` is the last change, not the last look, so an open PR
 * untouched for days has the oldest `at` and is what a takeover needs most:
 * merged entries go first (finished; a missed one costs a re-read), then the
 * rest oldest first. Survivors keep their order.
 */
export function fitProgress(
  base: SessionsResponse,
  progress: readonly TaskProgress[],
  budget: number = REPLY_JSON_BUDGET,
): SessionsResponse {
  if (progress.length === 0) return base;
  const sized = progress.map((entry, index) => ({
    entry,
    index,
    bytes: Buffer.byteLength(JSON.stringify(entry), "utf8"),
  }));
  const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
  let kept = sized.length;
  let sum = sized.reduce((total, item) => total + item.bytes, 0);
  let dropped = 0;
  const total = (): number =>
    baseBytes +
    (kept === 0 ? 0 : PROGRESS_KEY_BYTES + sum + kept - 1) +
    (dropped === 0 ? 0 : TRIMMED_KEY_BYTES + String(dropped).length);
  const order = sized.toSorted(
    (a, b) => Number(b.entry.merged === true) - Number(a.entry.merged === true) || a.entry.at - b.entry.at,
  );
  const gone = new Set<number>();
  for (const item of order) {
    if (total() <= budget) break;
    gone.add(item.index);
    kept -= 1;
    sum -= item.bytes;
    dropped += 1;
  }
  const survivors = progress.filter((_, index) => !gone.has(index));
  return {
    ...base,
    ...(survivors.length === 0 ? {} : { progress: survivors }),
    ...(dropped === 0 ? {} : { progressTrimmed: dropped }),
  };
}

/** The three ops the scheduler dispatches, typed, for a caller inside this process. */
export interface LocalOps {
  readonly sessions: () => Promise<SessionsResponse | ErrorResponse>;
  readonly spawn: (payload: unknown) => Promise<SpawnResponse | ErrorResponse>;
  readonly despawn: (payload: unknown) => Promise<DespawnResponse | ErrorResponse>;
}

/**
 * The leader reaching its own machine (`termFleet` in `leader-adapters.ts`): the same validation,
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
    // Every caller of these is the scheduler: `termFleet` in `leader-adapters.ts` is the only one.
    sessions: () => run("sessions", crypto.randomUUID(), () => listSessions(ctx, true)),
    spawn: (payload) => {
      const taskId = isRecord(payload) && isTaskId(payload["taskId"]) ? payload["taskId"] : crypto.randomUUID();
      return run("spawn", taskId, () => handleSpawn(ctx, audit, payload, true));
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
 * socket run the same code and stay distinguishable in the log. `from` is the
 * envelope's sealer, AAD-bound: the relay leg passes it, and the local socket,
 * which no scheduler reaches, has none.
 */
export function createHandler(
  ctx: HandlerContext,
  origin: SpawnOrigin = "relay",
): (plain: Plain, from?: string) => Promise<Plain | null> {
  const audit = spawnAudit(origin, ctx.auditSink);
  const despawnTrail = despawnAudit(origin, ctx.auditSink);
  return async (plain: Plain, from?: string): Promise<Plain | null> => {
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
          return { payload: await listSessions(ctx, from === SCHEDULER_ID) };
        case "spawn":
          return { payload: await handleSpawn(ctx, audit, plain.payload, from === SCHEDULER_ID) };
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
