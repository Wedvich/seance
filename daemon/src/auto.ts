import {
  CAPABILITIES,
  continuationSpec,
  continueOffer,
  failureReasonText,
  httpsUrl,
  isTaskId,
  parseTaskSpec,
  queuedTask,
  RequestFailure,
  QUEUE_MAX_TASKS,
  schedulerErrorText,
  schedulerRefusal,
  storeErrorText,
  TASK_REQUEST_LIMITS,
  TASK_SPEC_LIMITS,
  type AccountRecord,
  type Capability,
  type Machine,
  type SchedulerAvailability,
  type SpawnClient,
  type TaskRequest,
  type TaskSpec,
  lastHeardAt,
} from "@seance/shared";
import { enqueueAudit, type AuditSink, type EnqueueSurface } from "./audit.ts";
import { DaemonFault, type SchedulerLeg } from "./fleet.ts";
import { originQuery } from "./scan.ts";

/**
 * Enqueuing on `auto` as an app-role client does it — which origin a repo
 * names, whether a request fits the scheduler's bounds, and the create itself
 * — apart from the MCP SDK and zod, so another client (the CLI's spawn, Raycast)
 * can reuse it. `mcp.ts` wraps the answers as tool results.
 */

/** How an enqueue ended, as a line for whoever asked: `ok` false is an error for them to see. */
export interface AutoEnqueued {
  readonly ok: boolean;
  readonly text: string;
}

const done = (text: string): AutoEnqueued => ({ ok: true, text });
const failed = (text: string): AutoEnqueued => ({ ok: false, text });

/**
 * `auto`'s `repo` as the scheduler keys it, `RepoEntry.origin`. Callers hold
 * clone names from `list_machines`, so either is accepted: an origin in any
 * form `originQuery` keys (a pasted URL, mixed case), or a clone name —
 * matched exactly, since it is a directory name — whose clones all share one
 * origin. Clone names are machine-local, so two unrelated repos can share one
 * — picking between them would run the task in the wrong repo, so that is an
 * error naming each. A pinned task passes only the pin's machines and clones
 * (`scope` names them), so a name is read as the pinned machine lists it.
 */
export function resolveOrigin(
  machines: readonly Machine[],
  repo: string,
  scope = "the fleet",
): { readonly origin: string } | { readonly error: string } {
  const origins = new Set<string>();
  /** origin → the machines whose clone of it is named `repo` */
  const named = new Map<string, string[]>();
  /** Machines whose clone named `repo` reports no origin: an older daemon the scheduler cannot route to. */
  const unkeyed: string[] = [];
  for (const machine of machines) {
    for (const entry of machine.repos) {
      if (entry.origin === undefined) {
        if (entry.name === repo) unkeyed.push(machine.name);
        continue;
      }
      origins.add(entry.origin);
      if (entry.name !== repo) continue;
      const on = named.get(entry.origin) ?? [];
      if (!on.includes(machine.name)) on.push(machine.name);
      named.set(entry.origin, on);
    }
  }
  const key = originQuery(repo).find((candidate) => origins.has(candidate));
  if (key !== undefined) return { origin: key };
  const [only, ...rest] = named.keys();
  if (only !== undefined && rest.length === 0) return { origin: only };
  if (only !== undefined) {
    const each = [...named].map(([origin, on]) => `${origin} (on ${on.join(", ")})`).join("; ");
    return { error: `"${repo}" names clones of more than one repo — pass the origin instead: ${each}` };
  }
  const known = [...origins].toSorted().join(", ");
  const stale =
    unkeyed.length === 0
      ? ""
      : ` (${unkeyed.join(", ")} has a clone by that name, but its daemon reports no origin, so the scheduler cannot route to it)`;
  return {
    error: `no repo "${repo}" for ${scope}${stale} — known origins: ${known === "" ? "(none reported)" : known}`,
  };
}

