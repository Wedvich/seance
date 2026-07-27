import { presentedToken, roleForPath, tokenMatches } from "./auth.ts";
import type { Env } from "./env.ts";

export { Hub } from "./hub.ts";

/** One relay, one registry, one broadcast domain. */
const HUB_NAME = "hub";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const role = roleForPath(new URL(req.url).pathname);
    if (role === null) return new Response("not found", { status: 404 });
    // Auth before protocol: an unauthenticated caller learns nothing about what
    // this endpoint expects.
    if (!tokenMatches(presentedToken(req, role), env.BEARER_TOKEN)) {
      return new Response("unauthorized", { status: 401 });
    }
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    // Forwarded untouched: the hub re-derives the role from the same path helper,
    // which avoids rebuilding an upgrade request just to carry a header.
    return env.HUB.get(env.HUB.idFromName(HUB_NAME)).fetch(req);
  },
} satisfies ExportedHandler<Env>;
