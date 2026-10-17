import { describe, expect, test } from "bun:test";
import {
  APP_ID,
  IDENTITY_PUBLIC_KEY_BYTES,
  IDENTITY_SIGNATURE_BYTES,
  MACHINES_ID,
  MAX_REGISTER_ROLES,
  PROTOCOL_VERSION,
  SCHEDULER_ID,
  STATUS_MAX_CT_LENGTH,
  STORE_CREATE_MAX_CT_LENGTH,
  STORE_MAX_CT_LENGTH,
  base64Length,
  importPsk,
  seal,
  type Envelope,
} from "@seance/shared";
import { LEAD_PROOF_MAX_CT_LENGTH, parseAppFrame, parseDaemonFrame, parseEnvelope } from "../src/wire.ts";

const env = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: PROTOCOL_VERSION,
  to: "device-1",
  from: APP_ID,
  iv: "cmFuZG9taXZieXRl",
  ct: "Y2lwaGVydGV4dA==",
  ...over,
});

// Shape only: the parser bounds the key and signature to their exact encoded
// sizes and leaves verifying them to the hub.
const KEY = "A".repeat(base64Length(IDENTITY_PUBLIC_KEY_BYTES));
const SIG = "A".repeat(base64Length(IDENTITY_SIGNATURE_BYTES));

const registerFrame = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    t: "register",
    deviceId: "device-1",
    info: env({ to: APP_ID, from: "device-1" }),
    key: KEY,
    ts: Date.now(),
    sig: SIG,
    ...over,
  });

describe("parseEnvelope bounds", () => {
  test("accepts what the daemon and app actually send", () => {
    expect(parseEnvelope(env())).not.toBeNull();
    expect(parseEnvelope(env({ to: crypto.randomUUID(), from: APP_ID }))).not.toBeNull();
  });

  test("unknown protocol versions still forward — the endpoints reject what they cannot open", () => {
    expect(parseEnvelope(env({ v: 99 }))).not.toBeNull();
  });

  test("a ciphertext past the cap is refused before it can reach a 128 KiB storage value", () => {
    expect(parseEnvelope(env({ ct: "A".repeat(64 * 1024) }))).not.toBeNull();
    expect(parseEnvelope(env({ ct: "A".repeat(64 * 1024 + 1) }))).toBeNull();
  });

  test("routing ids are bounded and boring — they become storage keys and log lines", () => {
    expect(parseEnvelope(env({ to: "a".repeat(64) }))).not.toBeNull();
    expect(parseEnvelope(env({ to: "a".repeat(65) }))).toBeNull();
    expect(parseEnvelope(env({ to: "has space" }))).toBeNull();
    expect(parseEnvelope(env({ to: "has\nnewline" }))).toBeNull();
    expect(parseEnvelope(env({ from: "../escape" }))).toBeNull();
  });

  test("an oversized iv is refused", () => {
    expect(parseEnvelope(env({ iv: "a".repeat(33) }))).toBeNull();
  });

  test("empty strings are not ids", () => {
    expect(parseEnvelope(env({ to: "" }))).toBeNull();
    expect(parseEnvelope(env({ ct: "" }))).toBeNull();
  });
});

