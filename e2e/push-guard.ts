import { pushEndpoint } from "@seance/shared";
import type { Fetch } from "../daemon/src/seams.ts";

/**
 * The `httpFetch` every e2e daemon gets. A leader in a suite holds subscriptions the tests
 * wrote (not real browsers') and raises alerts as the suite's tasks move, so without this
 * seam a CI run would POST to a real push service. A request to an allowlisted push host is
 * refused here and recorded by host; anything else goes out as it would in production.
 */
export function pushGuardFetch(attempts: string[] = []): Fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (pushEndpoint(url) === null) return fetch(input, init);
    attempts.push(new URL(url).hostname);
    return Promise.reject(new Error("e2e: a push service is never contacted"));
  };
}
