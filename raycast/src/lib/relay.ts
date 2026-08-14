import {
  RelayClient,
  type RelayState,
  type RescanResponse,
  type SpawnClient,
  type SpawnRequest,
  type SpawnResponse,
} from "@seance/shared";
import type { Credentials } from "./credentials.ts";

/** Stamped into every spawn this surface sends; the daemon audits it as `client="raycast"`. */
export const SPAWN_CLIENT: SpawnClient = "raycast";

export interface RelayHandle {
  readonly getState: () => RelayState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly spawn: (deviceId: string, request: Omit<SpawnRequest, "client">) => Promise<SpawnResponse>;
  readonly rescan: (deviceId: string) => Promise<RescanResponse>;
  readonly stop: () => void;
}

/**
 * A third app-role client, exactly as `seanced mcp` is: same `/app?t=<token>`
 * upgrade, same envelope crypto, same correlation. No relay or daemon change.
 *
 * No `createSocket` override: `RelayClient`'s default `new WebSocket(url)` is
 * enough once `installNodeGlobals()` has put one on the global object, which it
 * has to do anyway for the `WebSocket.OPEN` static the client also reads. See
 * lib/runtime.ts for why Raycast's sandbox leaves that global empty, and why the
 * `perMessageDeflate: false` scar in daemon/src/mcp.ts has no equivalent here.
 */
export function connect(credentials: Credentials, log: (line: string) => void = () => {}): RelayHandle {
  const client = new RelayClient({
    url: credentials.relayUrl,
    token: credentials.bearerToken,
    key: credentials.key,
    // Raycast surfaces console output only in the dev-mode terminal, and a
    // released extension has nowhere to put it — so the wire log is dropped by
    // default rather than shouted into a void.
    log,
  });
  client.start();

  return {
    getState: client.getState,
    subscribe: client.subscribe,
    spawn: (deviceId, request) =>
      client.request<SpawnResponse>(deviceId, "spawn", { ...request, client: SPAWN_CLIENT } satisfies SpawnRequest),
    rescan: async (deviceId) => {
      const reply = await client.request<RescanResponse>(deviceId, "rescan", {});
      // Folds the fresh list into the machine it came from, so a rescan that
      // found nothing new still moves `scannedAt` — without this the daemon
      // only re-registers on a *changed* set and the picker looks inert.
      client.applyScan(deviceId, reply.repos, reply.scannedAt);
      return reply;
    },
    stop: () => client.stop(),
  };
}
