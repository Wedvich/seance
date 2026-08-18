import { describe, expect, test } from "bun:test";
import { APP_ID, MACHINES_ID, PROTOCOL_VERSION } from "@seance/shared";
import { parseAppFrame, parseDaemonFrame, parseEnvelope } from "../src/wire.ts";

const env = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: PROTOCOL_VERSION,
  to: "device-1",
  from: APP_ID,
  iv: "cmFuZG9taXZieXRl",
  ct: "Y2lwaGVydGV4dA==",
  ...over,
});

const registerFrame = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ t: "register", deviceId: "device-1", info: env({ to: APP_ID, from: "device-1" }), ...over });

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

  test("the caps are bytes, so multi-byte text cannot carry three times the cap", () => {
    // 32 KiB of three-byte characters is 96 KiB encoded: under the cap counted
    // as string units, past the storage value it would become.
    expect(parseEnvelope(env({ ct: "€".repeat(32 * 1024) }))).toBeNull();
    expect(parseEnvelope(env({ ct: "€".repeat(21 * 1024) }))).not.toBeNull();
    // `iv` has no charset to save it — the size cap is the only bound there.
    expect(parseEnvelope(env({ iv: "€".repeat(16) }))).toBeNull();
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