/** The way past the prompt bound other than shortening: a direct spawn is not bound by the scheduler's. MCP has none. */
const PROMPT_BOUND_ESCAPE: Readonly<Record<EnqueueSurface, string | null>> = {
  mcp: null,
  cli: "pass --now to spawn here directly",
};

/**
 * Past a bound `createTask` refuses the enqueue locally as a bare
 * `invalid_request`, before any store write — so it is refused here, naming
 * the bound, as the PWA does.
 */
function overBound(
  field: keyof typeof TASK_REQUEST_LIMITS,
  value: string | undefined,
  surface: EnqueueSurface,
): string | null {
  const limit = TASK_REQUEST_LIMITS[field];
  if (value === undefined || value.length <= limit) return null;
  const escape = PROMPT_BOUND_ESCAPE[surface];
  const fix =
    field === "prompt"
      ? ` — shorten it (the session can gather the rest with tools)${escape === null ? "" : `, or ${escape}`}`
      : "";
  return `the ${field} is ${value.length} characters; a queued spawn takes at most ${limit}${fix}`;
}

/** What an `auto` enqueue may carry beyond a request: the authoring fields (M4), a pin and avoid, never lineage or base. */
export type AutoSpec = TaskRequest &
  Pick<TaskSpec, "deps" | "batch" | "until" | "linear" | "pin" | "avoid" | "continues">;

/**
 * `machine` is the human name from the target's config, resolved against the
 * live registry; a deviceId is accepted as the exact-match escape hatch for
 * names that collide. Misses come back with the candidates, because the model
 * on the other end of this tool can correct itself from a good error.
 */
export function resolveMachine(
  machines: readonly Machine[],
  ref: string,
): { readonly machine: Machine } | { readonly error: string } {
  const byId = machines.find((machine) => machine.deviceId === ref);
  if (byId !== undefined) return { machine: byId };
  const named = machines.filter((machine) => machine.name.toLowerCase() === ref.toLowerCase());
  const [only] = named;
  if (named.length === 1 && only !== undefined) return { machine: only };
  if (named.length > 1) {
    const ids = named.map((machine) => `${machine.name} (${machine.deviceId})`).join(", ");
    return { error: `"${ref}" names more than one machine — use a deviceId: ${ids}` };
  }
  const known = machines.map((machine) => machine.name).join(", ");
  return { error: `no machine named "${ref}" — known machines: ${known === "" ? "(none registered)" : known}` };
}

/**
 * Where an `auto` task may run, as a person names it: a machine by name or
 * deviceId, an account by alias, email or accountId, machines to avoid by name
 * or deviceId. Each surface spells the fields its own way (`fieldNames`).
 */
export interface PlacementInput {
  readonly machine?: string | undefined;
  readonly account?: string | undefined;
  readonly avoid?: readonly string[] | undefined;
}

/** How a surface names each restriction in its refusals: MCP's fields, the CLI's flags. */
export interface PlacementNames {
  readonly machine: string;
  readonly account: string;
  readonly avoid: string;
}

export const MCP_PLACEMENT_NAMES: PlacementNames = { machine: "pin.machine", account: "pin.account", avoid: "avoid" };

/** What the input needs before the fleet is known, refused before anything dials the relay. */
export function placementInputError(input: PlacementInput, names: PlacementNames = MCP_PLACEMENT_NAMES): string | null {
  if (input.machine === "") return `${names.machine} is empty`;
  if (input.machine !== undefined && input.machine.length > TASK_SPEC_LIMITS.placement) {
    return `${names.machine} is ${input.machine.length} characters; at most ${TASK_SPEC_LIMITS.placement}`;
  }
  if (input.account?.trim() === "") return `${names.account} is empty`;
  const avoid = input.avoid ?? [];
  if (avoid.some((ref) => ref === "")) return `${names.avoid} names an empty machine`;
  if (new Set(avoid).size > TASK_SPEC_LIMITS.avoid) {
    return `${names.avoid} names ${new Set(avoid).size} machines; a task avoids at most ${TASK_SPEC_LIMITS.avoid}`;
  }
  return null;
}

