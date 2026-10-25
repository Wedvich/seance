import { describe, expect, test } from "bun:test";
import {
  fromBase64Url,
  RequestFailure,
  type PushSettingsReading,
  type PushSubscribeReply,
  type PushSubscribeRequest,
  type PushUnsubscribeReply,
  type StoreRefusal,
} from "@seance/shared";
import {
  disablePush,
  enablePush,
  inspectPush,
  PushTimeout,
  resyncPush,
  watchResync,
  withTimeout,
  type PushClient,
  type PushEnv,
  type PushInspection,
  type PushOffOutcome,
  type PushOutcome,
  type PushPermission,
  type PushSubscriptionLike,
} from "../src/push.ts";

const PUBLIC_KEY = Buffer.alloc(65, 4).toString("base64url");
const OTHER_KEY = Buffer.alloc(65, 5).toString("base64url");
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
const KEYS = { p256dh: Buffer.alloc(65, 1).toString("base64url"), auth: Buffer.alloc(16, 2).toString("base64url") };

interface Calls {
  readonly subscribed: Uint8Array[];
  readonly unsubscribed: string[];
  readonly settings: (string | undefined)[];
  readonly sent: PushSubscribeRequest[];
  readonly unsubscribeSent: string[];
  /** Every `setOptedOut` call, in order. */
  readonly optedOut: boolean[];
  /** Every step in the order it ran, so a test can say what stands between the click and `subscribe`. */
  readonly order: string[];
}

function subscription(
  endpoint: string,
  key: string,
  calls: Calls,
  local: boolean | Error = true,
): PushSubscriptionLike {
  return {
    endpoint,
    options: { applicationServerKey: fromBase64Url(key).buffer },
    // A browser's own JSON carries `expirationTime`, which the leader's parser would refuse.
    toJSON: () => ({ endpoint, keys: KEYS, expirationTime: null }),
    unsubscribe: () => {
      calls.order.push("unsubscribe");
      calls.unsubscribed.push(endpoint);
      return local instanceof Error ? Promise.reject(local) : Promise.resolve(local);
    },
  };
}

