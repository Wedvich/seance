import type { Verdict } from "./state.ts";
import type { AppState } from "./view.ts";

/**
 * Every view-transition type the app starts, and the vocabulary screen.css
 * selects on through `:active-view-transition-type(…)`. Exported so a test can
 * hold the stylesheet to it: a typo'd type would silently never match.
 */
export const TRANSITION_KINDS = [
  "push",
  "pop",
  "switch",
  "verdict-in",
  "verdict-out",
  "modal-in",
  "modal-out",
] as const;

export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/** The phone's three peer screens under its one header; the verdict belongs to the prompt's. */
export type Screen = "prompt" | "queue" | "machines";

/**
 * What decides whether a store change is a screen change. Screen identity
 * only, never content: a poll landing while someone types must not freeze the
 * page for a capture frame.
 */
export interface ScreenKey {
  readonly screen: Screen;
  /** The modal over every screen. */
  readonly settings: boolean;
  /** Mirrors VerdictView's key in app.tsx: a queued task by id, so its polls are not a change; any other verdict by object. */
  readonly verdict: string | Verdict | null;
  readonly wide: boolean;
}

export function screenKey(state: AppState): ScreenKey {
  const { verdict } = state;
  return {
    screen: state.queue ? "queue" : state.machines ? "machines" : "prompt",
    settings: state.settings,
    verdict: verdict === null ? null : verdict.kind === "queued" ? `queued:${verdict.task.id}` : verdict,
    wide: state.wide,
  };
}

/**
 * The task the Queue should bring into view. The phone's page is display: none under Settings, where the
 * row can be neither scrolled to nor seen, so the focus waits (the Queue clears it once it has applied it)
 * until Settings closes, or the mark would expire unseen. On a desk the columns stay visible behind it.
 */
export function visibleFocus(state: AppState): string | null {
  return state.settings && !state.wide ? null : state.focusedTask;
}

export function transitionKind(prev: ScreenKey, next: ScreenKey): TransitionKind | null {
  // A layout flip re-renders everything at once; there is nothing to slide between.
  if (prev.wide !== next.wide) return null;
  if (prev.settings !== next.settings) {
    if (next.wide) return next.settings ? "modal-in" : "modal-out";
    return next.settings ? "push" : "pop";
  }
  // Under the modal nothing shows; on a desk Queue and Machines are columns, always on screen.
  if (next.settings) return null;
  // A screen change wins over a verdict change, so one popstate closing the Queue and the verdict is one switch.
  if (prev.screen !== next.screen) return next.wide ? null : "switch";
  // A verdict under a phone screen is not on screen.
  if (next.screen !== "prompt" && !next.wide) return null;
  if (prev.verdict === next.verdict) return null;
  if (prev.verdict === null) return "verdict-in";
  if (next.verdict === null) return "verdict-out";
  return null;
}

/** The slice of the browser's ViewTransition the runner reads. */
export interface ViewTransitionLike {
  readonly updateCallbackDone: Promise<void>;
  skipTransition(): void;
}

export interface TransitionOptions {
  readonly update: () => Promise<void>;
  readonly types: string[];
}

export interface TransitionDeps<S> {
  /** `document.startViewTransition`, wired only where typed transitions exist; absent means an instant swap. */
  readonly start?: (options: TransitionOptions) => ViewTransitionLike;
  readonly reducedMotion: () => boolean;
  readonly hidden: () => boolean;
  /** Renders the state; resolves once the DOM is committed. */
  readonly apply: (state: S) => Promise<void>;
}

/**
 * Offered every store change, it decides whether the change is a screen
 * transition and, if so, holds the state back until the browser has captured
 * the old screen: the update callback runs a frame after the start, and a
 * state applied before it would land in the "old" snapshot.
 */
interface Started {
  readonly from: ScreenKey;
  readonly kind: TransitionKind;
  transition: ViewTransitionLike | null;
}

export class TransitionRunner<S> {
  readonly #deps: TransitionDeps<S>;
  /** The key of the latest offered state, which is what the screen shows or is about to. */
  #shown: ScreenKey;
  /** Set while a started transition waits for its update callback; latest offer wins. */
  #pending: { readonly state: S; readonly run: number; readonly started: Started } | null = null;
  #runs = 0;

  constructor(initial: ScreenKey, deps: TransitionDeps<S>) {
    this.#shown = initial;
    this.#deps = deps;
  }

  offer(state: S, key: ScreenKey): void {
    const previous = this.#shown;
    const kind = transitionKind(previous, key);
    this.#shown = key;
    if (this.#pending !== null) {
      const { started, run } = this.#pending;
      this.#pending = { state, run, started };
      // The types were fixed at start; a collapsed final state that is no
      // longer that screen change would play the wrong choreography.
      if (transitionKind(started.from, key) !== started.kind) started.transition?.skipTransition();
      return;
    }
    const { start, reducedMotion, hidden, apply } = this.#deps;
    if (kind === null || start === undefined || reducedMotion() || hidden()) {
      void apply(state);
      return;
    }
    const run = ++this.#runs;
    const started: Started = { from: previous, kind, transition: null };
    this.#pending = { state, run, started };
    const update = (): Promise<void> => this.#flush(run) ?? Promise.resolve();
    let transition: ViewTransitionLike;
    try {
      transition = start({ update, types: [kind] });
    } catch {
      void this.#flush(run);
      return;
    }
    started.transition = transition;
    // The browser runs `update` even for a skipped transition; this only
    // backstops one that never did, so a state is never lost. Scoped to its
    // own run, so a late rejection cannot flush a newer transition's state
    // before that one's capture.
    transition.updateCallbackDone.catch(() => void this.#flush(run));
  }

  #flush(run: number): Promise<void> | null {
    const pending = this.#pending;
    if (pending === null || pending.run !== run) return null;
    this.#pending = null;
    return this.#deps.apply(pending.state);
  }
}
