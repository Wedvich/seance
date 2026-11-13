import type { SessionState } from "@seance/shared";

/**
 * What the daemon keeps per pane séance started (`ours`), tasked or not, for the custodian's due check and its
 * `sessions` verb (docs/custodian.md, C14, C23, C24; DESIGN.md, "Session events", "Per-pane retention"): the
 * last state a bound session-event frame carried, and when the pane's visible screen last changed. In memory
 * only. The screen is normalised (`normaliseScreen`) and reduced to a hash at once; its text is never kept,
 * logged or sent.
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

/** One tracked pane's activity with its id: what the custodian seat's due check reads (`all`). */
export interface TrackedActivity extends PaneActivity {
  readonly pane: string;
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
  /** Every tracked pane's activity, for the custodian seat's due check (C14). */
  readonly all: () => readonly TrackedActivity[];
  /** Samples at once, then every `intervalMs`; a call while running does nothing. */
  readonly start: () => void;
  /**
   * Stops the timer only. The facts stay: the tracker is one per process (`run-capabilities.ts`), so a config
   * reload's stop→start keeps what every pane's frames and screen said, and a pass in flight finishes harmlessly.
   */
  readonly stop: () => void;
}

export const SAMPLE_INTERVAL_MS = 60_000;

/** A run of 10+ box-drawing rule characters alone on its line: the top and bottom edge of Claude's input box. */
const RULE = /^\s*[─━]{10,}\s*$/u;
/** A parenthesised elapsed time, with or without counters after it: `(2m 14s · ↑ 3.1k tokens · esc to interrupt)`. */
const TIMER = /\(\s*(?:\d+[hms]\s*)+(?:·[^)]*)?\)/gu;
/** The spinner's animated glyph at the start of its line; the word after it stays, it is fixed per turn. */
const SPINNER_GLYPH = /^(\s*)[✻✽✶✳✢✺✹·*](?=\s)/u;

/**
 * The screen as the change hash sees it: what a session that is doing nothing leaves still. Claude Code repaints
 * parts of its own screen with no work behind them, and a busy session hung inside a command is exactly one
 * ticking spinner, so a verbatim hash would never read it as unchanged (C27's `interrupt`, C14's due check).
 * Dropped:
 * - everything from the input box's top edge down (the last-but-one rule line): the box, which also changes
 *   when someone types, the status line and the hint lines, whose cost, context and clock readings move;
 * - an elapsed time in parentheses, with the token counter and hint beside it, on the spinner line and a
 *   running tool's line (`(2m 14s · ↑ 3.1k tokens · esc to interrupt)`, `(12s)`), masked to `(…)`;
 * - the spinner's animated glyph, masked to `*`.
 * Kept: the transcript, so real progress (new output, a tool finishing, the spinner's verb changing) still
 * moves the hash. A screen with fewer than two rule lines (an exit dialog, a pane not running Claude) is
 * hashed whole bar the masks. Limits: a repaint this does not know (wording from Claude Code 2.1.x), a
 * resize, or a client attaching at another size, still moves it, which only ever reads as activity, the
 * safe side for every consumer.
 */
export function normaliseScreen(screen: string): string {
  const lines = screen.split("\n");
  const rules = lines.flatMap((line, at) => (RULE.test(line) ? [at] : []));
  const kept = rules.length >= 2 ? lines.slice(0, rules[rules.length - 2]) : lines;
  return kept
    .map((line) => line.replace(TIMER, "(…)").replace(SPINNER_GLYPH, "$1*"))
    .join("\n")
    .trimEnd();
}

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
    const listed = new Map(live.map((pane) => [pane.id, pane.pid]));
    for (const [id, entry] of entries) {
      // A listed id under another pid is a reused `%n` (tmux restarted): the old pane's facts are not the new one's.
      if (entry.createdAt < listedAt && listed.get(id) !== entry.pid) entries.delete(id);
    }
    for (const pane of live) {
      let screen: string | null;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one capture at a time: the sampler's cost stays one tmux exec in flight
        screen = await deps.capture(pane.id);
      } catch {
        // A spawn failure (tmux briefly missing, EMFILE) is a failed capture, never a reason to reject the pass.
        continue;
      }
      if (screen === null) continue;
      const at = now();
      const entry = entryFor(pane, at);
      const hash = Bun.hash(normaliseScreen(screen));
      if (entry.hash !== hash) {
        entry.hash = hash;
        entry.screenSince = at;
      }
      entry.sampledAt = at;
    }
  };

  const sample = (): Promise<void> => {
    running ??= pass().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    observe: (pane, state, turnEnded): void => {
      if (!pane.ours || pane.dead) return;
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
    all: (): readonly TrackedActivity[] =>
      [...entries].map(([pane, entry]) => ({
        pane,
        state: entry.state,
        stateSince: entry.stateSince,
        turnEnded: entry.turnEnded,
        screenSince: entry.screenSince,
        sampledAt: entry.sampledAt,
      })),
    start: (): void => {
      if (timer !== null) return;
      void sample().catch(() => {});
      timer = setInterval(() => void sample().catch(() => {}), deps.intervalMs ?? SAMPLE_INTERVAL_MS);
      // The daemon's stop clears it; a handle dropped without one must not hold the process open.
      timer.unref();
    },
    stop: (): void => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
