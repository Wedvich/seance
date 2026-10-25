import { toBase64Url, type VapidKeys } from "@seance/shared";

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
