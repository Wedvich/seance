import { pushEndpoint, type PushAlert, type WebPushSubscription } from "@seance/shared";
import type { log as Log } from "./log.ts";
import type { Fetch } from "./seams.ts";
import type { TermSettings } from "./settings.ts";
import { encryptPayload, vapidAuthorization } from "./web-push.ts";

/**
 * Sends a `PushAlert` to every subscription the term's settings hold (DESIGN.md,
 * Scheduler, "Web Push"). Scheduler-free: the leader maps a library alert to a
 * `PushAlert` and hands it here.
 *
 * `send` returns before anything leaves and never throws, so a push fault can
 * never surface in the scheduler pass that alerted (`Scheduler#alert` would swallow
 * a throw into `onError`, where it would read as a scheduler error). Each send is
 * held to what a forged subscription must not be able to do: it goes only to an
 * endpoint `pushEndpoint` accepts *now* (the record is re-checked, not trusted),
 * follows no redirect, and gives up after `timeoutMs`.
 *
 * Logs only failures, as host and status. Never an endpoint path (the path is the
 * subscription's secret), a key, a JWT or a payload.
 */

export interface PushSender {
  /** Queues the alert for every subscription; returns at once. */
  readonly send: (alert: PushAlert) => void;
}

export interface PushSenderOpts {
  readonly settings: Pick<TermSettings, "current" | "update">;
  readonly httpFetch: Fetch;
  /** The VAPID `sub` claim: a contact URI for the push service. */
  readonly sub: string;
  readonly now: () => number;
  readonly log: Pick<typeof Log, "info" | "warn">;
  /** A prune that threw (the term's store revoked): the term's own fault path. */
  readonly onError: (err: unknown) => void;
  /** Requests in flight at once. Past it a send waits in line rather than being lost. */
  readonly maxInFlight?: number;
  /** Sends waiting in line at most; past it one is dropped. Bounds memory when a push service stalls. */
  readonly maxQueued?: number;
  readonly timeoutMs?: number;
}

const MAX_IN_FLIGHT = 8;
const MAX_QUEUED = 64;
const TIMEOUT_MS = 5_000;
/** A push service holds an undelivered push this long (RFC 8030): an alert stale past it is not worth showing. */
const TTL_S = 3600;

interface Target {
  readonly subscription: WebPushSubscription;
  /** `pushEndpoint`'s normalized form of the stored endpoint. */
  readonly endpoint: string;
}

/** What a failed send reads as in a log when there was no status. */
function failureOf(err: unknown): "timeout" | "error" {
  return err instanceof Error && err.name === "TimeoutError" ? "timeout" : "error";
}

export function createPushSender(o: PushSenderOpts): PushSender {
  const maxInFlight = o.maxInFlight ?? MAX_IN_FLIGHT;
  const maxQueued = o.maxQueued ?? MAX_QUEUED;
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  const utf8 = new TextEncoder();
  // Slots are taken synchronously in `launch`, so a burst in one pass counts against the cap before any request starts.
  let inFlight = 0;
  const waiting: (() => void)[] = [];

  const prune = async (target: Target, host: string, status: number): Promise<void> => {
    let result;
    try {
      result = await o.settings.update((record) => {
        const held = record.subscriptions;
        if (held?.some((s) => s.endpoint === target.subscription.endpoint) !== true) return null;
        const { version: _version, subscriptions: _held, ...rest } = record;
        const kept = held.filter((s) => s.endpoint !== target.subscription.endpoint);
        return kept.length === 0 ? rest : { ...rest, subscriptions: kept };
      });
    } catch (err) {
      // The term's store was revoked: its own fault path decides, not this send.
      o.onError(err);
      return;
    }
    if (result.ok) o.log.info(`push: pruned a subscription host=${host} status=${status}`);
    else o.log.warn(`push: could not prune a subscription host=${host} status=${status} code=${result.code}`);
  };

  const deliver = async (alert: PushAlert, target: Target): Promise<void> => {
    const host = new URL(target.endpoint).hostname;
    let status: number;
    try {
      const vapid = o.settings.current()?.vapid;
      // Gone since it was queued: the term's settings went unavailable.
      if (vapid === undefined) return;
      // Built when the send starts, not when it was queued, so a long line holds no key material.
      const body = await encryptPayload(target.subscription, utf8.encode(JSON.stringify(alert)));
      const authorization = await vapidAuthorization(target.endpoint, vapid, o.sub, o.now());
      const response = await o.httpFetch(target.endpoint, {
        method: "POST",
        // A push service never redirects a live subscription; following one would let it aim the leader elsewhere.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: String(TTL_S),
          Urgency: "high",
          Authorization: authorization,
        },
        body,
      });
      // Nothing of the answer is read: free the connection.
      response.body?.cancel().catch(() => undefined);
      if (response.ok) return;
      status = response.status;
    } catch (err) {
      o.log.warn(`push: send failed host=${host} status=${failureOf(err)}`);
      return;
    }
    if (status === 404 || status === 410) await prune(target, host, status);
    else o.log.warn(`push: send failed host=${host} status=${status}`);
  };

  const launch = (alert: PushAlert, target: Target): void => {
    inFlight += 1;
    deliver(alert, target)
      .catch(() => undefined)
      .finally(() => {
        inFlight -= 1;
        waiting.shift()?.();
      });
  };

  return {
    send: (alert) => {
      try {
        let dropped = 0;
        for (const subscription of o.settings.current()?.subscriptions ?? []) {
          const endpoint = pushEndpoint(subscription.endpoint);
          if (endpoint === null) continue;
          const target = { subscription, endpoint };
          // Behind anything already waiting, so alerts reach a subscription in the order they were raised.
          if (inFlight < maxInFlight && waiting.length === 0) launch(alert, target);
          else if (waiting.length < maxQueued) waiting.push(() => launch(alert, target));
          else dropped += 1;
        }
        if (dropped > 0) o.log.warn(`push: queue full, dropped ${dropped} send(s)`);
      } catch {
        o.log.warn("push: could not queue an alert");
      }
    },
  };
}
