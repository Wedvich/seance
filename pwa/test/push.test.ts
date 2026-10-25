import { describe, expect, test } from "bun:test";
import { fromBase64Url, RequestFailure, type PushSubscribeReply, type PushSubscribeRequest } from "@seance/shared";
import {
  enablePush,
  resyncPush,
  type PushClient,
  type PushEnv,
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
}

function subscription(endpoint: string, key: string, calls: Calls): PushSubscriptionLike {
  return {
    endpoint,
    options: { applicationServerKey: fromBase64Url(key).buffer },
    // A browser's own JSON carries `expirationTime`, which the leader's parser would refuse.
    toJSON: () => ({ endpoint, keys: KEYS, expirationTime: null }),
    unsubscribe: () => {
      calls.unsubscribed.push(endpoint);
      return Promise.resolve(true);
    },
  };
}

function harness(opts: {
  permission?: PushPermission;
  requested?: PushPermission;
  existing?: { endpoint: string; key: string };
  made?: string;
  settings?: { publicKey: string; subscribed: boolean } | null | Error;
  reply?: PushSubscribeReply | null | Error;
}): { client: PushClient; env: PushEnv; calls: Calls } {
  const calls: Calls = { subscribed: [], unsubscribed: [], settings: [], sent: [] };
  const existing = opts.existing === undefined ? null : subscription(opts.existing.endpoint, opts.existing.key, calls);
  const settings = opts.settings === undefined ? { publicKey: PUBLIC_KEY, subscribed: false } : opts.settings;
  const reply = opts.reply === undefined ? { endpoint: ENDPOINT } : opts.reply;
  const client: PushClient = {
    pushSettings: (endpoint) => {
      calls.settings.push(endpoint);
      return settings instanceof Error ? Promise.reject(settings) : Promise.resolve(settings);
    },
    pushSubscribe: (sub) => {
      calls.sent.push(sub);
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  };
  const env: PushEnv = {
    permission: () => opts.permission ?? "granted",
    requestPermission: () => Promise.resolve(opts.requested ?? "granted"),
    manager: () =>
      Promise.resolve({
        getSubscription: () => Promise.resolve(existing),
        subscribe: (options) => {
          calls.subscribed.push(options.applicationServerKey);
          return Promise.resolve(subscription(opts.made ?? ENDPOINT, PUBLIC_KEY, calls));
        },
      }),
  };
  return { client, env, calls };
}

describe("enablePush", () => {
  test("subscribes under the leader's key and sends the endpoint and keys, without the browser's expirationTime", async () => {
    const { client, env, calls } = harness({});
    expect(await enablePush(client, env)).toEqual({ kind: "enabled" });
    expect(calls.subscribed).toEqual([fromBase64Url(PUBLIC_KEY)]);
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

  test("no settings record reads as no leader having set up push, and subscribes nothing", async () => {
    const { client, env, calls } = harness({ settings: null });
    expect(await enablePush(client, env)).toMatchObject({
      kind: "failed",
      message: expect.stringContaining("No scheduler leader"),
    });
    expect(calls.subscribed).toEqual([]);
    expect(calls.sent).toEqual([]);
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
    expect(await enablePush(client, env)).toEqual({
      kind: "failed",
      message: "This browser's push service isn't supported.",
    });
    expect(calls.sent).toEqual([]);
    expect(calls.unsubscribed).toEqual([made]);
  });

  test("the leader's refusals and a failed request each read as their own line", async () => {
    const refusal = (code: string): PushSubscribeReply => ({ ok: false, code, message: "raw" });
    const messageOf = async (reply: PushSubscribeReply | null | Error): Promise<string> => {
      const { client, env } = harness({ reply });
      const outcome = await enablePush(client, env);
      return outcome.kind === "failed" ? outcome.message : outcome.kind;
    };
    // After the pre-check passed, `invalid_request` can only be a leader that predates the op.
    expect(await messageOf(refusal("invalid_request"))).toContain("older version");
    expect(await messageOf(refusal("subscriptions_full"))).toContain("Too many");
    expect(await messageOf(refusal("settings_unavailable"))).toContain("push is off");
    expect(await messageOf(refusal("made_up_code"))).toContain("made_up_code");
    expect(await messageOf(null)).toContain("Couldn't read");
    expect(await messageOf(new RequestFailure("timeout", "no answer"))).toContain("Couldn't reach");
    expect(await messageOf(new Error("push service down"))).toContain("couldn't subscribe");
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
  });
});
