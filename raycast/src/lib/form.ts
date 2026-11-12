import {
  DEFAULT_AUTONOMY,
  lastHeardAt,
  originLabel,
  TASK_REQUEST_LIMITS,
  taskRequest,
  withAutonomy,
  type AutonomyLevel,
  type MachineStatus,
  type RepoEntry,
  type SpawnRequest,
  type TaskRequest,
} from "@seance/shared";
import type { Effort, Model } from "./options.ts";

/**
 * The machine picker's `auto` entry: the scheduler places the task. Held in
 * `machineId` (and as a `LastUsed.repos` key) beside deviceIds, which are
 * base64url SHA-256 digests and so never spell it.
 */
export const AUTO = "auto";

/**
 * The picker's view of a machine — `Machine` from the relay client minus the
 * fields nothing here renders. Declared structurally rather than importing
 * `Machine` so the *same* rules apply to the live registry and to the cached
 * projection read back from LocalStorage, which is the whole point of
 * cache-first: the form is rendered from one shape whether or not a socket has
 * opened yet.
 */
export interface PickerMachine {
  readonly deviceId: string;
  readonly name: string;
  readonly connected: boolean;
  /** In a cached projection, already the heard time (`lastHeardAt`): the cache keeps no `status`. */
  readonly lastSeen: number;
  /** Live registry only; dates a slept machine past its register (`lastHeardAt`). */
  readonly status?: MachineStatus;
  readonly scannedAt: number;
  readonly repos: readonly RepoEntry[];
}

/** One collator for every sort; constructing one per comparison is not free. */
const collator = new Intl.Collator();

/**
 * Alphabetical by name, matching the PWA's pickers. The relay pushes registry
 * entries in lexicographic *deviceId* order, which to a reader is no order at
 * all.
 */
export function sortedByName<T extends { readonly name: string }>(items: readonly T[]): readonly T[] {
  return items.toSorted((a, b) => collator.compare(a.name, b.name));
}

/**
 * How every machine list enters the form — cache read and live push alike:
 * machines alphabetical, and each machine's repos too, since the daemon
 * reports repos in scan order. Sorting at entry rather than at render is what
 * makes the "first listed" fallbacks below land on the item actually shown
 * first.
 */
export function sortedMachines(machines: readonly PickerMachine[]): readonly PickerMachine[] {
  return sortedByName(machines.map((machine) => ({ ...machine, repos: sortedByName(machine.repos) })));
}

/** Everything the form holds. The prompt always starts empty, so it is never persisted. */
export interface FormValues {
  readonly prompt: string;
  /** A deviceId, `AUTO`, or null when there is nothing to pick. */
  readonly machineId: string | null;
  /** A clone name on a machine; on `AUTO`, an origin (`RepoEntry.origin`), the scheduler's repo key. */
  readonly repo: string | null;
  readonly model: Model;
  readonly effort: Effort;
  readonly worktree: boolean;
  /** Never remembered or a preference: every open starts at `DEFAULT_AUTONOMY`, so a level picked once never rides along unseen. */
  readonly autonomy: AutonomyLevel;
}

/**
 * What survives between invocations, written after each successful spawn.
 * The repo is remembered *per machine*, so switching machines restores what
 * you last ran there instead of resetting to that machine's first repo. `AUTO`
 * is a key like any deviceId, holding an origin.
 */
export interface LastUsed {
  readonly machineId: string | null;
  readonly repos: Readonly<Record<string, string>>;
  readonly model: Model;
  readonly effort: Effort;
  readonly worktree: boolean;
}

/** Raycast preferences. Defaults only — never secrets; the PSK is read from the daemon's own stores. */
export interface Defaults {
  /** Machine *name*, since that is what a human types into a preference. Empty means "no opinion". */
  readonly machineName: string;
  readonly model: Model;
  readonly effort: Effort;
}

export interface Reconciliation {
  readonly values: FormValues;
  /** Non-null when the registry moved the selection out from under the user; the view Toasts it. */
  readonly note: string | null;
}

/**
 * `AUTO` once picked, else first connected machine, else first listed, extended
 * with the preference: a remembered machine that is gone from the registry
 * falls back to the *named* default (a machine, or `auto`) before falling back
 * to position.
 */
function pickTarget(
  machines: readonly PickerMachine[],
  preferredId: string | null,
  defaults: Defaults,
): PickerMachine | typeof AUTO | null {
  if (preferredId === AUTO) return AUTO;
  const remembered = machines.find((machine) => machine.deviceId === preferredId);
  if (remembered !== undefined) return remembered;
  if (defaults.machineName !== "") {
    const wanted = defaults.machineName.toLowerCase();
    const named = machines.find((machine) => machine.name.toLowerCase() === wanted);
    if (named !== undefined) return named;
    if (wanted === AUTO) return AUTO;
  }
  return machines.find((machine) => machine.connected) ?? machines[0] ?? null;
}

