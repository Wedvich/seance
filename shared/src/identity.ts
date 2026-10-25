import { fromBase64, toBase64, toBase64Url } from "./crypto.ts";

/**
 * A machine's identity is a signing keypair, and its deviceId is the hash of
 * the public key — so an id is a claim only its holder can make good on. A
 * register carries the public key and a signature, and the relay, blind to the
 * PSK, can still verify both: the key hashes to the id, and the signature was
 * made with that key. Without this a register proved only bearer-token
 * possession, and no rule about which socket keeps a route could refuse both
 * an eviction and a squat (DESIGN.md, threat model item 3).
 *
 * ML-DSA-65 (FIPS 204, NIST level 3): the key is minted once and outlives every
 * reinstall of the daemon that keeps its state dir, which is the long-lived
 * kind that post-quantum guidance draws the level-3 floor under. Available in
 * Bun's WebCrypto and on Workers behind the `webcrypto_modern_algorithms`
 * compatibility flag; the formats below are the draft Modern Algorithms API's,
 * and `raw-seed` is why the daemon stores 32 bytes rather than a private key.
 */
export const IDENTITY_ALGORITHM = "ML-DSA-65";
export const IDENTITY_SEED_BYTES = 32;
export const IDENTITY_PUBLIC_KEY_BYTES = 1952;
export const IDENTITY_SIGNATURE_BYTES = 3309;

/** base64 length of a byte count, for the relay's bounds on the wire. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * The register timestamp is accepted within this window either side of the
 * relay's clock. Freshness, not replay protection in the envelope sense: only
 * the relay ever sees a signature, so the window just keeps a captured register
 * from being replayed indefinitely by anything that did see one.
 */
export const REGISTER_FRESHNESS_MS = 60_000;

export interface Identity {
  readonly deviceId: string;
  /** base64 of the raw public key — what the register frame carries. */
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
}

export function generateIdentitySeed(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(IDENTITY_SEED_BYTES));
}

/**
 * Hash, not the key itself: ids reach storage keys, log lines and AAD, and
 * 1952 bytes of key is none of those things. base64url without padding keeps
 * it inside the relay's `[A-Za-z0-9._-]` id charset.
 */
export async function deviceIdOf(publicKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey));
  return toBase64Url(digest);
}

export async function identityFromSeed(seed: Uint8Array<ArrayBuffer>): Promise<Identity> {
  if (seed.byteLength !== IDENTITY_SEED_BYTES) {
    throw new Error(`identity seed must be ${IDENTITY_SEED_BYTES} bytes, got ${seed.byteLength}`);
  }
  const privateKey = await crypto.subtle.importKey("raw-seed", seed, { name: IDENTITY_ALGORITHM }, true, ["sign"]);
  const publicKey = await crypto.subtle.getPublicKey(privateKey, ["verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw-public", publicKey));
  return { deviceId: await deviceIdOf(raw), publicKey: toBase64(raw), privateKey };
}

/**
 * One encoding on both ends, or nothing verifies — the signature's
 * domain-separated message. v1 covers the route alone; v2, under its own tag so
 * neither message can be read as the other, also covers `roles`, the one other
 * register field the relay acts on. The join is unambiguous because the relay
 * admits role strings only from its id charset, which has neither `,` nor `|`.
 */
function registerMessage(deviceId: string, ts: number, roles?: readonly string[]): Uint8Array<ArrayBuffer> {
  const text =
    roles === undefined
      ? `seance-register|${deviceId}|${ts}`
      : `seance-register-v2|${deviceId}|${ts}|${roles.join(",")}`;
  return new Uint8Array(new TextEncoder().encode(text));
}

/** `roles` absent signs v1; present (even empty) signs v2, and the frame must carry exactly that list. */
export async function signRegister(identity: Identity, ts: number, roles?: readonly string[]): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: IDENTITY_ALGORITHM },
    identity.privateKey,
    registerMessage(identity.deviceId, ts, roles),
  );
  return toBase64(new Uint8Array(sig));
}

export type RegisterVerdict = "ok" | "key-id-mismatch" | "bad-signature" | "stale" | "malformed";

/**
 * The relay's check, in the order a forgery fails cheapest: the key must hash
 * to the id before any signature is examined, so a key the caller minted for an
 * id it does not own is refused on a digest. `now` is the relay's clock.
 *
 * A claim with `roles` verifies against v2 only, never falling back to v1: a
 * signature that does not cover the roles a frame carries is a bad signature,
 * not a roleless register, so nothing can splice roles onto a v1 register.
 */
export async function verifyRegister(
  claim: {
    readonly deviceId: string;
    readonly publicKey: string;
    readonly ts: number;
    readonly sig: string;
    readonly roles?: readonly string[];
  },
  now: number,
): Promise<RegisterVerdict> {
  if (Math.abs(now - claim.ts) > REGISTER_FRESHNESS_MS) return "stale";
  let raw: Uint8Array<ArrayBuffer>;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(claim.publicKey);
    sig = fromBase64(claim.sig);
  } catch {
    return "malformed";
  }
  if (raw.byteLength !== IDENTITY_PUBLIC_KEY_BYTES || sig.byteLength !== IDENTITY_SIGNATURE_BYTES) return "malformed";
  if ((await deviceIdOf(raw)) !== claim.deviceId) return "key-id-mismatch";
  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey("raw-public", raw, { name: IDENTITY_ALGORITHM }, false, ["verify"]);
  } catch {
    return "malformed";
  }
  const ok = await crypto.subtle.verify(
    { name: IDENTITY_ALGORITHM },
    publicKey,
    sig,
    registerMessage(claim.deviceId, claim.ts, claim.roles),
  );
  return ok ? "ok" : "bad-signature";
}
