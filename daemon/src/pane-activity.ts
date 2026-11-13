import type { SessionState } from "@seance/shared";

/**
 * What the daemon keeps per pane séance started (`ours`), tasked or not, for the custodian's due check and its
 * `sessions` verb (docs/custodian.md, C14, C23, C24; DESIGN.md, "Session events", "Per-pane retention"): the
 * last state a bound session-event frame carried, and when the pane's visible screen last changed. In memory
 * only. The screen is reduced to a hash at once; its text is never kept, logged or sent.
 *
 * Retention, not an act: the state comes from frames the ingest already bound to a pane by the kernel's peer
 * pid, and nothing here runs anything shaped by a frame. The sampler's own subprocesses are fixed-argv tmux
 * reads: one `list-panes` a minute, and one `capture-pane` per live `ours` pane, none when there is none.
 */

/** A frame's state as retained: `done` is a report sent mid-turn, not a state a session rests in. */
export type TrackedState = Exclude<SessionState, "done">;

export interface PaneActivity {
  /** The last state a bound frame carried; null while none has arrived (C24's `unobserved`). */
  readonly state: TrackedState | null;
  /** When the current run of `state` and `turnEnded` began; null with `state`. */
  readonly stateSince: number | null;
  /** The last frame was an `idle` carrying `turnEnded`: the turn's own end, never a hooks-worker respawn's. */
  readonly turnEnded: boolean;
  /**
   * When the sampled screen last differed from the sample before; the first sample of the pane counts as a
   * change, so this is how long it has been unchanged *as far as this process has seen*, never longer. Null
   * until the pane's first sample.
   */
  readonly screenSince: number | null;
  /** The pane's last successful capture: a consumer can tell a stalled sampler from a still screen. */
  readonly sampledAt: number | null;
}

/** A pane as the tracker needs it; `BoundPane` (`session-events.ts`) is one. */
export interface TrackedPane {
  readonly id: string;
  readonly pid: number;
  readonly dead: boolean;
  readonly ours: boolean;
}

export interface PaneActivityDeps {
  /** Every pane; throws when tmux could not answer (a failed read must never read as every pane gone). */
  readonly panes: () => Promise<readonly TrackedPane[]>;
  /** The pane's visible screen, no history; null when tmux could not capture it. */
  readonly capture: (paneId: string) => Promise<string | null>;
  readonly now?: () => number;
  readonly intervalMs?: number;
}

export interface PaneActivityTracker {
  /** Session-event ingest's `retain`: a bound frame's state. A pane not `ours`, or dead, is ignored. */
  readonly observe: (pane: TrackedPane, state: TrackedState, turnEnded: boolean) => void;
  /** One sampling pass; a call while one runs joins it, so a slow tmux never stacks passes. */
  readonly sample: () => Promise<void>;
  /** Null for a pane not tracked: not `ours`, gone, or neither sampled nor heard from yet. */
  readonly activity: (paneId: string) => PaneActivity | null;
  /** Samples at once, then every `intervalMs`. */
  readonly start: () => void;
  readonly stop: () => void;
}

export const SAMPLE_INTERVAL_MS = 60_000;

interface Entry {
  /** A tmux server restart reuses `%n`; the pid tells the new pane from the old one. */
  readonly pid: number;
  /** Before a listing began, an entry its listing lacks is gone; after, it may be newer than the listing. */
  readonly createdAt: number;
  state: TrackedState | null;
  stateSince: number | null;
  turnEnded: boolean;
  hash: number | bigint | null;
  screenSince: number | null;
  sampledAt: number | null;
}

export function createPaneActivity(deps: PaneActivityDeps): PaneActivityTracker {
  const now = deps.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let stopped = false;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const entryFor = (pane: TrackedPane, at: number): Entry => {
    const held = entries.get(pane.id);
    if (held !== undefined && held.pid === pane.pid) return held;
    const fresh: Entry = {
      pid: pane.pid,
      createdAt: at,
      state: null,
      stateSince: null,
      turnEnded: false,
      hash: null,
      screenSince: null,
      sampledAt: null,
    };
    entries.set(pane.id, fresh);
    return fresh;
  };

  const pass = async (): Promise<void> => {
    const listedAt = now();
    let panes: readonly TrackedPane[];
    try {
      panes = await deps.panes();
    } catch {
      // No answer is not an empty server: every entry stands until a listing says otherwise.
      return;
    }
    const live = panes.filter((pane) => pane.ours && !pane.dead);
    const listed = new Set(live.map((pane) => pane.id));
    for (const [id, entry] of entries) {
      if (!listed.has(id) && entry.createdAt < listedAt) entries.delete(id);
    }
    for (const pane of live) {
      if (stopped) return;
      // oxlint-disable-next-line no-await-in-loop -- one capture at a time: the sampler's cost stays one tmux exec in flight
      const screen = await deps.capture(pane.id);
      if (screen === null || stopped) continue;
      const at = now();
      const entry = entryFor(pane, at);
      const hash = Bun.hash(screen);
      if (entry.hash !== hash) {
        entry.hash = hash;
        entry.screenSince = at;
      }
      entry.sampledAt = at;
    }
  };

  const sample = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    running ??= pass().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    observe: (pane, state, turnEnded): void => {
      if (stopped || !pane.ours || pane.dead) return;
      const at = now();
      const entry = entryFor(pane, at);
      if (entry.state !== state || entry.turnEnded !== turnEnded) entry.stateSince = at;
      entry.state = state;
      entry.turnEnded = turnEnded;
    },
    sample,
    activity: (paneId): PaneActivity | null => {
      const entry = entries.get(paneId);
      if (entry === undefined) return null;
      return {
        state: entry.state,
        stateSince: entry.stateSince,
        turnEnded: entry.turnEnded,
        screenSince: entry.screenSince,
        sampledAt: entry.sampledAt,
      };
    },
    start: (): void => {
      if (stopped || timer !== null) return;
      void sample();
      timer = setInterval(() => void sample(), deps.intervalMs ?? SAMPLE_INTERVAL_MS);
    },
    stop: (): void => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      entries.clear();
    },
  };
}