describe("parseDaemonFrame", () => {
  test("accepts a well-formed register", () => {
    expect(parseDaemonFrame(registerFrame())).not.toBeNull();
    expect(parseDaemonFrame(registerFrame({ deviceId: crypto.randomUUID() }))).not.toBeNull();
  });

  test("a deviceId past the cap or off the charset is refused", () => {
    expect(parseDaemonFrame(registerFrame({ deviceId: "a".repeat(65) }))).toBeNull();
    expect(parseDaemonFrame(registerFrame({ deviceId: "has space" }))).toBeNull();
    expect(parseDaemonFrame(registerFrame({ deviceId: "" }))).toBeNull();
  });

  test("a key or signature of any other size, or an unusable timestamp, is refused before any crypto runs", () => {
    expect(parseDaemonFrame(registerFrame({ key: KEY.slice(1) }))).toBeNull();
    expect(parseDaemonFrame(registerFrame({ key: `${KEY}A` }))).toBeNull();
    expect(parseDaemonFrame(registerFrame({ key: `${KEY.slice(1)}!` }))).toBeNull();
    expect(parseDaemonFrame(registerFrame({ sig: SIG.slice(1) }))).toBeNull();
    expect(parseDaemonFrame(registerFrame({ sig: undefined }))).toBeNull();
    expect(parseDaemonFrame(registerFrame({ ts: "now" }))).toBeNull();
    expect(parseDaemonFrame(registerFrame({ ts: Number.NaN }))).toBeNull();
  });

  test("a daemon cannot claim a reserved wire address", () => {
    expect(parseDaemonFrame(registerFrame({ deviceId: APP_ID }))).toBeNull();
    expect(parseDaemonFrame(registerFrame({ deviceId: MACHINES_ID }))).toBeNull();
    expect(parseDaemonFrame(registerFrame({ deviceId: SCHEDULER_ID }))).toBeNull();
  });

  test("roles are optional, kept raw for the signature, and bounded like ids", () => {
    expect(parseDaemonFrame(registerFrame())).not.toHaveProperty("roles");
    expect(parseDaemonFrame(registerFrame({ roles: ["scheduler"] }))).toMatchObject({ roles: ["scheduler"] });
    // A role this relay does not know still parses: the signature covers it.
    expect(parseDaemonFrame(registerFrame({ roles: ["scheduler", "later"] }))).toMatchObject({
      roles: ["scheduler", "later"],
    });
    expect(parseDaemonFrame(registerFrame({ roles: [] }))).toMatchObject({ roles: [] });
    expect(parseDaemonFrame(registerFrame({ roles: "scheduler" }))).toBeNull();
    expect(parseDaemonFrame(registerFrame({ roles: [1] }))).toBeNull();
    // `,` and `|` are v2's separators; the id charset keeps them out.
    expect(parseDaemonFrame(registerFrame({ roles: ["a,b"] }))).toBeNull();
    expect(parseDaemonFrame(registerFrame({ roles: ["a|b"] }))).toBeNull();
    expect(
      parseDaemonFrame(registerFrame({ roles: Array.from({ length: MAX_REGISTER_ROLES + 1 }, () => "x") })),
    ).toBeNull();
  });

  test("malformed JSON and unknown frame types are dropped, not thrown", () => {
    expect(parseDaemonFrame("{nope")).toBeNull();
    expect(parseDaemonFrame(JSON.stringify({ t: "forget", deviceId: "device-1" }))).toBeNull();
  });
});

describe("status frames", () => {
  test("a status is a bounded envelope: a KiB of ciphertext, since it lands on the socket attachment", () => {
    const fits: Envelope = {
      v: PROTOCOL_VERSION,
      to: APP_ID,
      from: "device-1",
      iv: "cmFuZG9taXZieXRl",
      ct: "A".repeat(STATUS_MAX_CT_LENGTH),
    };
    expect(parseDaemonFrame(JSON.stringify({ t: "status", env: fits }))).toEqual({ t: "status", env: fits });
    const over = env({ to: APP_ID, from: "device-1", ct: "A".repeat(STATUS_MAX_CT_LENGTH + 1) });
    expect(parseDaemonFrame(JSON.stringify({ t: "status", env: over }))).toBeNull();
    // The same ciphertext is an ordinary msg's size — the bound is the frame's, not the envelope's.
    expect(parseDaemonFrame(JSON.stringify({ t: "msg", env: over }))).not.toBeNull();
    expect(parseDaemonFrame(JSON.stringify({ t: "status" }))).toBeNull();
    expect(parseDaemonFrame(JSON.stringify({ t: "status", env: env({ iv: "" }) }))).toBeNull();
  });

  test("an app socket cannot send one", () => {
    expect(parseAppFrame(JSON.stringify({ t: "status", env: env({ to: APP_ID, from: "device-1" }) }))).toBeNull();
  });
});

