import { describe, expect, test } from "bun:test";
import {
  fromBase64Url,
  parsePushSubscribeRequest,
  RequestFailure,
  schedulerErrorText,
  type PushDevice,
  type PushSettingsReading,
  type PushSubscribeReply,
  type PushSubscribeRequest,
  type PushUnsubscribeReply,
  type StoreRefusal,
} from "@seance/shared";
import {
  deviceLabel,
  deviceRows,
  disablePush,
  enablePush,
  inspectPush,
  PushTimeout,
  removeDevice,
  resyncPush,
  watchResync,
  withTimeout,
  type PushClient,
  type PushEnv,
  type PushFailure,
  type PushInspection,
  type PushOffOutcome,
  type PushOutcome,
  type PushPermission,
  type PushRemoveOutcome,
  type PushSubscriptionLike,
} from "../src/push.ts";

const PUBLIC_KEY = Buffer.alloc(65, 4).toString("base64url");
const OTHER_KEY = Buffer.alloc(65, 5).toString("base64url");
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
const SELF: PushDevice = { endpoint: ENDPOINT, vendor: "Chrome/Android", self: true };
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
  onGone: () => void = () => {},
): PushSubscriptionLike {
  return {
    endpoint,
    options: { applicationServerKey: fromBase64Url(key).buffer },
    // A browser's own JSON carries `expirationTime`, which the leader's parser would refuse.
    toJSON: () => ({ endpoint, keys: KEYS, expirationTime: null }),
    unsubscribe: () => {
      calls.order.push("unsubscribe");
      calls.unsubscribed.push(endpoint);
      if (local === true) onGone();
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
  /** `getSubscription()` rejects with this. */
  getFails?: Error;
  /** What the existing subscription's `unsubscribe()` answers. */
  local?: boolean | Error;
  unsubscribeReply?: PushUnsubscribeReply | null | Error;
  /** One `push-unsubscribe` answer per call, the last repeating; wins over `unsubscribeReply`. */
  unsubscribeReplies?: readonly (PushUnsubscribeReply | null | Error)[];
  /** `push-unsubscribe` answers only once this settles. */
  unsubscribeGate?: Promise<void>;
  optedOut?: boolean;
  userAgent?: string;
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
  // What the browser holds now: an unsubscribe that works empties it, a subscribe fills it.
  let held: PushSubscriptionLike | null =
    opts.existing === undefined
      ? null
      : subscription(opts.existing.endpoint, opts.existing.key, calls, opts.local ?? true, () => {
          held = null;
        });
  let optedOut = opts.optedOut ?? false;
  const settings =
    opts.settings === undefined ? { publicKey: PUBLIC_KEY, subscribed: false, devices: [] } : opts.settings;
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
    pushUnsubscribe: async ({ endpoint }) => {
      calls.order.push("send-unsubscribe");
      calls.unsubscribeSent.push(endpoint);
      const replies = opts.unsubscribeReplies;
      const answer =
        replies === undefined
          ? opts.unsubscribeReply === undefined
            ? { endpoint }
            : opts.unsubscribeReply
          : replies[Math.min(calls.unsubscribeSent.length, replies.length) - 1];
      await opts.unsubscribeGate;
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    },
  };
  const requested = opts.requested ?? "granted";
  const env: PushEnv = {
    permission: () => opts.permission ?? "granted",
    optedOut: () => optedOut,
    userAgent: () => opts.userAgent ?? "",
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
          return opts.getFails === undefined ? Promise.resolve(held) : Promise.reject(opts.getFails);
        },
        subscribe: (options) => {
          calls.order.push("subscribe");
          calls.subscribed.push(options.applicationServerKey);
          held = subscription(opts.made ?? ENDPOINT, PUBLIC_KEY, calls);
          return Promise.resolve(held);
        },
      });
    },
  };
  return { client, env, calls };
}

/** A turn-off's outcome with its note settled, to compare whole. */
async function settled(
  outcome: Promise<PushOffOutcome>,
): Promise<{ readonly kind: "disabled"; readonly note: string | null } | PushFailure> {
  const off = await outcome;
  return off.kind === "disabled" ? { kind: "disabled", note: await off.note } : off;
}

