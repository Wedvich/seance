import { realpath } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  accountNameIn,
  agentVisibleTags,
  CAPABILITIES,
  creatorTaskTags,
  refTags,
  taskTagEntries,
  MESSAGE_KINDS,
  MESSAGE_MAX,
  MESSAGE_ROUTE_MAX,
  MESSAGE_PUSH_MAX,
  MESSAGE_RATE,
  fleetTraits,
  parseDateTime,
  traitHealthByMachine,
  AUTONOMY_LEVELS,
  autonomyOf,
  DEFAULT_AUTONOMY,
  withAutonomy,
  type AutonomyLevel,
  continueOffer,
  passOffer,
  type OfferContext,
  DEP_AFTER,
  knownAccounts,
  taskPrBlock,
  type KnownAccount,
  failureReasonText,
  isTransportError,
  reasonText,
  RequestFailure,
  QUEUE_MAX_TASKS,
  REPORT_DONE_TOOL,
  schedulerErrorText,
  schedulerRefusal,
  schedulerRole,
  SUCCESSOR_RECORD_MAX,
  taskFailureText,
  TASK_FAILURE_LIMITS,
  TASK_REQUEST_LIMITS,
  ATTACHMENT_LIMITS,
  TASK_SPEC_LIMITS,
  TASK_UNTIL,
  withReportInstruction,
  type Candidate,
  type Decision,
  type DespawnRequest,
  type DespawnResponse,
  type ErrorResponse,
  type Machine,
  type PauseHold,
  type RepoEntry,
  type RequestOp,
  type SchedulerAvailability,
  TASK_PHASES,
  type DrainView,
  type SessionEntry,
  type SessionsResponse,
  type SpawnClient,
  type Task,
  type TaskDep,
  type TaskUntil,
  closedAt,
  drainStuckText,
  drainView,
  exclaveAuth,
  exclaveTraitHealth,
  exclaveTraitUnchecked,
  lastHeardAt,
  sleepingMachine,
} from "@seance/shared";
import { appRelayClient, importAppKeys, LazyRelay, type AppKeys } from "./app-relay.ts";
import { cliSink, traitRefusalAudit, type AuditSink } from "./audit.ts";
import { queueTasksFor, setAccountOpen, setMachineOpen } from "./availability-client.ts";
import {
  continueAuto,
  enqueueAuto,
  advertises,
  leaderTakesReported,
  MCP_PLACEMENT_NAMES,
  pinAccountGateError,
  placementInputError,
  placementNeedsPinAccount,
  resolveMachine,
  resolveOrigin,
  resolvePlacement,
  specError,
  passAuto,
  amendAuto,
  startAuto,
  startGateError,
  startQueuedAuto,
  taskTagsGateError,
  traitsGateError,
  requiresCheck,
  usesReported,
  type AutoSpec,
  type PlacementInput,
  type PlacementNames,
} from "./auto.ts";
import { BrokerError } from "./broker-client.ts";
import type { Check } from "./check.ts";
import { loadConfig, loadPsk, type Config } from "./config.ts";
import { exec } from "./exec.ts";
import { userScopeTargets } from "./exclaves.ts";
import {
  brokerFailureText,
  brokerFleet,
  FleetUnreachable,
  relayFleet,
  SCHEDULER_NEEDS_NEWER_DAEMON,
  selectFleet,
  type Fleet,
  type FleetLease,
  type SchedulerLeg,
} from "./fleet.ts";
import { recordedBunCheck, resolvedMain } from "./link.ts";
import { localRequest, localSocketReachable, LocalUnavailable } from "./local-client.ts";
import { handOff, passToSuccessor, reportDone } from "./report-done.ts";
import { sendMessage, type RouteGate } from "./send-message.ts";
import { WATCH_TTL_MS } from "./watch-frame.ts";
import { unwatchGithub, watchGithub, type WatchGate } from "./watch-github.ts";
import { readState } from "./state.ts";

/**
 * What this box is, and how to reach its daemon without the relay.
 *
 * Resolved from `config.json` and `state.json` rather than from the registry, so
 * recognising a target as local never depends on the relay being up — which is
 * what lets a local request fail with "the daemon isn't running" instead of
 * quietly paying a round trip to Cloudflare to be told the same thing.
 *
 * Only `get_sessions` and `despawn_session` use it: a spawn always queues, so it
 * needs the key or the broker.
 *
 * `request` is injectable so the tools can be driven without a socket; in
 * production it is `localRequest`.
 */
export interface LocalMachine {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  /**
   * Re-read per call, not snapshotted: the daemon rewrites state.json on every
   * rescan and `seance mcp` outlives many of them. Its one user is the
   * list_machines fallback, which lists this machine's repos when the relay is
   * unreachable; a snapshot would miss a repo cloned since startup, or every repo
   * if the first scan hadn't landed.
   */
  readonly repos: () => Promise<readonly RepoEntry[]>;
  /** Any op may answer with an `ErrorResponse`, as over the relay. */
  readonly request: <T>(op: RequestOp, payload: unknown) => Promise<T | ErrorResponse>;
  /** Whether its daemon is listening, asked without sending an op — nothing is run or audited. */
  readonly reachable: () => Promise<boolean>;
}

/**
 * Whether a tool's `machine` argument names this box. Same precedence as
 * `resolveMachine`: a deviceId matches exactly, a name case-insensitively.
 *
 * Local wins over a remote machine of the same name, deliberately — the point of
 * the short circuit is that the common case takes no round trip, and a name
 * collision is exactly what `deviceId` is the escape hatch for.
 */
export function isLocalRef(local: LocalMachine, ref: string): boolean {
  return ref === local.deviceId || ref.toLowerCase() === local.name.toLowerCase();
}

/** `pin` as a tool takes it: a machine by name or deviceId, an account by alias, email or id; the spec holds ids only. */
interface PinInput {
  readonly machine?: string | undefined;
  readonly account?: string | undefined;
  /** Only to refuse it, naming what replaced the exclave pin. */
  readonly exclave?: unknown;
}

/**
 * `pin` and `avoid` as one placement, refused before anything dials the relay when malformed.
 * `machinePin` is spawn_session's top-level `machine`, merged in only after the pin itself
 * is checked, so it cannot turn an empty `pin: {}` into a valid one.
 */
function placementInput(
  pin: PinInput | undefined,
  avoid: readonly string[] | undefined,
  names: PlacementNames = MCP_PLACEMENT_NAMES,
  machinePin?: string,
): { readonly input: PlacementInput } | { readonly error: string } {
  if (pin !== undefined && "exclave" in pin) {
    return { error: "exclave pins are gone — pin an account (list_machines shows each exclave's account)" };
  }
  if (pin !== undefined && pin.machine === undefined && pin.account === undefined) {
    return { error: "pin names neither a machine nor an account" };
  }
  const input: PlacementInput = {
    machine: machinePin ?? pin?.machine,
    account: pin?.account,
    ...(avoid === undefined ? {} : { avoid }),
  };
  const invalid = placementInputError(input, names);
  return invalid === null ? { input } : { error: invalid };
}

/**
 * `repo` as the scheduler keys it, and the placement as the spec holds it: the
 * repo read within the pin's scope, since a name ambiguous across the fleet can
 * still mean one clone where the task may run. `echo` names a resolved account.
 */
async function autoTarget(
  lease: { readonly machines: readonly Machine[]; readonly scheduler: SchedulerLeg },
  repo: string,
  input: PlacementInput,
  names: PlacementNames = MCP_PLACEMENT_NAMES,
): Promise<
  | { readonly fields: Pick<AutoSpec, "repo" | "pin" | "avoid">; readonly echo: string | null }
  | { readonly error: string }
> {
  const placed = await resolvePlacement(lease.machines, lease.scheduler.accounts, input, names);
  if ("error" in placed) return placed;
  const resolved = resolveOrigin(placed.machines, repo, placed.scope);
  if ("error" in resolved) return resolved;
  return { fields: { repo: resolved.origin, ...placed.fields }, echo: placed.echo };
}

interface ToolResult {
  [key: string]: unknown;
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

const HAND_OFF_TOOL = "hand_off_task";
const PASS_SELF_TOOL = "pass_to_successor";
const SEND_MESSAGE_TOOL = "send_message";
const WATCH_TOOL = "watch_github";
const UNWATCH_TOOL = "unwatch_github";

/**
 * How long `pass_to_successor` looks for the leader's confirmation after its daemon pushed and reported:
 * a commit point is written within seconds of a healthy leader's receipt, but the PR head read and the
 * successor's create run first.
 */
export interface PassPoll {
  readonly windowMs: number;
  readonly everyMs: number;
}
const PASS_POLL: PassPoll = { windowMs: 30_000, everyMs: 1_000 };

/** Said whatever the confirmation: the session is closed at its turn's end, or not at all, and nothing after the push is carried. */
const END_THE_TURN =
  "Do no further work and end your turn now with one line: if the pass stands, this session is closed when the turn ends, and anything committed after the push is not carried.";

const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const errorResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/**
 * What names an account to a person: alias, else email, else short id (`accountNameIn`). `aliases`
 * is empty wherever none could be read; a label is all it ever decides.
 */
interface AccountNames {
  readonly known: readonly KnownAccount[];
  readonly aliases: ReadonlyMap<string, string>;
}

const nameOf = (names: AccountNames, accountId: string): string =>
  accountNameIn(names.known, accountId, names.aliases.get(accountId));

/**
 * How long a label waits for the listing. A lost one would otherwise hold the call for
 * `STORE_LIST_TIMEOUT_MS` (30 s) on every call; an alias is not worth that. Not applied to a pin's
 * resolution, which needs the real answer.
 */
export const ACCOUNT_LABEL_DEADLINE_MS = 1_500;

/**
 * The aliases set on `accountIds`, from the lease's cached listing (`AccountCache`: once per
 * socket, as the PWA lists, since the `account:` list bucket is shared). None through the broker
 * (`brokerScheduler`), and no listing spent when nothing needs a name. A refused, lost, failed or
 * slow (past `ACCOUNT_LABEL_DEADLINE_MS`) listing is no aliases: a label never fails or stalls a call.
 */
async function accountAliases(lease: FleetLease, accountIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const aliases = new Map<string, string>();
  if (lease.scheduler === null || accountIds.length === 0) return aliases;
  const { accounts } = lease.scheduler;
  const listing = (async (): Promise<Awaited<ReturnType<SchedulerLeg["accounts"]>>> => {
    try {
      return await accounts({ label: true });
    } catch (err) {
      // A bug, not a lost listing: the label still never fails, but the cache rethrows it on
      // purpose. stderr, never `log.ts`: stdout is the JSON-RPC channel.
      if (!(err instanceof RequestFailure)) console.error("seance mcp: account listing failed:", err);
      return null;
    }
  })();
  // The listing keeps running past the deadline and fills the cache for the next call.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ACCOUNT_LABEL_DEADLINE_MS);
  });
  const records = await Promise.race([listing, deadline]);
  clearTimeout(timer);
  const wanted = new Set(accountIds);
  for (const record of records ?? []) {
    if (record.alias !== null && wanted.has(record.accountId)) aliases.set(record.accountId, record.alias);
  }
  return aliases;
}

/**
 * Every account the registry reports plus `extraIds` (which count as twins too), with the aliases
 * of those `shown` names — every known one by default. One listing at most.
 */
async function accountNames(
  lease: FleetLease,
  extraIds: readonly string[] = [],
  shown?: readonly string[],
): Promise<AccountNames> {
  const known = knownAccounts(lease.machines, extraIds);
  const ids = shown ?? known.map((account) => account.accountId);
  return { known, aliases: await accountAliases(lease, ids) };
}

/**
 * What each closed machine's drain has done (`drainView`), read only while a machine is closed and only
 * under a leader that advertises `drainPass`: one queue read and one `sessions` read per closed, connected
 * machine. This box's own sessions come from its local daemon (a brokered request aimed at the broker's own
 * machine is refused `self_target`). A queue read that fails yields nothing, never a guessed view; sessions
 * that cannot be read leave `empty` null.
 */
async function readDrains(
  lease: FleetLease,
  local: LocalMachine | null,
  scheduler: SchedulerAvailability | null,
): Promise<ReadonlyMap<string, DrainView>> {
  const views = new Map<string, DrainView>();
  const leg = lease.scheduler;
  if (leg === null || scheduler === null || !advertises(lease.machines, scheduler, CAPABILITIES.drainPass)) {
    return views;
  }
  const closed = lease.machines.filter((m) => closedAt(m) !== null);
  if (closed.length === 0) return views;
  const readSessions = async (machine: Machine): Promise<SessionsResponse | null> => {
    if (!machine.connected) return null;
    try {
      const reply =
        local !== null && machine.deviceId === local.deviceId
          ? await local.request<SessionsResponse>("sessions", {})
          : await lease.request<SessionsResponse>(machine.deviceId, "sessions", {});
      return "ok" in reply ? null : reply;
    } catch {
      return null;
    }
  };
  const sessions = await Promise.all(closed.map(readSessions));
  const paneTaskIds = sessions.flatMap((reply) =>
    (reply?.sessions ?? []).flatMap((s) => (s.taskId === undefined ? [] : [s.taskId])),
  );
  const queue = await queueTasksFor(leg, paneTaskIds);
  if (queue === null) return views;
  closed.forEach((machine, index) => {
    views.set(
      machine.deviceId,
      drainView(machine, queue.tasks, sessions[index]?.sessions ?? null, { idle: queue.idle }),
    );
  });
  return views;
}

