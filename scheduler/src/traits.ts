import type { ExclaveInfo, Reason } from "@seance/shared";
import type { Decision } from "./route.ts";
import type { Task } from "./task.ts";

/**
 * One `trait_absent` per required trait the exclave does not carry, in `requires` order (not just
 * the first: the PWA words each, and `traitsHolding` names which one holds). An exclave with no
 * `traits` — an older daemon, or none declared — carries none, so a task that requires one never
 * places there. Pinned, `run-now` and continuation tasks go through this too.
 */
export function traitFilter(task: Task, exclave: ExclaveInfo): readonly Reason[] {
  const carried = exclave.traits ?? [];
  return (task.spec.requires ?? [])
    .filter((trait) => !carried.includes(trait))
    .map((trait): Reason => ({ code: "trait_absent", trait }));
}

/**
 * The trait a reason is about, for the codes that mean "the exclave does not offer it". The probes
 * PR adds `trait_unhealthy` here, in this one place.
 */
function missingTrait(reason: Reason): string | null {
  return reason.code === "trait_absent" ? reason.trait : null;
}

/**
 * The required traits that hold an unplaced task, for the held-by-trait log line: not every trait
 * of a task that waits for quota. `trait` holds when nothing was chosen and either
 * - (a) some candidate is rejected only for traits and lacks nothing but it: that one trait alone
 *   stops an otherwise free place (a place lacking several holds none of them singly: another
 *   exclave may carry the rest); or
 * - (b) every candidate that was judged lacks it: no machine has it. A machine whose blob lists
 *   no exclaves is rejected `exclaves_unknown` and never judged (`exclave: null`), so it is
 *   ignored here — it neither counts for nor against the trait.
 * In `requires` order.
 */
export function traitsHolding(decision: Decision, requires: readonly string[]): readonly string[] {
  if (decision.chosen !== null) return [];
  const lacks = (rejected: readonly Reason[], trait: string): boolean =>
    rejected.some((reason) => missingTrait(reason) === trait);
  const judged = decision.candidates.filter((c) => c.exclave !== null);
  const traitOnly = decision.candidates.filter(
    (c) => c.rejected.length > 0 && c.rejected.every((reason) => missingTrait(reason) !== null),
  );
  const onlyLacks = (rejected: readonly Reason[], trait: string): boolean =>
    rejected.every((reason) => missingTrait(reason) === trait);
  return requires.filter(
    (trait) =>
      traitOnly.some((c) => onlyLacks(c.rejected, trait)) ||
      (judged.length > 0 && judged.every((c) => lacks(c.rejected, trait))),
  );
}
