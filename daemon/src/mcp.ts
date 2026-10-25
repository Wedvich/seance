import { realpath } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  accountNameIn,
  DEP_AFTER,
  knownAccounts,
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
  taskFailureText,
  TASK_FAILURE_LIMITS,
  TASK_REQUEST_LIMITS,
  TASK_SPEC_LIMITS,
  TASK_UNTIL,
  withReportInstruction,
  type BatchStrategy,
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
  type SessionsResponse,
  type SpawnClient,
  type SpawnRequest,
  type SpawnResponse,
  type Task,
  type TaskDep,
  type TaskUntil,
} from "@seance/shared";
import { appRelayClient, importAppKeys, LazyRelay, type AppKeys } from "./app-relay.ts";
import { cliSink, type AuditSink } from "./audit.ts";
import {
  enqueueAuto,
  leaderTakesReported,
  pinAccountGateError,
  placementInputError,
  placementNeedsPinAccount,
  resolveMachine,
  resolveOrigin,
  resolvePlacement,
  specError,
  usesReported,
  type AutoSpec,
  type PlacementInput,
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
import { reportDone } from "./report-done.ts";
import { readState } from "./state.ts";

/**
 * What this box is, and how to reach its daemon without the relay.
 *
 * Resolved from `config.json` and `state.json` rather than from the registry, so
 * recognising a target as local never depends on the relay being up — which is
 * what lets a local request fail with "the daemon isn't running" instead of
 * quietly paying a round trip to Cloudflare to be told the same thing.
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
   * rescan and `seanced mcp` outlives many of them. A snapshot rejects a repo
   * cloned since startup, and rejects every repo if the first scan hadn't landed.
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
  /** Only to refuse it: the exclave pin is gone, and zod would otherwise strip the key without a word. */
  readonly exclave?: unknown;
}

/** `pin` and `avoid` as one placement, refused before anything dials the relay when malformed. */
function placementInput(
  pin: PinInput | undefined,
  avoid: readonly string[] | undefined,
): { readonly input: PlacementInput } | { readonly error: string } {
  if (pin !== undefined && "exclave" in pin) {
    return { error: "exclave pins are gone — pin an account (list_machines shows each exclave's account)" };
  }
  if (pin !== undefined && pin.machine === undefined && pin.account === undefined) {
    return { error: "pin names neither a machine nor an account" };
  }
  const input: PlacementInput = {
    machine: pin?.machine,
    account: pin?.account,
    ...(avoid === undefined ? {} : { avoid }),
  };
  const invalid = placementInputError(input);
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
): Promise<
  | { readonly fields: Pick<AutoSpec, "repo" | "pin" | "avoid">; readonly echo: string | null }
  | { readonly error: string }