/** A clock the test reads: every backoff asked for, run at once. */
function instantTimer(): { readonly waits: number[]; readonly setTimer: (run: () => void, ms: number) => () => void } {
  const waits: number[] = [];
  return {
    waits,
    setTimer: (run, ms) => {
      waits.push(ms);
      queueMicrotask(run);
      return () => {};
    },
  };
}

/** A settled turn-off's note, or its failure's line. */
function messageOrNote(outcome: Awaited<ReturnType<typeof settled>>): string {
  return outcome.kind === "failed" ? outcome.message : (outcome.note ?? "");
}

/** The messages a failed outcome carries, for the cases that only differ in their line. */
function messageOf(outcome: PushOutcome | PushOffOutcome | PushInspection | PushRemoveOutcome | null): string {
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
      settings: { publicKey: PUBLIC_KEY, subscribed: true, devices: [SELF] },
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
      settings: { publicKey: PUBLIC_KEY, subscribed: true, devices: [SELF] },
    });
    expect(await inspectPush(client, env)).toEqual({ kind: "on", devices: [SELF] });
  });

  test("granted permission alone is not on: no subscription, one the record lost, or one under another key", async () => {
    const none = harness({ permission: "granted" });
    const lost = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: false, devices: [] },
    });
    const rekeyed = harness({
      existing: { endpoint: ENDPOINT, key: OTHER_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: true, devices: [SELF] },
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
      settings: { publicKey: PUBLIC_KEY, subscribed: true, devices: [SELF] },
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
      settings: { publicKey: PUBLIC_KEY, subscribed: false, devices: [] },
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

  test("a turn-off that lands while it prepares wins: nothing is subscribed", async () => {
    const { client, env, calls } = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: false, devices: [] },
    });
    const slow: PushClient = {
      ...client,
      pushSettings: async (endpoint) => {
        const reading = await client.pushSettings(endpoint);
        env.setOptedOut(true);
        return reading;
      },
    };
    expect(await resyncPush(slow, env)).toBeNull();
    expect(calls.sent).toEqual([]);
    expect(calls.subscribed).toEqual([]);
  });
});

