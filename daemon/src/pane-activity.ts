import type { SessionState } from "@seance/shared";
import { processStart } from "./peer.ts";
import type { SavedActivity } from "./pane-activity-store.ts";

/**
 * What the daemon keeps per pane séance started (`ours`), tasked or not, for the custodian's due check and its
 * `sessions` verb (docs/custodian.md, C14, C23, C24; DESIGN.md, "Session events", "Per-pane retention"): the
 * last state a bound session-event frame carried, and when the pane's visible screen last changed. Kept in memory
 * and, given a `store`, written to `custodian/activity.json` (`pane-activity-store.ts`) so a restart can take it back:
 * a reloaded entry stays hidden (provisional) until a fresh sample hashes the screen the same as when it was saved. The
 * screen is normalised (`normaliseScreen`) and reduced to a hash at once; its text is never kept, written, logged or
 * sent.
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
  /** What tells a pane's process from a later one under the same pid; defaults to `processStart`. */
  readonly processStart?: (pid: number) => string | null;
  /** Where the facts outlive the process: read once, before the first pass or write; absent, memory only. */
  readonly store?: {
    readonly load: () => Promise<readonly SavedActivity[]>;
    readonly save: (panes: readonly SavedActivity[]) => Promise<void>;
  };
  /** How long a change waits for others before one write carries them all. */
  readonly saveDelayMs?: number;
}

export interface PaneActivityTracker {
  /** Session-event ingest's `retain`: a bound frame's state. A pane not `ours`, or dead, is ignored. */
  readonly observe: (pane: TrackedPane, state: TrackedState, turnEnded: boolean) => void;
  /** The clock `sampledAt`, `screenSince` and `stateSince` are stamped with. */
  readonly now: () => number;
  /** One sampling pass; a call while one runs joins it, so a slow tmux never stacks passes. */
  readonly sample: () => Promise<void>;
  /** Null for a pane not tracked: not `ours`, gone, or neither sampled nor heard from yet. */
  readonly activity: (paneId: string) => PaneActivity | null;
  /** Every tracked pane's activity, for the custodian seat's due check (C14). */
  readonly all: () => readonly TrackedActivity[];
  /**
   * Forgets every pane's last state, keeping its screen facts: frames were dropped while nothing retained them, so
   * a state held across that gap may be hours old and would read as a pane idle since then.
   */
  readonly forgetStates: () => void;
  /**
   * The oldest `stateSince` among entries a restart took back and a sample confirmed: from then the facts are
   * continuous, though this process began later. Null when none was.
   */
  readonly restoredSince: () => number | null;
  /** Settles once every write begun, the one a stop forced included, has landed. */
  readonly settled: () => Promise<void>;
  /** Samples at once, then every `intervalMs`; a call while running does nothing. */
  readonly start: () => void;
  /**
   * Stops the timer, and writes at once a change still waiting out its delay (`settled` says when it landed). The facts
   * stay: the tracker is one per process (`run-capabilities.ts`), so a config reload's stop→start keeps what every
   * pane's frames and screen said, and a pass in flight finishes harmlessly.
   */
  readonly stop: () => void;
}

export const SAMPLE_INTERVAL_MS = 60_000;
export const SAVE_DELAY_MS = 2_000;

/**
 * An edge of Claude's input box: a run of 8+ box-drawing rule characters alone on its line, or with one label cut
 * into it (a named session's top edge reads `──── fix-the-thing (thad) ─`, Claude Code 2.1.325). The drain ask and
 * the custodian's `close` find the box by it too (`drain-ask.ts`).
 */
export const INPUT_BOX_RULE = /^\s*(?:[─━]{8,}(?: [^─━]+ [─━]+)?|[─━]+ [^─━]+ [─━]{8,})\s*$/u;
const RULE = INPUT_BOX_RULE;
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
  const kept = rules.length >= 2 ? lines.slice(0, rules.at(-2)) : lines;
  return kept
    .map((line) => line.replace(TIMER, "(…)").replace(SPINNER_GLYPH, "$1*"))
    .join("\n")
    .trimEnd();
}

interface Entry {
  /** A tmux server restart reuses `%n`; the pid tells the new pane from the old one. */
  readonly pid: number;
  /** The pid's process start time, which a saved entry is checked against after a restart; null when unreadable. */
  readonly start: string | null;
  /** Taken back from the store and not yet confirmed by a sample: hidden from every reader. */
  provisional: boolean;
  /** Before a listing began, an entry its listing lacks is gone; after, it may be newer than the listing. */
  readonly createdAt: number;
  state: TrackedState | null;
  stateSince: number | null;
  turnEnded: boolean;
  hash: string | null;
  screenSince: number | null;
  sampledAt: number | null;
}

