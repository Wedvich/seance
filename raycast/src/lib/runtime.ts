import { webcrypto } from "node:crypto";
import { WebSocket } from "ws";

/**
 * Installs the two globals `shared/` reaches for and Raycast does not provide.
 *
 * Raycast runs extensions on Node v22.22.2, but inside a sandbox whose global
 * object is *not* that Node's: probing it from inside a command reports `fetch`,
 * `btoa` and `TextEncoder` present while `crypto` and `WebSocket` are both
 * undefined. A bare `node` of the same version has all four, so the runtime
 * version alone does not answer the question — only probing from inside the
 * sandbox does. Without this shim the extension dies on `crypto is not defined`
 * the moment `importPsk` runs.
 *
 * `shared/` consumes both as globals — `crypto.subtle` and
 * `crypto.getRandomValues` in crypto.ts, `crypto.randomUUID` and the
 * `WebSocket.OPEN` static in app-client.ts — and it is consumed by the PWA and
 * the daemon, where the globals genuinely exist. Widening it with injectable
 * seams for a third consumer's sandbox would be the wrong direction, so the
 * adaptation lives here, at the boundary that needs it.
 *
 * `defineProperty` rather than assignment because `globalThis.crypto` is an
 * accessor with no setter on Node.
 *
 * `ws` is the dependency this forces. Node's own global WebSocket is undici's
 * and has no importable form, so once the sandbox withholds it there is nothing
 * else to hand over. Its client offers permessage-deflate by default, which the
 * relay — a Cloudflare Worker — does not accept, so the `perMessageDeflate:
 * false` scar from Bun dialing workerd has no equivalent here; the extension
 * passes no `createSocket` and lets the negotiation come back empty.
 */
export function installNodeGlobals(): void {
  if (globalThis.crypto === undefined) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true, writable: true });
  }
  if (globalThis.WebSocket === undefined) {
    Object.defineProperty(globalThis, "WebSocket", { value: WebSocket, configurable: true, writable: true });
  }
}
