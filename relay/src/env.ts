export interface Env {
  readonly HUB: DurableObjectNamespace;
  /**
   * Shared relay token, set with `wrangler secret put BEARER_TOKEN`. Anti-junk
   * hygiene only — the PSK is the trust boundary, and the relay never holds it.
   */
  readonly BEARER_TOKEN: string;
  /**
   * Device ids the relay may nominate as scheduler leader, comma-separated, set
   * with `wrangler secret put SCHEDULER_LEADERS`. Not secret: a secret only so a
   * CI deploy never overwrites it and no ids sit in git. Unset or empty
   * nominates nobody (`parseLeaders` in leadership.ts).
   */
  readonly SCHEDULER_LEADERS?: string;
  /**
   * Test-only overrides for the silent-socket sweep, the store's tombstone age
   * and the scheduler-reply window, in ms (vars are strings). Unset in
   * production — the defaults in hub.ts and shared's `STORE_TOMBSTONE_MS` apply.
   */
  readonly SWEEP_INTERVAL_MS?: string;
  readonly SWEEP_SILENCE_LIMIT_MS?: string;
  readonly STORE_TOMBSTONE_MS?: string;
  readonly SCHEDULER_REPLY_WINDOW_MS?: string;
}