describe("disablePush", () => {
  test("unsubscribes this browser first, then asks the leader to drop the normalized endpoint", async () => {
    const raw = "https://FCM.googleapis.com/fcm/send/abc";
    const { client, env, calls } = harness({ existing: { endpoint: raw, key: PUBLIC_KEY } });
    expect(await settled(disablePush(client, env))).toEqual({ kind: "disabled", note: null });
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
      const outcome = await disablePush(client, env, { setTimer: instantTimer().setTimer });
      expect(calls.unsubscribed).toEqual([ENDPOINT]);
      expect(calls.optedOut).toEqual([true]);
      if (outcome.kind !== "disabled") throw new Error(`expected disabled, got ${outcome.kind}`);
      const note = (await outcome.note) ?? "";
      // Only a not_ready is asked again, up to the bound; every other answer is final.
      const retryable =
        unsubscribeReply !== null &&
        !(unsubscribeReply instanceof Error) &&
        "code" in unsubscribeReply &&
        unsubscribeReply.code === "not_ready";
      expect(calls.unsubscribeSent).toHaveLength(retryable ? 4 : 1);
      return note;
    };
    const older = await offWith({ ok: false, code: "invalid_request", message: "raw" });
    expect(older).toContain("older version");
    expect(older).toContain("until the push service reports it gone");
    for (const reply of [
      new RequestFailure("timeout", "no answer"),
      { ok: false, code: "not_ready", message: "raw" },
      { ok: false, code: "settings_unavailable", message: "raw" },
      { ok: false, code: "internal_error", message: "raw" },
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one harness per case
      const note = await offWith(reply);
      expect(note).toContain("Couldn't tell the scheduler leader");
      expect(note).not.toContain("older version");
    }
    // Answers the app cannot read, or that echo another endpoint, are not "couldn't tell" and not a removal either.
    for (const reply of [null, { endpoint: "https://fcm.googleapis.com/fcm/send/other" }]) {
      // oxlint-disable-next-line no-await-in-loop -- one harness per case
      const note = await offWith(reply);
      expect(note).toContain("Couldn't read the scheduler leader's answer");
    }
  });

  test("with no subscription, or one off the allowlist, there is nothing for the leader to free", async () => {
    const none = harness({});
    expect(await settled(disablePush(none.client, none.env))).toEqual({ kind: "disabled", note: null });
    const foreign = harness({ existing: { endpoint: "https://push.example.com/x", key: PUBLIC_KEY } });
    expect(await settled(disablePush(foreign.client, foreign.env))).toEqual({ kind: "disabled", note: null });
    expect(foreign.calls.unsubscribed).toEqual(["https://push.example.com/x"]);
    for (const { calls } of [none, foreign]) {
      expect(calls.unsubscribeSent).toEqual([]);
      expect(calls.optedOut).toEqual([true]);
    }
  });

  test("a browser that cannot unsubscribe is still off once the leader dropped it, and a failure only when neither worked", async () => {
    const leaderDropped = harness({ existing: { endpoint: ENDPOINT, key: PUBLIC_KEY }, local: false });
    expect(await settled(disablePush(leaderDropped.client, leaderDropped.env))).toEqual({
      kind: "disabled",
      note: null,
    });

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
    // Nothing was turned off, so the person is not opted out of the re-sync.
    expect(neither.calls.optedOut).toEqual([true, false]);
    expect(neither.env.optedOut()).toBe(false);

    const stuck = harness({ manager: new PushTimeout() });
    expect(messageOf(await disablePush(stuck.client, stuck.env))).toContain("service worker");
    expect(stuck.env.optedOut()).toBe(false);

    const unreadable = harness({ getFails: new Error("storage gone") });
    expect(messageOf(await disablePush(unreadable.client, unreadable.env))).toContain("couldn't turn push off");
    expect(unreadable.env.optedOut()).toBe(false);

    // A failed retry must not drop a turn-off that already stood.
    const already = harness({ optedOut: true, getFails: new Error("storage gone") });
    await disablePush(already.client, already.env);
    expect(already.env.optedOut()).toBe(true);
  });

  test("is off as soon as this browser unsubscribed, before the leader answers", async () => {
    // A leader that never answers: the op's timeout must not hold the card on "Turning off…".
    const { client, env, calls } = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      unsubscribeGate: Promise.withResolvers<void>().promise,
    });
    const outcome = await disablePush(client, env);
    expect(outcome.kind).toBe("disabled");
    expect(calls.unsubscribed).toEqual([ENDPOINT]);
    expect(calls.unsubscribeSent).toEqual([ENDPOINT]);
    expect(env.optedOut()).toBe(true);
  });

  test("the note arrives once the leader answers, after the outcome already said off", async () => {
    const gate = Promise.withResolvers<void>();
    let opened = false;
    const { client, env } = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      unsubscribeReply: { ok: false, code: "invalid_request", message: "raw" },
      unsubscribeGate: gate.promise,
    });
    const outcome = await disablePush(client, env);
    if (outcome.kind !== "disabled") throw new Error(`expected disabled, got ${outcome.kind}`);
    let note: string | null | undefined;
    void outcome.note.then((line) => {
      note = line;
    });
    // The outcome resolved while the op was still held, so it did not wait for the answer.
    expect(opened).toBe(false);
    expect(note).toBeUndefined();
    opened = true;
    gate.resolve();
    expect(await outcome.note).toContain("older version");
    expect(note).toContain("older version");
  });

  test("a leader still starting, or a write that lost a race, is asked again after a doubling backoff", async () => {
    const notReady: PushUnsubscribeReply = { ok: false, code: "not_ready", message: "raw" };
    const freed = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      unsubscribeReplies: [notReady, { endpoint: ENDPOINT }],
    });
    const clock = instantTimer();
    expect(await settled(disablePush(freed.client, freed.env, { setTimer: clock.setTimer }))).toEqual({
      kind: "disabled",
      note: null,
    });
    expect(freed.calls.unsubscribeSent).toEqual([ENDPOINT, ENDPOINT]);
    expect(clock.waits).toEqual([1_000]);

    // The bound holds: four attempts, then the slot stays until the push service reports it gone.
    const racing = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      unsubscribeReply: { ok: false, code: "conflict", message: "raw" },
    });
    const racingClock = instantTimer();
    const off = await settled(disablePush(racing.client, racing.env, { setTimer: racingClock.setTimer }));
    expect(messageOrNote(off)).toContain("Couldn't tell the scheduler leader");
    expect(racing.calls.unsubscribeSent).toHaveLength(4);
    expect(racingClock.waits).toEqual([1_000, 2_000, 4_000]);
  });

  test("a browser that kept its subscription is off after a retry freed the slot, and failed when four conflicts leave it", async () => {
    const notReady: PushUnsubscribeReply = { ok: false, code: "not_ready", message: "raw" };
    const retried = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      local: false,
      unsubscribeReplies: [notReady, { endpoint: ENDPOINT }],
    });
    const clock = instantTimer();
    expect(await settled(disablePush(retried.client, retried.env, { setTimer: clock.setTimer }))).toEqual({
      kind: "disabled",
      note: null,
    });
    expect(retried.calls.unsubscribeSent).toEqual([ENDPOINT, ENDPOINT]);
    expect(clock.waits).toEqual([1_000]);

    const racing = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      local: false,
      optedOut: false,
      unsubscribeReply: { ok: false, code: "conflict", message: "raw" },
    });
    const racingClock = instantTimer();
    expect(await disablePush(racing.client, racing.env, { setTimer: racingClock.setTimer })).toEqual({
      kind: "failed",
      message: "This browser couldn't turn push off. Try again.",
      retryable: true,
    });
    expect(racing.calls.unsubscribeSent).toHaveLength(4);
    expect(racing.calls.optedOut).toEqual([true, false]);
    expect(racing.env.optedOut()).toBe(false);
  });

  test("an older leader, unreadable settings or a timeout are not asked again", async () => {
    for (const reply of [
      { ok: false, code: "invalid_request", message: "raw" },
      { ok: false, code: "settings_unavailable", message: "raw" },
      { ok: false, code: "internal_error", message: "raw" },
      new RequestFailure("timeout", "no answer"),
    ] as const) {
      const { client, env, calls } = harness({
        existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
        unsubscribeReply: reply,
      });
      const clock = instantTimer();
      // oxlint-disable-next-line no-await-in-loop -- one harness per case
      await settled(disablePush(client, env, { setTimer: clock.setTimer }));
      expect(calls.unsubscribeSent).toEqual([ENDPOINT]);
      expect(clock.waits).toEqual([]);
    }
  });

  test("a retry waiting while the person turns it on again is not sent", async () => {
    const { client, env, calls } = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      unsubscribeReplies: [{ ok: false, code: "not_ready", message: "raw" }, { endpoint: ENDPOINT }],
    });
    const fire = Promise.withResolvers<() => void>();
    const controller = new AbortController();
    const outcome = await disablePush(
      client,
      env,
      {
        setTimer: (run) => {
          fire.resolve(run);
          return () => {};
        },
      },
      controller.signal,
    );
    if (outcome.kind !== "disabled") throw new Error(`expected disabled, got ${outcome.kind}`);
    const run = await fire.promise;
    // Enable aborts the turn-off; a push service may hand the new subscription the same endpoint.
    controller.abort();
    expect(await enablePush(client, env)).toEqual({ kind: "enabled" });
    run();
    expect(await outcome.note).toContain("Couldn't tell the scheduler leader");
    expect(calls.unsubscribeSent).toEqual([ENDPOINT]);
  });

  test("the retry still runs when storage is blocked and the opt-out mark never reads true", async () => {
    const { client, env, calls } = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      unsubscribeReplies: [{ ok: false, code: "not_ready", message: "raw" }, { endpoint: ENDPOINT }],
    });
    const blocked: PushEnv = { ...env, optedOut: () => false, setOptedOut: () => {} };
    const clock = instantTimer();
    expect(
      await settled(disablePush(client, blocked, { setTimer: clock.setTimer }, new AbortController().signal)),
    ).toEqual({ kind: "disabled", note: null });
    expect(calls.unsubscribeSent).toEqual([ENDPOINT, ENDPOINT]);
  });

  test("off, inspected and enabled again on one browser: it subscribes anew and the re-sync is back", async () => {
    const { client, env, calls } = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: true, devices: [SELF] },
    });
    expect(await settled(disablePush(client, env))).toEqual({ kind: "disabled", note: null });
    const inspection = await inspectPush(client, env);
    if (inspection.kind !== "off") throw new Error(`expected off, got ${inspection.kind}`);
    expect(calls.subscribed).toEqual([]);
    expect(await enablePush(client, env, inspection.prepared)).toEqual({ kind: "enabled" });
    expect(calls.subscribed).toEqual([fromBase64Url(PUBLIC_KEY)]);
    expect(calls.sent).toEqual([{ endpoint: ENDPOINT, keys: KEYS }]);
    expect(env.optedOut()).toBe(false);
  });

  test("an inspection that finds the browser on drops a stale turn-off", async () => {
    const { client, env } = harness({
      optedOut: true,
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: true, devices: [SELF] },
    });
    expect(await inspectPush(client, env)).toEqual({ kind: "on", devices: [SELF] });
    expect(env.optedOut()).toBe(false);
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

const CHROME_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("deviceLabel", () => {
  test("names the browser and the system from a user agent, and the one it knows alone", () => {
    const table: readonly (readonly [string, string | undefined])[] = [
      [
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36",
        "Chrome · Android",
      ],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
        "Chrome · Windows",
      ],
      [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
        "Chrome · macOS",
      ],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
        "Edge · Windows",
      ],
      ["Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0", "Firefox · Linux"],
      ["Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0", "Firefox · Android"],
      [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15",
        "Safari · macOS",
      ],
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
        "Safari · iOS",
      ],
      [
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
        "Samsung Internet · Android",
      ],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
        "Opera · Windows",
      ],
      ["", undefined],
      ["curl/8.0", undefined],
    ];
    for (const [agent, label] of table) {
      expect(deviceLabel(agent)).toBe(label);
      if (label === undefined) continue;
      expect(label.length).toBeLessThanOrEqual(64);
      expect(label).toBe(label.trim());
      // What the leader's parser will accept, so a label is never the reason a subscribe is refused.
      expect(parsePushSubscribeRequest({ endpoint: ENDPOINT, keys: KEYS, label })).not.toBeNull();
    }
  });
});

