export interface Env {
  readonly HUB: DurableObjectNamespace;
  /**
   * Shared relay token, set with `wrangler secret put BEARER_TOKEN`. Anti-junk
   * hygiene only — the PSK is the trust boundary, and the relay never holds it.
   */
  readonly BEARER_TOKEN: string;
}