export function createPaneActivity(deps: PaneActivityDeps): PaneActivityTracker {
  const now = deps.now ?? Date.now;
  const startOf = deps.processStart ?? processStart;
  const entries = new Map<string, Entry>();
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let restoredFrom: number | null = null;

  const { store } = deps;
  let loading: Promise<void> | null = null;
  /** Once per process, before any write: a write first would replace the file with what this process alone has seen. */
  const load = (): Promise<void> => {
    loading ??= (async (): Promise<void> => {
      if (store === undefined) return;
      const saved = await store.load().catch((): readonly SavedActivity[] => []);
      for (const each of saved) {
        // A frame since this process began knows better than the file.
        if (entries.has(each.pane)) continue;
        entries.set(each.pane, {
          pid: each.pid,
          start: each.start,
          provisional: true,
          createdAt: Number.NEGATIVE_INFINITY,
          state: each.state,
          stateSince: each.stateSince,
          turnEnded: each.turnEnded,
          hash: each.hash,
          screenSince: each.screenSince,
          sampledAt: null,
        });
      }
    })();
    return loading;
  };

  const snapshot = (): readonly SavedActivity[] =>
    [...entries].flatMap(([pane, e]) =>
      e.state === null || e.stateSince === null || e.start === null || e.hash === null || e.screenSince === null
        ? []
        : [
            {
              pane,
              pid: e.pid,
              start: e.start,
              state: e.state,
              stateSince: e.stateSince,
              turnEnded: e.turnEnded,
              hash: e.hash,
              screenSince: e.screenSince,
            },
          ],
    );
  let writing: Promise<void> = Promise.resolve();
  let lastWritten: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // One write at a time, each of the facts as they stand when it begins: overlapping renames could land an older one last.
  const writeNow = async (): Promise<void> => {
    if (store === undefined) return;
    await load();
    const panes = snapshot();
    const text = JSON.stringify(panes);
    if (text === lastWritten) return;
    await store.save(panes);
    lastWritten = text;
  };
  const write = (): void => {
    // A failed write leaves `lastWritten` behind, so the next change tries again.
    writing = writing.then(writeNow).catch(() => {});
  };
  const changed = (): void => {
    if (store === undefined || saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      write();
    }, deps.saveDelayMs ?? SAVE_DELAY_MS);
    saveTimer.unref();
  };

  const entryFor = (pane: TrackedPane, at: number): Entry => {
    const held = entries.get(pane.id);
    if (held !== undefined && held.pid === pane.pid && !held.provisional) return held;
    const fresh: Entry = {
      pid: pane.pid,
      start: startOf(pane.pid),
      provisional: false,
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
    // Without a store the listing starts at once, so a frame landing meanwhile is ordered after it.
    if (store !== undefined) await load();
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
      // The same pid under another process: the kernel reused it, and the saved facts were another session's.
      else if (entry.provisional && startOf(entry.pid) !== entry.start) entries.delete(id);
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
      const hash = String(Bun.hash(normaliseScreen(screen)));
      const held = entries.get(pane.id);
      if (held?.provisional === true && held.pid === pane.pid) {
        // The daemon was down and may have missed a whole turn: only a screen that has not moved since the save says
        // it did not. A moved one drops what the file said, and the pane starts afresh below.
        if (held.hash === hash) {
          held.provisional = false;
          held.sampledAt = at;
          if (held.stateSince !== null) restoredFrom = Math.min(restoredFrom ?? held.stateSince, held.stateSince);
          continue;
        }
        entries.delete(pane.id);
      }
      const entry = entryFor(pane, at);
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
      changed();
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
      changed();
    },
    now,
    sample,
    activity: (paneId): PaneActivity | null => {
      const entry = entries.get(paneId);
      if (entry === undefined || entry.provisional) return null;
      return {
        state: entry.state,
        stateSince: entry.stateSince,
        turnEnded: entry.turnEnded,
        screenSince: entry.screenSince,
        sampledAt: entry.sampledAt,
      };
    },
    all: (): readonly TrackedActivity[] =>
      [...entries].flatMap(([pane, entry]) =>
        entry.provisional
          ? []
          : [
              {
                pane,
                state: entry.state,
                stateSince: entry.stateSince,
                turnEnded: entry.turnEnded,
                screenSince: entry.screenSince,
                sampledAt: entry.sampledAt,
              },
            ],
      ),
    forgetStates: (): void => {
      // A provisional entry is no state held across an unseen gap: the sample that confirms it is what covers the gap.
      for (const entry of entries.values()) {
        if (entry.provisional) continue;
        entry.state = null;
        entry.stateSince = null;
        entry.turnEnded = false;
      }
      changed();
    },
    restoredSince: () => restoredFrom,
    settled: async (): Promise<void> => {
      let tail: Promise<void>;
      do {
        tail = writing;
        // oxlint-disable-next-line no-await-in-loop -- drains until the chain stands still
        await tail;
      } while (tail !== writing);
    },
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
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
        write();
      }
    },
  };
}

/**
 * The tracker as the daemon holds it: one per process, taken by each running custodian seat. Frames are retained, and
 * the sampler runs, only while some seat holds it: without a reader nothing would prune the facts (only a sampler
 * pass does), and a frame dropped while nobody held it would leave a state that is hours old when the next seat
 * reads it, so the first taker forgets states. The gate is the process's, not one daemon instance's: a reload's
 * incoming instance retains from its first frame while the outgoing one still holds the tracker.
 */
export interface PaneRetention {
  /** A frame's state, kept only while the tracker is held. */
  readonly observe: PaneActivityTracker["observe"];
  /** Takes the tracker (the first taker forgets stale states and starts the sampler); the release is idempotent. */
  readonly acquire: () => () => void;
}

export function createPaneRetention(tracker: PaneActivityTracker): PaneRetention {
  let holders = 0;
  return {
    observe: (pane, state, turnEnded): void => {
      if (holders > 0) tracker.observe(pane, state, turnEnded);
    },
    acquire: (): (() => void) => {
      if (holders === 0) tracker.forgetStates();
      holders += 1;
      tracker.start();
      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        holders -= 1;
        if (holders === 0) tracker.stop();
      };
    },
  };
}