/** Whether the input needs a leader that routes on `pin.account` and `avoid` (`CAPABILITIES.pinAccount`). */
export function placementNeedsPinAccount(input: PlacementInput): boolean {
  return input.account !== undefined || (input.avoid ?? []).length > 0;
}

/** The account an input resolved to, with what it was matched by for the answer. */
interface AccountMatch {
  readonly accountId: string;
}

/** Each account a registry entry reports signed in, with where and every email a machine reports for it. */
interface SignedIn {
  readonly places: string[];
  readonly emails: Set<string>;
}

function signedInAccounts(machines: readonly Machine[]): ReadonlyMap<string, SignedIn> {
  const accounts = new Map<string, SignedIn>();
  for (const machine of machines) {
    for (const exclave of machine.exclaves ?? []) {
      if (exclave.accountId === null) continue;
      const held = accounts.get(exclave.accountId) ?? { places: [], emails: new Set<string>() };
      held.places.push(`${machine.name}/${exclave.id}`);
      if (exclave.email) held.emails.add(exclave.email);
      accounts.set(exclave.accountId, held);
    }
  }
  return accounts;
}

/**
 * One account as a refusal lists it: the full accountId — two orgs can hold
 * the same person, so the email and the account half alone may read alike —
 * its alias and email where known, and where it is signed in.
 */
function describeAccount(
  accountId: string,
  signedIn: ReadonlyMap<string, SignedIn>,
  records: readonly AccountRecord[] | null,
): string {
  const alias = records?.find((r) => r.accountId === accountId)?.alias ?? null;
  const held = signedIn.get(accountId);
  const named = [alias === null ? null : `alias "${alias}"`, ...(held?.emails ?? [])];
  const where = held === undefined ? "signed in nowhere" : `on ${held.places.join(", ")}`;
  return `${accountId} (${[...named, where].join(", ")})`;
}

/**
 * An account by alias (account records), then email (what the registry's
 * exclaves report), then its exact `accountId`. Only an account some sealed
 * registry entry reports signed in can match: an alias record names any id a
 * PSK holder wrote, and the relay may serve a stale one, so the registry is the
 * authority on which accounts exist. `records` null is a listing that failed:
 * aliases are unavailable, an email or id still resolves. Only the accountId
 * leaves here; the email is for the person reading the answer.
 */
export function resolveAccount(
  machines: readonly Machine[],
  records: readonly AccountRecord[] | null,
  input: string,
  name = "pin.account",
): AccountMatch | { readonly error: string } {
  const signedIn = signedInAccounts(machines);
  const wanted = input.trim().toLowerCase();
  const pick = (ids: readonly string[], by: string): AccountMatch | { readonly error: string } | null => {
    const distinct = [...new Set(ids)];
    const [only] = distinct;
    if (only === undefined) return null;
    if (distinct.length > 1) {
      const each = distinct.map((id) => describeAccount(id, signedIn, records)).join("; ");
      return { error: `${name}: "${input}" is the ${by} of more than one account — give its id: ${each}` };
    }
    if (!signedIn.has(only)) {
      return {
        error: `${name}: "${input}" names ${describeAccount(only, signedIn, records)}, which no machine reports signed in, so the scheduler could never place it`,
      };
    }
    return { accountId: only };
  };
  const aliased = (records ?? []).filter((r) => r.alias?.trim().toLowerCase() === wanted).map((r) => r.accountId);
  // A stale record holding the alias must not make a live one ambiguous: narrow to signed-in accounts first.
  const live = aliased.filter((id) => signedIn.has(id));
  const byAlias = live.length > 0 ? live : aliased;
  const byEmail = [...signedIn]
    .filter(([, held]) => [...held.emails].some((email) => email.toLowerCase() === wanted))
    .map(([id]) => id);
  const byId = signedIn.has(input.trim()) || records?.some((r) => r.accountId === input.trim()) === true;
  const found = pick(byAlias, "alias") ?? pick(byEmail, "email") ?? (byId ? pick([input.trim()], "id") : null);
  if (found !== null) return found;
  if (records === null) {
    return {
      error: `${name}: aliases unavailable: the account listing is unavailable right now, and "${input}" is not an email or id a machine reports — give the account's email or id: ${listAccounts(signedIn, null)}`,
    };
  }
  return { error: `${name}: no account "${input}" — the fleet's accounts: ${listAccounts(signedIn, records)}` };
}

