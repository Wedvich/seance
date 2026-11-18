/**
 * Panes Séance itself set out to close (`despawnSession`: a despawn, a hand-off's or pass's close, a custodian `close`),
 * for an adapter's `session-gone` to say `closed` rather than `exited` (docs/messaging.md §6.1). Memory only, per
 * process, keyed by pane id: a reader asks within `CLOSING_TTL_MS` of the close starting, past the graceful exit's
 * grace and the kill after it. Display only: nothing binds, routes or acts on it.
 */
export const CLOSING_TTL_MS = 60_000;
const CLOSING_MAX = 256;

const closing = new Map<string, number>();

export function noteClosing(pane: string, now: number = Date.now()): void {
  closing.delete(pane); // re-insert: insertion order is age order
  closing.set(pane, now);
  for (const [id, at] of closing) {
    if (closing.size <= CLOSING_MAX && now - at <= CLOSING_TTL_MS) break;
    closing.delete(id);
  }
}

/** Whether Séance began closing `pane` within the last `CLOSING_TTL_MS`. */
export function closedBySeance(pane: string, now: number = Date.now()): boolean {
  const at = closing.get(pane);
  return at !== undefined && now - at <= CLOSING_TTL_MS;
}
