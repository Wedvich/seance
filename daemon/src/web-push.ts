import {
  fromBase64Url,
  PUSH_ALERT_MAX_BYTES,
  toBase64Url,
  type VapidKeys,
  type WebPushSubscription,
} from "@seance/shared";

/**
 * Web Push on WebCrypto alone (DESIGN.md records zero crypto dependencies, so no
 * `web-push` package). Scheduler-free.
 */

/**
 * A fresh VAPID keypair (RFC 8292): an ECDSA P-256 pair, the public half as the
 * raw uncompressed point (65 bytes) and the private half as the JWK's `d` (32
 * bytes), both unpadded base64url — what `parseSettingsRecord` accepts and
 * what a browser's `applicationServerKey` is.
 */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (d === undefined) throw new Error("the exported VAPID private key has no scalar");
  return { publicKey: toBase64Url(publicKey), privateKey: d };
}

const utf8 = new TextEncoder();

/** One 4096-byte record (RFC 8188): the header names it, and a payload this small never needs a second. */
const RECORD_SIZE = 4096;

/** The header's `keyid` is the sender's public key: an uncompressed P-256 point. */
const POINT_BYTES = 65;

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
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

/**
 * A push body for one subscription: RFC 8291 `aes128gcm`, a single record. The
 * plaintext is padded with only the delimiter, so a push service sees a length
 * that is the payload's plus fixed framing — fine, since the payload carries
 * ids and state, never anything whose length matters. `opts` exist for the
 * RFC's Appendix A vector, which fixes the sender's key and the salt; production
 * leaves them out, so every push uses a fresh key and salt.
 */
export async function encryptPayload(
  sub: WebPushSubscription,
  plaintext: Uint8Array,
  opts: { readonly ephemeral?: CryptoKeyPair; readonly salt?: Uint8Array<ArrayBuffer> } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > PUSH_ALERT_MAX_BYTES) throw new Error("the push payload is over its size bound");
  const uaPublic = fromBase64Url(sub.keys.p256dh);
  const auth = fromBase64Url(sub.keys.auth);
  const ephemeral =
    opts.ephemeral ?? (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]));
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256),
  );
  const ikm = await hkdf(auth, secret, concat(utf8.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 closes the last (here the only) record.
  const record = concat(plaintext, new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record));
  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = POINT_BYTES;
  return concat(header, asPublic, cipher);
}

/** A VAPID JWT lives this long (RFC 8292 caps it at 24 h; half that leaves room for clock skew). */
const VAPID_TTL_S = 12 * 3600;

/**
 * The `Authorization` header (RFC 8292) that tells a push service which
 * application server sends: a JWT scoped to the endpoint's origin, signed with
 * the VAPID private key, and the public key beside it. `sub` is a contact URI
 * the service may use to reach the operator (Apple refuses a push without one).
 */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, sub: string, now: number): Promise<string> {
  const point = fromBase64Url(keys.publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(point.subarray(1, 33)),
    y: toBase64Url(point.subarray(33, 65)),
    d: keys.privateKey,
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (value: unknown): string => toBase64Url(utf8.encode(JSON.stringify(value)));
  const signing = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + VAPID_TTL_S,
    sub,
  })}`;
  // WebCrypto's ECDSA signature is already the fixed-width r || s that JWS wants, not DER.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8.encode(signing)),
  );
  return `vapid t=${signing}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}
