export interface Env {
  readonly HUB: DurableObjectNamespace;
  /**
   * Shared relay token, set with `wrangler secret put BEARER_TOKEN`. Anti-junk
   * hygiene only — the PSK is the trust boundary, and the relay never holds it.
   */
  readonly BEARER_TOKEN: string;
  /**
   * Test-only overrides for the silent-socket sweep, in ms (vars are strings).
   * Unset in production — the defaults in hub.ts apply.
   */
  readonly SWEEP_INTERVAL_MS?: string;
  readonly SWEEP_SILENCE_LIMIT_MS?: string;
}
