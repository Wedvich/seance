import { CLOSE_BAD_REQUEST, CLOSE_UNAUTHORIZED } from "@seance/shared";
import { presentedToken, roleForPath, tokenMatches } from "./auth.ts";
import type { Env } from "./env.ts";

export { Hub } from "./hub.ts";

/** One relay, one registry, one broadcast domain. */
const HUB_NAME = "hub";

/**
 * Completes the handshake, then closes — the only way to hand a browser a
 * reason, since JS cannot see the status of a rejected upgrade. The socket
 * never reaches the Hub, so an unauthenticated caller cannot wake the DO.
 */
function closeUpgrade(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const role = roleForPath(new URL(req.url).pathname);
    if (role === null) return new Response("not found", { status: 404 });

    const presented = presentedToken(req, role);
    const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";

    if (!tokenMatches(presented, env.BEARER_TOKEN)) {
      // Only a real app handshake gets a coded close; anything else keeps the
      // 401 so an unauthenticated caller still learns nothing about the protocol.
      if (role === "app" && isUpgrade) {
        return presented === null
          ? closeUpgrade(CLOSE_BAD_REQUEST, "missing token")
          : closeUpgrade(CLOSE_UNAUTHORIZED, "unauthorized");
      }
      return new Response("unauthorized", { status: 401 });
    }

    if (!isUpgrade) {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    // Forwarded untouched: the hub re-derives the role from the same path helper,
    // which avoids rebuilding an upgrade request just to carry a header.
    return env.HUB.get(env.HUB.idFromName(HUB_NAME)).fetch(req);
  },
} satisfies ExportedHandler<Env>;
