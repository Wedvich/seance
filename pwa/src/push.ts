import {
  fromBase64Url,
  pushEndpoint,
  RequestFailure,
  schedulerErrorText,
  type PushSettingsReading,
  type PushSubscribeReply,
  type PushSubscribeRequest,
  type PushUnsubscribeReply,
  type PushUnsubscribeRequest,
  type StoreRefusal,
} from "@seance/shared";

/**
 * Subscribing this browser to the leader's Web Push. Logic only, with the browser's
 * Notification and PushManager behind `PushEnv`: pwa/test runs without a DOM lib, and
 * the real binding lives in push-browser.ts, which no test imports.
 *
 * Two phases, so the click has little to do: `inspectPush` reads everything slow when the
 * card mounts (the VAPID key, the service worker, this browser's own subscription), and
 * `enablePush` then runs only `requestPermission` and `subscribe` back to back. iOS grants
 * a subscription only close behind its gesture.
 *
 * `disablePush` is the way back: it unsubscribes the browser and asks the leader to free the
 * endpoint's slot, and marks the browser turned off so `resyncPush` leaves it alone.
 */

/** What a subscription flow needs of the scheduler client: the key and the subscribe and unsubscribe ops. */
export interface PushClient {
  pushSettings(endpoint?: string): Promise<PushSettingsReading | StoreRefusal | null>;
  pushSubscribe(subscription: PushSubscribeRequest): Promise<PushSubscribeReply | null>;
  pushUnsubscribe(request: PushUnsubscribeRequest): Promise<PushUnsubscribeReply | null>;
}

export interface PushSubscriptionLike {
  readonly endpoint: string;
  readonly options: { readonly applicationServerKey: ArrayBuffer | null };
  toJSON(): { readonly endpoint?: string; readonly keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: {
    readonly userVisibleOnly: boolean;
    readonly applicationServerKey: Uint8Array<ArrayBuffer>;
  }): Promise<PushSubscriptionLike>;
}

export interface PushEnv {
  permission(): PushPermission;
  requestPermission(): Promise<PushPermission>;
  /** The active service worker's push manager. Rejects with `PushTimeout` when none becomes ready. */
  manager(): Promise<PushManagerLike>;
  /**
   * The person turned push off in this browser. Permission stays granted after a turn-off (no
   * API takes it back), so without this the silent re-sync would subscribe again on the next load.
   */
  optedOut(): boolean;
  setOptedOut(off: boolean): void;
}

export type PushPermission = "default" | "denied" | "granted";

/** A failed flow. `retryable`: asking again later may succeed (nothing answered, or not yet set up); false is a refusal that will not change. */
export interface PushFailure {
  readonly kind: "failed";
  readonly message: string;
  readonly retryable: boolean;
}

export type PushOutcome = { readonly kind: "enabled" } | { readonly kind: "denied" } | PushFailure;

/**
 * A turn-off: this browser no longer gets pushes. `note` says the leader still holds its slot
 * (it could not be told, or predates the op), which goes once the push service reports it gone.
 */
export type PushOffOutcome = { readonly kind: "disabled"; readonly note: string | null } | PushFailure;

/** What the card learns before any click. */
export type PushInspection =
  | { readonly kind: "on" }
  | { readonly kind: "off"; readonly prepared: PushPrepared }
  | PushFailure;

/**
 * What `inspectPush` read: this browser's push manager and subscription, and the leader's key,
 * so the click can subscribe at once. Opaque to callers, who only hand it back to `enablePush`.
 */
export interface PushPrepared {
  readonly manager: PushManagerLike;
  readonly existing: PushSubscriptionLike | null;
  readonly key: Uint8Array<ArrayBuffer>;
  /** `existing` was made under `key`, so it can be reused. A subscription under another key can never be sent to with this one. */
  readonly reusable: boolean;
  /** The record already holds `existing`, under the current key: nothing is left to do. */
  readonly held: boolean;
}

/** A service worker that never became ready: `navigator.serviceWorker.ready` has no failure of its own. */
export class PushTimeout extends Error {
  constructor() {
    super("the service worker did not become ready");
    this.name = "PushTimeout";
  }
}