function listAccounts(signedIn: ReadonlyMap<string, SignedIn>, records: readonly AccountRecord[] | null): string {
  const each = [...signedIn.keys()].toSorted().map((id) => describeAccount(id, signedIn, records));
  return each.length === 0 ? "(none signed in on any machine)" : each.join("; ");
}

/** A placement resolved at submit time: what the spec stores, the repo scope, and what to tell the person. */
export interface ResolvedPlacement {
  readonly fields: Pick<AutoSpec, "pin" | "avoid" | "continues">;
  /** The machines a repo name is read against: the pinned one (or all), its clones cut to the pinned account's exclaves. */
  readonly machines: readonly Machine[];
  /** What `resolveOrigin` names the scope by. */
  readonly scope: string;
  /** What the answer adds: the account a pin resolved to (accountId and email), and that a pinned machine is offline so the task waits; one line, null with neither. */
  readonly echo: string | null;
}

/**
 * The input as the spec stores it: deviceIds (a name is neither stable nor
 * unique) and an accountId, never an alias or an email. A machine reporting no
 * exclaves is never a candidate (`exclaves_unknown`), so a pin to it is
 * refused; so is an account signed in nowhere in the pin's scope, and an avoid
 * list naming the pinned machine — each could never place. Avoiding every
 * other machine is allowed: the task waits, as a pin to an offline machine does.
 * `avoid` does not narrow the repo scope, for the same reason. `accounts` is
 * asked only for an account pin.
 */
