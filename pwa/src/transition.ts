import type { Verdict } from "./state.ts";
import type { AppState } from "./view.ts";

/**
 * Every view-transition type the app starts, and the vocabulary screen.css
 * selects on through `:active-view-transition-type(…)`. Exported so a test can
 * hold the stylesheet to it: a typo'd type would silently never match.
 */
export const TRANSITION_KINDS = ["push", "pop", "verdict-in", "verdict-out", "modal-in", "modal-out"] as const;

export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/**
 * What decides whether a store change is a screen change. Screen identity
 * only, never content: a poll landing while someone types must not freeze the
 * page for a capture frame.
 */
export interface ScreenKey {
  readonly depth: 0 | 1;
  readonly layer: "settings" | "queue" | "machines" | null;
  /** Mirrors VerdictView's key in app.tsx: a queued task by id, so its polls are not a change; any other verdict by object. */
  readonly verdict: string | Verdict | null;
  readonly wide: boolean;
}

export function screenKey(state: AppState): ScreenKey {
  const layer = state.queue ? "queue" : state.machines ? "machines" : state.settings ? "settings" : null;
  const { verdict } = state;
  return {
    depth: layer === null ? 0 : 1,
    layer,
    verdict: verdict === null ? null : verdict.kind === "queued" ? `queued:${verdict.task.id}` : verdict,
    wide: state.wide,
  };
}

export function transitionKind(prev: ScreenKey, next: ScreenKey): TransitionKind | null {
  // A layout flip re-renders everything at once; there is nothing to slide between.
  if (prev.wide !== next.wide) return null;
  // Depth wins over a verdict change, so one popstate closing the Queue and the verdict is a pop.
  if (prev.depth !== next.depth) {
    const pushing = next.depth > prev.depth;
    if (!next.wide) return pushing ? "push" : "pop";
    // On a desk Queue and Machines are columns, always on screen; only Settings is a layer.
    const layer = pushing ? next.layer : prev.layer;
    if (layer !== "settings") return null;
    return pushing ? "modal-in" : "modal-out";
  }
  // A verdict under a phone layer is not on screen, and on a desk it sits behind the modal.
  if (next.depth !== 0 || prev.verdict === next.verdict) return null;
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