/** Rejects with `PushTimeout` after `ms`; the work itself is not cancelled, only no longer waited for. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PushTimeout()), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** How long to wait for the service worker before saying so. */
export const SERVICE_WORKER_READY_MS = 10_000;

const NO_SETTINGS = "No scheduler leader has set up push yet. Try again once one is running.";
const STORE_DECLINED = "The relay declined to read the push settings. Try again in a moment.";
const UNSUPPORTED_SERVICE = "This browser's push service isn't supported.";
const LEADER_OLDER = "The scheduler leader is on an older version; try again after it updates.";
const RELAY_UNREACHABLE = "Couldn't reach the relay.";
const LEADER_UNREACHABLE = "Couldn't reach the scheduler leader.";
const NOT_SUBSCRIBED = "This browser couldn't subscribe to push.";
const NOT_ALLOWED = "Notifications weren't allowed.";
const PERMISSION_FAILED = "The browser couldn't ask for notification permission.";
const WORKER_NOT_READY = "Séance's service worker isn't ready. Reload the app and try again.";
const UNREADABLE = "Couldn't read the scheduler's answer. Update seanced and the app to matching versions.";
const NOT_UNSUBSCRIBED = "This browser couldn't turn push off. Try again.";
const SLOT_KEPT_OLDER =
  "The scheduler leader is on an older version, so it keeps this browser's slot until the push service reports it gone.";
const SLOT_UNREADABLE =
  "Couldn't read the scheduler leader's answer, so it may keep this browser's slot until the push service reports it gone. Update seanced and the app to matching versions.";
const SLOT_KEPT =
  "Couldn't tell the scheduler leader, so it keeps this browser's slot until the push service reports it gone.";

/** What a refusal code reads as here, and whether it can change; one without its own line falls back to the shared text. */
const REFUSALS: Readonly<Record<string, { readonly text: string; readonly retryable: boolean }>> = {
  invalid_request: { text: LEADER_OLDER, retryable: false },
  subscriptions_full: { text: "Too many browsers are subscribed already.", retryable: false },
  not_ready: { text: "The scheduler leader is still starting. Try again in a moment.", retryable: true },
  conflict: { text: "Another change landed first. Try again.", retryable: true },
  settings_unavailable: {
    text: "The scheduler leader can't read its push settings, so push is off.",
    retryable: false,
  },
};

function failure(message: string, retryable = false): PushFailure {
  return { kind: "failed", message, retryable };
}

function refusal(code: string): PushFailure {
  const known = REFUSALS[code];
  return known === undefined
    ? failure(`Couldn't store the subscription: ${schedulerErrorText(code)}.`)
    : failure(known.text, known.retryable);
}

function sameBytes(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (a === null) return false;
  const left = new Uint8Array(a);
  return left.length === b.length && left.every((byte, i) => byte === b[i]);
}

function failureOf(err: unknown): PushFailure {
  if (err instanceof PushTimeout) return failure(WORKER_NOT_READY);
  if (err instanceof RequestFailure) {
    return failure(err.target === "relay" ? RELAY_UNREACHABLE : LEADER_UNREACHABLE, true);
  }
  return failure(NOT_SUBSCRIBED);
}

/** Everything the click would otherwise wait for. A failure here is the card's line, and a reason the button still tries. */
async function prepare(client: PushClient, env: PushEnv): Promise<PushPrepared | PushFailure> {
  const manager = await env.manager();
  const existing = await manager.getSubscription();
  const settings = await client.pushSettings(
    existing === null ? undefined : (pushEndpoint(existing.endpoint) ?? existing.endpoint),
  );
  if (settings === null) return failure(NO_SETTINGS, true);
  if ("ok" in settings) return failure(STORE_DECLINED, true);
  const key = fromBase64Url(settings.publicKey);
  const reusable = existing !== null && sameBytes(existing.options.applicationServerKey, key);
  return { manager, existing, key, reusable, held: reusable && settings.subscribed };
}