export async function resolvePlacement(
  machines: readonly Machine[],
  accounts: () => Promise<readonly AccountRecord[] | null>,
  input: PlacementInput,
  names: PlacementNames = MCP_PLACEMENT_NAMES,
): Promise<ResolvedPlacement | { readonly error: string }> {
  let target: Machine | undefined;
  if (input.machine !== undefined) {
    const resolved = resolveMachine(machines, input.machine);
    if ("error" in resolved) return { error: `${names.machine}: ${resolved.error}` };
    target = resolved.machine;
    if ((target.exclaves ?? []).length === 0) {
      return {
        error: `${names.machine}: ${target.name} (${target.deviceId}) reports no exclaves, so the scheduler cannot place there — its daemon needs \`seanced update\``,
      };
    }
  }
  const scoped = target === undefined ? machines : [target];
  let account: string | undefined;
  const notes: string[] = [];
  if (target !== undefined && !target.connected) {
    notes.push(
      `${target.name} is offline (last seen ${new Date(lastHeardAt(target)).toISOString()}); the task waits for it`,
    );
  }
  if (input.account !== undefined) {
    const records = await accounts();
    const matched = resolveAccount(machines, records, input.account, names.account);
    if ("error" in matched) return matched;
    account = matched.accountId;
    const signedIn = signedInAccounts(machines);
    if (target !== undefined && !(target.exclaves ?? []).some((x) => x.accountId === account)) {
      return {
        error: `${names.account}: ${describeAccount(account, signedIn, records)} is signed in on no exclave of ${target.name} (${target.deviceId})`,
      };
    }
    const emails = [...(signedIn.get(account)?.emails ?? [])];
    notes.push(`pinned to account ${account} (${emails.length === 0 ? "no email reported" : emails.join(", ")})`);
  }
  const avoid: string[] = [];
  for (const ref of input.avoid ?? []) {
    const resolved = resolveMachine(machines, ref);
    if ("error" in resolved) return { error: `${names.avoid}: ${resolved.error}` };
    const { deviceId, name } = resolved.machine;
    if (deviceId === target?.deviceId) {
      return {
        error: `${names.avoid} names ${name} (${deviceId}), the machine the task is pinned to — it could never run`,
      };
    }
    if (!avoid.includes(deviceId)) avoid.push(deviceId);
  }
  if (avoid.length > TASK_SPEC_LIMITS.avoid) {
    return { error: `${names.avoid} names ${avoid.length} machines; a task avoids at most ${TASK_SPEC_LIMITS.avoid}` };
  }
  if (account !== undefined) {
    const reporting = machines.filter((m) => (m.exclaves ?? []).some((x) => x.accountId === account));
    if (reporting.length > 0 && reporting.every((m) => avoid.includes(m.deviceId))) {
      return {
        error: `${names.avoid} covers every machine signed in to account ${account} (${reporting.map((m) => m.name).join(", ")}), so the scheduler could never place it`,
      };
    }
  }
  // Strict, as the scheduler's clone match is: a clone from a daemon predating exclaves is in no account.
  const inAccount = (machine: Machine): Machine => {
    if (account === undefined) return machine;
    const homes = new Set((machine.exclaves ?? []).filter((x) => x.accountId === account).map((x) => x.id));
    return {
      ...machine,
      repos: machine.repos.filter((entry) => entry.exclave !== undefined && homes.has(entry.exclave)),
    };
  };
  const pin = {
    ...(target === undefined ? {} : { deviceId: target.deviceId }),
    ...(account === undefined ? {} : { account }),
  };
  const where = [target?.name, account === undefined ? undefined : `account ${account}`].filter((w) => w !== undefined);
  return {
    fields: {
      ...(target === undefined && account === undefined ? {} : { pin }),
      ...(avoid.length === 0 ? {} : { avoid }),
    },
    machines: scoped.map(inAccount),
    scope: where.length === 0 ? "the fleet" : `a task pinned to ${where.join(", ")}`,
    echo: notes.length === 0 ? null : notes.join("; "),
  };
}

export function taskRequestError(request: TaskRequest, surface: EnqueueSurface = "mcp"): string | null {
  return (
    overBound("prompt", request.prompt, surface) ??
    overBound("title", request.title, surface) ??
    overBound("model", request.model, surface) ??
    overBound("effort", request.effort, surface) ??
    overBound("repo", request.repo, surface)
  );
}

/**
 * `createTask` refuses a record `parseTaskSpec` would null as a bare
 * `invalid_request`, which tells an agent nothing: every bound it can cross is
 * named here first, and the parser itself is the backstop for the rest.
 */
export function specError(spec: AutoSpec, surface: EnqueueSurface = "mcp"): string | null {
  const request = taskRequestError(spec, surface);
  if (request !== null) return request;
  const { deps, linear, pin, avoid } = spec;
  if (pin !== undefined && pin.deviceId === undefined && pin.account === undefined) {
    return "pin names neither a machine nor an account";
  }
  if (avoid !== undefined && avoid.length > TASK_SPEC_LIMITS.avoid) {
    return `avoid names ${avoid.length} machines; a task avoids at most ${TASK_SPEC_LIMITS.avoid}`;
  }
  if (deps !== undefined) {
    if (deps.length > TASK_SPEC_LIMITS.deps) {
      return `after lists ${deps.length} tasks; a task waits on at most ${TASK_SPEC_LIMITS.deps}`;
    }
    const stray = deps.find((dep) => !isTaskId(dep.task));
    if (stray !== undefined) return `after: ${JSON.stringify(stray.task.slice(0, 64))} is not a task id from get_queue`;
  }
  if (linear !== undefined) {
    if (linear.issue.trim() === "") return "linear.issue is empty";
    if (linear.issue.length > TASK_SPEC_LIMITS.linearIssue) {
      return `linear.issue is ${linear.issue.length} characters; at most ${TASK_SPEC_LIMITS.linearIssue}`;
    }
    if (linear.url !== undefined && httpsUrl(linear.url) === null) return "linear.url must be an https: URL";
  }
  // `client` is left out: every caller's name fits its bound, so the spec parses as the record will.
  return parseTaskSpec(spec) === null ? "invalid task spec" : null;
}