function describeMachine(
  machine: Machine,
  local: LocalMachine | null,
  scheduler: SchedulerAvailability | null,
  names: AccountNames,
  now: number,
  drain?: DrainView,
): Record<string, unknown> {
  // Null when this transport has no view of the scheduler at all (a broker daemon that predates brokered scheduler access).
  const role = scheduler === null ? null : schedulerRole(machine.deviceId, scheduler);
  const { source, lastUpdate } = machine;
  const closedMs = closedAt(machine);
  return {
    name: machine.name,
    deviceId: machine.deviceId,
    platform: machine.platform,
    connected: machine.connected,
    lastSeen: new Date(lastHeardAt(machine)).toISOString(),
    repos: machine.repos.map((repo) => repo.name),
    // Absent, not empty, on a daemon predating exclaves: the scheduler cannot place there.
    ...(machine.exclaves === undefined
      ? {}
      : {
          exclaves: machine.exclaves.map((info, index) => {
            const auth = exclaveAuth(machine, index, now);
            const traits = info.traits ?? [];
            const failing = traits.filter((trait) => exclaveTraitHealth(machine, index, trait, now) === "failing");
            // Only a probe the status lists as unread: a probe-less trait, or a machine offline or stale, has none to await.
            const unchecked = traits.filter((trait) => exclaveTraitUnchecked(machine, index, trait, now));
            return {
              id: info.id,
              ...(info.accountId === null ? {} : { accountId: info.accountId }),
              ...(info.email === undefined ? {} : { email: info.email }),
              ...(info.traits === undefined ? {} : { traits: info.traits }),
              ...(info.keepFree === undefined ? {} : { keepFree: info.keepFree }),
              // A probe reading failing holds a task needing the trait off this exclave; unchecked still routes.
              ...(failing.length === 0 ? {} : { traitsFailing: failing }),
              ...(unchecked.length === 0 ? {} : { traitsUnchecked: unchecked }),
              ...(info.accountId === null ? {} : describeName(names, info.accountId)),
              // A signed-out exclave has no login to read: the scheduler already filters it as `auth_missing`.
              ...(info.accountId === null ? {} : { auth: auth.state }),
              ...(auth.state === "expiring" ? { loginExpiresAt: new Date(auth.expiresAt).toISOString() } : {}),
            };
          }),
        }),
    // Named so the model knows which target costs nothing to reach; get_sessions
    // and despawn_session there go straight to the daemon on this box.
    local: local !== null && machine.deviceId === local.deviceId,
    // When a person closed it to new scheduled work, from its newest status; null while open.
    closed: closedMs === null ? null : new Date(closedMs).toISOString(),
    ...(drain === undefined
      ? {}
      : {
          drain: {
            draining: drain.draining,
            // Soft-closed, nothing moves: `running`, `idle` and `waitingOnYou` are disjoint, as in the PWA and CLI summary.
            ...(drain.draining
              ? { moving: drain.moving.length }
              : {
                  running: drain.moving.filter((m) => !m.idle && !m.waitingOnYou).length,
                  idle: drain.moving.filter((m) => m.idle && !m.waitingOnYou).length,
                }),
            waitingOnYou: drain.moving.filter((m) => m.waitingOnYou).length,
            moved: drain.moved.length,
            stuck: drain.stuck.map((s) => ({
              ...(s.taskId === undefined ? {} : { taskId: s.taskId }),
              reason: drainStuckText(s),
            })),
            empty: drain.empty,
          },
        }),
    ...(role === null ? {} : { scheduler: role }),
    ...(source === undefined
      ? {}
      : {
          source: {
            sha: source.sha.slice(0, 12),
            committed: new Date(source.commitTs).toISOString(),
            branch: source.branch,
          },
        }),
    ...(lastUpdate === undefined
      ? {}
      : {
          lastUpdate: {
            at: new Date(lastUpdate.at).toISOString(),
            // No `detail`: raw git/bun stderr, and the outcome code carries the meaning.
            outcome: lastUpdate.outcome,
          },
        }),
  };
}

/** The local machine as `list_machines` renders it when the relay cannot be reached at all. */
function describeLocal(local: LocalMachine, reachable: boolean, repos: readonly RepoEntry[]): Record<string, unknown> {
  return {
    name: local.name,
    deviceId: local.deviceId,
    platform: local.platform,
    connected: reachable,
    repos: repos.map((repo) => repo.name),
    local: true,
  };
}

/**
 * Whether the local entry is `connected`. A broker failure already observed the
 * daemon on the very socket local ops use, so its verdict stands; probing again
 * could race a restart and contradict the advice in the same answer.
 */
function localReachable(local: LocalMachine, err: unknown): Promise<boolean> {
  if (err instanceof FleetUnreachable && err.localOps !== "unknown") return Promise.resolve(err.localOps === "up");
  return local.reachable();
}

function fallbackNote(err: unknown, reachable: boolean): string {
  // The broker's advice already says what local ops can expect; adding to it would only repeat or contradict it.
  if (err instanceof FleetUnreachable) return `${err.message} Only this machine is listed.`;
  const why = `the relay is unreachable (${failureText("connect", err)})`;
  return reachable
    ? `${why} — only this machine is listed (without its exclaves: the scheduler needs the relay); get_sessions and despawn_session still work here, but spawn_session queues through the relay, so nothing can be spawned until it is back`
    : `${why} — only this machine is listed (without its exclaves: the scheduler needs the relay), and its daemon is not listening either, so no op on this machine works until seanced is running (\`seance status\`)`;
}

/** `LocalUnavailable` is the one worth naming a fix for — here, so every flavour of it carries the advice. */
function localFailureText(op: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof LocalUnavailable) {
    return `${op} failed: ${detail} — is seanced running? try \`seance status\``;
  }
  return `${op} failed: ${detail}`;
}

/**
 * Both legs need this: a handler that throws answers with an `ErrorResponse`, and
 * neither client treats that as a failure — `RequestFailure` is the relay refusing
 * to deliver, not the daemon refusing to serve. Unchecked, `sessions` is undefined
 * and `JSON.stringify` hands `textResult` a non-string.
 */
function renderSessions(reply: SessionsResponse | ErrorResponse): ToolResult {
  if ("ok" in reply) return errorResult(`get_sessions failed (${reply.code}): ${reply.message}`);
  return textResult(JSON.stringify(reply.sessions.map(agentVisibleSession), null, 2));
}

/** A session as another agent's context may see it: its tags cut to the allowlist (docs/tags.md §6.3). */
function agentVisibleSession(entry: SessionEntry): SessionEntry {
  const { tags, ...rest } = entry;
  const visible = agentVisibleTags(tags);
  return visible === undefined ? rest : { ...rest, tags: visible };
}

/** One line per failure whichever transport carried it: a brokered `RequestFailure` renders as the direct one does. */
function failureText(op: string, err: unknown): string {
  const detail =
    err instanceof RequestFailure
      ? failureReasonText(err)
      : err instanceof BrokerError
        ? brokerFailureText(err)
        : err instanceof Error
          ? err.message
          : String(err);
  return `${op} failed: ${detail}`;
}

/** Why the fleet could not be opened at all. A keyless box's reason is self-explanatory; a direct failure is the relay's. */
function openFailureText(err: unknown): string {
  return err instanceof FleetUnreachable ? err.message : failureText("connecting to the relay", err);
}

/**
 * `send_message`'s routing check (`sendMessage`'s `routeGate`), run only when the daemon says the task is not on its
 * machine: the verified leader must advertise `messageRoute`, or an older one would drop the message unseen. Its own
 * lease, so the idle clock sees it like any tool call. Exported because the e2e builds the gate exactly as the tool
 * does, over a real fleet.
 */
export function messageRouteGate(fleet: Fleet): RouteGate {
  return async (need) => {
    let lease: FleetLease;
    try {
      lease = await fleet.open();
    } catch (err) {
      return { ok: false, text: openFailureText(err) };
    }
    try {
      if (lease.scheduler === null) {
        return {
          ok: false,
          text: `can't confirm a scheduler leader routes messages (${SCHEDULER_NEEDS_NEWER_DAEMON}); nothing was sent`,
        };
      }
      const availability = lease.scheduler.availability();
      const capability = need === "reply" ? CAPABILITIES.messageReply : CAPABILITIES.messageRoute;
      if (advertises(lease.machines, availability, capability)) return { ok: true };
      return {
        ok: false,
        text:
          availability.kind === "ready"
            ? `the scheduler's leader cannot route ${need === "reply" ? "replies" : "messages"} yet — its daemon needs \`seance update\`; nothing was sent`
            : "no verified scheduler is leading, so a message to another machine cannot be routed — try again once one leads; nothing was sent",
      };
    } finally {
      lease.release();
    }
  };
}

/**
 * `watch_github`'s gate, run before the add is sent: this machine's daemon and the verified leader must both advertise
 * `watches` (docs/gh-watch.md W10), never the daemon's word alone. Its own lease, as `messageRouteGate`'s. Exported
 * for its tests.
 */
export function watchGate(fleet: Fleet, local: LocalMachine | null): WatchGate {
  return async () => {
    if (local === null) return { ok: false, text: "this machine has no daemon state, so no daemon can watch for it" };
    let lease: FleetLease;
    try {
      lease = await fleet.open();
    } catch (err) {
      return { ok: false, text: openFailureText(err) };
    }
    try {
      if (lease.scheduler === null) {
        return { ok: false, text: `can't confirm a scheduler leader keeps watches (${SCHEDULER_NEEDS_NEWER_DAEMON})` };
      }
      const own = lease.machines.find((m) => m.deviceId === local.deviceId);
      if (own === undefined) return { ok: false, text: "this machine's daemon is not in the fleet's registry" };
      if (own.capabilities?.includes(CAPABILITIES.watches) !== true) {
        return { ok: false, text: "this machine's daemon keeps no watches yet — it needs `seance update`" };
      }
      const availability = lease.scheduler.availability();
      if (advertises(lease.machines, availability, CAPABILITIES.watches)) return { ok: true };
      return {
        ok: false,
        text:
          availability.kind === "ready"
            ? "the scheduler's leader keeps no watches yet — its daemon needs `seance update`"
            : "no verified scheduler is leading, so nothing would read GitHub for the watch",
      };
    } finally {
      lease.release();
    }
  };
}

/** `watch_github`'s and `unwatch_github`'s frame client; `seance mcp` sends the `watch` frame, tests drive a double. */
export interface WatchClient {
  readonly add: typeof watchGithub;
  readonly remove: typeof unwatchGithub;
}

const WATCH_CLIENT: WatchClient = { add: watchGithub, remove: unwatchGithub };

/**
 * `machine: "auto"`: no machine pin, the scheduler places the spawn. Matched in
 * any case, as names are; a machine actually named "auto" is pinned by its deviceId.
 */
export const AUTO_MACHINE = "auto";

function isAutoRef(ref: string): boolean {
  return ref.toLowerCase() === AUTO_MACHINE;
}

/**
 * Said wherever `auto` is described, because an agent will otherwise take the
 * queue for something it is not. The queue is the relay's store, so a waiting
 * task survives a leader change (docs/scheduler.md, M3).
 */
const AUTO_LIMITS =
  "The scheduler's queue is held by the relay: a task waits there for capacity, survives leader changes (every relay deploy and daemon self-update), and runs once a scheduler leads. A task already placed is an ordinary session. Dependencies, batches, refs (the issue or PR a task is for), pins, avoided machines and required traits are set with spawn_session's after, until, ref, pin, avoid and requires fields and with queue_batch. A start time (not_before) holds a task until then; it is not a deadline.";

/** `not_before` on the tools that create a task: ISO 8601 with an offset, so the model resolves a relative request itself. */
const NOT_BEFORE_FIELD = z
  .string()
  .optional()
  .describe(
    "Not before this time: ISO 8601 date-time with an offset (`2026-11-18T21:30:00+01:00` or `…Z`). Resolve relative requests ('in 2 hours') yourself. The task is not started before then (to within about 30 s); start_task ignores it, and a time already past is refused",
  );

/** `not_before` as the epoch ms a spec holds, or why it is refused. */
function notBeforeInput(text: string): { readonly at: number } | { readonly error: string } {
  const at = parseDateTime(text, { requireOffset: true });
  if (at === null) {
    return { error: `not_before ${JSON.stringify(text.slice(0, 64))} is not an ISO 8601 date-time with an offset` };
  }
  return at <= Date.now() ? { error: "not_before is in the past" } : { at };
}

/** What `schedulerFailureText` and `olderDaemonText` name a scheduler call by. */
type SchedulerCall = "get_queue" | "cancel_task";
type SchedulerTool =
  | "spawn_session"
  | "queue_batch"
  | "continue_task"
  | "start_task"
  | "pass_task"
  | "amend_task"
  | SchedulerCall;

/**
 * A keyless box's daemon brokers the scheduler (DESIGN.md "Fleet broker"), so a
 * lease with no scheduler leg means that daemon predates it, or was restarting.
 */
function olderDaemonText(op: SchedulerTool): string {
  return `${op} unavailable: ${SCHEDULER_NEEDS_NEWER_DAEMON}`;
}

/**
 * The leader's message is its own `String(err)` — any length, any lines — and a tool result is
 * one line for a person: control characters collapse to spaces, and it is cut at the bound a
 * task's failure message already has.
 */
