import { APP_PATH, DAEMON_PATH } from "./types.ts";

/**
 * The config's relayUrl is the daemon endpoint; app-role clients dial `/app`.
 * Shared because both non-browser app-role clients (`seanced mcp`, the Raycast
 * extension) read the same daemon config and need the identical swap — the PWA
 * is configured with an app URL directly and never calls this.
 */
export function appRelayUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  if (url.pathname.endsWith(DAEMON_PATH)) {
    url.pathname = url.pathname.slice(0, -DAEMON_PATH.length) + APP_PATH;
  }
  return url.href;
}
