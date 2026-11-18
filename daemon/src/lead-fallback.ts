import type { DrainEmptyWatch } from "./drain-empty.ts";

/**
 * docs/drain.md §6's "Later", as built (DESIGN.md, "Closing a machine", "A closed, empty machine leads only as a
 * fallback"): once this machine is closed and empty, every register it sends signs `fallback` beside `scheduler`,
 * so the relay hands the term to any other eligible daemon that is, or later gets, connected, and back to this one
 * only while none is. The daemon decides empty from its own facts alone — the status loop's sessions read (the
 * same list `drainView` and the `drain: empty` line read) and no task launch in flight — and never needs to know
 * who else is listed: that is the relay's `SCHEDULER_LEADERS`, which it never exposes.
 *
 * Once per `cl`: set the first time a read sees no pane under a close, it holds until `cl` changes (a reopen, or a
 * reopen and a new close), even if a pane appears again meanwhile, so a box that flickers between empty and not
 * never moves the term back and forth. Memory only: a restart while closed claims plain `scheduler` until its
 * first read sees the box empty again.
 */
export interface LeadFallback extends DrainEmptyWatch {
  /** Read at every register: whether it signs `fallback`. */
  readonly active: () => boolean;
}

export function createLeadFallback(deps: {
  /** A task launch the daemon accepted and has not yet settled: its pane may not be listed yet. */
  readonly launching: () => boolean;
  /** Each change, after `active` already answers the new value: the caller re-registers. */
  readonly changed: (active: boolean, cl: number) => void;
}): LeadFallback {
  let fellBackAt: number | null = null;
  return {
    active: () => fellBackAt !== null,
    observe: (cl, panes) => {
      if (fellBackAt !== null && cl !== fellBackAt) {
        const was = fellBackAt;
        fellBackAt = null;
        deps.changed(false, was);
      }
      if (cl === null || fellBackAt !== null || panes > 0 || deps.launching()) return;
      fellBackAt = cl;
      deps.changed(true, cl);
    },
  };
}