/** Whether the spec needs a leader that understands `until: "reported"` or `after: "done"` (`CAPABILITIES.reportedDone`). */
export function usesReported(spec: Pick<AutoSpec, "until" | "deps">): boolean {
  return spec.until === "reported" || spec.deps?.some((dep) => dep.after === "done") === true;
}

/**
 * The rollout gate: the verified leader's own advertisement. An older leader strips `until` on its first
 * write and holds a `done` edge unreadable, so neither is written to one — or to none, which cannot say.
 */
export function leaderTakesReported(lease: SchedulerLease): boolean {
  return leaderAdvertises(lease, CAPABILITIES.reportedDone);
}

interface SchedulerLease {
  readonly machines: readonly Machine[];
  readonly scheduler: SchedulerLeg;
}

/** Whether the verified leader advertises `capability`; none, or an unverified one, cannot say, so it is false. */
export function leaderAdvertises(lease: SchedulerLease, capability: Capability): boolean {
  return advertises(lease.machines, lease.scheduler.availability(), capability);
}

/** `leaderAdvertises` over a registry and a leader's availability, for a caller with no `SchedulerLeg` (the broker). */
export function advertises(
  machines: readonly Machine[],
  leader: SchedulerAvailability,
  capability: Capability,
): boolean {
  if (leader.kind !== "ready") return false;
  const machine = machines.find((m) => m.deviceId === leader.deviceId);
  return machine?.capabilities?.includes(capability) === true;
}

/** The submit-time gate for a continue task: the leader must route `mode: "continue"`, or it holds the record unreadable. */
export function continueGateError(availability: SchedulerAvailability, advertised: boolean): string | null {
  if (advertised) return null;
  return availability.kind === "ready"
    ? "the scheduler's leader cannot continue a session yet — its daemon needs `seanced update`"
    : "no verified scheduler is leading, so it cannot be confirmed to continue a session — try again once one leads";
}

/**
 * Queues a task that resumes a failed or cancelled task's session (DESIGN.md, Daemon, "Continuing a
 * session"): the same gates as the app's Continue button — the leader and the machine it ran on
 * advertise `continueTask` (and `continueCancelled` for a cancelled task), the task is a failed or cancelled session in a worktree — then a create
 * like `spawn_session`'s. `label` names the caller in refusals. Never logs, as `enqueueAuto`.
 */
