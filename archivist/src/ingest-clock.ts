import type { ArchiveIngestSource } from "@seance/shared";

/**
 * When each source last landed data, this process only. The collectors note it
 * and the status answer reads it, so neither reaches into the other.
 */
export interface IngestClock {
  note(source: ArchiveIngestSource): void;
  snapshot(): Readonly<Record<ArchiveIngestSource, number | null>>;
}

export function createIngestClock(now: () => number = Date.now): IngestClock {
  const at: Record<ArchiveIngestSource, number | null> = { store: null, registry: null, status: null, pull: null };
  return {
    note: (source) => {
      at[source] = now();
    },
    snapshot: () => ({ ...at }),
  };
}
