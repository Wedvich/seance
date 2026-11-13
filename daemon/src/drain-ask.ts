import type { NeedsInputReason, SessionState } from "@seance/shared";
import type { DrainAskOutcome } from "./audit.ts";
import { KEY_GAP_MS } from "./despawn.ts";
import { PANE_ID } from "./pane-id.ts";
import { log } from "./log.ts";
import type { BoundPane } from "./session-events.ts";
import { capturePane, tmux } from "./tmux.ts";

/**
 * The drain's session ask (DESIGN.md, "The drain's session ask"; docs/drain.md is the spec's remainder): while
 * this machine is closed, the daemon types one constant prompt into each tasked session's pane so the session
 * commits and passes itself (`pass_to_successor`), which the outside pass cannot do for a dirty tree.
 *
 * Invariant (CLAUDE.md): the only keys that ever go in are `DRAIN_PROMPT` (`send-keys -l`), Enter, the graceful
 * despawn's Escape and its Ctrl+C, never a field of any frame. Only into a live pane whose launch ledger holds a
 * worktree launch of its task (`askable`), only while closed, the text only after that pane's `idle` carrying
 * `turnEnded` and never while its last frame is `needs-input` (the drain can deny a permission, never grant one).
 * Enter goes in only after every re-check, the screen's own input box among them. Never a second Ctrl+C, which
 * exits Claude Code; never an Escape in the draft clear (two quick Escapes open its Rewind menu). One audit line
 * per act (`origin=drain`), never the text.
 */

/**
 * One line, no digit (a dialog takes number keys as choices), no leading `-` (tmux would read a flag): it is
 * one `send-keys -l` argument and must not submit early. The session is told why, what to do and where the
 * question it was waiting on goes, since an interrupt may have dismissed it.
 */
export const DRAIN_PROMPT =
  "Seance is closing this machine for new work, so this session has to move. Please stop where you are, " +
  "commit everything you have (a WIP commit is fine), then call the seance MCP tool pass_to_successor with a " +
  "record of where you stand and what comes next, including any question you were waiting on the person to " +
  "answer, and end your turn. Do not start anything new.";

/** How long a turn may run after the close before it is interrupted. */
export const DRAIN_INTERRUPT_MS = 300_000;
/** How long an interrupted pane gets to reach a turn-ended idle before it is skipped (step B covers it). */
export const DRAIN_SKIP_MS = 30_000;

/** Screen reads after typing before the prompt counts as absent: about a second at `KEY_GAP_MS`. */
const SCREEN_CHECK_TRIES = 7;

const NORMALIZE = /\s+/gu;
const RULE = /^─{8,}$/u;

/**
 * The text in the screen's input box (between the last two full-width `─` rules, as Claude Code draws it), after the
 * `❯`, wrapped lines joined and whitespace collapsed; `""` for an empty box. Null when there is no box: a permission
 * dialog, a question or the Rewind menu replaces it. Read in memory, never returned to a wire, logged or audited.
 */
export function inputBoxText(screen: string): string | null {
  const lines = screen.split("\n").map((line) => line.trimEnd());
  const rules: number[] = [];
  for (const [index, line] of lines.entries()) if (RULE.test(line.trim())) rules.push(index);
  const open = rules.at(-2);
  const close = rules.at(-1);
  if (open === undefined || close === undefined) return null;
  const box = lines
    .slice(open + 1, close)
    .join(" ")
    .replace(NORMALIZE, " ")
    .trim();
  if (!box.startsWith("❯")) return null;
  return box.slice("❯".length).replace(NORMALIZE, " ").trim();
}

/**
 * Whether the screen's input box holds exactly `prompt`: a `❯`, then the text wrapped over any number of lines. A
 * permission dialog, a question or the Rewind menu replaces the box, and the prompt only in the transcript above an
 * empty box is not in it.
 */
export function inputBoxShows(screen: string, prompt: string): boolean {
  return inputBoxText(screen) === prompt.replace(NORMALIZE, " ").trim();
}

