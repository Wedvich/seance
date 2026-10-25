import { beforeAll, describe, expect, test } from "bun:test";
import {
  APP_ID,
  AT_REST_OPS,
  generateIdentitySeed,
  identityFromSeed,
  importPsk,
  openAtRest,
  sealAtRest,
  SCHEDULER_ID,
  seal,
  SETTINGS_KEY,
  STORE_CREATE_MAX_CT_LENGTH,
  toBase64,
  type AtRestOp,
  type Envelope,
  type SettingsRecord,
  type StoreRequestFrame,
} from "@seance/shared";
import { RelayClient } from "../src/relay-client.ts";
import { createSettingsStore, type SettingsStore } from "../src/settings-store.ts";
import { withinCap } from "../src/store-frames.ts";
import { generateVapidKeys } from "../src/web-push.ts";
import { VersionFloor } from "../src/version-floor.ts";
import { startTestRelay, type TestRelay } from "./harness.ts";

const PSK = toBase64(new Uint8Array(32).fill(5));
const TOKEN = "settings-store-test";
let key: CryptoKey;

beforeAll(async () => {
  key = await importPsk(PSK);
});

class Revoked extends Error {}

interface Rig {
  readonly relay: TestRelay;
  readonly store: SettingsStore;
}

interface RigOpts {
  readonly floor?: VersionFloor;
  /** Flips the term's liveness; defaults to always live. */
  readonly live?: () => boolean;
}

/** A real daemon `RelayClient` leading under term 2 on the test relay, and an adapter over it. */
async function withRig(body: (rig: Rig) => Promise<void>, opts: RigOpts = {}): Promise<void> {
  const relay = startTestRelay(TOKEN);
  const identity = await identityFromSeed(generateIdentitySeed());
  const client = new RelayClient({
    url: relay.url,
    bearerToken: TOKEN,
    identity,
    key,
    buildInfo: () =>
      seal(
        key,
        { to: APP_ID, from: identity.deviceId },
        { id: crypto.randomUUID(), ts: Date.now(), op: "machine-info", payload: {} },
      ),
    handle: () => Promise.resolve(null),
    storeTimeoutMs: 300,
    storeListTimeoutMs: 300,
  });
  client.start();
  try {
    await relay.registers.next();
    relay.lead(identity.deviceId, 2);
    const store = createSettingsStore({
      leg: client,
      key,
      term: 2,
      live: opts.live ?? (() => true),
      ...(opts.floor === undefined ? {} : { floor: opts.floor }),
      revoked: (why) => new Revoked(why),
    });
    await body({ relay, store });
  } finally {
    client.stop();
    relay.stop();
  }
}

async function drain(relay: TestRelay): Promise<StoreRequestFrame[]> {
  const frames: StoreRequestFrame[] = [];
  while (relay.storeFrames.size > 0) frames.push(await relay.storeFrames.next());
  return frames;
}

const settingsEnv = (payload: unknown, op: AtRestOp = AT_REST_OPS.settings, to = SCHEDULER_ID): Promise<Envelope> =>
  sealAtRest(key, { to, from: SCHEDULER_ID }, op, payload);

describe("round trip", () => {
  test("none at first; a create at 0 carries the term and a record sealed to the scheduler under op settings", async () => {
    await withRig(async ({ relay, store }) => {
      expect(await store.get()).toBeNull();
      const vapid = await generateVapidKeys();
      expect(await store.put(0, { vapid })).toEqual({ ok: true, version: 1 });
      expect(await store.get()).toEqual({ version: 1, record: { version: 1, vapid } });
      // A second create is a conflict, never an overwrite.
      expect(await store.put(0, { vapid })).toEqual({ ok: false, code: "version_conflict" });

      const first = (await drain(relay)).find((frame) => frame.t === "store-put");
      if (first?.t !== "store-put") throw new Error("no create sent");
      expect(first).toMatchObject({ key: SETTINGS_KEY, expect: 0, term: 2 });
      expect(first.env.to).toBe(SCHEDULER_ID);
      expect(first.env.from).toBe(SCHEDULER_ID);
      const opened = await openAtRest(key, first.env, AT_REST_OPS.settings);
      expect(opened.payload).toEqual({ version: 1, vapid });
    });
  });

  test("an overwrite by expect keeps the other fields, as the parser builds them", async () => {
    await withRig(async ({ store }) => {
      const vapid = await generateVapidKeys();
      await store.put(0, { vapid });
      expect(await store.put(1, { vapid, linearKey: "lin_api_key" })).toEqual({ ok: true, version: 2 });
      expect(await store.get()).toEqual({ version: 2, record: { version: 2, vapid, linearKey: "lin_api_key" } });
    });
  });

  test("a record the parser refuses is not sent", async () => {
    await withRig(async ({ relay, store }) => {
      const bad: Omit<SettingsRecord, "version"> = { vapid: { publicKey: "short", privateKey: "short" } };
      expect(await store.put(0, bad)).toEqual({ ok: false, code: "refused" });
      expect(relay.storeFrames.size).toBe(0);
    });
  });
});