> {
  const placed = await resolvePlacement(lease.machines, lease.scheduler.accounts, input);
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
      if (!(err instanceof RequestFailure)) console.error("seanced mcp: account listing failed:", err);
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

function describeMachine(
  machine: Machine,
  local: LocalMachine | null,
  scheduler: SchedulerAvailability | null,
  names: AccountNames,
): Record<string, unknown> {
  // Null when this transport has no view of the scheduler at all (a broker daemon that predates brokered scheduler access).
  const role = scheduler === null ? null : schedulerRole(machine.deviceId, scheduler);
  const { source, lastUpdate } = machine;
  return {
    name: machine.name,
    deviceId: machine.deviceId,
    platform: machine.platform,
    connected: machine.connected,
    lastSeen: new Date(machine.lastSeen).toISOString(),
    repos: machine.repos.map((repo) => repo.name),
    // Absent, not empty, on a daemon predating exclaves: auto cannot place there.
    ...(machine.exclaves === undefined
      ? {}
      : {
          exclaves: machine.exclaves.map((info) => ({
            id: info.id,
            ...(info.accountId === null ? {} : { accountId: info.accountId }),
            ...(info.email === undefined ? {} : { email: info.email }),
            ...(info.accountId === null ? {} : describeName(names, info.accountId)),
          })),
        }),
    // Named so the model knows which target costs nothing to reach; spawning
    // there goes straight to the daemon on this box.
    local: local !== null && machine.deviceId === local.deviceId,
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
    ? `${why} — only this machine is listed (without its exclaves: auto needs the relay), and only local spawns will work`
    : `${why} — only this machine is listed (without its exclaves: auto needs the relay), and its daemon is not listening either, so nothing will spawn until ` +
        "seanced is running (`seanced status`)";
}

/** `LocalUnavailable` is the one worth naming a fix for — here, so every flavour of it carries the advice. */
function localFailureText(op: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof LocalUnavailable) {
    return `${op} failed: ${detail} — is seanced running? try \`seanced status\``;
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
  return textResult(JSON.stringify(reply.sessions, null, 2));
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
 * `machine: "auto"`: the scheduler places the spawn. Matched in any case, as
 * names are; a machine actually named "auto" is still reached by its deviceId.
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
  "The scheduler's queue is held by the relay: a task waits there for capacity, survives leader changes (every relay deploy and daemon self-update), and runs once a scheduler leads. A task already placed is an ordinary session. Dependencies, batches, Linear links, pins and avoided machines are set with spawn_session's after, until, linear, pin and avoid fields and with queue_batch.";

/** What `schedulerFailureText` and `olderDaemonText` name a scheduler call by. */
type SchedulerCall = "get_queue" | "cancel_task";
type SchedulerTool = "auto" | "queue_batch" | SchedulerCall;

/**
 * A keyless box's daemon brokers the scheduler (DESIGN.md "Fleet broker"), so a
 * lease with no scheduler leg means that daemon predates it, or was restarting.
 */
function olderDaemonText(op: SchedulerTool): string {
  const instead = op === "auto" ? " — or name a machine instead (list_machines)" : "";
  return `${op} unavailable: ${SCHEDULER_NEEDS_NEWER_DAEMON}${instead}`;
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
    const spill = winner?.spill === undefined ? "" : `, spending credits (${winner.spill.window})`;
    head = `chose ${where}${score}${spill}`;
  }
  const others = decision.candidates
    .filter((c) => c !== winner)
    .map((c) => {
      if (c.rejected.length > 0) return `${candidateWhere(c)}: ${c.rejected.map(reasonText).join(", ")}`;
      if (c.score === undefined) return `${candidateWhere(c)}: rejected for a reason this seanced cannot read`;
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
 */
function failureMessage(failure: NonNullable<Task["failure"]>): string {
  const worded = taskFailureText(failure.code);
  return worded === null ? failure.message : `${worded} (${failure.message})`;
}

function describeHold(hold: PauseHold, names: AccountNames): Record<string, unknown> {
  return {
    ...(hold.account === undefined ? {} : describeAccount(names, hold.account)),
    until: hold.until,
    since: new Date(hold.at).toISOString(),
    ...(hold.resumeAt === undefined ? {} : { resumeAt: new Date(hold.resumeAt).toISOString() }),
  };
}

const AFTER_WHEN = z
  .enum(DEP_AFTER)
  .default("opened")
  .describe(
    '"opened": the task has a PR and its branch is pushed (stacked work, the default). "merged": its branch merged. "done": the task is settled done — for a task authored with until "reported", only its session\'s own report',
  );

const LINEAR_FIELD = z
  .object({
    issue: z
      .string()
      .describe(`The Linear issue identifier, e.g. "ENG-123" (at most ${TASK_SPEC_LIMITS.linearIssue} characters)`),
    url: z.string().optional().describe("The issue's https: URL"),
  })
  .optional()
  .describe(
    "The Linear issue this task is for. Informational: the scheduler stores and shows it, and reads nothing from Linear",
  );

const UNTIL_FIELD = z
  .enum(TASK_UNTIL)
  .optional()
  .describe(
    `What settles the task. "merged" (default): its PR merging, or its session ending. "reported": a merge settles nothing; the session settles it by calling ${REPORT_DONE_TOOL} when it is truly finished (a deploy watched, say), which lets dependents wait for that. It needs a prompt, to which the instruction to report is appended, and the session needs the seance MCP server installed in its exclave`,
  );

const PIN_FIELD = z
  .object({
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
  })
  // Loose so a stale `exclave` key reaches `placementInput` and is refused, not stripped.
  .loose()
  .optional()
  .describe(
    'Machine "auto" only: restrict where the scheduler may place the task — to one machine, one account, or both; give at least one. An unknown machine, a name two machines share, an account no machine (or not the pinned one) reports signed in, or an alias or email two accounts share is refused, naming the choices. A pinned task waits in the queue for a slot where it is pinned rather than going elsewhere. Give its repo as the pinned machine (or the account\'s clones) list it, or by origin',
  );

const AVOID_FIELD = z
  .array(z.string())
  .optional()
  .describe(
    `Machine "auto" only: machines (name or deviceId) the scheduler must not place the task on, at most ${TASK_SPEC_LIMITS.avoid}. Naming the pinned machine is refused; avoiding every other machine is not — the task waits`,
  );

const REPORTED_GATE =
  "auto refused: the scheduler's leader does not take until: reported / after: done yet — its daemon needs `seanced update`";
const REPORTED_UNKNOWN =
  "auto refused: no verified scheduler is leading, so it cannot be confirmed to take until: reported / after: done — try again once one leads (list_machines shows it)";

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
  readonly plan?: boolean | undefined;
}): Omit<AutoSpec, "repo"> {
  const { prompt, title, mode, model, effort, plan } = input;
  return {
    mode,
    ...(prompt === undefined ? {} : { prompt }),
    ...(title === undefined ? {} : { title }),
    ...(model === undefined || model === "" ? {} : { model }),
    ...(effort === undefined || effort === "" ? {} : { effort }),
    ...(plan === undefined ? {} : { plan }),
  };
}

/**
 * The authoring fields as a spec holds them: `until` only when it is not the default, `linear.url` only
 * when given, and `linear.issue` trimmed as the PWA's form trims it (a blank one is then refused by `specError`).
 */
function authoredFields(
  deps: readonly TaskDep[],
  until: TaskUntil | undefined,
  linear: { readonly issue: string; readonly url?: string | undefined } | undefined,
): Pick<AutoSpec, "deps" | "until" | "linear"> {
  return {
    ...(deps.length === 0 ? {} : { deps }),
    ...(until === "reported" ? { until } : {}),
    ...(linear === undefined
      ? {}
      : {
          linear: {
            issue: linear.issue.trim(),
            ...(linear.url === undefined || linear.url === "" ? {} : { url: linear.url }),
          },
        }),
  };
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

function batchStrategy(
  strategy: "sequential" | "parallel" | "auto",
  max: number | undefined,
): { readonly strategy: BatchStrategy } | { readonly error: string } {
  if (strategy === "parallel") {
    return max === undefined ? { error: 'strategy "parallel" needs max' } : { strategy: { mode: "parallel", max } };
  }
  return max === undefined ? { strategy: { mode: strategy } } : { error: `max applies to strategy "parallel" only` };
}

function describeStrategy(strategy: BatchStrategy): string {
  return strategy.mode === "parallel" ? `parallel, at most ${strategy.max} at once` : strategy.mode;
}

/** Under `until: "reported"` the prompt the author wrote is not the one that is bounded. */
function lengthNote(invalid: string, until: TaskUntil | undefined): string {
  if (until !== "reported" || !invalid.startsWith("the prompt is")) return "";
  return " (the instruction to report is appended to the prompt and counts)";
}

function describeTask(task: Task, machines: readonly Machine[], names: AccountNames): Record<string, unknown> {
  const placement = placementOf(task, machines);
  const pin = describePin(task, machines, names);
  const { spec } = task;
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
    ...(task.decision === undefined ? {} : { decision: decisionText(task.decision) }),
    ...(task.failure === undefined ? {} : { failure: `${task.failure.code}: ${failureMessage(task.failure)}` }),
    // A `manual` mark reads apart from a finish: a person settled it, nothing observed it end.
    ...(task.state === "done" && task.doneBy !== undefined ? { doneBy: task.doneBy } : {}),
    ...(task.escalated === true ? { escalated: true } : {}),
    ...(task.needsInputSince === undefined ? {} : { needsInputSince: new Date(task.needsInputSince).toISOString() }),
    ...(spec.until === "reported" ? { until: spec.until } : {}),
    // A merge under `until: "reported"` settles nothing, so it is told apart from a finish here too.
    ...(task.merged === true ? { merged: true } : {}),
    ...(spec.batch === undefined ? {} : { batch: spec.batch }),
    ...(spec.deps === undefined ? {} : { after: spec.deps.map((dep) => ({ task: dep.task, when: dep.after })) }),
    ...(spec.linear === undefined ? {} : { linear: spec.linear }),
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
 * `sessions`/`spawn`/`despawn` ops, plus the scheduler behind `machine: "auto"` (a
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
 * records its own `auto` enqueue in the audit log, as `seanced spawn` does —
 * never on stdout, the JSON-RPC channel. When the daemon's broker makes the
 * enqueue for a keyless process, the daemon adds its own `origin=local-broker`
 * line beside it.
 */
export function buildMcpServer(
  fleet: Fleet,
  local: LocalMachine | null = null,
  audit: AuditSink = cliSink,
  report: typeof reportDone = reportDone,
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
        "List the dev machines registered with the Séance relay: name, platform, connectivity, and the repos each one can spawn a Claude Code session in. `exclaves` are its exclaves (the accounts' homes): each one's id, and the accountId and email of the Claude account signed in there, if any, plus `account`, the name every Séance client shows for it (its alias where one is set, else the email, else a short id; tagged where two accounts would read alike; no alias on a box whose daemon brokers for it, with no readable PSK) — a display name only, never a value for pin.account — and `alias` where one is set: an auto task's pin.account takes the `accountId`, the `email` or the `alias`, not `account`; a machine with the field absent or empty reports none, so auto cannot place there until its daemon updates. Offline machines are listed with their last-seen time. `source` is the build a machine's daemon runs (sha, commit time, branch) and `lastUpdate` its last reported self-update attempt, with when it ran (a skipped_* or *_failed outcome is replaced by `current` once a later check finds the machine up to date). `scheduler: \"leader\"` marks the verified scheduler leader that `auto` tasks go through; `\"unverified\"` marks a nominee that has not proven it holds this fleet's key, so get_queue and cancel_task refuse to ask it; no mark on any entry means no verified leader, or that this machine's daemon could not say (older, or restarting).",
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
        const machines = lease.machines.map((machine) => describeMachine(machine, local, scheduler, names));
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
      inputSchema: z.object({ machine: z.string().describe("Machine name (or deviceId) from list_machines") }),
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
      description: `List the scheduler's queue — the tasks spawn_session with machine "auto" queued from any client, and what holds dispatch (a paused queue, or an account named as a pin names it) — with each one's state, its pin (whichever of machine and account it pins: the machine by name where known, plus its deviceId; the account by its alias where one is set (none on a box whose daemon brokers for it), else the email a machine reports, else a short id, plus its accountId; an email or short id two accounts share, case aside, gains a tag telling them apart: the org's short id, or more of it where that still collides; pinned and held accounts no machine reports count as accounts too), the machines it avoids, where it was placed, and why the latest routing decision chose or rejected each machine. At most ${QUEUE_MAX_TASKS} tasks, unfinished first (a task waiting on a person leads); prompts are cut to a preview, and a finished task's is not kept (a task that ran has its transcript on its machine; one that never ran has no copy). ${AUTO_LIMITS}`,
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
        const tasks = reply.tasks.map((task) => describeTask(task, lease.machines, names));
        const holds = (reply.holds ?? []).map((hold) => describeHold(hold, names));
        return textResult(JSON.stringify({ at: new Date(reply.at).toISOString(), holds, tasks }, null, 2));
      }),
  );

  server.registerTool(
    "cancel_task",
    {
      title: "Cancel a scheduler task",
      description:
        'Cancel a task that spawn_session with machine "auto" submitted, by its id from get_queue. A task still waiting is taken out of the queue; one running is despawned on its machine first. A task whose machine stopped answering (lost) is cancelled as it stands, and its session may outlive the cancel there. A task mid-dispatch is refused; ask again in a moment.',
      inputSchema: z.object({ taskId: z.string().describe("The task's id from get_queue") }),
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
    "spawn_session",
    {
      title: "Spawn a Claude Code session",
      description: `Spawn a remote-controlled Claude Code session on a machine, in a named repo. Defaults to a fresh git worktree; mode "here" runs in the repo's main checkout instead. Naming this machine goes straight to the local daemon, with no relay round trip; if a remote machine shares this one's name, reach it by deviceId. machine "auto" queues the spawn for the scheduler, which picks the machine and account (under a pin, only what the pin leaves open), and answers with the task id once it is queued — get_queue shows where it lands and why; it goes through this machine's daemon when this process cannot read the key, and caps the prompt at ${TASK_REQUEST_LIMITS.prompt} characters. ${AUTO_LIMITS}`,
      inputSchema: z.object({
        machine: z
          .string()
          .describe('Machine name (or deviceId) from list_machines, or "auto" to let the scheduler place the session'),
        repo: z
          .string()
          .describe(
            "Repo name from that machine's repo list. With machine \"auto\": a repo name from list_machines that means one repo across the fleet, or the repo's origin when it does not (host/path, or the remote URL as git prints it; case does not matter). With a pin, the name is read only where the pin points: the pinned machine's repo list (cut to its clones where the pinned account is signed in), the pinned account's clones, or the origin",
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
        plan: z
          .boolean()
          .optional()
          .describe(
            "Start the session in plan mode: it researches and writes an implementation plan for approval instead of editing files. Set this when the request is to plan, design, investigate or scope work rather than carry it out. Omit it otherwise.",
          ),
        after: z
          .array(
            z.object({
              task: z.string().describe("A task id from get_queue or an earlier queue_batch"),
              when: AFTER_WHEN,
            }),
          )
          .max(TASK_SPEC_LIMITS.deps)
          .optional()
          .describe(
            'Machine "auto" only: hold this task until each listed task releases it, so the scheduler runs the work in order. A task that failed or was cancelled fails its dependents',
          ),
        until: UNTIL_FIELD,
        linear: LINEAR_FIELD,
        pin: PIN_FIELD,
        avoid: AVOID_FIELD,
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ machine, repo, prompt, title, mode, model, effort, plan, after, until, linear, pin, avoid }) => {
      if (isAutoRef(machine)) {
        const reported = withReportedPrompt(until, prompt);
        if ("error" in reported) return errorResult(`auto refused: ${reported.error}`);
        const placement = placementInput(pin, avoid);
        if ("error" in placement) return errorResult(`auto refused: ${placement.error}`);
        // `client` is not a TaskRequest field: the leader stamps its own
        // dispatch `client=scheduler`, so the target audits the session as the
        // scheduler's.
        const spec: AutoSpec = {
          repo,
          ...requestFields({ prompt: reported.prompt, title, mode, model, effort, plan }),
          ...authoredFields(
            (after ?? []).map(({ task, when }) => ({ task, after: when })),
            until,
            linear,
          ),
        };
        // Refused before the fleet opens: no relay round trip to learn the prompt is too long.
        const invalid = specError(spec);
        if (invalid !== null) return errorResult(`auto refused: ${invalid}${lengthNote(invalid, until)}`);
        return withFleet(async (lease) => {
          // Never a fallback: a lease with no scheduler leg belongs to a daemon too old to broker one.
          if (lease.scheduler === null) return errorResult(olderDaemonText("auto"));
          const leg = { machines: lease.machines, scheduler: lease.scheduler };
          if (usesReported(spec) && !leaderTakesReported(leg)) return errorResult(reportedGateError(leg));
          // Before any account listing: a leader that cannot route on them never gets the fields.
          const gate = placementNeedsPinAccount(placement.input)
            ? pinAccountGateError(leg, "pin.account / avoid")
            : null;
          if (gate !== null) return errorResult(gate);
          const resolved = await autoTarget(leg, repo, placement.input);
          if ("error" in resolved) return errorResult(resolved.error);
          // The origin a clone name resolved to is what the leader bounds, not the name.
          const resolvedSpec: AutoSpec = { ...spec, ...resolved.fields };
          const longOrigin = specError(resolvedSpec);
          if (longOrigin !== null) return errorResult(`auto refused: ${longOrigin}${lengthNote(longOrigin, until)}`);
          const enqueued = await enqueueAuto(lease.scheduler, resolvedSpec, audit, "mcp");
          if (!enqueued.ok) return errorResult(enqueued.text);
          return textResult(resolved.echo === null ? enqueued.text : `${enqueued.text}\n${resolved.echo}`);
        });
      }
      // `until: "merged"` and an empty `after` are the defaults, which a named machine honours trivially.
      if (
        (after !== undefined && after.length > 0) ||
        until === "reported" ||
        linear !== undefined ||
        pin !== undefined ||
        avoid !== undefined
      ) {
        return errorResult(
          'after, until, linear, pin and avoid apply to machine "auto" only — a named machine starts the session there now, with nothing to wait for or place',
        );
      }
      const request: SpawnRequest = {
        repo,
        mode,
        client: "mcp" satisfies SpawnClient,
        ...(prompt === undefined ? {} : { prompt }),
        ...(title === undefined ? {} : { title }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(plan === undefined ? {} : { plan }),
      };
      const rendered = (reply: SpawnResponse, where: string): ToolResult => {
        if (!reply.ok) {
          // `too_large` judges the reply, not the spawn: a success embeds the
          // session list, so an agent must look before it retries.
          const look = reply.code === "too_large" ? " — it may be running; check get_sessions" : "";
          return errorResult(`spawn failed (${reply.code}): ${reply.message}${look}`);
        }
        const note = reply.note === undefined ? "" : `\nnote: ${reply.note}`;
        const state = reply.pending === true ? " (started, not registered yet)" : "";
        return textResult(`spawned window ${reply.window} on ${where} at ${reply.path}${state}${note}`);
      };

      if (local !== null && isLocalRef(local, machine)) {
        // Same pre-check as the relay path and for the same reason — the daemon
        // resolves the repo authoritatively, this just answers with candidates
        // instead of costing a round trip to be told `repo_not_found`. An empty
        // set means the first scan hasn't landed, not that there are no repos:
        // deny nothing then, and let the daemon answer.
        const repos = await local.repos();
        if (repos.length > 0 && !repos.some((entry) => entry.name === repo)) {
          const known = repos.map((entry) => entry.name).join(", ");
          return errorResult(`${local.name} has no repo named "${repo}" — its repos: ${known}`);
        }
        try {
          return rendered(await local.request<SpawnResponse>("spawn", request), local.name);
        } catch (err) {
          return errorResult(localFailureText("spawn_session", err));
        }
      }

      return withFleet(async (lease) => {
        const resolved = resolveMachine(lease.machines, machine);
        if ("error" in resolved) return errorResult(resolved.error);
        const target = resolved.machine;
        if (!target.connected) {
          return errorResult(`${target.name} is not connected — last seen ${new Date(target.lastSeen).toISOString()}`);
        }
        if (!target.repos.some((entry) => entry.name === repo)) {
          const known = target.repos.map((entry) => entry.name).join(", ");
          return errorResult(`${target.name} has no repo named "${repo}" — its repos: ${known}`);
        }
        try {
          return rendered(await lease.request<SpawnResponse>(target.deviceId, "spawn", request), target.name);
        } catch (err) {
          return errorResult(failureText("spawn_session", err));
        }
      });
    },
  );

  server.registerTool(
    "queue_batch",
    {
      title: "Queue a batch of tasks",
      description: `Queue several tasks for the scheduler at once, as one batch with a shared strategy: "sequential" runs them one at a time in the order given, "parallel" runs at most max at once, "auto" leaves it to the dependencies and the fleet's capacity. Always machine "auto". Name a task's own dependencies with after: another member by its ref (an earlier one only), or an existing task by its id. Pin a member to a machine, an account or both with its pin, and keep it off machines with its avoid, as spawn_session's: an unknown or ambiguous machine or account refuses the whole batch, and a pinned member waits for a slot where it is pinned; each account a member is pinned to is named in the answer. Answers with the batch id and each member's task id, or names the member that failed and the ones that had already queued. ${AUTO_LIMITS}`,
      inputSchema: z.object({
        strategy: z.enum(["sequential", "parallel", "auto"]),
        max: z
          .number()
          .int()
          .min(1)
          .max(TASK_SPEC_LIMITS.parallel)
          .optional()
          .describe('At most this many members run at once. Required with strategy "parallel", refused otherwise'),
        tasks: z
          .array(
            z.object({
              ref: z
                .string()
                .optional()
                .describe("A name for this task within the batch, for later members' after to point at"),
              repo: z.string().describe("As spawn_session's repo with machine \"auto\", read within this member's pin"),
              prompt: z.string().optional().describe("The task for the spawned session"),
              title: z.string().optional().describe("Name for the spawned session, its window and its worktree branch"),
              mode: z.enum(["worktree", "here"]).default("worktree"),
              model: z.string().optional(),
              effort: z.string().optional(),
              plan: z.boolean().optional().describe("Start in plan mode, as spawn_session's plan"),
              after: z
                .array(
                  z.object({
                    task: z.string().optional().describe("An existing task's id from get_queue"),
                    ref: z.string().optional().describe("An earlier member's ref"),
                    when: AFTER_WHEN,
                  }),
                )
                .max(TASK_SPEC_LIMITS.deps)
                .optional()
                .describe("Each entry names exactly one of task and ref"),
              until: UNTIL_FIELD,
              linear: LINEAR_FIELD,
              pin: PIN_FIELD,
              avoid: AVOID_FIELD,
            }),
          )
          .min(1)
          .max(BATCH_TASKS_MAX),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ strategy, max, tasks }) => {
      const shared = batchStrategy(strategy, max);
      if ("error" in shared) return errorResult(`queue_batch: ${shared.error}`);
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
        const spec: AutoSpec = {
          repo: member.repo,
          ...requestFields({ ...member, prompt: reported.prompt }),
          ...authoredFields(deps, member.until, member.linear),
          batch: { id: batchId, index: n, strategy: shared.strategy },
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
          `batch ${batchId}: ${resolvedPlan.length} tasks queued (${describeStrategy(shared.strategy)})`,
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
      inputSchema: z.object({
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
          return errorResult(`${target.name} is not connected — last seen ${new Date(target.lastSeen).toISOString()}`);
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
    REPORT_DONE_TOOL,
    {
      title: "Report this session's scheduler task done",
      description:
        "Settle the scheduler task this session runs as done, releasing the tasks that wait on it. Call it only when the task's prompt asks you to, and only once the work is fully finished, a deploy you were watching included: it cannot be taken back. Outside a scheduler task it does nothing and says so. Goes to this machine's own daemon, which binds it to this session's tmux pane.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const result = await report();
      return result.ok ? textResult(result.text) : errorResult(result.text);
    },
  );

  return server;
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
 * The fleet as `seanced mcp` reaches it. The PSK is resolved on first remote
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

/** `seanced mcp` — serve MCP over stdio until the client hangs up. */
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
    message: `MCP entry (${label}) runs ${recorded}, not this checkout's ${expected} — \`seanced mcp install\` repoints it`,
  };
}

/** Whether each exclave's Claude Code knows about `seanced mcp`, and whether its recorded bun and script are current; renders under doctor's binaries section. */
export async function mcpChecks(): Promise<readonly Check[]> {
  const claude = Bun.which("claude");
  if (claude === null) {
    return [{ level: "warn", message: "claude not on PATH — `seanced mcp install` needs Claude Code" }];
  }
  const { present } = await userScopeTargets();
  const perTarget = await Promise.all(
    present.map(async (target): Promise<readonly Check[]> => {
      const result = await exec([claude, "mcp", "get", "seance"], { timeoutMs: 15_000, env: target.env });
      if (result.exitCode !== 0) {
        return [
          {
            level: "warn",
            message: `MCP server not registered with Claude Code in ${target.label} — run \`seanced mcp install\``,
          },
        ];
      }
      const registered: Check = { level: "ok", message: `MCP server registered with Claude Code in ${target.label}` };
      // Same drift hazard as the plist/unit: `mcp install` records PATH's bun and
      // this checkout's main.ts in Claude's config, and nothing rewrites that entry
      // on its own.
      const findings = await Promise.all([
        recordedBunCheck(mcpBunPath(result.stdout), `MCP entry (${target.label})`, "seanced mcp install"),
        mcpScriptCheck(mcpScriptPath(result.stdout), target.label),
      ]);
      return [registered].concat(findings.filter((check) => check !== null));
    }),
  );
  return perTarget.flat();
}