/** One entry of the repository dropdown. */
export interface RepoChoice {
  readonly value: string;
  readonly title: string;
  readonly keywords: readonly string[];
}

/**
 * On `AUTO`, every origin some machine reports, once each, by label — as the
 * PWA lists them with no pin (`scopedRepos`). A clone without an origin (a
 * daemon too old to report one) is one the scheduler cannot route to, so it is
 * left out. On a machine, its clones by name.
 */
export function repoChoices(machineId: string | null, machines: readonly PickerMachine[]): readonly RepoChoice[] {
  if (machineId !== AUTO) {
    const machine = machines.find((candidate) => candidate.deviceId === machineId);
    return (machine?.repos ?? []).map((repo) => ({ value: repo.name, title: repo.name, keywords: [repo.path] }));
  }
  const origins = new Set(machines.flatMap((machine) => machine.repos.flatMap((repo) => repo.origin ?? [])));
  return sortedByName(
    [...origins].map((origin) => ({ value: origin, title: originLabel(origin), name: originLabel(origin) })),
  ).map(({ value, title }) => ({ value, title, keywords: [value] }));
}

/** First preference still offered, else the first choice — the cache or the memory may name one that has gone. */
function pickRepo(choices: readonly RepoChoice[], preferred: readonly (string | null)[]): RepoChoice | null {
  for (const value of preferred) {
    const match = value === null ? undefined : choices.find((choice) => choice.value === value);
    if (match !== undefined) return match;
  }
  return choices[0] ?? null;
}

/**
 * Folds a machine list into the current selection, reporting what it had to
 * change. Called twice per invocation with the same rules: once over the cached
 * projection to render instantly, then again when the live registry lands.
 */
export function reconcile(
  values: FormValues,
  machines: readonly PickerMachine[],
  context: {
    readonly cached: readonly PickerMachine[];
    readonly lastUsed: LastUsed | null;
    readonly defaults: Defaults;
  },
): Reconciliation {
  const target = pickTarget(machines, values.machineId, context.defaults);
  if (target === null || machines.length === 0) {
    // Nothing to pick from. `checkSubmit` explains the emptiness; a note here
    // would just duplicate it, and an empty registry is not a *change*. `auto` stays picked.
    return { values: { ...values, machineId: target === AUTO ? AUTO : null, repo: null }, note: null };
  }
  const targetId = target === AUTO ? AUTO : target.deviceId;
  const where = target === AUTO ? "every machine" : target.name;
  const shown = (value: string): string => (target === AUTO ? originLabel(value) : value);

  // The per-target memory: the current selection
  // carries over only while the target itself is unchanged — on a switch, the
  // target's own remembered repo wins, never the previous target's.
  const remembered = context.lastUsed?.repos[targetId] ?? null;
  const repo = pickRepo(
    repoChoices(targetId, machines),
    targetId === values.machineId ? [values.repo, remembered] : [remembered],
  );
  const next: FormValues = { ...values, machineId: targetId, repo: repo?.value ?? null };

  if (targetId !== values.machineId) {
    // Only worth a note if something was actually selected before, and only if
    // the cache can still name it — otherwise this is a first-run selection.
    // Reaches `auto` only from a vanished machine, when the preference names it.
    const lost = context.cached.find((candidate) => candidate.deviceId === values.machineId);
    const note =
      values.machineId === null
        ? null
        : `${lost?.name ?? "the last machine"} is no longer registered — switched to ${target === AUTO ? "Auto" : target.name}`;
    return { values: next, note };
  }

  if (repo === null) {
    const empty =
      target === AUTO ? "No machine reports a repo the scheduler can route to" : `${where} has no repos to spawn in`;
    return { values: next, note: values.repo === null ? null : empty };
  }
  if (repo.value !== values.repo) {
    const note = values.repo === null ? null : `${shown(values.repo)} is gone from ${where} — picked ${repo.title}`;
    return { values: next, note };
  }
  return { values: next, note: null };
}

/**
 * The form's opening state: last-used where it still resolves, preferences
 * where it does not. Expressed as `reconcile` over the cached list so the
 * fallback rules are stated exactly once.
 */
export function initialValues(
  cached: readonly PickerMachine[],
  lastUsed: LastUsed | null,
  defaults: Defaults,
): FormValues {
  const base: FormValues = {
    prompt: "",
    machineId: lastUsed?.machineId ?? null,
    repo: null,
    model: lastUsed?.model ?? defaults.model,
    effort: lastUsed?.effort ?? defaults.effort,
    worktree: lastUsed?.worktree ?? true,
    autonomy: DEFAULT_AUTONOMY,
  };
  return reconcile(base, cached, { cached, lastUsed, defaults }).values;
}

