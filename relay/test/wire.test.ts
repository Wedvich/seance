import { describe, expect, test } from "bun:test";
import {
  APP_ID,
  IDENTITY_PUBLIC_KEY_BYTES,
  IDENTITY_SIGNATURE_BYTES,
  MACHINES_ID,
  PROTOCOL_VERSION,
  base64Length,
} from "@seance/shared";
import { parseAppFrame, parseDaemonFrame, parseEnvelope } from "../src/wire.ts";

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
  });

  test("malformed JSON and unknown frame types are dropped, not thrown", () => {
    expect(parseDaemonFrame("{nope")).toBeNull();
    expect(parseDaemonFrame(JSON.stringify({ t: "forget", deviceId: "device-1" }))).toBeNull();
  });
});

describe("parseAppFrame", () => {
  test("only msg frames, and only with a valid envelope", () => {
    expect(parseAppFrame(JSON.stringify({ t: "msg", env: env() }))).not.toBeNull();
    expect(parseAppFrame(JSON.stringify({ t: "register", deviceId: "device-1" }))).toBeNull();
    expect(parseAppFrame(JSON.stringify({ t: "msg", env: env({ ct: "" }) }))).toBeNull();
  });
});