describe("the device label on the wire", () => {
  test("Enable and the re-sync of an unheld browser send the label; no user agent sends none", async () => {
    const enabled = harness({ userAgent: CHROME_LINUX });
    expect(await enablePush(enabled.client, enabled.env)).toEqual({ kind: "enabled" });
    expect(enabled.calls.sent).toEqual([{ endpoint: ENDPOINT, keys: KEYS, label: "Chrome · Linux" }]);

    const resync = harness({
      userAgent: CHROME_LINUX,
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: false, devices: [] },
    });
    expect(await resyncPush(resync.client, resync.env)).toEqual({ kind: "enabled" });
    expect(resync.calls.sent).toEqual([{ endpoint: ENDPOINT, keys: KEYS, label: "Chrome · Linux" }]);
  });

  test("a held browser whose entry has no label sends one backfill, touching nothing in the browser", async () => {
    const { client, env, calls } = harness({
      userAgent: CHROME_LINUX,
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: true, devices: [SELF] },
    });
    expect(await resyncPush(client, env)).toEqual({ kind: "enabled" });
    expect(calls.sent).toEqual([{ endpoint: ENDPOINT, keys: KEYS, label: "Chrome · Linux" }]);
    expect(calls.subscribed).toEqual([]);
    expect(calls.unsubscribed).toEqual([]);
  });

  test("a held browser whose entry has a label, or that has no label to send, sends nothing", async () => {
    const labelled = harness({
      userAgent: CHROME_LINUX,
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: true, devices: [{ ...SELF, label: "Chrome · Linux" }] },
    });
    await resyncPush(labelled.client, labelled.env);
    expect(labelled.calls.sent).toEqual([]);
    const unnamed = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: true, devices: [SELF] },
    });
    await resyncPush(unnamed.client, unnamed.env);
    expect(unnamed.calls.sent).toEqual([]);
  });

  test("a failed backfill never drops the held subscription", async () => {
    const { client, env, calls } = harness({
      userAgent: CHROME_LINUX,
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: true, devices: [SELF] },
      reply: { ok: false, code: "not_ready", message: "raw" },
    });
    expect(await resyncPush(client, env)).toMatchObject({ kind: "failed", retryable: true });
    expect(calls.unsubscribed).toEqual([]);
  });

  test("inspectPush hands back the record's devices", async () => {
    const devices: readonly PushDevice[] = [
      SELF,
      { endpoint: "https://web.push.apple.com/x", vendor: "Safari", self: false },
    ];
    const { client, env } = harness({
      existing: { endpoint: ENDPOINT, key: PUBLIC_KEY },
      settings: { publicKey: PUBLIC_KEY, subscribed: true, devices },
    });
    expect(await inspectPush(client, env)).toEqual({ kind: "on", devices });
  });
});