function oneLine(message: string): string {
  return message
    .replaceAll(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .trim()
    .slice(0, TASK_FAILURE_LIMITS.message);
}

/** A cancel's answer lost: its session may already be ended, and the queue says. */
const MAY_HAVE_CANCELLED = "the cancel may have landed anyway — check get_queue";

/** A transport-code answer carries the leader's own message, never contradicted: an `unrecorded` cancel's already says its session may have ended. */
const LEADER_SAYS_IF_CANCELLED =
  "the leader's message says whether the cancel landed — if it does not, check get_queue";

function candidateWhere(candidate: Candidate): string {
  return candidate.exclave === null ? candidate.machine : `${candidate.machine}/${candidate.exclave}`;
}

/** A decision record in one line: who was chosen, and why each other candidate was not. */
export function decisionText(decision: Decision): string {
  const { chosen } = decision;
  const winner =
    chosen === null
      ? undefined
      : decision.candidates.find((c) => c.deviceId === chosen.deviceId && c.exclave === chosen.exclave);
  let head = "no candidate can take it now";
  if (chosen !== null) {
    const where = winner === undefined ? `${chosen.deviceId}/${chosen.exclave}` : candidateWhere(winner);
    const score = winner?.score === undefined ? "" : ` (lowest score, ${winner.score.total.toFixed(2)})`;
    const spill =
      winner?.spill === undefined
        ? ""
        : `, ${winner.spill.spending === true ? "spending credits" : "may spill into credits"} (${winner.spill.window})`;
    head = `chose ${where}${score}${spill}`;
  }
  const others = decision.candidates
    .filter((c) => c !== winner)
    .map((c) => {
      if (c.rejected.length > 0) return `${candidateWhere(c)}: ${c.rejected.map(reasonText).join(", ")}`;
      if (c.score === undefined)
        return `${candidateWhere(c)}: rejected for a reason this seanced can't read; the leader may run another version`;
      // With nothing chosen a scored candidate lost to something other than its score (a hold, a race).
      const lost = chosen === null ? "scored but not chosen" : "scored higher";
      return `${candidateWhere(c)}: ${lost}, ${c.score.total.toFixed(2)}`;
    });
  // Cut from this copy (`Decision.trimmed`): the list above is partial, not every loser.
  const cut = decision.trimmed ?? 0;
  const omitted = cut === 0 ? [] : [`${cut} more ${cut === 1 ? "candidate" : "candidates"} not shown`];
  const tail = [...others, ...omitted];
  return tail.length === 0 ? head : `${head}; ${tail.join("; ")}`;
}

interface TaskPlacement {
  readonly machine: string;
  readonly deviceId: string;
  readonly exclave: string;
  readonly clone: string;
  readonly window?: string;
}

function machineName(task: Task, machines: readonly Machine[], deviceId: string): string | undefined {
  return (
    machines.find((m) => m.deviceId === deviceId)?.name ??
    task.decision?.candidates.find((c) => c.deviceId === deviceId)?.machine
  );
}

/** An account's label, plus its alias where one is set: a pin takes the alias too. */
function describeName(names: AccountNames, accountId: string): Record<string, string> {
  const alias = names.aliases.get(accountId);
  return { account: nameOf(names, accountId), ...(alias === undefined ? {} : { alias }) };
}

/** An account by its label beside its id. */
function describeAccount(names: AccountNames, accountId: string): Record<string, string> {
  return { account: nameOf(names, accountId), accountId };
}

/** A machine by deviceId, named where this view knows it. */
function describeDevice(task: Task, machines: readonly Machine[], deviceId: string): Record<string, string> {
  const machine = machineName(task, machines, deviceId);
  return { ...(machine === undefined ? {} : { machine }), deviceId };
}

/** A task's pin: its machine named where this view knows it, its account by label beside the id. */
function describePin(task: Task, machines: readonly Machine[], names: AccountNames): Record<string, string> | null {
  const { pin } = task.spec;
  if (pin === undefined) return null;
  return {
    ...(pin.deviceId === undefined ? {} : describeDevice(task, machines, pin.deviceId)),
    ...(pin.account === undefined ? {} : describeAccount(names, pin.account)),
  };
}

/** Where a task landed, or is landing, by registry name where this view still has it. */
function placementOf(task: Task, machines: readonly Machine[]): TaskPlacement | null {
  const target = task.assignment ?? task.reservation;
  if (target === undefined) return null;
  const machine = machineName(task, machines, target.deviceId) ?? target.deviceId;
  const { deviceId, exclave, clone } = target;
  const window = task.assignment?.window;
  return { machine, deviceId, exclave, clone, ...(window === undefined ? {} : { window }) };
}

/**
 * A scheduler-set code leads with its shared wording, but keeps the raw message: it alone names
 * the failed dependency, the loop, or why a dispatch went unconfirmed. A daemon refusal's is its own.
 * A `session_failed` with its status, or a `session_closed`, drops it: the wording already says all the message does.
 */
function failureMessage(task: Task, failure: NonNullable<Task["failure"]>): string {
  const worded = taskFailureText(failure.code, failure.exit, task.spec.until, failure.oomKill);
  if (worded === null) return failure.message;
  if (failure.code === "session_closed") return worded;
  return failure.code === "session_failed" && failure.exit !== undefined ? worded : `${worded} (${failure.message})`;
}

function describeHold(hold: PauseHold, names: AccountNames): Record<string, unknown> {
  return {
    ...(hold.account === undefined ? {} : describeAccount(names, hold.account)),
    until: hold.until,
    since: new Date(hold.at).toISOString(),
    ...(hold.resumeAt === undefined ? {} : { resumeAt: new Date(hold.resumeAt).toISOString() }),
  };
}

/**
 * Every input object is strict, nested ones included: zod strips unknown keys by default, which turned
 * a misspelled or retired field (a stale `plan: true`) into a silently different task. The SDK reports
 * the refusal as a tool error naming the key (DESIGN.md, "MCP server"), so the caller can correct it.
 */
const NO_INPUT = z.strictObject({});

const AFTER_WHEN = z
  .enum(DEP_AFTER)
  .default("opened")
  .describe(
    '"opened" (the default): the task has a PR and its branch is pushed. A worktree task\'s first "opened" entry is what it stacks on: its worktree starts from that task\'s pushed branch, not the default branch, so it builds on that work before it merges (from the default branch instead if that PR merged first, or if the task finished with nothing pushed). "merged": its branch merged, and the worktree starts from the default branch, which then holds the work: the choice for work that should not build on an unmerged branch. "done": the task is settled done — for a task authored with until "reported", only its session\'s own report',
  );

const REF_DESCRIPTION =
  'What this task is for, as source:id — e.g. "linear:ENG-123" or "github:owner/repo#12" (a lowercase source of letters, digits and hyphens, then a colon, then an id of at most 64 letters, digits and ._#/-). Informational: the scheduler stores and shows it (get_queue lists it as tags["creator.ref"]), and reads nothing from the tracker. It replaces the retired `linear: { issue, url }` field: pass "linear:ENG-123" here and the URL as the ref URL';
const REF_URL_DESCRIPTION = "The ref's https: URL, shown beside it in the app; only with the ref";

const AUTONOMY_FIELD = z
  .enum(AUTONOMY_LEVELS)
  .optional()
  .describe(
    "How much the session decides on its own. steer: it starts in plan mode, plans and waits for approval before changing anything. Set it when the request is to plan, design, investigate or scope work rather than carry it out. checkpoint, the default: it never stops to ask whether to proceed, only for real choices, which it asks with a recommendation. auto: it also makes reversible choices itself and records them as Decided lines for review, stopping only for guardrails (production, money, secrets, deleting, messaging people) and choices it has no recommendation for. Set auto when the user wants the work done unattended, steer when they want to approve a plan first; omit it otherwise",
  );

const UNTIL_FIELD = z
  .enum(TASK_UNTIL)
  .optional()
  .describe(
    `What settles the task. "merged" (default): its PR merging, or its session ending — the first merge settles it even while its session keeps working, after which it can no longer be passed to a successor. "reported": a merge settles nothing; the session settles it by calling ${REPORT_DONE_TOOL} when it is truly finished (a deploy watched, a follow-up PR, evals run after the merge, say), which lets dependents wait for that. It needs a prompt, to which the instruction to report is appended, and the session needs the seance MCP server installed in its exclave`,
  );

const PIN_FIELD = z
  .strictObject({
    machine: z
      .string()
      .optional()
      .describe(
        `Machine name (or deviceId) from list_machines. A name two machines share is refused: use a deviceId. At most ${TASK_SPEC_LIMITS.placement} characters`,
      ),
    account: z
      .string()
      .optional()
      .describe(
        "A Claude account: its alias (as the PWA names it), its email, or its accountId (organization:account) — list_machines lists each exclave's accountId, email and alias (not its `account` label, which is no value to pass). Only an account some machine reports signed in is taken; the task stores its accountId, never the alias or email",
      ),
    // Retired, still listed: strict refuses it anyway, but `placementInput` says what replaced it.
    exclave: z.unknown().optional().describe("Retired: refused"),
  })
  .optional()
  .describe(
    "Restrict where the scheduler may place the task — to one machine, one account, or both; give at least one. An unknown machine, a name two machines share, an account no machine (or not the pinned one) reports signed in, or an alias or email two accounts share is refused, naming the choices. A pinned task waits in the queue for a slot where it is pinned rather than going elsewhere. Give its repo as the pinned machine (or the account's clones) list it, or by origin",
  );

const AVOID_FIELD = z
  .array(z.string())
  .optional()
  .describe(
    `Machines (name or deviceId) the scheduler must not place the task on, at most ${TASK_SPEC_LIMITS.avoid}. Naming the pinned machine is refused; avoiding every other machine is not — the task waits`,
  );

const REQUIRES_FIELD = z
  .array(z.string())
  .min(1)
  .max(TASK_SPEC_LIMITS.requires)
  .optional()
  .describe(
    `Traits the machine must declare (list_machines shows each exclave's \`traits\`): the task is placed only on an exclave carrying every one, at most ${TASK_SPEC_LIMITS.requires}. A trait no machine declares is refused, naming the ones that exist; so is a combination no exclave the task may reach carries. A trait on a machine that is offline makes the task wait for it. A trait whose probe is failing on every exclave that carries it holds the task there too (list_machines shows traitsFailing; get_queue names the machines under requires[].failing)`,
  );

const REPORTED_GATE =
  "spawn refused: the scheduler's leader does not take until: reported / after: done yet — its daemon needs `seance update`";
const REPORTED_UNKNOWN =
  "spawn refused: no verified scheduler is leading, so it cannot be confirmed to take until: reported / after: done — try again once one leads (list_machines shows it)";

/** Why an `until: "reported"` / `after: "done"` spec is not written to this lease's scheduler. */
function reportedGateError(lease: Parameters<typeof leaderTakesReported>[0]): string {
  return lease.scheduler.availability().kind === "ready" ? REPORTED_GATE : REPORTED_UNKNOWN;
}

/** Empty model/effort mean "default", which a task spells as absent. */
function requestFields(input: {
  readonly prompt?: string | undefined;
  readonly title?: string | undefined;
  readonly mode: "worktree" | "here";
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly autonomy?: AutonomyLevel | undefined;
}): Omit<AutoSpec, "repo"> {
  const { prompt, title, mode, model, effort, autonomy } = input;
  const fields = {
    mode,
    ...(prompt === undefined ? {} : { prompt }),
    ...(title === undefined ? {} : { title }),
    ...(model === undefined || model === "" ? {} : { model }),
    ...(effort === undefined || effort === "" ? {} : { effort }),
    ...(autonomy === undefined ? {} : { autonomy }),
  };
  // `steer` is sealed with `plan: true`, for a leader that drops `autonomy`. Never null: the tools take no `plan`.
  return withAutonomy(fields) ?? fields;
}

/** The authoring fields as a spec holds them: `until` only when it is not the default. */
function authoredFields(deps: readonly TaskDep[], until: TaskUntil | undefined): Pick<AutoSpec, "deps" | "until"> {
  return {
    ...(deps.length === 0 ? {} : { deps }),
    ...(until === "reported" ? { until } : {}),
  };
}

/**
 * A caller's ref as the creator tags a spec holds (`creatorTaskTags`, the one validator), or the refusal naming the
 * fields the caller wrote. A blank ref is none, and a URL beside none is a mistake worth saying so.
 */
function refInput(
  ref: string | undefined,
  url: string | undefined,
  names: { readonly ref: string; readonly url: string },
): Pick<AutoSpec, "tags"> | { readonly error: string } {
  const bare = url === undefined || url.trim() === "" ? undefined : url;
  if (ref === undefined || ref.trim() === "") {
    return bare === undefined ? {} : { error: `${names.url} needs ${names.ref}` };
  }
  const written = creatorTaskTags(refTags(ref.trim(), bare));
  if (!written.ok) {
    return {
      error: `${names.ref} must be source:id (a lowercase source, a colon, then an id of at most 64 letters, digits and ._#/-) and ${names.url} an https: URL`,
    };
  }
  return { tags: written.tags };
}

/**
 * `until: "reported"` carries its own instruction to report: appended here so the author sees the length
 * bound, and the leader never rewrites a prompt. A session told nothing would never report.
 */
function withReportedPrompt(
  until: TaskUntil | undefined,
  prompt: string | undefined,
): { readonly prompt: string | undefined } | { readonly error: string } {
  if (until !== "reported") return { prompt };
  if (prompt === undefined || prompt.trim() === "") {
    return { error: 'until "reported" needs a prompt — the session is told in it to report itself done' };
  }
  return { prompt: withReportInstruction(prompt) };
}

/** A batch is at most this many members: one tool call, and `queue_batch` creates them one by one. */
const BATCH_TASKS_MAX = 16;

/** Under `until: "reported"` the prompt the author wrote is not the one that is bounded. */
function lengthNote(invalid: string, until: TaskUntil | undefined): string {
  if (until !== "reported" || !invalid.startsWith("the prompt is")) return "";
  return " (the instruction to report is appended to the prompt and counts)";
}

function shownTags(spec: Task["spec"], at: number): Readonly<Record<string, string>> | undefined {
  const visible = agentVisibleTags(taskTagEntries(spec, at));
  return visible === undefined ? undefined : Object.fromEntries(Object.entries(visible).map(([k, e]) => [k, e.value]));
}

function describeTask(
  task: Task,
  machines: readonly Machine[],
  names: AccountNames,
  tasks: readonly Task[],
  offer: OfferContext,
  idle: ReadonlySet<string>,
  traits: ReadonlyMap<string, readonly string[]>,
  leaderSuccessor: boolean,
  now: number,
): Record<string, unknown> {
  const placement = placementOf(task, machines);
  const pin = describePin(task, machines, names);
  const { spec } = task;
  const level = autonomyOf(spec);
  const blocked = taskPrBlock(task);
  const tags = shownTags(spec, task.createdAt);
  return {
    id: task.id,
    state: task.state,
    repo: spec.repo,
    ...(spec.title === undefined ? {} : { title: spec.title }),
    // Cut to QUEUE_PROMPT_PREVIEW by the leader; a finished task has none.
    ...(spec.prompt === undefined ? {} : { prompt: spec.prompt }),
    createdAt: new Date(task.createdAt).toISOString(),
    ...(placement === null ? {} : { placement }),
    ...(pin === null ? {} : { pin }),
    ...(spec.avoid === undefined ? {} : { avoid: spec.avoid.map((id) => describeDevice(task, machines, id)) }),
    // Where each trait is declared, so a task held for one reads with the machines that could end the wait,
    // and which of them have a failing probe on every exclave that carries it ("MacBook's probe is failing").
    ...(spec.requires === undefined
      ? {}
      : {
          requires: spec.requires.map((trait) => {
            const { failing } = traitHealthByMachine(machines, trait, now);
            return { trait, machines: traits.get(trait) ?? [], ...(failing.length === 0 ? {} : { failing }) };
          }),
        }),
    // A deferred task's record decision is stale: the scheduler skips it unrouted until the time.
    ...(task.decision === undefined ||
    (spec.notBefore !== undefined &&
      spec.notBefore > now &&
      (task.state === "queued" || task.state === "blocked" || task.state === "ready"))
      ? {}
      : { decision: decisionText(task.decision) }),
    ...(task.failure === undefined ? {} : { failure: `${task.failure.code}: ${failureMessage(task, task.failure)}` }),
    // A `manual` mark reads apart from a finish: a person settled it, nothing observed it end.
    ...(task.state === "done" && task.doneBy !== undefined ? { doneBy: task.doneBy } : {}),
    ...(task.escalated === true ? { escalated: true } : {}),
    // The PWA's asleep rule, and the leader's: neither holds a concurrency slot once the machine has been gone ~2 min.
    ...(sleepingMachine(task, machines) !== undefined && task.state !== "lost" ? { away: true } : {}),
    ...(idle.has(task.id) ? { idle: true } : {}),
    ...(task.needsInputSince === undefined ? {} : { needsInputSince: new Date(task.needsInputSince).toISOString() }),
    // The closed kind only: a tool name is a session- or MCP-server-chosen string, not for another agent's context.
    ...(task.inputReason === undefined ? {} : { inputReason: task.inputReason }),
    // The closed reason only: the custodian's note is model-written from untrusted pane text, not for another agent's context.
    ...(task.flag === undefined ? {} : { flag: task.flag.reason }),
    ...(spec.until === "reported" ? { until: spec.until } : {}),
    // Only off the default: most tasks run at checkpoint, and `plan: true` alone reads as steer.
    ...(level === DEFAULT_AUTONOMY ? {} : { autonomy: level }),
    // A merge under `until: "reported"` settles nothing, so it is told apart from a finish here too.
    ...(task.merged === true ? { merged: true } : {}),
    ...(spec.batch === undefined ? {} : { batch: { id: spec.batch.id, index: spec.batch.index } }),
    ...(spec.deps === undefined ? {} : { after: spec.deps.map((dep) => ({ task: dep.task, when: dep.after })) }),
    // Only what `AGENT_VISIBLE_TAG_KEYS` allows: never the ref's URL or an opaque creator tag (a legacy `linear` reads as `creator.ref`).
    ...(tags === undefined ? {} : { tags }),
    ...(spec.continues === undefined ? {} : { continues: spec.continues.task }),
    ...(spec.notBefore === undefined ? {} : { notBefore: new Date(spec.notBefore).toISOString() }),
    // The same offer the app's Continue button follows; `continue_task` still re-checks the leader.
    ...(continueOffer(task, machines, tasks, offer).ok ? { continuable: true } : {}),
    ...(task.stack === undefined ? {} : { stackedOn: { task: task.stack.task, base: task.stack.on } }),
    ...(spec.succeeds === undefined ? {} : { succeeds: spec.succeeds.task }),
    ...(task.successor === undefined ? {} : { passedTo: task.successor }),
    // The same offer the app's menu follows; `pass_task` still re-checks the leader.
    ...(passOffer(task, machines, leaderSuccessor).ok ? { passable: true } : {}),
    // Never `prBlocked` on the task: an `until: "reported"` task does not wait on its merge.
    ...(blocked === null ? {} : { prBlocked: blocked }),
  };
}

/**
 * Why a scheduler call threw. A cancel whose reply was lost is "may have landed",
 * never "failed". A request that never left ("disconnected") is a plain failure.
 */
function schedulerFailureText(op: SchedulerCall, err: unknown): string {
  const landed = op === "cancel_task" ? MAY_HAVE_CANCELLED : null;
  if (err instanceof RequestFailure) {
    if (err.reason === "no_leader" || err.reason === "leader_unverified") {
      return `${op} unavailable: ${failureReasonText(err)}`;
    }
    if (landed !== null && (err.reason === "timeout" || err.reason === "dropped")) {
      return `${op}: no answer from the scheduler (${err.message}) — ${landed}`;
    }
    return `${op} failed: ${failureReasonText(err)}`;
  }
  const detail = err instanceof Error ? err.message : String(err);
  return landed === null ? `${op} failed: ${detail}` : `${op}: ${detail} — ${landed}`;
}

/** The answer to `cancel_task`: the task as it now stands, and what the cancel did or could not do. */
function renderCancelled(task: Task, machines: readonly Machine[]): ToolResult {
  const placement = placementOf(task, machines);
  const where = placement === null ? "" : ` on ${placement.machine}`;
  const lines = [`task ${task.id}: ${task.state}${where}`];
  if (task.state !== "cancelled") lines.push(`It had already finished (${task.state}) before the cancel landed.`);
  else if (task.leftRunning === true) {
    lines.push(
      `Its machine was away, so nothing was stopped there — its session may still be running: check get_sessions${where} once it is back, and end it with despawn_session.`,
    );
  }
  return textResult(lines.join("\n"));
}

/**
 * The MCP face of Séance: tools mapping 1:1 onto the registry and the
 * `sessions`/`despawn` ops, plus the scheduler behind `spawn_session` (a
 * store-put the relay answers), `get_queue` and `cancel_task`. Anything this hands to the relay rides the same
 * envelope crypto as the PWA — there is no separate MCP wire surface, whether
 * this process seals it or the daemon's broker does (`fleet.ts`).
 *
 * `local` is what makes a self-targeted call skip the relay: the per-machine
 * ops go straight to this box's daemon over its op socket, which is the same
 * handler the relay leg reaches and so the same backend, repo set, machineTag
 * and audit trail — only tagged `origin=local`. Null on a box with no daemon
 * state, where every target is remote by definition.
 *
 * `audit` takes the `origin=mcp` enqueue line (`enqueueAudit`): this process
 * records its own spawn enqueue in the audit log, as `seance spawn` does —
 * never on stdout, the JSON-RPC channel. When the daemon's broker makes the
 * enqueue for a keyless process, the daemon adds its own `origin=local-broker`
 * line beside it.
 */
export function buildMcpServer(
  fleet: Fleet,
  local: LocalMachine | null = null,
  audit: AuditSink = cliSink,
  report: typeof reportDone = reportDone,
  handOffTask: typeof handOff = handOff,
  passOwnTask: typeof passToSuccessor = passToSuccessor,
  passPoll: PassPoll = PASS_POLL,
  sendMsg: typeof sendMessage = sendMessage,
  /** `pass_to_successor`'s own pane, for its check before the push (`ownSettledTask`). */
  ownPane: () => string | undefined = () => process.env["TMUX_PANE"],
  watchClient: WatchClient = WATCH_CLIENT,
): McpServer {
  // 0.0.0 mirrors the package: the daemon versions by git sha, not semver.
  const server = new McpServer({ name: "seance", version: "0.0.0" });

  // Every tool bumps the idle clock via open/release, even ones that fail.
  const withFleet = async (fn: (lease: FleetLease) => Promise<ToolResult>): Promise<ToolResult> => {
    let lease: FleetLease;
    try {
      lease = await fleet.open();
    } catch (err) {
      return errorResult(openFailureText(err));
    }
    try {
      return await fn(lease);
    } finally {
      lease.release();
    }
  };

  server.registerTool(
    "list_machines",
    {
      title: "List machines",
      description:
        "List the dev machines registered with the Séance relay: name, platform, connectivity, and the repos each one can spawn a Claude Code session in. `exclaves` are its exclaves (the accounts' homes): each one's id, and the accountId and email of the Claude account signed in there, if any, plus `account`, the name every Séance client shows for it (its alias where one is set, else the email, else a short id; tagged where two accounts would read alike; no alias on a box whose daemon brokers for it, with no readable PSK) — a display name only, never a value for pin.account — and `alias` where one is set: a spawn's pin.account takes the `accountId`, the `email` or the `alias`, not `account`; a machine with the field absent or empty reports none, so the scheduler cannot place there until its daemon updates. Each signed-in exclave's `auth` is `expired` (its login needs /login; the scheduler does not place there), `expiring` (within 3 days, with `loginExpiresAt`; still placed), `ok`, or `unknown` (not read, or the machine is asleep or its daemon older; still placed). Offline machines are listed with their last-seen time: `lastSeen` is when the machine was last heard from (its last register or status beat, whichever is later). `closed` is when a person closed the machine to new scheduled work (null when open). On a closed machine, under a leader that drains closed machines, `drain` says how that is going: `draining` false for a soft close, whose drain has not been started (nothing is moved: `running` tasks still working there, `idle` ones idle at their prompt, which never finish on their own and are what a drain is for (the leader counts one idle 10 minutes after its turn ended), and `waitingOnYou` ones waiting on a person), true once it has (`moving` tasks still being passed to other machines, `waitingOnYou` of them waiting on a person); then `moved` successors created, `stuck` what the drain cannot move or was refused, each with a reason, and `empty`, whether no session is left on it (null when its sessions could not be read). `source` is the build a machine's daemon runs (sha, commit time, branch) and `lastUpdate` its last reported self-update attempt, with when it ran (a skipped_* or *_failed outcome is replaced by `current` once a later check finds the machine up to date). `scheduler: \"leader\"` marks the verified scheduler leader that every spawn goes through; `\"unverified\"` marks a nominee that has not proven it holds this fleet's key, so get_queue, cancel_task, start_task and pass_task refuse to ask it; no mark on any entry means no verified leader, or that this machine's daemon could not say (older, or restarting).",
      inputSchema: NO_INPUT,
      annotations: { readOnlyHint: true },
    },
    async () => {
      let lease: FleetLease;
      try {
        lease = await fleet.open();
      } catch (err) {
        // The fleet needs the relay, but this box does not. Answering with the
        // local machine alone beats answering with nothing: a model that cannot
        // see any machine cannot spawn on the one it is sitting on either.
        if (local === null) return errorResult(openFailureText(err));
        const [reachable, repos] = await Promise.all([localReachable(local, err), local.repos()]);
        return textResult(
          JSON.stringify(
            { machines: [describeLocal(local, reachable, repos)], note: fallbackNote(err, reachable) },
            null,
            2,
          ),
        );
      }
      try {
        const scheduler = lease.scheduler?.availability() ?? null;
        const names = await accountNames(lease);
        const drains = await readDrains(lease, local, scheduler);
        const machines = lease.machines.map((machine) =>
          describeMachine(machine, local, scheduler, names, Date.now(), drains.get(machine.deviceId)),
        );
        return textResult(JSON.stringify(machines, null, 2));
      } finally {
        lease.release();
      }
    },
  );

  server.registerTool(
    "get_sessions",
    {
      title: "List running sessions",
      description:
        "List the Claude Code tmux sessions currently running on a machine. Naming this machine answers from the local daemon without touching the relay.",
      inputSchema: z.strictObject({ machine: z.string().describe("Machine name (or deviceId) from list_machines") }),
      annotations: { readOnlyHint: true },
    },
    async ({ machine }) => {
      if (local !== null && isLocalRef(local, machine)) {
        try {
          return renderSessions(await local.request<SessionsResponse>("sessions", {}));
        } catch (err) {
          return errorResult(localFailureText("get_sessions", err));
        }
      }
      return withFleet(async (lease) => {
        const resolved = resolveMachine(lease.machines, machine);
        if ("error" in resolved) return errorResult(resolved.error);
        try {
          return renderSessions(await lease.request<SessionsResponse>(resolved.machine.deviceId, "sessions", {}));
        } catch (err) {
          return errorResult(failureText("get_sessions", err));
        }
      });
    },
  );

  server.registerTool(
    "get_queue",
    {
      title: "List the scheduler's queue",
      description: `List the scheduler's queue — the tasks spawn_session and queue_batch queued, and other clients' (the app, the CLI), and what holds dispatch (a paused queue, or an account named as a pin names it) — with each one's state, its pin (whichever of machine and account it pins: the machine by name where known, plus its deviceId; the account by its alias where one is set (none on a box whose daemon brokers for it), else the email a machine reports, else a short id, plus its accountId; an email or short id two accounts share, case aside, gains a tag telling them apart: the org's short id, or more of it where that still collides; pinned and held accounts no machine reports count as accounts too), the machines it avoids, its autonomy level where it is not the default checkpoint, where it was placed, and why the latest routing decision chose or rejected each machine. At most ${QUEUE_MAX_TASKS} tasks, unfinished first (a task waiting on a person leads); an awaiting-merge task whose open PR is stuck carries \`prBlocked\` — \`checks\` (a required check failed), \`conflict\`, \`behind\` (its branch is behind its base) or \`unarmed\` (its required checks passed but nothing will merge it: no auto-merge, no review requested); a task that ran stacked carries \`stackedOn\` — the task whose work its worktree started from (after any pass, the successor holding it) and \`base\`: \`branch\` (that task's pushed branch), \`merged\` (the default branch, since that task's PR had merged) or \`nothing\` (the default branch, since that task finished with nothing pushed); prompts are cut to a preview, and a finished task's is not kept (a task that ran has its transcript on its machine; one that never ran has no copy). A task marked away (its machine not connected) holds no concurrency slot once its machine has been gone about 2 minutes, and one marked idle (its session idle at its prompt 10+ minutes) holds none either; both count again when they resume, so the fleet can sit briefly over its cap. ${AUTO_LIMITS}`,
      inputSchema: NO_INPUT,
      annotations: { readOnlyHint: true },
    },
    async () =>
      withFleet(async (lease) => {
        if (lease.scheduler === null) return errorResult(olderDaemonText("get_queue"));
        let reply: Awaited<ReturnType<SchedulerLeg["queue"]>>;
        try {
          reply = await lease.scheduler.queue();
        } catch (err) {
          return errorResult(schedulerFailureText("get_queue", err));
        }
        if (reply === null)
          return errorResult("get_queue: the scheduler's answer was unreadable (a seanced version mismatch?)");
        if ("ok" in reply) return errorResult(`get_queue failed (${reply.code}): ${schedulerErrorText(reply.code)}`);
        // Pinned and held accounts no machine reports count too: two such read alike without a tag.
        const named = [
          ...reply.tasks.flatMap((task) => (task.spec.pin?.account === undefined ? [] : [task.spec.pin.account])),
          ...(reply.holds ?? []).flatMap((hold) => (hold.account === undefined ? [] : [hold.account])),
        ];
        // Only a pin or a hold names an account here: no listing for a queue that names none.
        const names = await accountNames(lease, named, named);
        const offer = {
          now: reply.at,
          leaderHandoff: advertises(lease.machines, lease.scheduler.availability(), CAPABILITIES.continueHandoff),
        };
        const idle = new Set((reply.idle ?? []).map((ref) => ref.taskId));
        const traits = fleetTraits(lease.machines);
        const leaderSuccessor = advertises(lease.machines, lease.scheduler.availability(), CAPABILITIES.successor);
        const tasks = reply.tasks.map((task) =>
          describeTask(task, lease.machines, names, reply.tasks, offer, idle, traits, leaderSuccessor, Date.now()),
        );
        const holds = (reply.holds ?? []).map((hold) => describeHold(hold, names));
        return textResult(JSON.stringify({ at: new Date(reply.at).toISOString(), holds, tasks }, null, 2));
      }),
  );

  server.registerTool(
    "cancel_task",
    {
      title: "Cancel a scheduler task",
      description:
        "Cancel a scheduler task (one spawn_session or queue_batch queued, or another client's) by its id from get_queue. A task still waiting is taken out of the queue; one running is despawned on its machine first. A task whose machine stopped answering (lost) is cancelled as it stands, and its session may outlive the cancel there. A task mid-dispatch is refused; ask again in a moment.",
      inputSchema: z.strictObject({ taskId: z.string().describe("The task's id from get_queue") }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ taskId }) =>
      withFleet(async (lease) => {
        if (lease.scheduler === null) return errorResult(olderDaemonText("cancel_task"));
        let reply: Awaited<ReturnType<SchedulerLeg["cancel"]>>;
        try {
          reply = await lease.scheduler.cancel(taskId);
        } catch (err) {
          return errorResult(schedulerFailureText("cancel_task", err));
        }
        if (reply === null) {
          return errorResult(
            `cancel_task: the scheduler's answer was unreadable (a seanced version mismatch?) — ${MAY_HAVE_CANCELLED}`,
          );
        }
        if ("ok" in reply) {
          // The transport swaps only a successful reply for `too_large`: the cancel ran, though the task may have finished first.
          if (reply.code === "too_large") {
            return errorResult(
              "cancel_task: the leader took the cancel, but its answer was too large to send — check get_queue for how the task stands",
            );
          }
          // A crashed handler may have got as far as the despawn; its message is the one that knows.
          const said = isTransportError(reply.code) ? `: ${oneLine(reply.message)} — ${LEADER_SAYS_IF_CANCELLED}` : "";
          return errorResult(`cancel_task failed (${reply.code}): ${schedulerErrorText(reply.code)}${said}`);
        }
        return renderCancelled(reply.task, lease.machines);
      }),
  );

  server.registerTool(
    "start_task",
    {
      title: "Start a queued scheduler task now",
      description:
        "Start a task waiting in the scheduler's queue right away, past the fleet's concurrency limit and a paused queue — the app's Start now. Only those are lifted (the queue stays paused for every other task): a paused account, the quota line, the disk floor, a pin or an avoid still hold it, and then it is refused unplaceable (get_queue's decision says why). The task must be ready — admitted, its dependencies released — so one still waiting on admission or its after is refused not_waiting; a task mid-dispatch is refused dispatching. Placed, it counts toward the limit like any task, so nothing new is placed until the count drains. Needs a scheduler leader whose daemon supports it. Answers with where it is starting.",
      inputSchema: z.strictObject({ taskId: z.string().describe("The waiting task's id from get_queue") }),
      annotations: { readOnlyHint: false },
    },
    async ({ taskId }) =>
      withFleet(async (lease) => {
        if (lease.scheduler === null) return errorResult(olderDaemonText("start_task"));
        const outcome = await startAuto({ machines: lease.machines, scheduler: lease.scheduler }, taskId, "mcp");
        return outcome.ok ? textResult(outcome.text) : errorResult(outcome.text);
      }),
  );

  server.registerTool(
    "pass_task",
    {
      title: "Pass a running scheduler task to a successor",
      description:
        "Pass a running task to a successor — the app's Pass to successor. The scheduler has the task's machine push its branch to origin, ends its session and queues a new task that carries the work on in a fresh session, with a prompt that names the branch and the pull request; the old task settles as superseded once the successor exists, and anything waiting on it waits on the successor instead. For a task that is stuck, or whose account is out of quota, and whose work is committed: a task with uncommitted changes, one in place (mode here) or one on the repo's default branch is refused, and nothing is pushed. Only a running task: one waiting for the user (needs-input) or for a merge is refused. Needs a scheduler leader and a task machine whose daemon supports it (get_queue shows both). Sent once and never retried by the tool: if the answer is lost, pass again, which is safe: a task already passed answers with its successor and sends nothing. To pass your own task use `pass_to_successor`; `pass_task` is for other tasks and closes the target session at once. Answers with the successor's task id.",
      inputSchema: z.strictObject({ taskId: z.string().describe("The running task's id from get_queue") }),
      annotations: { readOnlyHint: false },
    },
    async ({ taskId }) =>
      withFleet(async (lease) => {
        if (lease.scheduler === null) return errorResult(olderDaemonText("pass_task"));
        const outcome = await passAuto({ machines: lease.machines, scheduler: lease.scheduler }, taskId, "mcp");
        return outcome.ok ? textResult(outcome.text) : errorResult(outcome.text);
      }),
  );

  server.registerTool(
    "amend_task",
    {
      title: "Amend a task still waiting in the scheduler's queue",
      description: `Change a task that has not started yet — queued, blocked on its dependencies, or ready — in place, so its id, and everything waiting on it, stay as they are. \`append\` adds a note after a blank line at the end of its prompt (say what changed, e.g. "New information: …"); \`replacePrompt\` replaces the whole prompt instead (\`""\` clears it), against the prompt as the queue holds it when this is sent. Give one of the two at most. \`title\`, \`model\` and \`effort\` set those fields; null restores the default. \`not_before\` (ISO 8601 with an offset) sets or moves the time before which it will not start, and null clears it; it needs no prompt basis. The amended prompt stays within ${TASK_REQUEST_LIMITS.prompt} characters (${ATTACHMENT_LIMITS.prompt} with attachments). Refused once the task is starting (dispatching) or placed: a running session already has its prompt, so tell it directly. A successor's prompt takes an append only. Needs a scheduler leader whose daemon supports it. Sent once and never retried: if the answer is lost, check get_queue before amending again, since an append sent twice lands twice. Answers with the task's state.`,
      inputSchema: z.strictObject({
        taskId: z.string().describe("The waiting task's id from get_queue"),
        append: z.string().optional().describe("Text to add at the end of the prompt, after a blank line"),
        replacePrompt: z.string().optional().describe("The whole new prompt, in place of the current one"),
        title: z.string().nullable().optional().describe("A new title; null clears it"),
        model: z.string().nullable().optional().describe("A new model; null restores the default"),
        effort: z.string().nullable().optional().describe("A new effort; null restores the default"),
        not_before: z
          .union([z.string(), z.null()])
          .optional()
          .describe("Not before this time (ISO 8601 with an offset, in the future); null clears it"),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ taskId, append, replacePrompt, title, model, effort, not_before }) =>
      withFleet(async (lease) => {
        if (lease.scheduler === null) return errorResult(olderDaemonText("amend_task"));
        if (append !== undefined && replacePrompt !== undefined) {
          return errorResult("amend_task refused: give append or replacePrompt, not both");
        }
        const deferred = not_before === undefined || not_before === null ? null : notBeforeInput(not_before);
        if (deferred !== null && "error" in deferred) return errorResult(`amend_task refused: ${deferred.error}`);
        const prompt =
          append !== undefined
            ? { mode: "append" as const, text: append }
            : replacePrompt !== undefined
              ? { mode: "replace" as const, text: replacePrompt }
              : undefined;
        const outcome = await amendAuto(
          { machines: lease.machines, scheduler: lease.scheduler },
          {
            taskId,
            ...(prompt === undefined ? {} : { prompt }),
            ...(title === undefined ? {} : { title }),
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
            ...(not_before === null ? { notBefore: null } : deferred === null ? {} : { notBefore: deferred.at }),
          },
          "mcp",
        );
        return outcome.ok ? textResult(outcome.text) : errorResult(outcome.text);
      }),
  );

  server.registerTool(
    "continue_task",
    {
      title: "Continue a failed, cancelled or blocked scheduler task",
      description: `Resume a task whose session ended in failure, or that was cancelled after it started (get_queue marks one \`continuable\`), or an awaiting-merge task whose PR is blocked (\`prBlocked\` in get_queue): the resumed session (the newest of its chain) is told the PR, the reason and the failing required checks, fixes and pushes, then hands the PR back, and the task keeps waiting for the merge. The same conversation, in the same worktree on the same machine, as a new task the scheduler dispatches there, at the task's own autonomy level (a steer task's at checkpoint, out of plan mode). Continue moves to the newest continuation that ran in a chain, and is withheld while one still waits in the queue (cancel that one to continue again); the old task stays as it was, and so do the tasks that wait on it. The new task waits in the queue like any other, and fails if the worktree is gone (reaped), a session is open in it, or a later task ran in the worktree, or the machine no longer holds the launch record (kept a week, at most 128 launches). \`prompt\` is an optional note the resumed session is told, within the ${TASK_REQUEST_LIMITS.prompt}-character prompt bound. Answers with the new task id; get_queue shows where it lands. ${AUTO_LIMITS}`,
      inputSchema: z.strictObject({
        taskId: z.string().describe("The failed, cancelled or blocked awaiting-merge task's id from get_queue"),
        prompt: z.string().optional().describe("Optional: a note for the resumed session, from the user"),
        not_before: NOT_BEFORE_FIELD,
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ taskId, prompt, not_before }) =>
      withFleet(async (lease) => {
        if (lease.scheduler === null) return errorResult(olderDaemonText("continue_task"));
        const deferred = not_before === undefined ? null : notBeforeInput(not_before);
        if (deferred !== null && "error" in deferred) return errorResult(`continue_task refused: ${deferred.error}`);
        const outcome = await continueAuto(
          { machines: lease.machines, scheduler: lease.scheduler },
          taskId,
          prompt,
          audit,
          "mcp",
          deferred === null ? undefined : deferred.at,
        );
        return outcome.ok ? textResult(outcome.text) : errorResult(outcome.text);
      }),
  );

  server.registerTool(
    "spawn_session",
    {
      title: "Spawn a Claude Code session",
      description: `Queue a remote-controlled Claude Code session in a named repo for the scheduler, which picks the machine and account — under a pin, only what it leaves open. machine (or pin.machine) pins it to one machine, pin.account to one account, avoid keeps it off machines. Every scheduler limit still applies to a pinned task (the fleet limit when one is set, the quota line, the disk floor): it waits for a slot where it is pinned rather than going elsewhere, and get_queue says why. Defaults to a fresh git worktree; mode "here" runs in the repo's main checkout instead. Answers with the task id once it is queued (with start, also whether it started), never with a session: get_queue shows where it lands, and get_sessions on that machine shows it running. If this session is itself a scheduler task, opened no pull request and queued this one to carry its work on, call report_task_done once nothing of its own is left, or its task holds a slot until it exits. Goes through this machine's daemon when this process cannot read the key, and caps the prompt at ${TASK_REQUEST_LIMITS.prompt} characters. ${AUTO_LIMITS}`,
      inputSchema: z.strictObject({
        machine: z
          .string()
          .optional()
          .describe(
            'Optional: pin the task to one machine — a name or deviceId from list_machines (a name two machines share is refused: use a deviceId). Omitted or "auto": the scheduler picks any machine. The same as pin.machine; give one or the other',
          ),
        repo: z
          .string()
          .describe(
            "A repo name from list_machines that means one repo across the fleet (a bare basename such as `backend` also matches names listed as `parent/backend`), or the repo's origin when it does not (host/path, or the remote URL as git prints it; case does not matter). Under a machine or account pin, the name is read only where the pin points: the pinned machine's repo list (cut to its clones where the pinned account is signed in), the pinned account's clones, or the origin",
          ),
        prompt: z.string().optional().describe("The task for the spawned session"),
        title: z
          .string()
          .optional()
          .describe(
            "Name for the spawned Claude session — also names the window the backend runs it in, and the worktree branched for it. Defaults to a slug of the prompt.",
          ),
        mode: z.enum(["worktree", "here"]).default("worktree"),
        model: z.string().optional().describe('Model for the session, e.g. "opus"'),
        effort: z.string().optional().describe('Reasoning effort, e.g. "medium"'),
        autonomy: AUTONOMY_FIELD,
        after: z
          .array(
            z.strictObject({
              task: z.string().describe("A task id from get_queue or an earlier queue_batch"),
              when: AFTER_WHEN,
            }),
          )
          .max(TASK_SPEC_LIMITS.deps)
          .optional()
          .describe(
            'Hold this task until each listed task releases it, so the scheduler runs the work in order. A task that failed or was cancelled fails its dependents. With when "opened" (the default), a worktree task is stacked: it starts from the first such task\'s pushed branch (get_queue\'s stackedOn says what it started from); use when "merged" for work that should start from the default branch',
          ),
        until: UNTIL_FIELD,
        ref: z.string().optional().describe(REF_DESCRIPTION),
        ref_url: z.string().optional().describe(REF_URL_DESCRIPTION),
        pin: PIN_FIELD,
        avoid: AVOID_FIELD,
        requires: REQUIRES_FIELD,
        not_before: NOT_BEFORE_FIELD,
        start: z
          .boolean()
          .optional()
          .describe(
            "Start it now, past the fleet's concurrency limit and a paused queue, as start_task does — once the scheduler admits it (up to about 30 s; until then the call waits). Only those are lifted. Set this only when the user asks for the task to start immediately rather than wait its turn",
          ),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({
      machine,
      repo,
      prompt,
      title,
      mode,
      model,
      effort,
      autonomy,
      after,
      until,
      ref,
      ref_url,
      pin,
      avoid,
      requires,
      not_before,
      start,
    }) => {
      if (start === true && not_before !== undefined) {
        return errorResult("spawn refused: start and not_before contradict each other: start runs the task now");
      }
      const deferred = not_before === undefined ? null : notBeforeInput(not_before);
      if (deferred !== null && "error" in deferred) return errorResult(`spawn refused: ${deferred.error}`);
      const machinePin = machine === undefined || isAutoRef(machine) ? undefined : machine;
      if (machinePin !== undefined && pin?.machine !== undefined) {
        return errorResult("spawn refused: give the machine once — machine or pin.machine, not both");
      }
      // Errors name the field the caller wrote.
      const names: PlacementNames =
        machinePin === undefined ? MCP_PLACEMENT_NAMES : { ...MCP_PLACEMENT_NAMES, machine: "machine" };
      const reported = withReportedPrompt(until, prompt);
      if ("error" in reported) return errorResult(`spawn refused: ${reported.error}`);
      const placement = placementInput(pin, avoid, names, machinePin);
      if ("error" in placement) return errorResult(`spawn refused: ${placement.error}`);
      const refFields = refInput(ref, ref_url, { ref: "ref", url: "ref_url" });
      if ("error" in refFields) return errorResult(`spawn refused: ${refFields.error}`);
      // `client` is not a TaskRequest field: the leader stamps its own
      // dispatch `client=scheduler`, so the target audits the session as the
      // scheduler's.
      const spec: AutoSpec = {
        repo,
        ...requestFields({ prompt: reported.prompt, title, mode, model, effort, autonomy }),
        ...authoredFields(
          (after ?? []).map(({ task, when }) => ({ task, after: when })),
          until,
        ),
        ...refFields,
        ...(requires === undefined ? {} : { requires }),
        ...(deferred === null ? {} : { notBefore: deferred.at }),
      };
      // Refused before the fleet opens: no relay round trip to learn the prompt is too long.
      const invalid = specError(spec);
      if (invalid !== null) return errorResult(`spawn refused: ${invalid}${lengthNote(invalid, until)}`);
      return withFleet(async (lease) => {
        // Never a fallback: a lease with no scheduler leg belongs to a daemon too old to broker one.
        if (lease.scheduler === null) return errorResult(olderDaemonText("spawn_session"));
        const leg = { machines: lease.machines, scheduler: lease.scheduler };
        if (usesReported(spec) && !leaderTakesReported(leg)) return errorResult(reportedGateError(leg));
        // Before the create: a start that cannot be sent should not leave a task queued behind it.
        const startGate = start === true ? startGateError(leg) : null;
        if (startGate !== null) return errorResult(`spawn refused: start: ${startGate}`);
        // Before any account listing: a leader that cannot route on them never gets the fields.
        const gate = placementNeedsPinAccount(placement.input) ? pinAccountGateError(leg, "pin.account / avoid") : null;
        if (gate !== null) return errorResult(gate);
        const traitsGate = requires === undefined ? null : traitsGateError(leg, "requires");
        if (traitsGate !== null) return errorResult(traitsGate);
        // A create asked for the ref, so a leader that cannot take it refuses; the caller retries without it.
        const tagsGate = spec.tags === undefined ? null : taskTagsGateError(leg, "spawn", "ref");
        if (tagsGate !== null) return errorResult(tagsGate);
        const resolved = await autoTarget(leg, repo, placement.input, names);
        if ("error" in resolved) return errorResult(`spawn refused: ${resolved.error}`);
        // The origin a clone name resolved to is what the leader bounds, not the name.
        const resolvedSpec: AutoSpec = { ...spec, ...resolved.fields };
        const refused = requires === undefined ? null : requiresCheck(resolvedSpec, lease.machines);
        if (refused !== null) {
          await traitRefusalAudit(audit, "mcp")(refused.kind, requires?.length ?? 0, refused.count, refused.split);
          return errorResult(`spawn refused: ${refused.text}`);
        }
        const longOrigin = specError(resolvedSpec);
        if (longOrigin !== null) return errorResult(`spawn refused: ${longOrigin}${lengthNote(longOrigin, until)}`);
        const id = crypto.randomUUID();
        const enqueued = await enqueueAuto(lease.scheduler, resolvedSpec, audit, "mcp", id);
        if (!enqueued.ok) return errorResult(enqueued.text);
        const started = start === true ? (await startQueuedAuto(leg, id, "mcp")).text : null;
        return textResult([enqueued.text, resolved.echo, started].filter((line) => line !== null).join("\n"));
      });
    },
  );

  server.registerTool(
    "queue_batch",
    {
      title: "Queue a batch of tasks",
      description: `Queue several tasks for the scheduler at once, as one batch: a group that shows together in get_queue and the app, numbered in the order given. A batch sets no order and no limit of its own — members run as soon as their dependencies and the fleet's concurrency limit (none unless the owner set one) allow, side by side unless told otherwise. To run members in order, give each its after: another member by its ref (an earlier one only), or an existing task by its id. Pin a member to a machine, an account or both with its pin, and keep it off machines with its avoid, as spawn_session's: an unknown or ambiguous machine or account refuses the whole batch, and a pinned member waits for a slot where it is pinned; each account a member is pinned to is named in the answer. Answers with the batch id and each member's task id, or names the member that failed and the ones that had already queued. As spawn_session's: a scheduler task's session that opened no pull request and queued these to carry its work on calls report_task_done once nothing of its own is left. The old strategy and max fields are retired. ${AUTO_LIMITS}`,
      inputSchema: z.strictObject({
        // Retired, still listed: strict refuses them anyway, but the handler says what replaced them.
        strategy: z.unknown().optional().describe("Retired: refused unless absent or auto"),
        max: z.unknown().optional().describe("Retired: refused"),
        autonomy: AUTONOMY_FIELD.describe(
          "The autonomy level of every task that gives no autonomy of its own, as spawn_session's autonomy",
        ),
        tasks: z
          .array(
            z.strictObject({
              ref: z
                .string()
                .optional()
                .describe("A name for this task within the batch, for later members' after to point at"),
              repo: z.string().describe("As spawn_session's repo, read within this member's pin"),
              prompt: z.string().optional().describe("The task for the spawned session"),
              title: z.string().optional().describe("Name for the spawned session, its window and its worktree branch"),
              mode: z.enum(["worktree", "here"]).default("worktree"),
              model: z.string().optional(),
              effort: z.string().optional(),
              autonomy: AUTONOMY_FIELD.describe(
                "As spawn_session's autonomy; overrides the batch's autonomy for this task",
              ),
              after: z
                .array(
                  z.strictObject({
                    task: z.string().optional().describe("An existing task's id from get_queue"),
                    ref: z.string().optional().describe("An earlier member's ref"),
                    when: AFTER_WHEN,
                  }),
                )
                .max(TASK_SPEC_LIMITS.deps)
                .optional()
                .describe(
                  'Each entry names exactly one of task and ref. As spawn_session\'s after: with when "opened" (the default) a worktree member stacks on the first such task\'s pushed branch; when "merged" starts it from the default branch',
                ),
              until: UNTIL_FIELD,
              external_ref: z
                .string()
                .optional()
                .describe(
                  `As spawn_session's ref, named apart because a member's ref names it within the batch. ${REF_DESCRIPTION}`,
                ),
              external_ref_url: z.string().optional().describe(REF_URL_DESCRIPTION),
              pin: PIN_FIELD,
              avoid: AVOID_FIELD,
              requires: REQUIRES_FIELD,
              not_before: NOT_BEFORE_FIELD,
            }),
          )
          .min(1)
          .max(BATCH_TASKS_MAX),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ strategy, max, autonomy, tasks }) => {
      if ((strategy !== undefined && strategy !== "auto") || max !== undefined) {
        return errorResult(
          "queue_batch refused: a batch no longer orders or limits its members, so strategy and max are retired. Give each member its after to order them; concurrency is bounded by the fleet limit, when the owner set one",
        );
      }
      const batchId = crypto.randomUUID();
      const planned: {
        readonly id: string;
        readonly ref: string | undefined;
        readonly spec: AutoSpec;
        readonly placement: PlacementInput;
      }[] = [];
      const refs = new Map<string, string>();
      for (const [i, member] of tasks.entries()) {
        const n = i + 1;
        const id = crypto.randomUUID();
        const deps: TaskDep[] = [];
        for (const edge of member.after ?? []) {
          if ((edge.task === undefined) === (edge.ref === undefined)) {
            return errorResult(`queue_batch refused: task ${n}: each after entry names exactly one of task and ref`);
          }
          if (edge.task !== undefined) {
            deps.push({ task: edge.task, after: edge.when });
            continue;
          }
          const target = refs.get(edge.ref ?? "");
          if (target === undefined) {
            return errorResult(
              `queue_batch refused: task ${n}: after ref "${edge.ref}" is not the ref of an earlier task in this batch`,
            );
          }
          deps.push({ task: target, after: edge.when });
        }
        // Registered after the member's own edges, so a task cannot wait on itself.
        if (member.ref !== undefined) {
          if (member.ref === "" || refs.has(member.ref)) {
            return errorResult(
              `queue_batch refused: task ${n}: ref ${JSON.stringify(member.ref)} is empty or already used`,
            );
          }
          refs.set(member.ref, id);
        }
        const reported = withReportedPrompt(member.until, member.prompt);
        if ("error" in reported) return errorResult(`queue_batch refused: task ${n}: ${reported.error}`);
        const placement = placementInput(member.pin, member.avoid);
        if ("error" in placement) return errorResult(`queue_batch refused: task ${n}: ${placement.error}`);
        const deferred = member.not_before === undefined ? null : notBeforeInput(member.not_before);
        if (deferred !== null && "error" in deferred)
          return errorResult(`queue_batch refused: task ${n}: ${deferred.error}`);
        const refFields = refInput(member.external_ref, member.external_ref_url, {
          ref: "external_ref",
          url: "external_ref_url",
        });
        if ("error" in refFields) return errorResult(`queue_batch refused: task ${n}: ${refFields.error}`);
        const spec: AutoSpec = {
          repo: member.repo,
          ...requestFields({
            ...member,
            autonomy: member.autonomy ?? autonomy,
            prompt: reported.prompt,
          }),
          ...authoredFields(deps, member.until),
          ...refFields,
          ...(member.requires === undefined ? {} : { requires: member.requires }),
          ...(deferred === null ? {} : { notBefore: deferred.at }),
          batch: { id: batchId, index: n },
        };
        const invalid = specError(spec);
        if (invalid !== null) {
          return errorResult(`queue_batch refused: task ${n}: ${invalid}${lengthNote(invalid, member.until)}`);
        }
        planned.push({ id, ref: member.ref, spec, placement: placement.input });
      }
      return withFleet(async (lease) => {
        if (lease.scheduler === null) return errorResult(olderDaemonText("queue_batch"));
        const leg = { machines: lease.machines, scheduler: lease.scheduler };
        if (planned.some(({ spec }) => usesReported(spec)) && !leaderTakesReported(leg)) {
          return errorResult(reportedGateError(leg));
        }
        if (planned.some(({ placement }) => placementNeedsPinAccount(placement))) {
          const gate = pinAccountGateError(leg, "pin.account / avoid");
          if (gate !== null) return errorResult(gate);
        }
        if (planned.some(({ spec }) => spec.requires !== undefined)) {
          const gate = traitsGateError(leg, "requires");
          if (gate !== null) return errorResult(gate);
        }
        // Naming the first member that asked for a ref: the caller retries that member without it.
        const tagged = planned.findIndex(({ spec }) => spec.tags !== undefined);
        if (tagged !== -1) {
          const gate = taskTagsGateError(leg, `queue_batch task ${tagged + 1}`, "external_ref");
          if (gate !== null) return errorResult(gate);
        }
        // All resolved and bounded before the first create, so a batch is never half-written for want of a repo name or a pin.
        const resolvedPlan: { readonly id: string; readonly ref: string | undefined; readonly spec: AutoSpec }[] = [];
        const echoes: { readonly task: number; readonly text: string }[] = [];
        for (const [i, member] of planned.entries()) {
          // oxlint-disable-next-line no-await-in-loop -- the account cache lists once; later members read what it holds
          const resolved = await autoTarget(leg, member.spec.repo, member.placement);
          if ("error" in resolved) return errorResult(`queue_batch refused: task ${i + 1}: ${resolved.error}`);
          if (resolved.echo !== null) echoes.push({ task: i + 1, text: `task ${i + 1}: ${resolved.echo}` });
          const spec: AutoSpec = { ...member.spec, ...resolved.fields };
          const invalid = specError(spec);
          if (invalid !== null) {
            return errorResult(
              `queue_batch refused: task ${i + 1}: ${invalid}${lengthNote(invalid, member.spec.until)}`,
            );
          }
          const refused = spec.requires === undefined ? null : requiresCheck(spec, lease.machines);
          if (refused !== null) {
            // oxlint-disable-next-line no-await-in-loop -- a refusal ends the loop
            await traitRefusalAudit(audit, "mcp")(
              refused.kind,
              spec.requires?.length ?? 0,
              refused.count,
              refused.split,
            );
            return errorResult(`queue_batch refused: task ${i + 1}: ${refused.text}`);
          }
          resolvedPlan.push({ id: member.id, ref: member.ref, spec });
        }
        // One at a time, in order: a dependent's record lands after its predecessor's, and a failure stops the rest.
        const landed: string[] = [];
        for (const [i, member] of resolvedPlan.entries()) {
          // oxlint-disable-next-line no-await-in-loop -- each create follows the one before
          const enqueued = await enqueueAuto(lease.scheduler, member.spec, audit, "mcp", member.id);
          if (!enqueued.ok) {
            const queued = landed.length === 0 ? "none had queued" : `already queued: ${landed.join(", ")}`;
            const pinned = echoes.filter(({ task }) => task <= landed.length).map(({ text }) => text);
            return errorResult(
              [
                `queue_batch failed at task ${i + 1} of ${resolvedPlan.length} (${queued}; cancel_task takes them out if the batch is unwanted) — ${enqueued.text}`,
                ...pinned,
              ].join("\n"),
            );
          }
          landed.push(member.id);
        }
        const lines = [
          `batch ${batchId}: ${resolvedPlan.length} tasks queued`,
          ...resolvedPlan.map(({ id, ref }, i) => `task ${i + 1}${ref === undefined ? "" : ` (${ref})`}: ${id}`),
          ...echoes.map(({ text }) => text),
          "The scheduler places them as capacity and their dependencies allow; get_queue shows where each lands and why, and cancel_task takes one out.",
        ];
        if (schedulerRefusal(lease.scheduler.availability()) !== null) {
          lines.push(
            "No scheduler is leading right now (or its leader is unverified); the tasks wait in the relay's queue until one does.",
          );
        }
        return textResult(lines.join("\n"));
      });
    },
  );

  server.registerTool(
    "despawn_session",
    {
      title: "End a Claude Code session",
      description:
        "End a running Claude Code session on a machine and close its window. Asks claude to /exit — a worktree session keeps its worktree — and kills it if it hasn't exited within about five seconds; force kills straight away. Take the id from get_sessions. Naming this machine goes straight to the local daemon.",
      inputSchema: z.strictObject({
        machine: z.string().describe("Machine name (or deviceId) from list_machines"),
        id: z.string().describe('The session\'s id from get_sessions, e.g. "%12"'),
        force: z.boolean().optional().describe("Kill without asking claude to exit first"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ machine, id, force }) => {
      const request: DespawnRequest = {
        id,
        client: "mcp" satisfies SpawnClient,
        ...(force === true ? { force } : {}),
      };
      // An `ErrorResponse` (a crashed handler) is `ok: false` too, and renders the same way.
      const rendered = (reply: DespawnResponse | ErrorResponse, where: string): ToolResult => {
        if (!reply.ok) return errorResult(`despawn failed (${reply.code}): ${reply.message}`);
        return textResult(`${reply.outcome} ${reply.window} on ${where}`);
      };

      if (local !== null && isLocalRef(local, machine)) {
        try {
          return rendered(await local.request<DespawnResponse>("despawn", request), local.name);
        } catch (err) {
          return errorResult(localFailureText("despawn_session", err));
        }
      }

      return withFleet(async (lease) => {
        const resolved = resolveMachine(lease.machines, machine);
        if ("error" in resolved) return errorResult(resolved.error);
        const target = resolved.machine;
        if (!target.connected) {
          return errorResult(
            `${target.name} is not connected — last seen ${new Date(lastHeardAt(target)).toISOString()}`,
          );
        }
        try {
          return rendered(await lease.request<DespawnResponse>(target.deviceId, "despawn", request), target.name);
        } catch (err) {
          return errorResult(failureText("despawn_session", err));
        }
      });
    },
  );

  server.registerTool(
    "set_machine_open",
    {
      title: "Close or reopen a machine",
      description:
        "Close a machine to new scheduled work, or reopen it. A closed machine takes no task from the scheduler (auto, pinned, run-now, continuations), and a direct spawn still runs. Where the machine and the scheduler's leader support it the close is soft: its running tasks keep going until they finish, and nothing is interrupted or moved until you drain it (`drain`, also on a machine already closed). A drain (or any close elsewhere) asks each running session, on a daemon that supports it, to commit and pass itself at its next pause, interrupting a turn still running after 5 minutes, and has the leader pass what is left to other machines after 10 minutes unless it is reopened (pushing each one's branch and ending its session; a task run in place, a session that isn't a task, or a pass refused is left, and list_machines' drain field shows them). `now` (a machine advertising drain-now; implies `drain`) interrupts its sessions at once instead of after 5 minutes, and a session waiting on the person has its question dismissed. Closing needs the scheduler's leader to support it. Closing the machine that leads the queue is allowed and the reply says so: the queue runs only while that machine is up. Goes over the relay as an app-role client, this machine included, so a box whose key is service-delivered cannot send it: use the PWA's Machines screen there.",
      inputSchema: z.strictObject({
        machine: z.string().describe("Machine name (or deviceId) from list_machines"),
        open: z.boolean().describe("false closes it to new scheduled work; true reopens it"),
        drain: z
          .literal(true)
          .optional()
          .describe(
            "closing only: start the drain (ask, then pass), not a soft close; on a soft-closed machine it starts its drain",
          ),
        now: z
          .literal(true)
          .optional()
          .describe(
            "closing only: drain, interrupting its sessions at once instead of after 5 minutes (a machine advertising drain-now)",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ machine, open, drain, now }) =>
      withFleet(async (lease) => {
        const outcome = await setMachineOpen({
          ref: machine,
          selfId: null,
          open,
          ...(now === undefined ? {} : { now }),
          ...(drain === undefined ? {} : { drain }),
          lease,
        });
        return outcome.ok ? textResult(outcome.text) : errorResult(outcome.text);
      }),
  );

  server.registerTool(
    "set_account_open",
    {
      title: "Close or reopen an account",
      description:
        "Close a Claude account to new scheduled work, or reopen it: the PWA's account Open for work switch. A closed account takes no new task from the scheduler on any machine: auto tasks are placed on the fleet's other accounts, and a task pinned to it waits until it reopens. Nothing running is touched: its sessions keep going, and a direct spawn still runs. Reopening also lifts a hold until the account's quota resets. Goes over the relay as an app-role client, so a box whose key is service-delivered cannot send it: use the PWA's Machines screen there. Needs a verified scheduler leader.",
      inputSchema: z.strictObject({
        account: z.string().describe("The account's alias, email or accountId, as list_machines names it"),
        open: z.boolean().describe("false closes it to new scheduled work; true reopens it"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ account, open }) =>
      withFleet(async (lease) => {
        const outcome = await setAccountOpen({ ref: account, open, lease });
        return outcome.ok ? textResult(outcome.text) : errorResult(outcome.text);
      }),
  );

  server.registerTool(
    REPORT_DONE_TOOL,
    {
      title: "Report this session's scheduler task done",
      description:
        "Settle the scheduler task this session runs as done, releasing the tasks that wait on it. Call it when the task's prompt asks you to, or when this session's work is finished and it opened no pull request — for one, when you queued another task (spawn_session, queue_batch) to carry the work on and nothing of your own is left; otherwise its task holds a slot until the session exits. Only once the work is fully finished, a deploy you were watching included: it cannot be taken back. A task holding a pull request waits for the merge instead, and the report changes nothing there unless the prompt asked for it (use hand_off_task). The session stays open; only the task settles. Outside a scheduler task it does nothing and says so. Goes to this machine's own daemon, which binds it to this session's tmux pane.",
      inputSchema: NO_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const result = await report();
      return result.ok ? textResult(result.text) : errorResult(result.text);
    },
  );

  server.registerTool(
    HAND_OFF_TOOL,
    {
      title: "Hand this session's PR to the scheduler and close the session",
      description:
        "Close this session once the current turn ends, leaving its open pull request to the scheduler: the task then waits for the merge (awaiting merge) instead of this session watching CI. Call it only after the PR is open and whatever merges it is in place (auto-merge armed behind a required check, or a reviewer requested), as the last tool call of the run, then end the turn with your final summary. The one exception: a session that séance continued to unblock its pull request (its prompt says so and tells you to call this) calls it whatever the PR's state, armed or not, once its fix is pushed or there is nothing to push. Refused, with the reason, outside a scheduler task or when this machine's daemon saw no `gh pr create` from this session or the session it continues and holds no pull request this task inherited as a successor; keep watching the PR yourself then. Not for a task told to call `report_task_done` when finished: report it instead, since after a hand-off no session is left to report and the task waits until it expires. A continuation of a blocked task ends `done` instead: the task it continued keeps waiting for the merge. The worktree is kept, so the task can be continued later.",
      inputSchema: NO_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const result = await handOffTask();
      return result.ok ? textResult(result.text) : errorResult(result.text);
    },
  );

  server.registerTool(
    PASS_SELF_TOOL,
    {
      title: "Pass this session's task to a successor session",
      description: `Pass this scheduler task to a successor session when this one is running out of usage, or the owner asks. Commit everything first: the daemon pushes this worktree's branch to its upstream and refuses a dirty tree (nothing is pushed then). \`record\` is the whole of what the successor knows besides the branch and the PR it reads itself: what is done, what is left, decisions taken and why, how to verify; at most ${SUCCESSOR_RECORD_MAX} characters. Call it last and end the turn with one line: this session is closed when the turn ends, and nothing done after the push is carried. To pass your own task use this; \`pass_task\` is for other tasks and closes the target session at once. Not \`hand_off_task\`, which leaves a finished PR to the scheduler. Needs a scheduler leader that takes session passes; the call is refused before anything is pushed when there is none. If the task has a PR whose branch this worktree does not track, it is refused and tells you what to push first. A task the scheduler already counts finished (its PR merged under until "merged", even while this session kept working) takes no successor: refused, nothing pushed, and it says what to do instead. The answer says whether the scheduler recorded the successor or refused the pass, and why; only a recorded pass closes this session.`,
      inputSchema: z.strictObject({
        record: z.string().min(1).describe("What the successor needs: done, left, decisions, how to verify"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ record }, ctx) => {
      // UTF-16 units, as the daemon and the leader count: a schema `maxLength` counts code points, which lets an over-long record through.
      if (record.length > SUCCESSOR_RECORD_MAX) {
        return errorResult(
          `${PASS_SELF_TOOL} refused: the record is ${record.length} characters, ${record.length - SUCCESSOR_RECORD_MAX} over the ${SUCCESSOR_RECORD_MAX} allowed; cut it and call again. Nothing was pushed.`,
        );
      }
      return withFleet(async (lease) => {
        if (lease.scheduler === null) {
          return errorResult(
            `${PASS_SELF_TOOL} refused: can't confirm the scheduler takes session passes (${SCHEDULER_NEEDS_NEWER_DAEMON}). Nothing was pushed.`,
          );
        }
        // Before the push: a leader that predates the pass drops the report, and the branch would be pushed for nothing.
        if (!advertises(lease.machines, lease.scheduler.availability(), CAPABILITIES.successorSelf)) {
          return errorResult(
            `${PASS_SELF_TOOL} refused: ${
              lease.scheduler.availability().kind === "ready"
                ? "the scheduler's leader cannot take a session's pass yet — its daemon needs `seance update`"
                : "no verified scheduler is leading, so it cannot be confirmed to take a pass — try again once one leads"
            }. Nothing was pushed.`,
          );
        }
        // Before the push: a task the scheduler already counts as finished (a merge settles `until: "merged"` while the
        // session still runs) can have no successor, and the session must hear that, not "not confirmed".
        const settled = local === null ? null : await ownSettledTask(lease.scheduler, local.deviceId, ownPane());
        if (settled !== null) {
          return errorResult(
            `${PASS_SELF_TOOL} refused: no successor can be made. ${settledText(settled)} Nothing was pushed. ${settledInstead(null)}`,
          );
        }
        // The daemon stamps its `session-pass` with its own clock, this machine's: a refusal stamped earlier answers an earlier pass.
        const sentSince = Date.now();
        // The cancellation closes the daemon's connection, which is what keeps an interrupted call from passing later.
        const result = await passOwnTask(record, { signal: ctx.mcpReq.signal });
        // No answer is not a refusal: the daemon may have pushed and sent the pass, and closes this session at its turn's end.
        if (result.unanswered === true) {
          return textResult(
            `${PASS_SELF_TOOL}: no answer from this machine's daemon (${result.text}), so the branch may be pushed and the pass may have gone through; check get_queue for a successor on your task before pushing or passing again. ${END_THE_TURN}`,
          );
        }
        if (!result.ok) return errorResult(`${PASS_SELF_TOOL} refused: ${result.text}`);
        const ack = result.pass;
        if (ack === undefined) return textResult(`${result.text}. ${END_THE_TURN}`);
        const { taskId, remoteBranch } = ack;
        const verdict = await passVerdict(lease.scheduler, taskId, sentSince, passPoll);
        switch (verdict.kind) {
          case "passed":
            return textResult(
              `passed: the scheduler recorded successor ${verdict.successor} for task ${taskId}; its branch is pushed. ${END_THE_TURN}`,
            );
          case "finished":
            return errorResult(
              `${PASS_SELF_TOOL} refused: no successor exists. ${settledText(verdict.task)} The branch was pushed (${remoteBranch}) before the scheduler said so. ${settledInstead(remoteBranch)}`,
            );
          case "refused":
            return errorResult(
              `${PASS_SELF_TOOL} refused: no successor exists — the scheduler refused the pass: ${sessionPassRefusalText(verdict.code)} (${verdict.code}). The branch is pushed (${remoteBranch}). ${REFUSED_INSTEAD}`,
            );
          case "unconfirmed":
            return textResult(
              `${PASS_SELF_TOOL}: the branch is pushed (${remoteBranch}), but after ${Math.round(passPoll.windowMs / 1000)} s no successor is recorded for task ${taskId} and the scheduler gave no answer, so as of now no successor exists. If the leader still records one, this session closes when this turn ends; if it refused, the session stays open and is not closed by this pass. Before passing again, check get_queue: a successor on task ${taskId} means the pass stood. ${END_THE_TURN}`,
            );
        }
      });
    },
  );

  server.registerTool(
    SEND_MESSAGE_TOOL,
    {
      title: "Message another séance session's task",
      description: `Send a message to another séance session, addressed by its task id (\`get_queue\` lists them), or, to answer a message you received, by \`inReplyTo\` alone (the message id its wrapper names; leave \`to\` out): that reaches the session that sent it even when it has no task, from this machine or another, for an hour, and only from the session the message reached. It goes to this machine's own daemon, bound to this session's pane. A task on this machine is delivered directly; a task on another machine is reached through the scheduler leader, which resolves it (a task passed to a successor, or continued, reaches the session that carries the work now), forwards the message and keeps nothing: the answer is then \`sent through the scheduler\`, which is not delivery, and a receipt note follows in your conversation saying whether it was delivered, or why not. A message to another machine is at most ${MESSAGE_ROUTE_MAX} bytes once JSON-escaped. The receiver is told your task id, title and machine. Kinds: \`note\` is information, added to the receiver's conversation at once (read within a turn already running) and never waking an idle receiver; \`question\` wakes an idle receiver, which may answer you with its own \`send_message\` (kind note, \`inReplyTo\` the id of your message; the answer wakes you, since it answers a question you sent); \`request\` wakes it and asks it to do something, which it may decline when it does not fit its task or its user's instructions. A request is at most ${MESSAGE_PUSH_MAX} bytes and any message at most ${MESSAGE_MAX} bytes; a note or question over ${MESSAGE_PUSH_MAX} arrives as a stub the receiver pulls with its \`read_messages\` tool. At most ${MESSAGE_RATE.perMinute} messages a minute and ${MESSAGE_RATE.perHour} an hour per task. The text is prompt text: it is never logged. The answer says whether it was delivered or held for a listener that has not connected yet, and a message id that a reply carries as \`inReplyTo\`. To write to a tool your user connected to this machine through a Séance adapter, address it as \`adapter:<name>\` (its deliveries name it): the message goes to that adapter on this machine only, and the tool may answer by replying to the message id. When this session has a verified conversation id, messaging an adapter also subscribes it, so the tool may write to this conversation later by that id (named in the answer), across a restart with --resume, until you send it \`leave: true\`.`,
      inputSchema: z.strictObject({
        to: z
          .string()
          .optional()
          .describe(
            "the receiving task's id (get_queue lists them), or adapter:<name> for a tool's adapter on this machine; omit it to reply to a message you received (give inReplyTo)",
          ),
        kind: z
          .enum(MESSAGE_KINDS)
          .describe(
            "note: information, read at the receiver's next turn; question: wakes it, may be answered; request: wakes it, asks it to act",
          ),
        text: z.string().optional().describe("the message; may be left out only with leave"),
        inReplyTo: z.string().optional().describe("the message id you are answering"),
        leave: z
          .boolean()
          .optional()
          .describe("to an adapter only: end this conversation's subscription to it (no text needed)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ to, kind, text, inReplyTo, leave }) => {
      if ((text === undefined || text === "") && leave !== true) return errorResult("the message has no text");
      const result = await sendMsg(
        {
          ...(to === undefined ? {} : { to }),
          kind,
          text: text ?? "",
          ...(inReplyTo === undefined ? {} : { inReplyTo }),
          ...(leave === true ? { leave } : {}),
        },
        { routeGate: messageRouteGate(fleet) },
      );
      return result.ok ? textResult(result.text) : errorResult(result.text);
    },
  );

  server.registerTool(
    WATCH_TOOL,
    {
      title: "Wait on a GitHub PR or Actions run",
      description: `Instead of polling GitHub, have the fleet watch a pull request or Actions run (its github.com URL) and wake this session with a note in its inbox when something happens: a PR's checks pass or fail, a conflict, its merge or close; a run's completion. After a successful call, end your turn: the note wakes you. Do not poll the same target meanwhile. \`head\` (a PR only) is the commit you pushed, so a result for an older head is not taken for yours. Calling again with the same URL replaces its watch (a new \`head\` after a fix push). A watch ends with this session, when its PR is merged or closed or its run completes, or after ${WATCH_TTL_MS / 3_600_000} h. A refusal says how to wait yourself instead. Needs the inbox mod in this session's Claude account.`,
      inputSchema: z.strictObject({
        url: z.string().describe("https://github.com/<owner>/<repo>/pull/<n> or …/actions/runs/<id>"),
        head: z.string().optional().describe("PR only: the full sha of the commit you pushed"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ url, head }) => {
      const result = await watchClient.add({ url, ...(head === undefined ? {} : { head }) }, watchGate(fleet, local));
      return result.ok ? textResult(result.text) : errorResult(result.text);
    },
  );

  server.registerTool(
    UNWATCH_TOOL,
    {
      title: "Stop a GitHub watch",
      description:
        "Stop a watch this session made with watch_github, by the id it answered. Only for one you no longer wait on; a watch ends by itself with its target or this session.",
      inputSchema: z.strictObject({ id: z.string().describe("the watch id watch_github answered") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id }) => {
      const result = await watchClient.remove(id);
      return result.ok ? textResult(result.text) : errorResult(result.text);
    },
  );

  return server;
}

/**
 * The successor the leader recorded on `taskId`, polled for up to the window; null when none appeared, the queue
 * could not be read, or the leader answered with an error. Never throws: the push has happened, and the
 * session is told what it knows.
 */
/** What `pass_to_successor` read of its pass from the leader's queue. */
type PassVerdict =
  | { readonly kind: "passed"; readonly successor: string }
  /** The task is finished with no successor: none can come. */
  | { readonly kind: "finished"; readonly task: Task }
  /** The leader's refusal of this pass (`QueueResponse.passRefused`, stamped at or after `sentSince`). */
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "unconfirmed" };

/**
 * The leader's word on a session's own pass, read from its queue until the window closes: a successor, a finished
 * task, or the refusal the leader keeps for it. `session-pass` is fire-and-forget, so this read is its only answer.
 * An older leader keeps no refusals: its refusal reads `unconfirmed` unless the task is finished.
 */
async function passVerdict(
  scheduler: SchedulerLeg,
  taskId: string,
  sentSince: number,
  poll: PassPoll,
): Promise<PassVerdict> {
  const until = Date.now() + poll.windowMs;
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time, the leader's confirmation being what is waited for
      const queue = await scheduler.queue();
      if (queue !== null && !("ok" in queue)) {
        const task = queue.tasks.find((t) => t.id === taskId);
        if (task?.successor !== undefined) return { kind: "passed", successor: task.successor };
        if (task !== undefined && TASK_PHASES[task.state] === "finished") return { kind: "finished", task };
        const refusal = queue.passRefused?.find(
          (r) => r.taskId === taskId && r.sentAt !== undefined && r.sentAt >= sentSince,
        );
        if (refusal !== undefined) return { kind: "refused", code: refusal.code };
      }
    } catch {
      return { kind: "unconfirmed" };
    }
    if (Date.now() + poll.everyMs > until) return { kind: "unconfirmed" };
    // oxlint-disable-next-line no-await-in-loop -- see above
    await Bun.sleep(poll.everyMs);
  }
}

/**
 * The calling session's task when the leader already counts it finished with no successor, else null. Found by
 * this machine and `$TMUX_PANE` against the tasks' assignments: a claim, not a binding, which only ever refuses
 * early what the leader would refuse anyway (`finished`); anything unclear (no read, no pane, a live task in the
 * pane) is left to the daemon and the leader.
 */
async function ownSettledTask(
  scheduler: SchedulerLeg,
  deviceId: string,
  pane: string | undefined,
): Promise<Task | null> {
  if (pane === undefined || pane === "") return null;
  let queue: Awaited<ReturnType<SchedulerLeg["queue"]>>;
  try {
    queue = await scheduler.queue();
  } catch {
    return null;
  }
  if (queue === null || "ok" in queue) return null;
  const mine = queue.tasks.filter((t) => t.assignment?.deviceId === deviceId && t.assignment.pane === pane);
  if (mine.some((t) => TASK_PHASES[t.state] !== "finished" || t.successor !== undefined)) return null;
  return mine.toSorted((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/** Why a finished task takes no successor, in the session's terms. */
function settledText(task: Task): string {
  if (task.state === "done" && task.doneBy === "merged") {
    const pr = task.prUrl === undefined ? "its pull request" : `its pull request ${task.prUrl}`;
    return `Task ${task.id} is already done: ${pr} merged, and a task queued with until "merged" (the default) is settled by that merge even while its session keeps working, so the scheduler counts its work finished and has released what waited on it.`;
  }
  const by = task.state === "done" && task.doneBy !== undefined ? ` (by ${task.doneBy})` : "";
  return `Task ${task.id} is already ${task.state}${by}, so the scheduler has nothing left to pass on.`;
}

/** What a session whose task is finished does with work left over. `branch`: what was pushed, when it was. */
function settledInstead(branch: string | null): string {
  const named = branch === null ? "this worktree's branch (push it first)" : `branch ${branch}`;
  return `This session is not closed and stays open. Instead: carry the remaining work on here; or, if this session cannot go on, queue it as a new task with spawn_session, your record as its prompt, telling it to check out ${named} and carry on from there.`;
}

/** Said after any refusal of a pushed pass: nothing will close the session. */
const REFUSED_INSTEAD =
  "This session is not closed by the pass and stays open. Instead: fix the cause and call pass_to_successor again, or carry on here; if this session cannot go on, end the turn with a summary of what is left, so its owner can act.";

/** A session pass's refusal, where the generic wording would mislead a session whose branch is already pushed. */
const SESSION_PASS_REFUSED: Readonly<Record<string, string | undefined>> = {
  pr_unreadable: "the scheduler could not read the task's pull request to check the pushed branch against it",
  branch_mismatch:
    "the pushed branch is not the task's pull request's branch, or the pull request is from a fork; push this work to the pull request's branch, then pass again",
  conflict: "the task changed while the pass ran; call pass_to_successor again",
};

function sessionPassRefusalText(code: string): string {
  return SESSION_PASS_REFUSED[code] ?? schedulerErrorText(code);
}

/**
 * This box, as the tools see it, or null when no daemon state exists here — a
 * checkout that has never run `seanced` has no deviceId, and `readState` will
 * not invent one just to answer the question.
 */
export async function localMachine(config: Config): Promise<LocalMachine | null> {
  const state = await readState();
  if (state === null) return null;
  return {
    deviceId: state.deviceId,
    name: config.name,
    platform: process.platform,
    // Falls back to the startup read: a transient failure shouldn't read as "no repos".
    repos: async (): Promise<readonly RepoEntry[]> => (await readState())?.repos ?? state.repos,
    request: <T>(op: RequestOp, payload: unknown): Promise<T | ErrorResponse> => localRequest<T>(op, payload),
    reachable: (): Promise<boolean> => localSocketReachable(),
  };
}

/**
 * The fleet as `seance mcp` reaches it. The PSK is resolved on first remote
 * use, not at startup, because local ops need no key at all; when this process
 * can read none — the key exists only as a credential systemd delivers to the
 * daemon's unit — remote ops go through the daemon's broker instead, and the
 * key never enters this process. `selectFleet` memoizes the direct choice and
 * re-asks the stores after a while when there was nothing to find.
 */
function mcpFleet(config: Config): Fleet {
  return selectFleet({
    key: async (): Promise<AppKeys | null> => {
      const resolved = await loadPsk(config);
      return resolved === null ? null : importAppKeys(resolved.psk);
    },
    direct: (key) =>
      relayFleet(
        // stdout carries the protocol frames — the wire log must land on stderr.
        new LazyRelay({ create: () => appRelayClient(config, key, (line) => console.error(line)) }),
      ),
    broker: brokerFleet(),
  });
}

/** `seance mcp` — serve MCP over stdio until the client hangs up. */
export async function runMcpServer(): Promise<void> {
  const config = await loadConfig();
  const local = await localMachine(config);
  const fleet = mcpFleet(config);
  const handle = serveStdio(() => buildMcpServer(fleet, local), {
    onerror: (err) => console.error(`mcp: ${err.message}`),
  });
  await new Promise<void>((resolve) => {
    // The SDK's stdio transport watches 'data' but never 'end', so a client
    // that exits without signalling would leave this process — and any open
    // relay socket — orphaned behind it.
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
  });
  await handle.close();
  fleet.stop();
  process.exit(0);
}

/** `Command:` line of `claude mcp get` — the interpreter Claude Code will exec. Null when the output doesn't parse. */
export function mcpBunPath(output: string): string | null {
  return /^\s*Command:\s*(.+?)\s*$/mu.exec(output)?.[1] ?? null;
}

/**
 * `Args:` line of `claude mcp get`, minus the trailing `mcp` subcommand — the
 * script Claude Code will run. Null when the output doesn't parse.
 */
export function mcpScriptPath(output: string): string | null {
  return /^\s*Args:\s*(.+?)\s+mcp\s*$/mu.exec(output)?.[1] ?? null;
}

/**
 * Null when the entry runs this checkout's main.ts, compared realpath to realpath
 * so a symlinked checkout path still matches. Otherwise the stale-clone hazard
 * `modChecksFrom` guards for mods: an entry left pointing at another clone runs
 * *its* code, and fails in every session once that clone is deleted or never had
 * `bun install` run. Exported for tests; `current` defaults to `resolvedMain()`.
 */
export async function mcpScriptCheck(recorded: string | null, label: string, current?: string): Promise<Check | null> {
  if (recorded === null) return null;
  const [real, expected] = await Promise.all([realpath(recorded).catch(() => recorded), current ?? resolvedMain()]);
  if (real === expected) return null;
  return {
    level: "warn",
    message: `MCP entry (${label}) runs ${recorded}, not this checkout's ${expected} — \`seance mcp install\` repoints it`,
  };
}

/** Whether each exclave's Claude Code knows about `seance mcp`, and whether its recorded bun and script are current; renders under doctor's binaries section. */
export async function mcpChecks(): Promise<readonly Check[]> {
  const claude = Bun.which("claude");
  if (claude === null) {
    return [{ level: "warn", message: "claude not on PATH — `seance mcp install` needs Claude Code" }];
  }
  const { present } = await userScopeTargets();
  const perTarget = await Promise.all(
    present.map(async (target): Promise<readonly Check[]> => {
      const result = await exec([claude, "mcp", "get", "seance"], { timeoutMs: 15_000, env: target.env });
      if (result.exitCode !== 0) {
        return [
          {
            level: "warn",
            message: `MCP server not registered with Claude Code in ${target.label} — run \`seance mcp install\``,
          },
        ];
      }
      const registered: Check = { level: "ok", message: `MCP server registered with Claude Code in ${target.label}` };
      // Same drift hazard as the plist/unit: `mcp install` records PATH's bun and
      // this checkout's main.ts in Claude's config, and nothing rewrites that entry
      // on its own.
      const findings = await Promise.all([
        recordedBunCheck(mcpBunPath(result.stdout), `MCP entry (${target.label})`, "seance mcp install"),
        mcpScriptCheck(mcpScriptPath(result.stdout), target.label),
      ]);
      return [registered].concat(findings.filter((check) => check !== null));
    }),
  );
  return perTarget.flat();
}