export async function continueAuto(
  lease: SchedulerLease,
  taskId: string,
  prompt: string | undefined,
  audit: AuditSink,
  surface: EnqueueSurface,
): Promise<AutoEnqueued> {
  const label = surface === "mcp" ? "continue_task" : "continue";
  const shown = JSON.stringify(taskId.slice(0, 64));
  if (!isTaskId(taskId)) return failed(`${label} refused: ${shown} is not a task id`);
  const availability = lease.scheduler.availability();
  const gate = continueGateError(availability, leaderAdvertises(lease, CAPABILITIES.continueTask));
  if (gate !== null) return failed(`${label} refused: ${gate}`);
  let reply: Awaited<ReturnType<SchedulerLeg["queue"]>>;
  try {
    reply = await lease.scheduler.queue();
  } catch (err) {
    const why =
      err instanceof RequestFailure ? failureReasonText(err) : err instanceof Error ? err.message : String(err);
    return failed(`${label} failed: ${why}`);
  }
  if (reply === null)
    return failed(`${label} failed: the scheduler's answer was unreadable (a seanced version mismatch?)`);
  if ("ok" in reply) return failed(`${label} failed (${reply.code}): ${schedulerErrorText(reply.code)}`);
  const task = reply.tasks.find((t) => t.id === taskId);
  if (task === undefined) {
    return failed(
      `${label} refused: task ${taskId} is not in the leader's list (pruned, or past the ${QUEUE_MAX_TASKS} most relevant)`,
    );
  }
  const offer = continueOffer(task, lease.machines, reply.tasks);
  if (!offer.ok) return failed(`${label} refused: ${offer.reason}`);
  const spec = continuationSpec(task, offer.at, prompt);
  const invalid = specError(spec, surface);
  if (invalid !== null) return failed(`${label} refused: ${invalid}`);
  const enqueued = await enqueueAuto(lease.scheduler, spec, audit, surface);
  return enqueued.ok ? { ...enqueued, text: `continuing task ${taskId}\n${enqueued.text}` } : enqueued;
}

/**
 * The submit-time half of the `pinAccount` gate (the record's `PIN_SENTINEL`
 * is the other): null when the verified leader routes on `pin.account` and
 * `avoid`, else why nothing is written. `fields` names them as the surface does.
 */
export function pinAccountGateError(lease: SchedulerLease, fields: string): string | null {
  if (leaderAdvertises(lease, CAPABILITIES.pinAccount)) return null;
  return lease.scheduler.availability().kind === "ready"
    ? `spawn refused: the scheduler's leader does not route on ${fields} yet — its daemon needs \`seanced update\``
    : `spawn refused: no verified scheduler is leading, so it cannot be confirmed to route on ${fields} — try again once one leads`;
}

/** Tries at one create: each re-sends the same task, so a lost reply can never queue it twice. */
const ENQUEUE_ATTEMPTS = 3;
const ENQUEUE_RETRY_MS = 1_000;

/** Only on failures where nothing was queued: after a "may have queued" one it would run the task twice. */
export const NOW_HINT = "`seanced spawn --now` spawns on this machine without the relay, the key or the daemon.";

/** Where each surface's reader looks next: a shell user cannot call MCP's tools, so the CLI names the app's queue. */
const FOLLOW_UP: Readonly<
  Record<
    EnqueueSurface,
    {
      readonly placed: string;
      readonly check: string;
      readonly leaderless: string | null;
      /** Appended to a failure that provably left nothing queued; a shell user has the direct path, MCP does not. */
      readonly cleanFailure: string;
    }
  >
> = {
  mcp: {
    placed:
      "The scheduler places it as soon as a machine and account can take it; get_queue shows where it lands and why, and cancel_task takes it out.",
    check: "check get_queue",
    leaderless: null,
    cleanFailure: "",
  },
  cli: {
    placed:
      "The scheduler places it as soon as a machine and account can take it; the app's queue shows where it lands and why, and cancels it.",
    check: "check the app's queue",
    leaderless:
      "This task runs once a scheduler leads, so `seanced spawn --now` now would start a second session; for a spawn that must not wait, use `--now` instead of queuing.",
    cleanFailure: `. ${NOW_HINT}`,
  },
};

/**
 * Enqueues by `store-put` — the relay answers it itself, so no leader is needed:
 * with none (or an unverified one) the task waits in the relay's queue until one
 * leads. A lost reply (timeout, dropped socket) or no socket is tried again with
 * the same task, since a repeat create reads `landedEarlier`; every try lost says
 * so and names the id. Never logs: `seanced mcp`'s stdout is its JSON-RPC
 * channel. `surface` is the record's `client` and the audit line's origin, and
 * picks the follow-up text.
 */