describe("removeDevice", () => {
  const OTHER = "https://web.push.apple.com/other";

  test("asks the leader to drop that endpoint and reports it removed", async () => {
    const { client, calls } = harness({});
    expect(await removeDevice(client, OTHER)).toEqual({ kind: "removed" });
    expect(calls.unsubscribeSent).toEqual([OTHER]);
  });

  test("a leader that predates the op is told apart, and not asked again", async () => {
    const { client, calls } = harness({ unsubscribeReply: { ok: false, code: "invalid_request", message: "raw" } });
    const out = await removeDevice(client, OTHER, { setTimer: instantTimer().setTimer });
    expect(messageOf(out)).toContain("older version");
    expect(out).toMatchObject({ retryable: false });
    expect(calls.unsubscribeSent).toHaveLength(1);
  });

  test("a leader still starting is asked again after a backoff; four conflicts leave a retryable failure", async () => {
    const notReady: PushUnsubscribeReply = { ok: false, code: "not_ready", message: "raw" };
    const freed = harness({ unsubscribeReplies: [notReady, { endpoint: OTHER }] });
    const clock = instantTimer();
    expect(await removeDevice(freed.client, OTHER, { setTimer: clock.setTimer })).toEqual({ kind: "removed" });
    expect(clock.waits).toEqual([1_000]);

    const racing = harness({ unsubscribeReply: { ok: false, code: "conflict", message: "raw" } });
    const out = await removeDevice(racing.client, OTHER, { setTimer: instantTimer().setTimer });
    expect(out).toMatchObject({ kind: "failed", retryable: true });
    expect(racing.calls.unsubscribeSent).toHaveLength(4);
  });

  test("an unknown refusal carries the shared text; an unreachable leader is retryable", async () => {
    const odd = harness({ unsubscribeReply: { ok: false, code: "no_such_code", message: "raw" } });
    expect(messageOf(await removeDevice(odd.client, OTHER))).toContain(schedulerErrorText("no_such_code"));
    const down = harness({ unsubscribeReply: new RequestFailure("timeout", "no answer") });
    const out = await removeDevice(down.client, OTHER);
    expect(messageOf(out)).toContain("Couldn't reach the scheduler leader");
    expect(out).toMatchObject({ retryable: true });
    const other = harness({ unsubscribeReply: new Error("boom") });
    expect(await removeDevice(other.client, OTHER)).toMatchObject({ kind: "failed", retryable: false });
  });

  test("a null reply, or an echo of another endpoint, is unreadable", async () => {
    const none = harness({ unsubscribeReply: null });
    expect(messageOf(await removeDevice(none.client, OTHER))).toContain("Couldn't read");
    const echo = harness({ unsubscribeReply: { endpoint: ENDPOINT } });
    expect(messageOf(await removeDevice(echo.client, OTHER))).toContain("Couldn't read");
  });
});

describe("deviceRows", () => {
  test("shows the label, or the vendor as added before labels, and carries no endpoint", () => {
    const devices: readonly PushDevice[] = [
      { endpoint: ENDPOINT, vendor: "Chrome/Android", label: "Chrome · Linux", addedAt: 1_760_000_000_000, self: true },
      { endpoint: "https://web.push.apple.com/secret", vendor: "Safari", self: false },
    ];
    const rows = deviceRows(devices);
    expect(rows).toEqual([
      { title: "Chrome · Linux", addedAt: 1_760_000_000_000, self: true },
      { title: "Safari · added before labels", self: false },
    ]);
    expect(Object.keys(rows[1] ?? {})).not.toContain("addedAt");
    const json = JSON.stringify(rows);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("googleapis");
  });
});
