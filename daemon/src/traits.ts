import type { ExclaveInfo } from "@seance/shared";
import type { TraitsConfig } from "./config.ts";

/**
 * The scan's exclaves with this machine's declared traits added: each exclave carries the sorted
 * names whose `exclaves` is absent (every exclave) or lists its id, and none at all when no trait
 * applies. Kept out of the scan itself (`scanExclaves`, `exclaveInfoEqual`) so a rescan's "changed"
 * comparison never sees config; a config change restarts the daemon (`supervise.ts`) instead.
 */
export function withTraits(info: readonly ExclaveInfo[], traits: TraitsConfig | undefined): readonly ExclaveInfo[] {
  if (traits === undefined) return info;
  return info.map((exclave) => {
    const names = Object.entries(traits)
      .filter(([, scope]) => scope.exclaves === undefined || scope.exclaves.includes(exclave.id))
      .map(([name]) => name)
      .toSorted();
    return names.length === 0 ? exclave : { ...exclave, traits: names };
  });
}