/** What to persist after a spawn that started. Folds the machine's repo into the per-machine map. */
export function nextLastUsed(previous: LastUsed | null, values: FormValues): LastUsed {
  const repos = { ...previous?.repos };
  if (values.machineId !== null && values.repo !== null) repos[values.machineId] = values.repo;
  return {
    machineId: values.machineId,
    repos,
    model: values.model,
    effort: values.effort,
    worktree: values.worktree,
  };
}

/**
 * Either the resolved target or the reason there isn't one. A reason rather
 * than a bare `false`: refusing to submit without saying why is exactly the
 * failure mode this surface exists to avoid — the point is to not fire a spawn
 * into a void, and to say so. Returning the narrowed target too keeps the view
 * free of non-null assertions. `spawn` goes straight to a machine; `queue` is a
 * task in the relay's store for the scheduler to place.
 */
export type Submission =
  | {
      readonly ok: true;
      readonly kind: "spawn";
      readonly machine: PickerMachine;
      readonly request: Omit<SpawnRequest, "client">;
    }
  | { readonly ok: true; readonly kind: "queue"; readonly request: TaskRequest; readonly label: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The level as request fields: none at the default, as the PWA writes it, and `steer` with
 * `plan: true`, so a leader or daemon older than `autonomy` still starts the session in plan mode.
 */
export function autonomyFields(level: AutonomyLevel): Pick<SpawnRequest, "autonomy" | "plan"> {
  if (level === DEFAULT_AUTONOMY) return {};
  const fields = withAutonomy<Pick<SpawnRequest, "autonomy" | "plan">>({ autonomy: level });
  // Unreachable: only a `plan` beside the level can contradict it, and the form has none.
  if (fields === null) throw new Error(`autonomy ${level} contradicts no plan`);
  return fields;
}

/**
 * A direct spawn on `machine`. An empty prompt is a deliberate mode (start an empty session), and
 * the daemon distinguishes absent from empty — so it is omitted, not blanked.
 */
function spawnRequest(values: FormValues, repo: string): Omit<SpawnRequest, "client"> {
  return {
    repo,
    mode: values.worktree ? "worktree" : "here",
    model: values.model,
    effort: values.effort,
    ...(values.prompt.trim() === "" ? {} : { prompt: values.prompt }),
    ...autonomyFields(values.autonomy),
  };
}

export function checkSubmit(values: FormValues, machines: readonly PickerMachine[], connected: boolean): Submission {
  const auto = values.machineId === AUTO;
  const machine = machines.find((candidate) => candidate.deviceId === values.machineId);
  if (machines.length === 0 || (machine === undefined && !auto)) {
    if (machines.length > 0) return { ok: false, reason: "Pick a machine" };
    return {
      ok: false,
      reason: connected
        ? "No machines are registered with the relay"
        : "Still reaching the relay — no machine list yet",
    };
  }
  // The socket, not just the machine: a spawn is a request over a live app
  // socket, and the cached list can name a machine that looked online an hour ago.
  if (!connected) return { ok: false, reason: "Not connected to the relay" };
  if (machine === undefined) return checkQueue(values);
  if (!machine.connected) return { ok: false, reason: `${machine.name} is asleep — nothing would receive the spawn` };
  if (values.repo === null) {
    return { ok: false, reason: `${machine.name} has no repos — check repoRoots in its config, then rescan` };
  }
  return { ok: true, kind: "spawn", machine, request: spawnRequest(values, values.repo) };
}

/**
 * No machine need be awake, nor a scheduler leading: the relay's store answers
 * the create itself and the task waits there. The prompt is held to the
 * scheduler's bound here, where it can be named, rather than refused by
 * `createTask` as a bare `invalid_request`.
 */
function checkQueue(values: FormValues): Submission {
  if (values.repo === null) {
    return { ok: false, reason: "No machine reports a repo's origin — update seanced on them, then rescan" };
  }
  const request: TaskRequest = { ...taskRequest(values, values.repo, true), ...autonomyFields(values.autonomy) };
  const length = request.prompt?.length ?? 0;
  if (length > TASK_REQUEST_LIMITS.prompt) {
    return {
      ok: false,
      reason: `The prompt is ${length} characters; a queued task takes at most ${TASK_REQUEST_LIMITS.prompt}. Shorten it, or pick a machine to spawn on directly`,
    };
  }
  return { ok: true, kind: "queue", request, label: originLabel(values.repo) };
}

/** Age of the freshest machine contact, for the cached-list banner. `now` is injected so it is testable. */
export function formatAge(machines: readonly PickerMachine[], now: number): string {
  const newest = Math.max(...machines.map((machine) => lastHeardAt(machine)));
  const elapsed = Math.max(0, now - newest);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "moments ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