function harness(opts: {
  permission?: PushPermission;
  requested?: PushPermission | Error;
  existing?: { endpoint: string; key: string };
  made?: string;
  settings?: PushSettingsReading | StoreRefusal | null | Error;
  reply?: PushSubscribeReply | null | Error;
  manager?: Error;
  /** What the existing subscription's `unsubscribe()` answers. */
  local?: boolean | Error;
  unsubscribeReply?: PushUnsubscribeReply | null | Error;
  optedOut?: boolean;
}): { client: PushClient; env: PushEnv; calls: Calls } {
  const calls: Calls = {
    subscribed: [],
    unsubscribed: [],
    settings: [],
    sent: [],
    unsubscribeSent: [],
    optedOut: [],
    order: [],
  };
  const existing =
    opts.existing === undefined
      ? null
      : subscription(opts.existing.endpoint, opts.existing.key, calls, opts.local ?? true);
  let optedOut = opts.optedOut ?? false;
  const settings = opts.settings === undefined ? { publicKey: PUBLIC_KEY, subscribed: false } : opts.settings;
  const reply = opts.reply === undefined ? { endpoint: ENDPOINT } : opts.reply;
  const client: PushClient = {
    pushSettings: (endpoint) => {
      calls.order.push("settings");
      calls.settings.push(endpoint);
      return settings instanceof Error ? Promise.reject(settings) : Promise.resolve(settings);
    },
    pushSubscribe: (sub) => {
      calls.order.push("send");
      calls.sent.push(sub);
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
    pushUnsubscribe: ({ endpoint }) => {
      calls.order.push("send-unsubscribe");
      calls.unsubscribeSent.push(endpoint);
      const answer = opts.unsubscribeReply === undefined ? { endpoint } : opts.unsubscribeReply;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  const requested = opts.requested ?? "granted";
  const env: PushEnv = {
    permission: () => opts.permission ?? "granted",
    optedOut: () => optedOut,
    setOptedOut: (off) => {
      calls.optedOut.push(off);
      optedOut = off;
    },
    requestPermission: () => {
      calls.order.push("permission");
      return requested instanceof Error ? Promise.reject(requested) : Promise.resolve(requested);
    },
    manager: () => {
      calls.order.push("manager");
      if (opts.manager !== undefined) return Promise.reject(opts.manager);
      return Promise.resolve({
        getSubscription: () => {
          calls.order.push("get");
          return Promise.resolve(existing);
        },
        subscribe: (options) => {
          calls.order.push("subscribe");
          calls.subscribed.push(options.applicationServerKey);
          return Promise.resolve(subscription(opts.made ?? ENDPOINT, PUBLIC_KEY, calls));
        },
      });
    },
  };
  return { client, env, calls };
}

/** The messages a failed outcome carries, for the cases that only differ in their line. */
function messageOf(outcome: PushOutcome | PushOffOutcome | PushInspection | null): string {
  return outcome?.kind === "failed" ? outcome.message : String(outcome?.kind);
}

describe("enablePush", () => {
  test("subscribes under the leader's key and sends the endpoint and keys, without the browser's expirationTime", async () => {
    const { client, env, calls } = harness({});
    expect(await enablePush(client, env)).toEqual({ kind: "enabled" });
    expect(calls.subscribed).toEqual([fromBase64Url(PUBLIC_KEY)]);
    expect(calls.sent).toEqual([{ endpoint: ENDPOINT, keys: KEYS }]);
  });

  test("with what inspectPush read ahead, the click does nothing between the prompt and subscribe", async () => {
    const { client, env, calls } = harness({});
    const inspection = await inspectPush(client, env);
    if (inspection.kind !== "off") throw new Error(`expected off, got ${inspection.kind}`);
    calls.order.length = 0;
    expect(await enablePush(client, env, inspection.prepared)).toEqual({ kind: "enabled" });
    // No settings read, no service worker, no subscription lookup after the click: only the prompt, then subscribe.
    expect(calls.order).toEqual(["permission", "subscribe", "send"]);
    expect(calls.sent).toEqual([{ endpoint: ENDPOINT, keys: KEYS }]);
  });

  test("a refused permission stops before the leader is asked", async () => {
    const denied = harness({ requested: "denied" });
    expect(await enablePush(denied.client, denied.env)).toEqual({ kind: "denied" });
    const dismissed = harness({ requested: "default" });
    expect(await enablePush(dismissed.client, dismissed.env)).toMatchObject({ kind: "failed" });
    for (const { calls } of [denied, dismissed]) {
      expect(calls.settings).toEqual([]);
      expect(calls.subscribed).toEqual([]);
      expect(calls.sent).toEqual([]);
    }
  });

  test("a permission request that rejects is a failed outcome, not a rejection", async () => {
    const { client, env, calls } = harness({ requested: new Error("no dialog") });
    expect(await enablePush(client, env)).toMatchObject({
      kind: "failed",
      message: expect.stringContaining("permission"),
    });
    expect(calls.subscribed).toEqual([]);
  });

  test("a service worker that never became ready reads as that, and an unexpected throw as a failed subscribe", async () => {
    const stuck = harness({ manager: new PushTimeout() });
    expect(messageOf(await enablePush(stuck.client, stuck.env))).toContain("service worker");
    const broken = harness({ manager: new Error("boom") });
    expect(messageOf(await enablePush(broken.client, broken.env))).toContain("couldn't subscribe");
  });

  test("no settings record reads as no leader having set up push, and subscribes nothing", async () => {
    const { client, env, calls } = harness({ settings: null });
    expect(await enablePush(client, env)).toMatchObject({
      kind: "failed",
      message: expect.stringContaining("No scheduler leader"),
      retryable: true,
    });
    expect(calls.subscribed).toEqual([]);
    expect(calls.sent).toEqual([]);
  });

  test("a store refusal and an unreachable relay are not read as no leader having set up push", async () => {
    const refused = harness({ settings: { ok: false, code: "rate_limited" } });
    const declined = await enablePush(refused.client, refused.env);
    expect(messageOf(declined)).toContain("relay declined");
    expect(messageOf(declined)).not.toContain("No scheduler leader");
    expect(declined).toMatchObject({ retryable: true });

    const down = harness({ settings: new RequestFailure("timeout", "no answer", "relay") });
    const unreachable = await enablePush(down.client, down.env);
    expect(messageOf(unreachable)).toBe("Couldn't reach the relay.");
    expect(unreachable).toMatchObject({ retryable: true });
    for (const { calls } of [refused, down]) expect(calls.subscribed).toEqual([]);
  });

  test("a subscription made under another key is dropped before subscribing under the leader's", async () => {
    const { client, env, calls } = harness({
      existing: { endpoint: "https://fcm.googleapis.com/fcm/send/old", key: OTHER_KEY },
    });
    expect(await enablePush(client, env)).toEqual({ kind: "enabled" });
    expect(calls.unsubscribed).toEqual(["https://fcm.googleapis.com/fcm/send/old"]);
    expect(calls.subscribed).toHaveLength(1);
    expect(calls.sent).toHaveLength(1);
  });

  test("a subscription under the current key that the record holds needs nothing more", async () => {
    const { client, env, calls } = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: true },
    });
    expect(await enablePush(client, env)).toEqual({ kind: "enabled" });
    expect(calls.settings).toEqual([ENDPOINT]);
    expect(calls.unsubscribed).toEqual([]);
    expect(calls.subscribed).toEqual([]);
    expect(calls.sent).toEqual([]);
  });

  test("a push service off the allowlist is refused here: the leader is never asked and the subscription is dropped", async () => {
    const made = "https://push.example.com/send/abc";
    const { client, env, calls } = harness({ made });
    expect(await enablePush(client, env)).toMatchObject({
      kind: "failed",
      message: "This browser's push service isn't supported.",
    });
    expect(calls.sent).toEqual([]);
    expect(calls.unsubscribed).toEqual([made]);
  });

  test("the leader's refusals and a failed request each read as their own line", async () => {
    const refusal = (code: string): PushSubscribeReply => ({ ok: false, code, message: "raw" });
    const outcomeOf = async (reply: PushSubscribeReply | null | Error): Promise<PushOutcome> => {
      const { client, env } = harness({ reply });
      return enablePush(client, env);
    };
    // After the pre-check passed, `invalid_request` can only be a leader that predates the op.
    expect(messageOf(await outcomeOf(refusal("invalid_request")))).toContain("older version");
    expect(messageOf(await outcomeOf(refusal("subscriptions_full")))).toContain("Too many");
    expect(messageOf(await outcomeOf(refusal("settings_unavailable")))).toContain("push is off");
    expect(messageOf(await outcomeOf(refusal("made_up_code")))).toContain("made_up_code");
    expect(messageOf(await outcomeOf(null))).toContain("Couldn't read");
    expect(messageOf(await outcomeOf(new RequestFailure("timeout", "no answer")))).toContain("scheduler leader");
    expect(messageOf(await outcomeOf(new Error("push service down")))).toContain("couldn't subscribe");
    // Only what may change is worth asking again: a starting leader, not an old one or a full record.
    expect(await outcomeOf(refusal("not_ready"))).toMatchObject({ retryable: true });
    expect(await outcomeOf(new RequestFailure("timeout", "no answer"))).toMatchObject({ retryable: true });
    expect(await outcomeOf(refusal("invalid_request"))).toMatchObject({ retryable: false });
    expect(await outcomeOf(refusal("subscriptions_full"))).toMatchObject({ retryable: false });
  });
});

