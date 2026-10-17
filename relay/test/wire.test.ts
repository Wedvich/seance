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