describe("lead-proof frames", () => {
  test("a term and a small bounded envelope; a real proof, at the longest term, fits", async () => {
    const key = await importPsk(btoa(String.fromCharCode(...new Uint8Array(32))));
    const real = await seal(
      key,
      { to: APP_ID, from: "x".repeat(64) },
      { id: crypto.randomUUID(), ts: Date.now(), op: "lead-proof", payload: { term: Number.MAX_SAFE_INTEGER } },
    );
    expect(real.ct.length).toBeLessThanOrEqual(LEAD_PROOF_MAX_CT_LENGTH);
    const fits: Envelope = {
      v: PROTOCOL_VERSION,
      to: APP_ID,
      from: "device-1",
      iv: "cmFuZG9taXZieXRl",
      ct: "A".repeat(LEAD_PROOF_MAX_CT_LENGTH),
    };
    expect(parseDaemonFrame(JSON.stringify({ t: "lead-proof", term: 3, env: fits }))).toEqual({
      t: "lead-proof",
      term: 3,
      env: fits,
    });
    const over = env({ to: APP_ID, from: "device-1", ct: "A".repeat(LEAD_PROOF_MAX_CT_LENGTH + 1) });
    expect(parseDaemonFrame(JSON.stringify({ t: "lead-proof", term: 3, env: over }))).toBeNull();
    for (const term of [-1, 1.5, "3", undefined]) {
      expect(parseDaemonFrame(JSON.stringify({ t: "lead-proof", term, env: fits }))).toBeNull();
    }
    expect(parseAppFrame(JSON.stringify({ t: "lead-proof", term: 3, env: fits }))).toBeNull();
  });
});

describe("parseAppFrame", () => {
  test("only msg frames, and only with a valid envelope", () => {
    expect(parseAppFrame(JSON.stringify({ t: "msg", env: env() }))).not.toBeNull();
    expect(parseAppFrame(JSON.stringify({ t: "register", deviceId: "device-1" }))).toBeNull();
    expect(parseAppFrame(JSON.stringify({ t: "msg", env: env({ ct: "" }) }))).toBeNull();
  });

  test("a msg's term is optional and, when present, a non-negative integer", () => {
    const scheduled = env({ from: SCHEDULER_ID });
    expect(parseAppFrame(JSON.stringify({ t: "msg", env: scheduled, term: 3 }))).toMatchObject({
      env: scheduled,
      term: 3,
    });
    expect(parseAppFrame(JSON.stringify({ t: "msg", env: scheduled }))).not.toHaveProperty("term");
    for (const term of [-1, 1.5, "3", null, 2 ** 53]) {
      expect(parseAppFrame(JSON.stringify({ t: "msg", env: scheduled, term }))).toBeNull();
    }
  });
});

/** The same frame through each leg's parser. */
const both = (frame: Record<string, unknown>): readonly unknown[] => [
  parseDaemonFrame(JSON.stringify(frame)),
  parseAppFrame(JSON.stringify(frame)),
];