describe("inspectPush", () => {
  test("is on only for a subscription held under the current key and by the record", async () => {
    const { client, env } = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: true },
    });
    expect(await inspectPush(client, env)).toEqual({ kind: "on" });
  });

  test("granted permission alone is not on: no subscription, one the record lost, or one under another key", async () => {
    const none = harness({ permission: "granted" });
    const lost = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: false },
    });
    const rekeyed = harness({
      existing: { endpoint: ENDPOINT, key: OTHER_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: true },
    });
    for (const { client, env } of [none, lost, rekeyed]) {
      // oxlint-disable-next-line no-await-in-loop -- one harness per case
      expect(await inspectPush(client, env)).toMatchObject({ kind: "off" });
    }
  });

  test("a held subscription without the permission is not on either", async () => {
    const { client, env } = harness({
      permission: "default",
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: true },
    });
    expect(await inspectPush(client, env)).toMatchObject({ kind: "off" });
  });

  test("says why it cannot tell, and never rejects", async () => {
    const cases: readonly [Parameters<typeof harness>[0], string][] = [
      [{ settings: null }, "No scheduler leader"],
      [{ settings: { ok: false, code: "rate_limited" } }, "relay declined"],
      [{ settings: new RequestFailure("disconnected", "no socket", "relay") }, "Couldn't reach the relay"],
      [{ manager: new PushTimeout() }, "service worker"],
    ];
    for (const [opts, text] of cases) {
      const { client, env } = harness(opts);
      // oxlint-disable-next-line no-await-in-loop -- one harness per case
      const inspection = await inspectPush(client, env);
      expect(inspection).toMatchObject({ kind: "failed" });
      expect(messageOf(inspection)).toContain(text);
    }
  });
});

describe("withTimeout", () => {
  test("rejects with PushTimeout when the work never settles, and passes a result through", async () => {
    await expect(withTimeout(Promise.withResolvers<never>().promise, 20)).rejects.toBeInstanceOf(PushTimeout);
    expect(await withTimeout(Promise.resolve(7), 1_000)).toBe(7);
    await expect(withTimeout(Promise.reject(new Error("own")), 1_000)).rejects.toThrow("own");
  });
});