export async function enqueueAuto(
  scheduler: SchedulerLeg,
  request: AutoSpec,
  audit: AuditSink,
  surface: EnqueueSurface,
  id?: string,
): Promise<AutoEnqueued> {
  const task = queuedTask({ ...request, client: surface satisfies SpawnClient }, Date.now(), id);
  const audited = enqueueAudit(audit, surface);
  const followUp = FOLLOW_UP[surface];
  // Whether any try left this process: a socket that was never open sent nothing, so nothing can have queued.
  let sent = false;
  // Who the last lost try blamed, so the closing line names what stayed silent: through the broker it is the daemon, not the relay.
  let lastLostTarget: RequestFailure["target"] = "relay";
  for (let attempt = 1; attempt <= ENQUEUE_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      // oxlint-disable-next-line no-await-in-loop -- the wait between tries
      await Bun.sleep(ENQUEUE_RETRY_MS);
    }
    let reply: Awaited<ReturnType<SchedulerLeg["enqueue"]>>;
    try {
      // oxlint-disable-next-line no-await-in-loop -- each try follows the one before
      reply = await scheduler.enqueue(task);
    } catch (err) {
      // A daemon fault is final, not lost: a repeat meets it again.
      const lost =
        err instanceof RequestFailure &&
        !(err instanceof DaemonFault) &&
        (err.reason === "timeout" || err.reason === "dropped" || err.reason === "disconnected");
      if (lost) {
        if (!(err instanceof RequestFailure && err.reason === "disconnected")) sent = true;
        if (err instanceof RequestFailure) lastLostTarget = err.target;
        continue;
      }
      // A daemon fault's message is the daemon's own words (`boom`), not a verdict on whether it landed; the line below says that.
      const why =
        err instanceof DaemonFault
          ? err.message
          : err instanceof RequestFailure
            ? failureReasonText(err)
            : err instanceof Error
              ? err.message
              : String(err);
      // A fault after the send left the daemon may have stored it, as a lost earlier try may have.
      if (sent || err instanceof DaemonFault) {
        // An earlier try may have stored it, so this is no clean failure: audit it as the lost path does.
        // oxlint-disable-next-line no-await-in-loop -- the last thing this try does: it returns
        await audited(task, { kind: "unanswered" });
        return failed(`spawn failed: ${why} — task ${task.id} may have queued; ${followUp.check} before retrying`);
      }
      return failed(`spawn failed: ${why}${followUp.cleanFailure}`);
    }
    if (reply === null) {
      sent = true;
      continue;
    }
    if (!reply.ok) {
      // oxlint-disable-next-line no-await-in-loop -- the last thing this try does: it returns
      await audited(task, { kind: "refused", code: reply.code });
      return failed(`spawn refused (${reply.code}): ${storeErrorText(reply.code)}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    await audited(task, { kind: "queued", landedEarlier: reply.landedEarlier });
    const lines = [
      `task ${task.id}: queued${reply.landedEarlier ? " (an earlier try had already stored it)" : ""}`,
      followUp.placed,
    ];
    if (schedulerRefusal(scheduler.availability()) !== null) {
      lines.push(
        "No scheduler is leading right now (or its leader is unverified); the task waits in the relay's queue until one does.",
      );
      // Only with no nominee at all: an unverified one may be a healthy leader whose lead-proof has not arrived yet, and --now beside it runs the task twice.
      if (followUp.leaderless !== null && scheduler.availability().kind === "none") lines.push(followUp.leaderless);
    }
    return done(lines.join("\n"));
  }
  if (!sent) {
    return failed(
      `spawn: not queued — the relay was unreachable after ${ENQUEUE_ATTEMPTS} tries; try again${followUp.cleanFailure}`,
    );
  }
  await audited(task, { kind: "unanswered" });
  return failed(
    `spawn: no answer from ${lastLostTarget === "daemon" ? "this machine's daemon" : "the relay"} after ${ENQUEUE_ATTEMPTS} tries — task ${task.id} may have queued; ${followUp.check} before retrying`,
  );
}
