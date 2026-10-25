import { pollUntil } from "./fixtures.ts";

export interface PushRequest {
  readonly method: string;
  /** The endpoint's path: `endpoint(id)` puts `id` here, so subscriptions can be told apart. */
  readonly path: string;
  /** Lower-cased names, as the Fetch API gives them. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface PushEndpoint {
  /** A subscription endpoint URL on this stub. */
  readonly endpoint: (id?: string) => string;
  /** Every request received, oldest first, recorded on arrival (before any held answer). */
  readonly requests: () => readonly PushRequest[];
  /** The status later requests get: 201 by default, as a push service answers; 404 or 410 for a gone subscription, 429 for throttling. */
  readonly respondWith: (status: number) => void;
  /** Later requests are answered 302 with this `Location`, which a sender that followed it would reach; null clears it. */
  readonly redirectTo: (location: string | null) => void;
  /** Withholds answers until the returned release is called: a push service that takes seconds. */
  readonly hold: () => () => void;
  readonly waitForRequests: (count: number, timeoutMs?: number) => Promise<readonly PushRequest[]>;
  readonly stop: () => Promise<void>;
}

/**
 * A stand-in for a Web Push service (RFC 8030): records what a sender POSTs and
 * answers with a chosen status. It reads nothing — decrypting the payload
 * (RFC 8291) or checking the VAPID header is the test's business, with what
 * `requests()` hands back. Plain http on 127.0.0.1 (CLAUDE.md, Testing), so a
 * sender that only allows https push hosts reaches it through an injected fetch.
 */
export function startPushEndpoint(): PushEndpoint {
  const received: PushRequest[] = [];
  let status = 201;
  let location: string | null = null;
  // One gate while any hold is outstanding; it opens when the last release lands, so an earlier
  // release cannot free a request a later hold still withholds.
  let gate: { readonly promise: Promise<void>; readonly open: () => void } | null = null;
  let holds = 0;
  const openGate = (): void => {
    holds = 0;
    gate?.open();
    gate = null;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => {
        headers[name] = value;
      });
      received.push({
        method: req.method,
        path: new URL(req.url).pathname,
        headers,
        body: new Uint8Array(await req.arrayBuffer()),
      });
      // Read at arrival, so a status changed while this request is held does not reach it.
      const answer = status;
      const redirect = location;
      if (gate !== null) await gate.promise;
      if (redirect !== null) return new Response(null, { status: 302, headers: { location: redirect } });
      return new Response(null, { status: answer });
    },
  });
  return {
    endpoint: (id = "sub") => new URL(`/push/${encodeURIComponent(id)}`, server.url).href,
    requests: () => [...received],
    respondWith: (next) => {
      status = next;
    },
    redirectTo: (next) => {
      location = next;
    },
    hold: () => {
      if (gate === null) {
        const { promise, resolve } = Promise.withResolvers<void>();
        gate = { promise, open: resolve };
      }
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        if (holds === 0) openGate();
      };
    },
    waitForRequests: async (count, timeoutMs) => {
      await pollUntil(() => received.length >= count, `${count} push request(s)`, timeoutMs);
      return [...received];
    },
    // Release first: a held request is answered, not cut, by the shutdown.
    stop: async () => {
      openGate();
      await server.stop();
    },
  };
}
