import { TOKEN_PARAM } from "@seance/shared";

/**
 * What the worker hands the Durable Object. The app authenticates with `?t=`
 * because a browser cannot set a header on a WebSocket, but the hub re-derives
 * its role from the path alone — so carrying the bearer into the subrequest
 * only writes it into a second trace span. The eyeball's own URL is untouched:
 * this narrows where the token is retained, it does not get it out of the
 * query string (DESIGN.md, accepted trade-offs).
 *
 * Rebuilt rather than mutated — a Request's URL is read-only — and only ever
 * called past the upgrade check, so method plus headers is the whole request:
 * the hub's 101 needs the upgrade header to survive, and the GET has no body.
 */
export function hubRequest(req: Request): Request {
  const url = new URL(req.url);
  if (!url.searchParams.has(TOKEN_PARAM)) return req;
  url.searchParams.delete(TOKEN_PARAM);
  return new Request(url.href, { method: req.method, headers: req.headers });
}
