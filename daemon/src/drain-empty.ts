import { log } from "./log.ts";

/**
 * docs/drain.md §12's time from close to empty: one line the first time this machine's live panes read empty
 * while it is closed at a `cl` (DESIGN.md, "The drain's outside pass"). Fed by the status loop's own
 * sessions read, so it costs no read of its own and is as fine as that beat. Memory only, once per `cl` per
 * process: a restart while closed may log a `cl` again, which the line carries for a reader to fold.
 * Counts only what this daemon itself knows (its panes); moved and stuck are the leader's lines.
 */
export interface DrainEmptyWatch {
  /** One successful pane read: `cl` as read before it (null while open), `panes` its length. */
  readonly observe: (cl: number | null, panes: number) => void;
}

export function createDrainEmptyWatch(deps: {
  readonly now: () => number;
  readonly log?: (line: string) => void;
}): DrainEmptyWatch {
  const write = deps.log ?? ((line: string): void => log.info(line));
  let watching: { readonly cl: number; peak: number; logged: boolean } | null = null;
  return {
    observe: (cl, panes) => {
      if (cl === null) {
        watching = null;
        return;
      }
      if (watching?.cl !== cl) watching = { cl, peak: 0, logged: false };
      watching.peak = Math.max(watching.peak, panes);
      if (panes > 0 || watching.logged) return;
      watching.logged = true;
      write(`drain: empty cl=${cl} after_ms=${Math.max(0, deps.now() - cl)} peak=${watching.peak}`);
    },
  };
}

/**
 * `read` with each successful list fed to `watch`. `cl` is taken before the read, so an empty list was
 * listed after that close; a failed read rejects as before and never reaches the watch (unread is not empty).
 */
export function watchedSessions<T>(
  read: () => Promise<readonly T[]>,
  closed: () => number | null,
  watch: DrainEmptyWatch,
): () => Promise<readonly T[]> {
  return async () => {
    const cl = closed();
    const list = await read();
    watch.observe(cl, list.length);
    return list;
  };
}