async function subscribeWith(client: PushClient, prepared: PushPrepared): Promise<PushOutcome> {
  if (prepared.held) return { kind: "enabled" };
  if (prepared.existing !== null && !prepared.reusable) await prepared.existing.unsubscribe();
  const subscription = await prepared.manager.subscribe({ userVisibleOnly: true, applicationServerKey: prepared.key });
  const json = subscription.toJSON();
  const { p256dh, auth } = json.keys ?? {};
  // The leader's parser refuses a host off its allowlist and says only `invalid_request`: check first,
  // with the same function, so the refusal reads as the browser's and not as an old leader's.
  const endpoint = pushEndpoint(json.endpoint);
  if (endpoint === null) {
    await subscription.unsubscribe();
    return failure(UNSUPPORTED_SERVICE);
  }
  if (p256dh === undefined || auth === undefined) {
    await subscription.unsubscribe();
    return failure(NOT_SUBSCRIBED);
  }

  const reply = await client.pushSubscribe({ endpoint, keys: { p256dh, auth } });
  if (reply === null) return failure(UNREADABLE);
  if ("ok" in reply) return refusal(reply.code);
  return { kind: "enabled" };
}

async function guarded<T>(work: () => Promise<T>): Promise<T | PushFailure> {
  try {
    return await work();
  } catch (err) {
    return failureOf(err);
  }
}

/**
 * What this browser's push state really is, read without a prompt: `on` only when it holds
 * a subscription under the leader's current key that the record holds too, never because
 * permission was granted. `off` hands back what the click needs. Never rejects.
 */
export async function inspectPush(client: PushClient, env: PushEnv): Promise<PushInspection> {
  try {
    const prepared = await prepare(client, env);
    if ("kind" in prepared) return prepared;
    if (prepared.held && env.permission() === "granted") {
      // A browser proven on is not turned off: a stale flag (a turn-off that did not finish) must not keep the re-sync away.
      env.setOptedOut(false);
      return { kind: "on" };
    }
    return { kind: "off", prepared };
  } catch (err) {
    return failureOf(err);
  }
}

/**
 * The button's flow: ask for permission, then subscribe and hand the subscription to the
 * leader. Called from the click handler itself, and with `prepared` from `inspectPush` the
 * only awaits before `subscribe` are the permission prompt and, for a subscription under
 * another key, its unsubscribe. Without it (the card could not inspect) the flow reads
 * what it needs after the prompt, which iOS may no longer honour. Never rejects.
 */
export async function enablePush(
  client: PushClient,
  env: PushEnv,
  prepared: PushPrepared | null = null,
): Promise<PushOutcome> {
  let permission: PushPermission;
  try {
    permission = await env.requestPermission();
  } catch {
    return failure(PERMISSION_FAILED);
  }
  if (permission === "denied") return { kind: "denied" };
  if (permission !== "granted") return failure(NOT_ALLOWED);
  // A person who turns it on again wants the re-sync back.
  env.setOptedOut(false);
  return guarded(async () => {
    const ready = prepared ?? (await prepare(client, env));
    return "kind" in ready ? ready : subscribeWith(client, ready);
  });
}

/**
 * The same flow without a prompt, for a browser that already granted permission: re-sends a
 * subscription the record lost (pruned on a 410, or a leader that started over). Null when
 * there is nothing to do, and for a browser the person turned off.
 */
export async function resyncPush(client: PushClient, env: PushEnv): Promise<PushOutcome | null> {
  if (env.permission() !== "granted" || env.optedOut()) return null;
  return guarded(async () => {
    const prepared = await prepare(client, env);
    if ("kind" in prepared) return prepared;
    // A Turn off can land while `prepare` waits (a not_ready retry, a slow service worker): read the flag again.
    if (env.optedOut()) return null;
    return subscribeWith(client, prepared);
  });
}

/** The leader's answer to `push-unsubscribe` as the card's note: null when it dropped the endpoint. */
async function freeSlot(client: PushClient, endpoint: string): Promise<string | null> {
  try {
    const reply = await client.pushUnsubscribe({ endpoint });
    if (reply === null) return SLOT_UNREADABLE;
    // An echo of another endpoint is not an answer about this one.
    if (!("ok" in reply)) return reply.endpoint === endpoint ? null : SLOT_UNREADABLE;
    // The endpoint passed `pushEndpoint` here, so `invalid_request` can only be a leader that predates the op.
    return reply.code === "invalid_request" ? SLOT_KEPT_OLDER : SLOT_KEPT;
  } catch {
    return SLOT_KEPT;
  }
}

