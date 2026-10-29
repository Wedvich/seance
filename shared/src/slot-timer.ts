/**
 * Periodic work on shared wall-clock slots (`k * intervalMs + offsetMs` since the epoch) rather
 * than on each process's own start time. Every daemon's `status` beat and every app's heartbeat
 * land in the same second, so a phone on cellular wakes its radio once per interval instead of
 * once per machine plus its own ping — each wake holds the radio in its high-power state for a
 * tail of several seconds (DESIGN.md, Presence & identity, "Status cadence"). Alignment is an
 * optimisation only: a skewed clock costs an extra wake, never correctness.
 */

/** The first slot at least `minDelayMs` after `nowMs`. */
export function nextSlotAt(nowMs: number, intervalMs: number, offsetMs: number, minDelayMs: number): number {
  const earliest = nowMs + minDelayMs;
  const into = (((earliest - offsetMs) % intervalMs) + intervalMs) % intervalMs;
  return into === 0 ? earliest : earliest + intervalMs - into;
}

export interface SlotTimerOpts {
  readonly intervalMs: number;
  /** Where in the interval the slot sits. */
  readonly offsetMs?: number;
  /**
   * The first slot is at least this far off. One interval keeps what `setInterval` promised —
   * nothing fires before a full interval has passed — which callers' tests rely on.
   */
  readonly minFirstMs?: number;
}

/**
 * Calls `onSlot` on every slot until the returned stop is called. Re-armed from the slot it
 * was due at, not from when it fired: a timer firing a millisecond early must not fire the
 * same slot twice. One woken late (a laptop's sleep) fires once and skips the slots it missed.
 */
export function startSlotTimer(opts: SlotTimerOpts, onSlot: () => void): () => void {
  const { intervalMs } = opts;
  const offsetMs = opts.offsetMs ?? 0;
  let dueAt = nextSlotAt(Date.now(), intervalMs, offsetMs, opts.minFirstMs ?? intervalMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    timer = setTimeout(fire, Math.max(0, dueAt - Date.now()));
  };
  const fire = (): void => {
    const now = Date.now();
    dueAt += intervalMs;
    if (dueAt <= now) dueAt = nextSlotAt(now, intervalMs, offsetMs, 1);
    // Armed first, so a throwing callback cannot stop the beat.
    arm();
    onSlot();
  };
  arm();
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
