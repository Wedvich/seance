import type { Machine } from "./app-client.ts";
import { TASK_SPEC_LIMITS, type ExclaveInfo, type TaskSpec } from "./types.ts";

/**
 * Traits: a machine's own claim about what it has (DESIGN.md, "Traits"), declared in its
 * `config.json` and matched against `TaskSpec.requires`. One name rule and one fleet view,
 * so the daemon's config, the parsers and every client's refusal agree.
 */

/** Lowercase, digits and dashes: a name that is also one CLI argument, one JSON key and one line of text. */
export const TRAIT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

export const TRAIT_LIMITS = { perMachine: 16, requires: TASK_SPEC_LIMITS.requires } as const;

/** Machine names listed in one clause, and known trait names in one refusal: past them "and n more". */
const LIST_LIMIT = 4;
const KNOWN_LIMIT = 24;

export function isTraitName(value: unknown): value is string {
  return typeof value === "string" && TRAIT_NAME_PATTERN.test(value);
}

/**
 * Each trait any machine's exclave carries, with the sorted, deduped names of the machines
 * that carry it. Offline machines count: a trait that exists on a sleeping laptop is a trait
 * to wait for, as the skills inventory counts them.
 */
export function fleetTraits(machines: readonly Machine[]): ReadonlyMap<string, readonly string[]> {
  const holders = new Map<string, Set<string>>();
  for (const machine of machines) {
    for (const exclave of machine.exclaves ?? []) {
      for (const trait of exclave.traits ?? []) {
        const names = holders.get(trait);
        if (names === undefined) holders.set(trait, new Set([machine.name]));
        else names.add(machine.name);
      }
    }
  }
  return new Map([...holders.keys()].toSorted().map((trait) => [trait, [...(holders.get(trait) ?? [])].toSorted()]));
}

/** The names in `requires` that no machine declares, in request order. */
export function unknownTraits(requires: readonly string[], machines: readonly Machine[]): readonly string[] {
  const known = fleetTraits(machines);
  return requires.filter((trait) => !known.has(trait));
}

/** One refusal text for MCP, the CLI and the PWA, so a typo reads the same everywhere. */
export function unknownTraitsText(unknown: readonly string[], machines: readonly Machine[]): string {
  const known = [...fleetTraits(machines).keys()];
  const what = `no machine declares the trait${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}`;
  if (known.length === 0) return `${what} — no machine declares any traits`;
  const shown = known.slice(0, KNOWN_LIMIT).join(", ");
  const rest = known.length > KNOWN_LIMIT ? ` and ${known.length - KNOWN_LIMIT} more` : "";
  return `${what} — known: ${shown}${rest}`;
}

type ReachSpec = Pick<TaskSpec, "requires" | "pin" | "avoid">;

/**
 * The exclaves a task could ever be placed on, whatever is online or free: every exclave
 * of every machine (offline included), narrowed by the device pin and the account pin,
 * with avoided machines left out. A spec has no exclave pin to narrow by.
 */
function reachableExclaves(spec: ReachSpec, machines: readonly Machine[]): readonly ExclaveInfo[] {
  const avoided = new Set(spec.avoid ?? []);
  return machines
    .filter((m) => !avoided.has(m.deviceId) && (spec.pin?.deviceId === undefined || m.deviceId === spec.pin.deviceId))
    .flatMap((m) => m.exclaves ?? [])
    .filter((e) => spec.pin?.account === undefined || e.accountId === spec.pin.account);
}

/**
 * The one "could never place" check (the same rule as the scheduler's filter, per
 * exclave): `reachable` is true iff some single reachable exclave carries every
 * required trait; `missing` names the required traits no reachable exclave carries,
 * for the message. A task without `requires` is always reachable.
 */
export function unreachableTraits(
  spec: ReachSpec,
  machines: readonly Machine[],
): { readonly reachable: boolean; readonly missing: readonly string[] } {
  const requires = spec.requires ?? [];
  if (requires.length === 0) return { reachable: true, missing: [] };
  const exclaves = reachableExclaves(spec, machines);
  const missing = requires.filter((trait) => !exclaves.some((e) => e.traits?.includes(trait) === true));
  const reachable = exclaves.some((e) => requires.every((trait) => e.traits?.includes(trait) === true));
  return { reachable, missing };
}

/** `a, b and n more`, or empty names when there are none. */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, LIST_LIMIT).join(", ");
  return names.length > LIST_LIMIT ? `${shown} and ${names.length - LIST_LIMIT} more` : shown;
}

/**
 * Why a task with `requires` could never place, for the refusal: which machines have each
 * trait and what keeps each out of reach (`avoided`, a pin elsewhere or to another account).
 */
export function unreachableTraitsText(spec: ReachSpec, machines: readonly Machine[]): string {
  const requires = spec.requires ?? [];
  const avoided = new Set(spec.avoid ?? []);
  const holders = new Map<string, Machine[]>();
  for (const machine of machines) {
    for (const trait of requires) {
      if (!(machine.exclaves ?? []).some((e) => e.traits?.includes(trait) === true)) continue;
      holders.set(trait, [...(holders.get(trait) ?? []), machine]);
    }
  }
  const outOfReach = (machine: Machine, trait: string): string | null => {
    if (avoided.has(machine.deviceId)) return "avoided";
    if (spec.pin?.deviceId !== undefined && machine.deviceId !== spec.pin.deviceId) return "pinned elsewhere";
    const pinned = spec.pin?.account;
    const onAccount = (machine.exclaves ?? []).some(
      (e) => e.traits?.includes(trait) === true && e.accountId === pinned,
    );
    return pinned !== undefined && !onAccount ? "other account" : null;
  };
  const where = requires.map((trait) => {
    const on = (holders.get(trait) ?? []).map((m) => {
      const why = outOfReach(m, trait);
      return why === null ? m.name : `${m.name} (${why})`;
    });
    return on.length === 0 ? `${trait} is on no machine` : `${trait} is on ${nameList(on)}`;
  });
  const together = requires.length > 1 ? " together" : "";
  return `no exclave this task can reach carries ${requires.join(" and ")}${together} — ${where.join("; ")}`;
}
