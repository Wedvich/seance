import { APP_PATH, ATTACHMENT_PATH, DAEMON_PATH } from "./types.ts";

/**
 * Where an attachment is put and fetched: the relay's HTTP origin for either socket
 * URL (the daemon config's `relayUrl`, the PWA's `VITE_RELAY_URL`), at `ATTACHMENT_PATH`.
 */
export function attachmentUrl(relayUrl: string, id: string): string {
  const url = new URL(relayUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  for (const socket of [DAEMON_PATH, APP_PATH]) {
    if (url.pathname.endsWith(socket)) url.pathname = url.pathname.slice(0, -socket.length);
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}${ATTACHMENT_PATH}${id}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

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