describe("resyncPush", () => {
  test("does nothing without a permission already granted", async () => {
    for (const permission of ["default", "denied"] as const) {
      const { client, env, calls } = harness({ permission });
      // oxlint-disable-next-line no-await-in-loop -- one harness per case
      expect(await resyncPush(client, env)).toBeNull();
      expect(calls.settings).toEqual([]);
    }
  });

  test("puts a subscription the record lost back, without a prompt", async () => {
    const { client, env, calls } = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: false },
    });
    expect(await resyncPush(client, env)).toEqual({ kind: "enabled" });
    expect(calls.sent).toEqual([{ endpoint: ENDPOINT, keys: KEYS }]);
    expect(calls.order).not.toContain("permission");
  });

  test("leaves a browser the person turned off alone, though permission is still granted", async () => {
    const { client, env, calls } = harness({ optedOut: true });
    expect(await resyncPush(client, env)).toBeNull();
    expect(calls.order).toEqual([]);
  });
});

describe("disablePush", () => {
  test("unsubscribes this browser first, then asks the leader to drop the normalized endpoint", async () => {
    const raw = "https://FCM.googleapis.com/fcm/send/abc";
    const { client, env, calls } = harness({ existing: { endpoint: raw, key: PUBLIC_KEY } });
    expect(await disablePush(client, env)).toEqual({ kind: "disabled", note: null });
    expect(calls.order).toEqual(["manager", "get", "unsubscribe", "send-unsubscribe"]);
    expect(calls.unsubscribeSent).toEqual([ENDPOINT]);
    expect(calls.optedOut).toEqual([true]);
    // Turned off, the re-sync after a reload subscribes nothing.
    expect(await resyncPush(client, env)).toBeNull();
    expect(calls.subscribed).toEqual([]);
  });

  test("a leader that predates the op, or one that cannot be told, leaves the browser off and says the slot stays", async () => {
    const offWith = async (unsubscribeReply: PushUnsubscribeReply | null | Error) => {
      const { client, env, calls } = harness({ existing: { endpoint: ENDPOINT, key: PUBLIC_KEY }, unsubscribeReply });
      const outcome = await disablePush(client, env);
      expect(calls.unsubscribed).toEqual([ENDPOINT]);
      expect(calls.optedOut).toEqual([true]);
      if (outcome.kind !== "disabled") throw new Error(`expected disabled, got ${outcome.kind}`);
      return outcome.note ?? "";
    };
    const older = await offWith({ ok: false, code: "invalid_request", message: "raw" });
    expect(older).toContain("older version");
    expect(older).toContain("until the push service reports it gone");
    for (const reply of [
      new RequestFailure("timeout", "no answer"),
      { ok: false, code: "not_ready", message: "raw" },
      { ok: false, code: "settings_unavailable", message: "raw" },
      null,
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one harness per case
      const note = await offWith(reply);
      expect(note).toContain("Couldn't tell the scheduler leader");
      expect(note).not.toContain("older version");
    }
  });

  test("with no subscription, or one off the allowlist, there is nothing for the leader to free", async () => {
    const none = harness({});
    expect(await disablePush(none.client, none.env)).toEqual({ kind: "disabled", note: null });
    const foreign = harness({ existing: { endpoint: "https://push.example.com/x", key: PUBLIC_KEY } });
    expect(await disablePush(foreign.client, foreign.env)).toEqual({ kind: "disabled", note: null });
    expect(foreign.calls.unsubscribed).toEqual(["https://push.example.com/x"]);
    for (const { calls } of [none, foreign]) {
      expect(calls.unsubscribeSent).toEqual([]);
      expect(calls.optedOut).toEqual([true]);
    }
  });

  test("a browser that cannot unsubscribe is still off once the leader dropped it, and a failure only when neither worked", async () => {
    const leaderDropped = harness({ existing: { endpoint: ENDPOINT, key: PUBLIC_KEY }, local: false });
    expect(await disablePush(leaderDropped.client, leaderDropped.env)).toEqual({ kind: "disabled", note: null });

    const neither = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      local: new Error("push service down"),
      unsubscribeReply: new RequestFailure("timeout", "no answer"),
    });
    expect(await disablePush(neither.client, neither.env)).toEqual({
      kind: "failed",
      message: "This browser couldn't turn push off. Try again.",
      retryable: true,
    });
    // Still marked off: a reload must not subscribe it again while it is half turned off.
    expect(neither.calls.optedOut).toEqual([true]);

    const stuck = harness({ manager: new PushTimeout() });
    expect(messageOf(await disablePush(stuck.client, stuck.env))).toContain("service worker");
  });

  test("turning it on again clears the turn-off, so the re-sync is back", async () => {
    const { client, env, calls } = harness({ optedOut: true });
    expect(await enablePush(client, env)).toEqual({ kind: "enabled" });
    expect(calls.optedOut).toEqual([false]);
    expect(env.optedOut()).toBe(false);
    // A dismissed prompt is not turning it on.
    const dismissed = harness({ optedOut: true, requested: "default" });
    await enablePush(dismissed.client, dismissed.env);
    expect(dismissed.env.optedOut()).toBe(true);
  });
});

