import { describe, expect, test } from "bun:test";
import { fromBase64Url, parseSettingsRecord } from "@seance/shared";
import { generateVapidKeys } from "../src/web-push.ts";

describe("generateVapidKeys", () => {
  test("is unpadded base64url of a 65-byte point and a 32-byte scalar, which the settings parser accepts", async () => {
    const vapid = await generateVapidKeys();
    expect(vapid.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/u);
    expect(vapid.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(fromBase64Url(vapid.publicKey)).toHaveLength(65);
    expect(fromBase64Url(vapid.publicKey)[0]).toBe(0x04);
    expect(parseSettingsRecord({ version: 1, vapid })).toEqual({ version: 1, vapid });
  });

  test("the halves are one pair: a signature by the private scalar verifies under the public point", async () => {
    const { publicKey, privateKey } = await generateVapidKeys();
    const point = fromBase64Url(publicKey);
    const jwk = {
      kty: "EC",
      crv: "P-256",
      x: Buffer.from(point.subarray(1, 33)).toString("base64url"),
      y: Buffer.from(point.subarray(33, 65)).toString("base64url"),
      d: privateKey,
    };
    const priv = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const pub = await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const data = new TextEncoder().encode("vapid");
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, data);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, data)).toBe(true);
  });

  test("two calls give different pairs", async () => {
    expect((await generateVapidKeys()).publicKey).not.toBe((await generateVapidKeys()).publicKey);
  });
});