/** Production `keys`: one `send-keys` with constant arguments; true when tmux accepted it. */
export async function sendKeys(pane: string, args: readonly string[]): Promise<boolean> {
  return (await tmux(["send-keys", "-t", pane, ...args])).exitCode === 0;
}

/** Production `inputShows`: the pane's screen against `DRAIN_PROMPT`; false when tmux cannot say. */
export async function drainInputShows(pane: string): Promise<boolean> {
  const screen = await capturePane(pane, { history: false });
  return screen !== null && inputBoxShows(screen, DRAIN_PROMPT);
}

export interface DrainAskDeps {
  /** This machine's `cl`, or null while open. */
  readonly closed: () => number | null;
  readonly panes: () => Promise<readonly BoundPane[]>;
  /** `EndedTasks.askable`: a worktree launch in the ledger, not reported done, not being closed. */
  readonly askable: (taskId: string) => boolean;
  /** `SessionEvents.marked`: a pane with a hand-off or pass mark, or a close under way. */
  readonly marked: (pane: string) => boolean;
  /** One `send-keys -t <pane> ...args`; true when it was accepted. */
  readonly keys: (pane: string, args: readonly string[]) => Promise<boolean>;
  /** Whether the pane's input box shows exactly `DRAIN_PROMPT`, and no dialog or menu is on screen. */
  readonly inputShows: (pane: string) => Promise<boolean>;
  readonly audit: (taskId: string, outcome: DrainAskOutcome) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Runs `fn` after `ms`; returns the cancel. */
  readonly after?: (ms: number, fn: () => void) => () => void;
  readonly now?: () => number;
  readonly interruptMs?: number;
  readonly skipMs?: number;
}

export interface DrainAsk {
  /** Every bound, tasked event's state (`SessionEventDeps.onState`). */
  readonly observe: (
    pane: string,
    taskId: string,
    state: SessionState,
    turnEnded: boolean,
    reason: NeedsInputReason | undefined,
    closing: boolean,
  ) => void;
  /** This machine was closed at `cl` (or `now` was asked of an already-closed one): enumerate and ask. */
  readonly closed: (cl: number, now: boolean) => Promise<void>;
  /** Reopened: every pending ask and timer is dropped; a prompt already typed stays typed. */
  readonly reopened: () => void;
  /**
   * Whether this ask holds a live entry for the pane: waiting for its turn's end or its deadline, or mid-typing. Gone
   * once the prompt is typed, the pane skipped or dropped, or its session ended, so a stuck pane the ask gave up on is
   * the custodian's again. Read-only, for the custodian's `untouchable` (C7).
   */
  readonly holds: (pane: string) => boolean;
  /** A daemon that starts closed asks again; one ask per pane per process per `cl`. */
  readonly start: () => void;
  readonly stop: () => void;
}

interface PaneFrame {
  readonly taskId: string;
  readonly state: SessionState;
  readonly turnEnded: boolean;
  readonly reason: NeedsInputReason | undefined;
  readonly seq: number;
}

interface Entry {
  readonly taskId: string;
  readonly cl: number;
  phase: "waiting" | "interrupted";
  /** A typing sequence is in flight. */
  busy: boolean;
  /** A turn-ended idle arrived while it was: tried again once it settles. */
  again: boolean;
  cancelSkip: (() => void) | undefined;
}

