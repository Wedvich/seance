import type { ExclaveInfo } from "@seance/shared";
import type { TraitsConfig } from "./config.ts";

/**
 * The scan's exclaves with this machine's declared traits added: each exclave carries the sorted
 * names whose `exclaves` is absent (every exclave) or lists its id, and none at all when no trait
 * applies. Kept out of the scan itself (`scanExclaves`, `exclaveInfoEqual`) so a rescan's "changed"
 * comparison never sees config; a config change restarts the daemon (`supervise.ts`) instead.
 * `keepFree` is the sorted subset of those names marked so, absent when empty.
 */
export function withTraits(info: readonly ExclaveInfo[], traits: TraitsConfig | undefined): readonly ExclaveInfo[] {
  if (traits === undefined) return info;
  return info.map((exclave) => {
    const names = exclaveTraitNames(exclave.id, traits);
    if (names.length === 0) return exclave;
    const keepFree = names.filter((name) => traits[name]?.keepFree === true);
    return { ...exclave, traits: names, ...(keepFree.length === 0 ? {} : { keepFree }) };
  });
}

/**
 * The sorted trait names one exclave carries: the order of its advertised `ExclaveInfo.traits`, which a
 * status's `tf`/`tu` trait index points into. The one rule for both, so the index cannot drift from the blob.
 */
export function exclaveTraitNames(exclaveId: string, traits: TraitsConfig | undefined): readonly string[] {
  return Object.entries(traits ?? {})
    .filter(([, scope]) => scope.exclaves === undefined || scope.exclaves.includes(exclaveId))
    .map(([name]) => name)
    .toSorted();
}

/**
 * The `exclaves` entries of a trait that name no exclave in the scan, by trait. Config parse cannot know the
 * scan, and a mistyped id would declare the trait nowhere, so every `requires` of it is then refused as
 * "no machine declares" with nothing on this box saying why: `buildInfo` warns on these.
 */
export function unmatchedTraitExclaves(
  info: readonly ExclaveInfo[],
  traits: TraitsConfig | undefined,
): readonly { readonly trait: string; readonly exclaves: readonly string[] }[] {
  const known = new Set(info.map((exclave) => exclave.id));
  return Object.entries(traits ?? {}).flatMap(([trait, scope]) => {
    const unmatched = (scope.exclaves ?? []).filter((id) => !known.has(id));
    return unmatched.length === 0 ? [] : [{ trait, exclaves: unmatched }];
  });
}
