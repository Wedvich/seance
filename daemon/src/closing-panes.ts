/**
 * Panes Séance itself set out to close (`despawnSession`: a despawn, a hand-off's or pass's close, a custodian `close`),
 * for an adapter's `session-gone` to say `closed` rather than `exited` (DESIGN.md, "Adapters"). Memory only, per
 * process, keyed by pane id and the pane's pid: a pane id is unique only within one tmux server, which reuses it after
 * a restart (and a test process runs one server per file). A reader asks within `CLOSING_TTL_MS` of the close
 * starting, past the graceful exit's grace and the kill after it. Display only: nothing binds, routes or acts on it.
 */
export const CLOSING_TTL_MS = 60_000;
const CLOSING_MAX = 256;

const closing = new Map<string, number>();

const keyOf = (pane: string, pid: number): string => `${pane}:${pid}`;

export function noteClosing(pane: string, pid: number, now: number = Date.now()): void {
  const key = keyOf(pane, pid);
  closing.delete(key); // re-insert: insertion order is age order
  closing.set(key, now);
  for (const [id, at] of closing) {
    if (closing.size <= CLOSING_MAX && now - at <= CLOSING_TTL_MS) break;
    closing.delete(id);
  }
}

/** Whether Séance began closing `pane`, while `pid` was its process, within the last `CLOSING_TTL_MS`. */
export function closedBySeance(pane: string, pid: number, now: number = Date.now()): boolean {
  const at = closing.get(keyOf(pane, pid));
  return at !== undefined && now - at <= CLOSING_TTL_MS;
}