const defaultAfter = (ms: number, fn: () => void): (() => void) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export function createDrainAsk(deps: DrainAskDeps): DrainAsk {
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => Bun.sleep(ms));
  const after = deps.after ?? defaultAfter;
  const now = deps.now ?? Date.now;
  const interruptMs = deps.interruptMs ?? DRAIN_INTERRUPT_MS;
  const skipMs = deps.skipMs ?? DRAIN_SKIP_MS;
  /** Always kept, so a close knows who is idle. */
  const last = new Map<string, PaneFrame>();
  const entries = new Map<string, Entry>();
  /**
   * Pane and task pairs an entry was made for under `currentCl`: an entry is deleted once typed or skipped, so
   * without this a repeated close at the same `cl` would ask (and Escape) the same pane again.
   */
  const asked = new Set<string>();
  let currentCl: number | null = null;
  let deadlineAt: number | null = null;
  let cancelDeadline: (() => void) | undefined;
  let stopped = false;

  const record = async (taskId: string, outcome: DrainAskOutcome): Promise<void> => {
    try {
      await deps.audit(taskId, outcome);
    } catch (err) {
      log.warn(`drain ask: could not audit ${outcome} for task ${taskId} (${String(err)})`);
    }
  };

  const drop = (pane: string, entry: Entry): void => {
    entry.cancelSkip?.();
    entry.cancelSkip = undefined;
    if (entries.get(pane) === entry) entries.delete(pane);
  };

  const clearEntries = (): void => {
    for (const [pane, entry] of [...entries]) drop(pane, entry);
  };

  const clearDeadline = (): void => {
    cancelDeadline?.();
    cancelDeadline = undefined;
  };

  const current = (pane: string, entry: Entry): boolean =>
    !stopped && entries.get(pane) === entry && deps.closed() === entry.cl;

  const armSkip = (pane: string, entry: Entry): void => {
    entry.cancelSkip = after(skipMs, () => {
      entry.cancelSkip = undefined;
      if (!current(pane, entry) || entry.phase !== "interrupted") return;
      if (entry.busy) {
        armSkip(pane, entry);
        return;
      }
      drop(pane, entry);
      void record(entry.taskId, "skipped");
    });
  };

  /** Esc, once per entry: it ends a turn, denies a permission, dismisses a question. */
  const interrupt = async (pane: string, entry: Entry): Promise<void> => {
    // Checked before the key, not after: a reopen sets the state before it reaches `reopened()`.
    if (entry.phase !== "waiting" || !current(pane, entry)) return;
    entry.phase = "interrupted";
    let sent = false;
    try {
      sent = await deps.keys(pane, ["Escape"]);
    } catch (err) {
      log.warn(`drain ask: could not send Escape to pane ${pane} (task ${entry.taskId}) (${String(err)})`);
    }
    if (sent) {
      if (current(pane, entry)) armSkip(pane, entry);
      await record(entry.taskId, "interrupted");
      return;
    }
    if (!current(pane, entry)) return;
    log.warn(`drain ask: could not send Escape to pane ${pane} (task ${entry.taskId}) — dropped it`);
    drop(pane, entry);
    await record(entry.taskId, "skipped");
  };

  /** A pane's last frame is a turn's end: the only thing that lets the text in. */
  const idleNow = (pane: string): boolean => {
    const frame = last.get(pane);
    return frame !== undefined && frame.state === "idle" && frame.turnEnded;
  };

  const questionNow = (pane: string): boolean => {
    const frame = last.get(pane);
    return frame !== undefined && frame.state === "needs-input" && frame.reason === "question";
  };

  /** A pane the entry may be Escaped for: not typing, and not at a turn's end. */
  const interruptible = (pane: string, entry: Entry): boolean =>
    entry.phase === "waiting" && !entry.busy && !idleNow(pane);

  const pastDeadline = (): boolean => deadlineAt !== null && deadlineAt <= now();

  /** A question goes at once; anything else once the deadline has passed (it fires only once per `cl`). */
  const maybeInterrupt = (pane: string, entry: Entry): void => {
    if (questionNow(pane) && !entry.busy) void interrupt(pane, entry);
    else if (pastDeadline() && interruptible(pane, entry)) void interrupt(pane, entry);
  };

  const typeInto = async (pane: string, entry: Entry, seq0: number): Promise<void> => {
    const live = (await deps.panes()).find((p) => p.id === pane && !p.dead);
    if (!current(pane, entry)) return;
    // The pane is gone or carries another task now: nothing to ask.
    if (live?.taskId !== entry.taskId) {
      drop(pane, entry);
      return;
    }
    // A session that passed itself (or handed off, or reported done) while waiting ends its turn with a
    // turn-ended idle that must not be typed into.
    if (deps.marked(pane) || !deps.askable(entry.taskId)) {
      drop(pane, entry);
      return;
    }
    if (last.get(pane)?.seq !== seq0) return;
    // Draft clear: Ctrl+C alone, never a second one, never an Escape. No abort between it and the text: an
    // abort here would leave "Ctrl-C again to exit" armed for the next attempt's Ctrl+C.
    if (!(await deps.keys(pane, ["C-c"]))) {
      // Dropped, never retried: tmux may have delivered it anyway, and a second Ctrl+C would exit Claude Code.
      log.warn(`drain ask: could not send Ctrl+C to pane ${pane} (task ${entry.taskId}) — dropped it`);
      drop(pane, entry);
      await record(entry.taskId, "skipped");
      return;
    }
    await sleep(KEY_GAP_MS);
    if (!(await deps.keys(pane, ["-l", DRAIN_PROMPT]))) {
      // Exit is armed and nothing disarmed it: another attempt's Ctrl+C would exit Claude Code.
      log.warn(`drain ask: could not type into pane ${pane} (task ${entry.taskId}) — dropped it`);
      drop(pane, entry);
      await record(entry.taskId, "skipped");
      return;
    }
    // A slow redraw (a loaded box, a long prompt) may not show the text one gap after typing: poll a few gaps
    // before calling it absent, stopping as soon as a frame moves.
    let shown = false;
    for (let attempt = 0; attempt < SCREEN_CHECK_TRIES && !shown; attempt++) {
      // oxlint-disable-next-line no-await-in-loop -- paced polls of one pane, each gating the next
      await sleep(KEY_GAP_MS);
      if (!current(pane, entry) || last.get(pane)?.seq !== seq0) return;
      // oxlint-disable-next-line no-await-in-loop
      shown = await deps.inputShows(pane);
    }
    // Synchronous from here to Enter, so nothing can move between the last check and the key.
    if (!current(pane, entry) || last.get(pane)?.seq !== seq0) return;
    if (!shown) {
      // No frame moved, so no later turn end is coming to try again, and a screen that never matches would
      // otherwise leave the entry waiting for good with the text unsent in the box. Step B covers the task.
      log.warn(`drain ask: pane ${pane} (task ${entry.taskId}) did not show the prompt in its input box — skipped it`);
      drop(pane, entry);
      await record(entry.taskId, "skipped");
      return;
    }
    if (deps.marked(pane) || !deps.askable(entry.taskId)) return;
    if (!(await deps.keys(pane, ["Enter"]))) {
      // Dropped, never retried: a retry starts with a Ctrl+C while exit may still be armed.
      log.warn(`drain ask: could not send Enter to pane ${pane} (task ${entry.taskId}) — dropped it`);
      drop(pane, entry);
      await record(entry.taskId, "skipped");
      return;
    }
    drop(pane, entry);
    await record(entry.taskId, "typed");
  };

  const type = async (pane: string, entry: Entry): Promise<void> => {
    const frame = last.get(pane);
    if (entry.busy || frame === undefined || !current(pane, entry)) return;
    entry.busy = true;
    entry.again = false;
    try {
      await typeInto(pane, entry, frame.seq);
    } catch (err) {
      // Dropped, never retried: a throw after the first Ctrl+C may have left exit armed, and a second would exit
      // Claude Code. Step B covers the task.
      log.warn(`drain ask: typing into pane ${pane} (task ${entry.taskId}) failed — dropped it (${String(err)})`);
      if (entries.get(pane) === entry) {
        drop(pane, entry);
        await record(entry.taskId, "skipped");
      }
    } finally {
      entry.busy = false;
    }
    if (!current(pane, entry)) return;
    if (entry.again && idleNow(pane)) void type(pane, entry);
    else if (questionNow(pane) || pastDeadline()) maybeInterrupt(pane, entry);
  };

  const fireDeadline = (): void => {
    cancelDeadline = undefined;
    for (const [pane, entry] of entries) if (interruptible(pane, entry)) void interrupt(pane, entry);
  };

  const schedule = (): void => {
    clearDeadline();
    if (deadlineAt === null) return;
    const wait = deadlineAt - now();
    if (wait <= 0) fireDeadline();
    else cancelDeadline = after(wait, fireDeadline);
  };

  const begin = (pane: string, entry: Entry): void => {
    if (idleNow(pane)) void type(pane, entry);
    else if (questionNow(pane)) void interrupt(pane, entry);
  };

  const closed = async (cl: number, now_: boolean): Promise<void> => {
    if (stopped) return;
    if (currentCl !== cl) {
      clearEntries();
      asked.clear();
      currentCl = cl;
      deadlineAt = cl + interruptMs;
    }
    if (now_) deadlineAt = now();
    let panes: readonly BoundPane[];
    try {
      panes = await deps.panes();
    } catch (err) {
      log.warn(`drain ask: could not list panes (${String(err)})`);
      return;
    }
    // A reopen, a newer close or a stop may have come in while the panes were read.
    if (stopped || deps.closed() !== cl || currentCl !== cl) return;
    for (const pane of panes) {
      const taskId = pane.taskId;
      if (pane.dead || taskId === null || !PANE_ID.test(pane.id)) continue;
      if (!deps.askable(taskId) || deps.marked(pane.id) || entries.has(pane.id)) continue;
      const key = `${pane.id}\0${taskId}`;
      if (asked.has(key)) continue;
      asked.add(key);
      const entry: Entry = {
        taskId,
        cl,
        phase: "waiting",
        busy: false,
        again: false,
        cancelSkip: undefined,
      };
      entries.set(pane.id, entry);
      begin(pane.id, entry);
    }
    schedule();
  };

  return {
    observe: (pane, taskId, state, turnEnded, reason, closing): void => {
      if (stopped) return;
      const entry = entries.get(pane);
      if (state === "ended") {
        last.delete(pane);
        if (entry !== undefined) drop(pane, entry);
        return;
      }
      last.set(pane, {
        taskId,
        state,
        turnEnded: state === "idle" && turnEnded,
        reason: state === "needs-input" ? reason : undefined,
        seq: (last.get(pane)?.seq ?? 0) + 1,
      });
      if (entry === undefined) return;
      // The pane was reused for another task, or a hand-off or pass close started on this very frame.
      if (entry.taskId !== taskId || closing) {
        drop(pane, entry);
        return;
      }
      if (entry.busy) {
        if (idleNow(pane)) entry.again = true;
        return;
      }
      if (idleNow(pane)) void type(pane, entry);
      else maybeInterrupt(pane, entry);
    },
    closed,
    holds: (pane): boolean => entries.has(pane),
    reopened: (): void => {
      clearEntries();
      clearDeadline();
      asked.clear();
      currentCl = null;
      deadlineAt = null;
    },
    start: (): void => {
      const cl = deps.closed();
      if (cl !== null) void closed(cl, false);
    },
    stop: (): void => {
      stopped = true;
      clearEntries();
      clearDeadline();
    },
  };
}

/**
 * The ask as `run.ts` holds it: the relay client starts before the capabilities that build the ask, so a close
 * can land first. A plain close needs nothing (`start()` reads the state); a `now` would be lost, so it is kept
 * and replayed once the ask is wired.
 */
export interface LateDrainAsk {
  readonly closed: (cl: number, now: boolean) => void;
  readonly reopened: () => void;
  /** `ask` is undefined where none is wired; `cl` is the machine's close at this moment. */
  readonly wire: (ask: DrainAsk | undefined, cl: number | null) => void;
}

export function createLateDrainAsk(): LateDrainAsk {
  let ask: DrainAsk | undefined;
  let nowPending = false;
  return {
    closed: (cl, now): void => {
      if (ask === undefined) nowPending ||= now;
      else void ask.closed(cl, now);
    },
    reopened: (): void => {
      nowPending = false;
      ask?.reopened();
    },
    wire: (wired, cl): void => {
      ask = wired;
      const replay = nowPending;
      nowPending = false;
      if (replay && cl !== null) void wired?.closed(cl, true);
    },
  };
}