describe("reader rules", () => {
  test("every record a reader would refuse comes back with its reason, and is never opened as settings", async () => {
    await withRig(async ({ relay, store }) => {
      const vapid = await generateVapidKeys();
      const good = { version: 1, vapid };
      const other = await importPsk(toBase64(new Uint8Array(32).fill(9)));

      relay.plantRecord(SETTINGS_KEY, 1, await settingsEnv(good, AT_REST_OPS.pauseState));
      expect(await store.get()).toEqual({ version: 1, reason: "unopenable" });
      relay.plantRecord(SETTINGS_KEY, 1, await settingsEnv(good, AT_REST_OPS.settings, APP_ID));
      expect(await store.get()).toEqual({ version: 1, reason: "unopenable" });
      relay.plantRecord(
        SETTINGS_KEY,
        1,
        await sealAtRest(other, { to: SCHEDULER_ID, from: SCHEDULER_ID }, AT_REST_OPS.settings, good),
      );
      expect(await store.get()).toEqual({ version: 1, reason: "unopenable" });
      relay.plantRecord(SETTINGS_KEY, 1, await settingsEnv({ nonsense: true }));
      expect(await store.get()).toEqual({ version: 1, reason: "malformed" });
      // An authentic old blob put back names the version it was sealed at.
      relay.plantRecord(SETTINGS_KEY, 2, await settingsEnv(good));
      expect(await store.get()).toEqual({ version: 2, reason: "version_mismatch" });

      const env = await settingsEnv(good);
      relay.replyNextStore((frame) => ({
        t: "store-record",
        re: frame.id,
        record: { key: "settings:other", version: 1, env },
      }));
      expect(await store.get()).toEqual({ version: 1, reason: "key_mismatch" });
    });
  });

  test("a reply that cannot be answered rejects instead of reading as no record", async () => {
    await withRig(async ({ relay, store }) => {
      relay.replyNextStore((frame) => ({ t: "store-refused", re: frame.id, code: "invalid_request" }));
      await expect(store.get()).rejects.toThrow("invalid_request");
    });
  });
});

describe("size", () => {
  test("a create is held to the create cap before anything is sent, an overwrite to the larger one", () => {
    const env = (length: number): Envelope => ({
      v: 1,
      to: SCHEDULER_ID,
      from: SCHEDULER_ID,
      iv: "A",
      ct: "A".repeat(length),
    });
    expect(withinCap(env(STORE_CREATE_MAX_CT_LENGTH), 0)).toBe(true);
    expect(withinCap(env(STORE_CREATE_MAX_CT_LENGTH + 1), 0)).toBe(false);
    expect(withinCap(env(STORE_CREATE_MAX_CT_LENGTH + 1), 1)).toBe(true);
  });

  test("the relay refusing a write as too large reads as a value, not a throw", async () => {
    await withRig(async ({ relay, store }) => {
      relay.replyNextStore((frame) => ({ t: "store-refused", re: frame.id, code: "too_large" }));
      expect(await store.put(0, { vapid: await generateVapidKeys() })).toEqual({ ok: false, code: "too_large" });
    });
  });
});

describe("the term's fence", () => {
  test("a write after the term ended throws the caller's revoked error and sends nothing", async () => {
    let live = true;
    await withRig(
      async ({ relay, store }) => {
        const vapid = await generateVapidKeys();
        expect(await store.put(0, { vapid })).toEqual({ ok: true, version: 1 });
        await drain(relay);
        live = false;
        await expect(store.put(1, { vapid })).rejects.toBeInstanceOf(Revoked);
        // Reads change nothing, so they stay open.
        expect(await store.get()).toMatchObject({ version: 1 });
        expect((await drain(relay)).map((frame) => frame.t)).toEqual(["store-get"]);
      },
      { live: () => live },
    );
  });

  test("the relay answering not_leader throws it too", async () => {
    await withRig(async ({ relay, store }) => {
      relay.replyNextStore((frame) => ({ t: "store-refused", re: frame.id, code: "not_leader" }));
      await expect(store.put(0, { vapid: await generateVapidKeys() })).rejects.toBeInstanceOf(Revoked);
    });
  });
});

describe("the version floor", () => {
  test("a write raises it; a record below it, or none once one was seen, reads version_regressed", async () => {
    const floor = VersionFloor.memory();
    await withRig(
      async ({ relay, store }) => {
        expect(await store.get()).toBeNull();
        const vapid = await generateVapidKeys();
        await store.put(0, { vapid });
        await store.put(1, { vapid });
        expect(floor.settings()).toBe(2);
        expect(await store.get()).toMatchObject({ version: 2, record: { vapid } });

        // The relay answers with an authentic version-1 blob, bound to its own version.
        relay.plantRecord(SETTINGS_KEY, 1, await settingsEnv({ version: 1, vapid }));
        expect(await store.get()).toEqual({ version: 1, reason: "version_regressed" });

        relay.replyNextStore((frame) => ({ t: "store-record", re: frame.id, record: null }));
        expect(await store.get()).toEqual({ version: 0, reason: "version_regressed" });
      },
      { floor },
    );
  });

  test("a read raises it, and a first run with floor 0 still reads as none", async () => {
    const floor = VersionFloor.memory();
    await withRig(
      async ({ relay, store }) => {
        expect(await store.get()).toBeNull();
        relay.plantRecord(SETTINGS_KEY, 3, await settingsEnv({ version: 3, vapid: await generateVapidKeys() }));
        expect(await store.get()).toMatchObject({ version: 3 });
        expect(floor.settings()).toBe(3);
      },
      { floor },
    );
  });
});
