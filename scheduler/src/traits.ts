import { exclaveTraitHealth, type ExclaveInfo, type Machine, type Reason } from "@seance/shared";
import type { Decision } from "./route.ts";
import type { Task } from "./task.ts";

/**
 * One reason per required trait the exclave cannot offer, in `requires` order (not just the first:
 * the PWA words each, and `traitsHolding` names which one holds): `trait_absent` when it does not
 * carry the trait, `trait_unhealthy` when it does and its probe reads failing (`exclaveTraitHealth`,
 * the one rule). An unknown probe (not yet run, timed out, a stale status) still routes, as an
 * unknown login does. An exclave with no `traits` — an older daemon, or none declared — carries
 * none, so a task that requires one never places there. Pinned, `run-now` and continuation tasks
 * go through this too.
 */
export function traitFilter(
  task: Task,
  machine: Pick<Machine, "connected" | "status" | "exclaves">,
  exclave: ExclaveInfo,
  index: number,
  nowMs: number,
): readonly Reason[] {
  const carried = exclave.traits ?? [];
  return (task.spec.requires ?? []).flatMap((trait): readonly Reason[] => {
    if (!carried.includes(trait)) return [{ code: "trait_absent", trait }];
    return exclaveTraitHealth(machine, index, trait, nowMs) === "failing" ? [{ code: "trait_unhealthy", trait }] : [];
  });
}

/** The trait a reason is about, for the codes that mean "the exclave cannot offer it". */
function missingTrait(reason: Reason): string | null {
  return reason.code === "trait_absent" || reason.code === "trait_unhealthy" ? reason.trait : null;
}

/** Why a required trait holds a task: no machine carries it, or the ones that do have a failing probe. */
export type TraitHold = { readonly trait: string; readonly why: "absent" | "unhealthy" };

/**
 * The required traits that hold an unplaced task, for the held-by-trait log line: not every trait
 * of a task that waits for quota. `trait` holds when nothing was chosen and either
 * - (a) some candidate is rejected only for traits and lacks nothing but it: that one trait alone
 *   stops an otherwise free place (a place lacking several holds none of them singly: another
 *   exclave may carry the rest); or
 * - (b) every candidate that was judged lacks it: no machine has it. A machine whose blob lists
 *   no exclaves is rejected `exclaves_unknown` and never judged (`exclave: null`), so it is
 *   ignored here — it neither counts for nor against the trait.
 * In `requires` order. `why` is `unhealthy` when any judged candidate is rejected for that trait's
 * failing probe, `absent` otherwise.
 */
export function traitsHolding(decision: Decision, requires: readonly string[]): readonly TraitHold[] {
  if (decision.chosen !== null) return [];
  const lacks = (rejected: readonly Reason[], trait: string): boolean =>
    rejected.some((reason) => missingTrait(reason) === trait);
  const judged = decision.candidates.filter((c) => c.exclave !== null);
  const traitOnly = decision.candidates.filter(
    (c) => c.rejected.length > 0 && c.rejected.every((reason) => missingTrait(reason) !== null),
  );
  const onlyLacks = (rejected: readonly Reason[], trait: string): boolean =>
    rejected.every((reason) => missingTrait(reason) === trait);
  const unhealthy = (trait: string): boolean =>
    judged.some((c) => c.rejected.some((reason) => reason.code === "trait_unhealthy" && reason.trait === trait));
  return requires
    .filter(
      (trait) =>
        traitOnly.some((c) => onlyLacks(c.rejected, trait)) ||
        (judged.length > 0 && judged.every((c) => lacks(c.rejected, trait))),
    )
    .map((trait): TraitHold => ({ trait, why: unhealthy(trait) ? "unhealthy" : "absent" }));
}