describe("store frames", () => {
  const sealed = (ct = "Y2lwaGVydGV4dA=="): Record<string, unknown> => env({ to: SCHEDULER_ID, from: "device-1", ct });
  const frames = {
    list: { t: "store-list", id: "r1", prefix: "task:" },
    get: { t: "store-get", id: "r2", key: "task:t-1" },
    put: { t: "store-put", id: "r3", key: "task:t-1", expect: 0, env: sealed() },
    delete: { t: "store-delete", id: "r4", key: "task:t-1", expect: 2 },
  };
  test("each of the four parses on both legs", () => {
    for (const frame of Object.values(frames)) {
      for (const parsed of both(frame)) expect(parsed).toMatchObject({ t: frame["t"], id: frame["id"] });
    }
  });

  test("a term is the daemon leg's alone: kept there, stripped from an app frame", () => {
    for (const frame of [frames.put, frames.delete]) {
      const withTerm = JSON.stringify({ ...frame, term: 4 });
      expect(parseDaemonFrame(withTerm)).toMatchObject({ term: 4 });
      expect(parseAppFrame(withTerm)).not.toHaveProperty("term");
      expect(parseDaemonFrame(JSON.stringify(frame))).not.toHaveProperty("term");
    }
    // An invalid one is the daemon leg's malformed field; the app leg never reads it.
    const bad = JSON.stringify({ ...frames.put, term: -1 });
    expect(parseDaemonFrame(bad)).toMatchObject({ t: "store-rejected", id: "r3", code: "invalid_request" });
    expect(parseAppFrame(bad)).toMatchObject({ t: "store-put" });
  });

  test("no usable id means nothing to answer: null, never a rejection", () => {
    for (const id of [undefined, "", "a".repeat(65), "bad id!", 7, null]) {
      for (const frame of Object.values(frames)) {
        for (const parsed of both({ ...frame, id })) expect(parsed).toBeNull();
      }
    }
  });

  test("a bad key is invalid_request, under get, put and delete", () => {
    const keys = ["device:x", "task:", "task:a:b", "account:x", `task:${"a".repeat(65)}`, "scheduler:term", "", 3];
    for (const key of keys) {
      for (const frame of [frames.get, frames.put, frames.delete]) {
        for (const parsed of both({ ...frame, key })) {
          expect(parsed).toMatchObject({ t: "store-rejected", id: frame["id"], code: "invalid_request" });
        }
      }
    }
  });

  test("a list prefix must be a known one", () => {
    for (const prefix of ["account:", "device:", "task", "", undefined, 1]) {
      for (const parsed of both({ ...frames.list, prefix })) {
        expect(parsed).toMatchObject({ t: "store-rejected", code: "invalid_request" });
      }
    }
    expect(parseAppFrame(JSON.stringify({ ...frames.list, prefix: "queue:" }))).toMatchObject({ prefix: "queue:" });
  });

  test("expect is a safe non-negative integer", () => {
    for (const expectValue of [-1, 1.5, "1", 2 ** 53, null, undefined]) {
      for (const frame of [frames.put, frames.delete]) {
        for (const parsed of both({ ...frame, expect: expectValue })) {
          expect(parsed).toMatchObject({ t: "store-rejected", code: "invalid_request" });
        }
      }
    }
  });

  test("a malformed env is invalid_request", () => {
    for (const bad of [undefined, null, "x", {}, env({ ct: "" }), env({ iv: "" }), env({ to: "bad to!" })]) {
      for (const parsed of both({ ...frames.put, env: bad })) {
        expect(parsed).toMatchObject({ t: "store-rejected", id: "r3", code: "invalid_request" });
      }
    }
  });

  test("past the ciphertext bound is too_large: a create's is tighter than an overwrite's", () => {
    const put = (expectValue: number, length: number): Record<string, unknown> => ({
      ...frames.put,
      expect: expectValue,
      env: sealed("A".repeat(length)),
    });
    const tooLarge = { t: "store-rejected", id: "r3", code: "too_large" };
    for (const parsed of both(put(0, STORE_CREATE_MAX_CT_LENGTH + 1))) expect(parsed).toMatchObject(tooLarge);
    for (const parsed of both(put(1, STORE_MAX_CT_LENGTH + 1))) expect(parsed).toMatchObject(tooLarge);
    // Far past the envelope cap: still a size answer, not a malformed frame.
    for (const parsed of both(put(1, 1024 * 1024))) expect(parsed).toMatchObject(tooLarge);
    // A create may not use an overwrite's room.
    for (const parsed of both(put(0, STORE_MAX_CT_LENGTH))) expect(parsed).toMatchObject(tooLarge);
  });

  test("at exactly each bound the frame parses", () => {
    const put = (expectValue: number, length: number): Record<string, unknown> => ({
      ...frames.put,
      expect: expectValue,
      env: sealed("A".repeat(length)),
    });
    for (const parsed of both(put(0, STORE_CREATE_MAX_CT_LENGTH))) expect(parsed).toMatchObject({ t: "store-put" });
    for (const parsed of both(put(1, STORE_MAX_CT_LENGTH))) expect(parsed).toMatchObject({ t: "store-put" });
  });

  test("a list's unknown fields are ignored: a relay without paging answers the whole prefix", () => {
    for (const parsed of both({ ...frames.list, after: "task:z" })) {
      expect(parsed).toEqual({ t: "store-list", id: "r1", prefix: "task:" });
    }
  });

  test("an unknown store type is dropped", () => {
    for (const parsed of both({ t: "store-move", id: "r1", key: "task:t-1" })) expect(parsed).toBeNull();
  });
});