describe("watchResync", () => {
  /** A leader that comes and goes, and a clock the test fires by hand. */
  function rig(outcomes: readonly (PushOutcome | null)[], initiallyReady = true) {
    let ready = initiallyReady;
    const listeners = new Set<() => void>();
    const timers: { run: () => void; ms: number; live: boolean }[] = [];
    let runs = 0;
    const stop = watchResync(
      {
        ready: () => ready,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      () => {
        const outcome = outcomes[Math.min(runs, outcomes.length - 1)] ?? null;
        runs += 1;
        return Promise.resolve(outcome);
      },
      {
        maxAttempts: 4,
        backoffMs: 100,
        setTimer: (run, ms) => {
          const timer = { run, ms, live: true };
          timers.push(timer);
          return () => {
            timer.live = false;
          };
        },
      },
    );
    return {
      runs: () => runs,
      listeners: () => listeners.size,
      stop,
      timers,
      setReady: (next: boolean) => {
        ready = next;
        for (const listener of [...listeners]) listener();
      },
      /** Fires every timer still armed, as the clock reaching them. */
      fire: () => {
        for (const timer of [...timers]) {
          if (!timer.live) continue;
          timer.live = false;
          timer.run();
        }
      },
    };
  }
  const settle = (): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  const retryable: PushOutcome = { kind: "failed", message: "not ready", retryable: true };
  const terminal: PushOutcome = { kind: "failed", message: "refused", retryable: false };
  const denied: PushOutcome = { kind: "denied" };

  test("a first answer of not_ready is not the last: a later ready transition tries again, and a success ends it", async () => {
    const watch = rig([retryable, { kind: "enabled" }]);
    await settle();
    expect(watch.runs()).toBe(1);
    // The leader goes away and returns: that transition is the next chance, ahead of any backoff.
    watch.setReady(false);
    watch.setReady(true);
    await settle();
    expect(watch.runs()).toBe(2);
    expect(watch.listeners()).toBe(0);
    watch.setReady(false);
    watch.setReady(true);
    await settle();
    expect(watch.runs()).toBe(2);
  });

  test("a retryable failure is retried after a doubling backoff while a leader is verified, up to the bound", async () => {
    const watch = rig([retryable]);
    await settle();
    expect(watch.timers.map((timer) => timer.ms)).toEqual([100]);
    watch.fire();
    await settle();
    expect(watch.runs()).toBe(2);
    expect(watch.timers.map((timer) => timer.ms)).toEqual([100, 200]);
    watch.fire();
    await settle();
    watch.fire();
    await settle();
    // Four attempts in all, then it gives up for this page load.
    expect(watch.runs()).toBe(4);
    expect(watch.listeners()).toBe(0);
    watch.fire();
    await settle();
    expect(watch.runs()).toBe(4);
  });

  test("a backoff that fires while no leader is verified waits for the next transition", async () => {
    const watch = rig([retryable, { kind: "enabled" }]);
    await settle();
    watch.setReady(false);
    watch.fire();
    await settle();
    expect(watch.runs()).toBe(1);
    watch.setReady(true);
    await settle();
    expect(watch.runs()).toBe(2);
  });

  test("a terminal answer, a denial and nothing to do each end it at once", async () => {
    for (const outcome of [terminal, denied, null]) {
      const watch = rig([outcome]);
      // oxlint-disable-next-line no-await-in-loop -- one rig per case
      await settle();
      expect(watch.runs()).toBe(1);
      expect(watch.listeners()).toBe(0);
      expect(watch.timers).toEqual([]);
    }
  });

  test("starts when a leader becomes verified, and stop cancels a pending retry", async () => {
    const watch = rig([retryable, { kind: "enabled" }], false);
    await settle();
    expect(watch.runs()).toBe(0);
    watch.setReady(true);
    await settle();
    expect(watch.runs()).toBe(1);
    watch.stop();
    watch.fire();
    await settle();
    expect(watch.runs()).toBe(1);
    expect(watch.listeners()).toBe(0);
  });
});
