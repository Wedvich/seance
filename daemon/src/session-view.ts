import type { SessionEntry, SessionLive } from "@seance/shared";
import type { ProcessView, SessionTagsSource } from "./conversations.ts";

/**
 * An app's view of a session list (docs/work.md, "Wire"): each entry joined with its pane's session tags and its newest
 * live `claude`'s state from the conversation table, as held now (no sweep). The one join both the `sessions` reply
 * (`handlers.ts`, after a sweep) and the status's session generation read, so `sg` moves exactly when the reply would.
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
  readonly observe: (sessions: readonly SessionEntry[]) => number;
}

/**
 * `MachineStatus.sg`. Memory only: the fingerprint is a hash of the app's view less what moves without a change a
 * reader would act on (`live.since`, a tag's `at`), and the text it hashes is dropped at once. The status tick is its
 * one caller, so it bumps at most once per tick; `seed` is the boot time in unix seconds, so a restarted daemon starts
 * above any number its predecessor reached (bumps are tens of seconds apart) unless the clock went back. Clients
 * compare it for inequality only.
 */
export function createSessionGeneration(opts: {
  readonly seed: number;
  readonly view: (sessions: readonly SessionEntry[]) => readonly SessionEntry[];
}): SessionGeneration {
  let generation = opts.seed;
  let last: bigint | number | null = null;
  return {
    observe: (sessions) => {
      const print = Bun.hash(JSON.stringify(opts.view(sessions).map(shown)));
      if (last !== null && print !== last) generation += 1;
      last = print;
      return generation;
    },
  };
}

/** What a reader would act on: the entry without its clocks. */
function shown(entry: SessionEntry): unknown {
  const { tags, live, ...rest } = entry;
  return {
    ...rest,
    ...(tags === undefined
      ? {}
      : { tags: Object.entries(tags).map(([key, tag]) => [key, tag.value, tag.scope, tag.verified === true]) }),
    ...(live === undefined ? {} : { live: [live.state, live.turnEnded === true, live.reason ?? null] }),
  };
}
