import type { SessionEntry, SessionLive } from "@seance/shared";
import type { ProcessView, SessionTagsSource } from "./conversations.ts";

/**
 * An app's view of a session list (docs/work.md, "Wire"): each entry joined with its pane's session tags and its newest
 * live `claude`'s state from the conversation table, as held now (the caller sweeps first, or not). The one join both the
 * `sessions` reply (`handlers.ts`) and the status's session generation (which sweeps first too) read, so `sg` moves
 * when the reply's view does.
 * Never for a scheduler-sealed reply, and MCP strips `live` (WS6).
 */
export function appSessionView(
  source: Omit<SessionTagsSource, "sweep"> | undefined,
  sessions: readonly SessionEntry[],
): readonly SessionEntry[] {
  if (source === undefined) return sessions;
  return sessions.map((entry) => {
    if (entry.id === undefined) return entry;
    const tags = source.tagsFor(entry.id);
    const view = source.process(entry.id);
    const live = view === null ? undefined : liveOf(view);
    if (tags === undefined && live === undefined) return entry;
    return { ...entry, ...(tags === undefined ? {} : { tags }), ...(live === undefined ? {} : { live }) };
  });
}

/** A process's state as `SessionEntry.live`; undefined when none is retained (no frame with a state yet). */
export function liveOf(view: ProcessView): SessionLive | undefined {
  // `ended` is never retained (the table drops the process), but the type allows it.
  if (view.state === null || view.state === "ended") return undefined;
  return {
    state: view.state,
    since: view.since,
    ...(view.state === "idle" && view.turnEnded ? { turnEnded: true } : {}),
    ...(view.state === "needs-input" && view.reason !== null ? { reason: view.reason } : {}),
  };
}

export interface SessionGeneration {
  /** The generation after seeing `sessions` (the raw list): bumped when the app's view of it differs from the last. */
  readonly observe: (sessions: readonly SessionEntry[]) => Promise<number>;
}

/**
 * `MachineStatus.sg`. Memory only: the fingerprint is a hash of the app's view, and the text it hashes is dropped at
 * once. No clock in it moves without a change a reply would show (`live.since` and a tag's `at` restamp only when the
 * value changes), and one that returns to its old value within a beat (idle, busy, idle) still moves them. Tags are
 * hashed by key, so an adapter's replay reordering the table's map is no change. The status tick is its one caller, so
 * it bumps at most once per tick; `prepare` (the table's sweep, as a reply runs it) runs first, display-only, a
 * failure shown as the table already held. `seed` is the boot time in unix ms, so a restarted daemon starts above any
 * number its predecessor reached unless the clock went back or it bumped over 1000 a second. Clients compare it for
 * inequality only.
 */
export function createSessionGeneration(opts: {
  readonly seed: number;
  readonly view: (sessions: readonly SessionEntry[]) => readonly SessionEntry[];
  readonly prepare?: () => Promise<void>;
}): SessionGeneration {
  let generation = opts.seed;
  let last: bigint | number | null = null;
  return {
    observe: async (sessions) => {
      await opts.prepare?.().catch(() => {});
      const print = Bun.hash(JSON.stringify(opts.view(sessions).map(shown)));
      if (last !== null && print !== last) generation += 1;
      last = print;
      return generation;
    },
  };
}

/** What a reader would act on, in an order the table's insertion order cannot change. */
function shown(entry: SessionEntry): unknown {
  const { tags, live, ...rest } = entry;
  return {
    ...rest,
    ...(tags === undefined
      ? {}
      : {
          tags: Object.entries(tags)
            .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, tag]) => [key, tag.value, tag.scope, tag.verified === true, tag.at]),
        }),
    ...(live === undefined ? {} : { live: [live.state, live.since, live.turnEnded === true, live.reason ?? null] }),
  };
}
