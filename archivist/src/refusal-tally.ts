import type { ArchiveRefusals } from "@seance/shared";

/**
 * Finished tasks whose row SQLite refused and that have not archived since,
 * this process only (A36k). The collector notes them and the status answer
 * reads a count and a time, so neither reaches into the other and no id leaves.
 * A restart empties it: a record still in the store is refused again at the
 * next listing, and one pruned meanwhile drops from the count.
 */
export interface RefusalTally {
  refused(taskId: string): void;
  /** A later write of the task went through (archived, or already held at that version). */
  cleared(taskId: string): void;
  snapshot(): ArchiveRefusals;
}

export function createRefusalTally(now: () => number = Date.now): RefusalTally {
  // Id to first refusal: every pass refuses it again, and the first says how long it has been at risk.
  const firstRefused = new Map<string, number>();
  return {
    refused: (taskId) => {
      if (!firstRefused.has(taskId)) firstRefused.set(taskId, now());
    },
    cleared: (taskId) => {
      firstRefused.delete(taskId);
    },
    snapshot: () => {
      // A loop, not `Math.min(...)`: a schema break refuses every finished task the store holds.
      let since: number | null = null;
      for (const at of firstRefused.values()) if (since === null || at < since) since = at;
      return { tasks: firstRefused.size, since };
    },
  };
}
