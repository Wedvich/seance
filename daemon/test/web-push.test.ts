import { describe, expect, test } from "bun:test";
import {
  fromBase64Url,
  parseSettingsRecord,
  PUSH_ALERT_MAX_BYTES,
  toBase64Url,
  type WebPushSubscription,
} from "@seance/shared";
import { encryptPayload, generateVapidKeys, vapidAuthorization } from "../src/web-push.ts";

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

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const text = new TextEncoder();

/** The point's JWK, so a raw public key and its scalar become one private key. */
function jwkOf(point: Uint8Array, d: string): { kty: string; crv: string; x: string; y: string; d: string } {
  return {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(point.subarray(1, 33)),
    y: toBase64Url(point.subarray(33, 65)),
    d,
  };
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** The user agent's side (RFC 8291 §3.4), written out here so the test does not check the sender against itself. */
async function decrypt(
  body: Uint8Array<ArrayBuffer>,
  uaPublic: Uint8Array<ArrayBuffer>,
  uaPrivate: string,
  auth: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const salt = body.subarray(0, 16);
  expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096);
  expect(body[20]).toBe(65);
  const asPublic = body.subarray(21, 86);
  const priv = await crypto.subtle.importKey("jwk", jwkOf(uaPublic, uaPrivate), ECDH, false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("raw", asPublic, ECDH, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
  const join = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };
  const ikm = await hkdf(auth, secret, join(text.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, body.subarray(86)));
  expect(record.at(-1)).toBe(2);
  return record.subarray(0, -1);
}

describe("encryptPayload", () => {
  // RFC 8291 Appendix A and section 5.
  const uaPublic = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
  const auth = "BTBZMqHH6r4Tts7J_aSIgg";
  const asPublic = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const asPrivate = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
  const salt = "DGv6ra1nlYgDCS1FRnbzlw";
  const expected =
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
  const sub: WebPushSubscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/x",
    keys: { p256dh: uaPublic, auth },
  };

  test("reproduces the RFC 8291 Appendix A body byte for byte", async () => {
    const ephemeral: CryptoKeyPair = {
      publicKey: await crypto.subtle.importKey("raw", fromBase64Url(asPublic), ECDH, true, []),
      privateKey: await crypto.subtle.importKey("jwk", jwkOf(fromBase64Url(asPublic), asPrivate), ECDH, false, [
        "deriveBits",
      ]),
    };
    const body = await encryptPayload(sub, text.encode("When I grow up, I want to be a watermelon"), {
      ephemeral,
      salt: fromBase64Url(salt),
    });
    expect(toBase64Url(body)).toBe(expected);
  });

  test("a fresh key and salt each time, and the user agent's key opens it", async () => {
    const ua = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
    const point = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
    const { d } = await crypto.subtle.exportKey("jwk", ua.privateKey);
    if (d === undefined) throw new Error("no scalar");
    const authBytes = crypto.getRandomValues(new Uint8Array(16));
    const own: WebPushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: toBase64Url(point), auth: toBase64Url(authBytes) },
    };
    const plaintext = text.encode(JSON.stringify({ v: 1, kind: "needs-input", taskId: "t-1" }));
    const a = await encryptPayload(own, plaintext);
    const b = await encryptPayload(own, plaintext);
    expect(toBase64Url(a)).not.toBe(toBase64Url(b));
    expect(await decrypt(a, point, d, authBytes)).toEqual(plaintext);
    expect(await decrypt(b, point, d, authBytes)).toEqual(plaintext);
  });

  test("refuses an injected salt that is not 16 bytes", async () => {
    for (const length of [0, 15, 17]) {
      // oxlint-disable-next-line no-await-in-loop -- one length per case
      await expect(encryptPayload(sub, text.encode("x"), { salt: new Uint8Array(length) })).rejects.toThrow("16 bytes");
    }
  });

  test("refuses a payload past the bound, and accepts one at it", async () => {
    await expect(encryptPayload(sub, new Uint8Array(PUSH_ALERT_MAX_BYTES + 1))).rejects.toThrow("size bound");
    const body = await encryptPayload(sub, new Uint8Array(PUSH_ALERT_MAX_BYTES));
    // header 86 + payload + delimiter + 16-byte tag, inside the 4096-byte record a push service must take.
    expect(body).toHaveLength(86 + PUSH_ALERT_MAX_BYTES + 1 + 16);
  });
});

describe("vapidAuthorization", () => {
  const endpoint = "https://updates.push.services.mozilla.com/wpush/v2/abc?x=1";

  test("is a JWT for the endpoint's origin that expires in 12 h and verifies under the public key", async () => {
    const keys = await generateVapidKeys();
    const now = Date.parse("2026-10-25T10:00:00Z");
    const header = await vapidAuthorization(endpoint, keys, "https://relay.example", now);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/u.exec(header);
    expect(match).not.toBeNull();
    const [, head = "", claims = "", signature = "", k] = match ?? [];
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(head)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(claims)))).toEqual({
      aud: "https://updates.push.services.mozilla.com",
      exp: now / 1000 + 12 * 3600,
      sub: "https://relay.example",
    });
    const sig = fromBase64Url(signature);
    expect(sig).toHaveLength(64);
    const pub = await crypto.subtle.importKey(
      "raw",
      fromBase64Url(keys.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signed = text.encode(`${head}.${claims}`);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, signed)).toBe(true);
    // A different message does not verify: the check above is not vacuous.
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, text.encode("other"))).toBe(false);
  });
});