/**
 * The card's Turn off: unsubscribe this browser, then ask the leader to drop its endpoint.
 * The local unsubscribe goes first because it is what stops pushes here and needs no leader;
 * the op only frees the slot, and an endpoint it could not remove is pruned at the push
 * service's next 404/410. Marks the browser turned off before anything can fail, so a re-sync in
 * flight or on the next load does not subscribe it again, and puts the mark back when the
 * turn-off failed with nothing changed. Never rejects.
 */
export async function disablePush(client: PushClient, env: PushEnv): Promise<PushOffOutcome> {
  const wasOptedOut = env.optedOut();
  env.setOptedOut(true);
  // The browser still pushes, so the person has not opted out of the re-sync.
  const unchanged = (message: string): PushFailure => {
    env.setOptedOut(wasOptedOut);
    return failure(message, true);
  };
  let existing: PushSubscriptionLike | null;
  try {
    existing = await (await env.manager()).getSubscription();
  } catch (err) {
    return unchanged(err instanceof PushTimeout ? WORKER_NOT_READY : NOT_UNSUBSCRIBED);
  }
  if (existing === null) return { kind: "disabled", note: null };
  const endpoint = pushEndpoint(existing.endpoint);
  let unsubscribed: boolean;
  try {
    unsubscribed = await existing.unsubscribe();
  } catch {
    unsubscribed = false;
  }
  // Off the allowlist, no record can hold it: there is no slot to free.
  const note = endpoint === null ? null : await freeSlot(client, endpoint);
  // A browser that kept its subscription is still off once the leader dropped the endpoint: nothing sends to it.
  if (unsubscribed || (endpoint !== null && note === null)) return { kind: "disabled", note };
  return unchanged(NOT_UNSUBSCRIBED);
}

/** What `watchResync` needs of the app: whether a leader is verified now, and a nudge on every change. */
export interface ResyncSource {
  readonly ready: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface ResyncTuning {
  /** Attempts in all, the first included. */
  readonly maxAttempts?: number;
  /** The wait after a retryable failure, doubled per failure. */
  readonly backoffMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => () => void;
}

const RESYNC_ATTEMPTS = 5;
const RESYNC_BACKOFF_MS = 5_000;

/**
 * Runs `run` (the silent re-sync) when a leader is verified, and again after a retryable
 * failure: on each later not-ready-to-ready transition and after a doubling backoff, up to
 * `maxAttempts`. A terminal answer, a success or nothing to do ends it. A first attempt that
 * met a leader still starting (`not_ready`) must not be the only one, or the subscription the
 * record lost stays lost until the next page load. Returns a stop.
 */
export function watchResync(
  source: ResyncSource,
  run: () => Promise<PushOutcome | null>,
  tuning: ResyncTuning = {},
): () => void {
  const maxAttempts = tuning.maxAttempts ?? RESYNC_ATTEMPTS;
  const backoffMs = tuning.backoffMs ?? RESYNC_BACKOFF_MS;
  const setTimer =
    tuning.setTimer ??
    ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  let attempts = 0;
  let running = false;
  let finished = false;
  let wasReady = false;
  let cancelTimer: (() => void) | null = null;

  const finish = (): void => {
    finished = true;
    cancelTimer?.();
    cancelTimer = null;
    unsubscribe();
  };

  const attempt = (): void => {
    if (finished || running) return;
    cancelTimer?.();
    cancelTimer = null;
    running = true;
    attempts += 1;
    void run().then(
      (outcome) => {
        running = false;
        if (outcome?.kind !== "failed" || !outcome.retryable || attempts >= maxAttempts) {
          finish();
          return;
        }
        // Not while a leader is not verified: the next transition retries then, and counts as this attempt's successor.
        cancelTimer = setTimer(
          () => {
            cancelTimer = null;
            if (source.ready()) attempt();
          },
          backoffMs * 2 ** (attempts - 1),
        );
      },
      () => {
        running = false;
        finish();
      },
    );
  };

  const onChange = (): void => {
    const ready = source.ready();
    const rose = ready && !wasReady;
    wasReady = ready;
    if (rose) attempt();
  };

  const unsubscribe = source.subscribe(onChange);
  onChange();
  return finish;
}
