import {
  fromBase64Url,
  pushEndpoint,
  RequestFailure,
  schedulerErrorText,
  type PushSubscribeReply,
  type PushSubscribeRequest,
} from "@seance/shared";

/**
 * Subscribing this browser to the leader's Web Push. Logic only, with the browser's
 * Notification and PushManager behind `PushEnv`: pwa/test runs without a DOM lib, and
 * the real binding lives in push-browser.ts, which no test imports.
 */

/** What a subscription flow needs of the scheduler client: the key and the subscribe op. */
export interface PushClient {
  pushSettings(endpoint?: string): Promise<{ readonly publicKey: string; readonly subscribed: boolean } | null>;
  pushSubscribe(subscription: PushSubscribeRequest): Promise<PushSubscribeReply | null>;
}

export interface PushSubscriptionLike {
  readonly endpoint: string;
  readonly options: { readonly applicationServerKey: ArrayBuffer | null };
  toJSON(): { readonly endpoint?: string; readonly keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}

export interface PushEnv {
  permission(): PushPermission;
  requestPermission(): Promise<PushPermission>;
  /** The active service worker's push manager. */
  manager(): Promise<{
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: {
      readonly userVisibleOnly: boolean;
      readonly applicationServerKey: Uint8Array<ArrayBuffer>;
    }): Promise<PushSubscriptionLike>;
  }>;
}

export type PushPermission = "default" | "denied" | "granted";

export type PushOutcome =
  | { readonly kind: "enabled" }
  | { readonly kind: "denied" }
  | { readonly kind: "failed"; readonly message: string };

const NO_SETTINGS = "No scheduler leader has set up push yet. Try again once one is running.";
const UNSUPPORTED_SERVICE = "This browser's push service isn't supported.";
const LEADER_OLDER = "The scheduler leader is on an older version; try again after it updates.";
const UNREACHABLE = "Couldn't reach the scheduler leader.";
const NOT_SUBSCRIBED = "This browser couldn't subscribe to push.";
const UNREADABLE = "Couldn't read the scheduler's answer. Update seanced and the app to matching versions.";

/** What a refusal code reads as here; one without its own line falls back to the shared text. */
const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  invalid_request: LEADER_OLDER,
  subscriptions_full: "Too many browsers are subscribed already.",
  not_ready: "The scheduler leader is still starting. Try again in a moment.",
  conflict: "Another change landed first. Try again.",
  settings_unavailable: "The scheduler leader can't read its push settings, so push is off.",
};

function sameBytes(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (a === null) return false;
  const left = new Uint8Array(a);
  return left.length === b.length && left.every((byte, i) => byte === b[i]);
}

function refusalText(code: string): string {
  return REFUSAL_TEXT[code] ?? `Couldn't store the subscription: ${schedulerErrorText(code)}.`;
}

async function subscribeFlow(client: PushClient, env: PushEnv): Promise<PushOutcome> {
  const manager = await env.manager();
  const existing = await manager.getSubscription();
  const settings = await client.pushSettings(
    existing === null ? undefined : (pushEndpoint(existing.endpoint) ?? existing.endpoint),
  );
  if (settings === null) return { kind: "failed", message: NO_SETTINGS };

  const key = fromBase64Url(settings.publicKey);
  // A subscription made under another key (a regenerated record) can never be sent to with this one.
  const reusable = existing !== null && sameBytes(existing.options.applicationServerKey, key);
  if (existing !== null && !reusable) await existing.unsubscribe();
  if (reusable && settings.subscribed) return { kind: "enabled" };

  const subscription = await manager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = subscription.toJSON();
  const { p256dh, auth } = json.keys ?? {};
  // The leader's parser refuses a host off its allowlist and says only `invalid_request`: check first,
  // with the same function, so the refusal reads as the browser's and not as an old leader's.
  const endpoint = pushEndpoint(json.endpoint);
  if (endpoint === null) {
    await subscription.unsubscribe();
    return { kind: "failed", message: UNSUPPORTED_SERVICE };
  }
  if (p256dh === undefined || auth === undefined) {
    await subscription.unsubscribe();
    return { kind: "failed", message: NOT_SUBSCRIBED };
  }

  const reply = await client.pushSubscribe({ endpoint, keys: { p256dh, auth } });
  if (reply === null) return { kind: "failed", message: UNREADABLE };
  if ("ok" in reply) return { kind: "failed", message: refusalText(reply.code) };
  return { kind: "enabled" };
}

async function guarded(client: PushClient, env: PushEnv): Promise<PushOutcome> {
  try {
    return await subscribeFlow(client, env);
  } catch (err) {
    if (err instanceof RequestFailure) return { kind: "failed", message: UNREACHABLE };
    return { kind: "failed", message: NOT_SUBSCRIBED };
  }
}

/**
 * The button's flow: ask for permission, then subscribe and hand the subscription to the
 * leader. Called from the click handler itself, since iOS only grants permission to a gesture.
 */
export async function enablePush(client: PushClient, env: PushEnv): Promise<PushOutcome> {
  const permission = await env.requestPermission();
  if (permission === "denied") return { kind: "denied" };
  if (permission !== "granted") return { kind: "failed", message: "Notifications weren't allowed." };
  return guarded(client, env);
}

/**
 * The same flow without a prompt, for a browser that already granted permission: re-sends a
 * subscription the record lost (pruned on a 410, or a leader that started over). Null when
 * there is nothing to do.
 */
export async function resyncPush(client: PushClient, env: PushEnv): Promise<PushOutcome | null> {
  if (env.permission() !== "granted") return null;
  return guarded(client, env);
}
