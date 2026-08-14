import type { RepoEntry } from "@seance/shared";
import type { Effort, Model } from "./options.ts";

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
  readonly lastSeen: number;
  readonly scannedAt: number;
  readonly repos: readonly RepoEntry[];
}

/** One collator for every sort; constructing one per comparison is not free. */
const collator = new Intl.Collator();

/**
 * Alphabetical by name, matching the PWA's pickers. The relay pushes registry
 * entries in lexicographic *deviceId* order, which to a reader is no order at
 * all. Applied where the list enters the form rather than at render, so the
 * "first listed" fallbacks below land on the machine that is actually shown
 * first.
 */
export function sortedByName<T extends { readonly name: string }>(items: readonly T[]): readonly T[] {
  return items.toSorted((a, b) => collator.compare(a.name, b.name));
}

/** Everything the form holds. The prompt always starts empty, so it is never persisted. */
export interface FormValues {
  readonly prompt: string;
  readonly machineId: string | null;
  readonly repo: string | null;
  readonly model: Model;
  readonly effort: Effort;
  readonly worktree: boolean;
}

/**
 * What survives between invocations, written after each successful spawn.
 * Mirrors the PWA's `PersistedForm`: the repo is remembered *per machine*, so
 * switching machines restores what you last ran there instead of resetting to
 * that machine's first repo.
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
 * First connected machine, else first listed — the same fallback the PWA's
 * `resolveMachine` applies, extended with the preference: a remembered machine
 * that is gone from the registry falls back to the *named* default before
 * falling back to position.
 */
function pickMachine(
  machines: readonly PickerMachine[],
  preferredId: string | null,
  defaults: Defaults,
): PickerMachine | null {
  const remembered = machines.find((machine) => machine.deviceId === preferredId);
  if (remembered !== undefined) return remembered;
  if (defaults.machineName !== "") {
    const named = machines.find((machine) => machine.name.toLowerCase() === defaults.machineName.toLowerCase());
    if (named !== undefined) return named;
  }
  return machines.find((machine) => machine.connected) ?? machines[0] ?? null;
}

/** The machine's remembered repo, else its first — the cache may name one that has gone. */
function pickRepo(machine: PickerMachine, preferred: string | null): RepoEntry | null {
  return machine.repos.find((repo) => repo.name === preferred) ?? machine.repos[0] ?? null;
}

/**
 * Folds a machine list into the current selection, reporting what it had to
 * change. Called twice per invocation with the same rules: once over the cached
 * projection to render instantly, then again when the live registry lands.
 */
export function reconcile(
  values: FormValues,
  machines: readonly PickerMachine[],
  context: { readonly cached: readonly PickerMachine[]; readonly defaults: Defaults },
): Reconciliation {
  const machine = pickMachine(machines, values.machineId, context.defaults);
  if (machine === null) {
    // Nothing to pick from. `submitBlocker` explains the emptiness; a note here
    // would just duplicate it, and an empty registry is not a *change*.
    return { values: { ...values, machineId: null, repo: null }, note: null };
  }

  const repo = pickRepo(machine, values.repo);
  const next: FormValues = { ...values, machineId: machine.deviceId, repo: repo?.name ?? null };

  if (machine.deviceId !== values.machineId) {
    // Only worth a note if something was actually selected before, and only if
    // the cache can still name it — otherwise this is a first-run selection.
    const lost = context.cached.find((candidate) => candidate.deviceId === values.machineId);
    const note =
      values.machineId === null
        ? null
        : `${lost?.name ?? "the last machine"} is no longer registered — switched to ${machine.name}`;
    return { values: next, note };
  }

  if (repo === null) {
    return { values: next, note: values.repo === null ? null : `${machine.name} has no repos to spawn in` };
  }
  if (repo.name !== values.repo) {
    const note = values.repo === null ? null : `${values.repo} is gone from ${machine.name} — picked ${repo.name}`;
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
  const machineId = lastUsed?.machineId ?? null;
  const base: FormValues = {
    prompt: "",
    machineId,
    repo: machineId === null ? null : (lastUsed?.repos[machineId] ?? null),
    model: lastUsed?.model ?? defaults.model,
    effort: lastUsed?.effort ?? defaults.effort,
    worktree: lastUsed?.worktree ?? true,
  };
  return reconcile(base, cached, { cached, defaults }).values;
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
 * free of non-null assertions.
 */
export type Submission =
  | { readonly ok: true; readonly machine: PickerMachine; readonly repo: string }
  | { readonly ok: false; readonly reason: string };

export function checkSubmit(values: FormValues, machines: readonly PickerMachine[], connected: boolean): Submission {
  const machine = machines.find((candidate) => candidate.deviceId === values.machineId);
  if (machine === undefined) {
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
  if (!machine.connected) return { ok: false, reason: `${machine.name} is asleep — nothing would receive the spawn` };
  if (values.repo === null) {
    return { ok: false, reason: `${machine.name} has no repos — check repoRoots in its config, then rescan` };
  }
  return { ok: true, machine, repo: values.repo };
}
