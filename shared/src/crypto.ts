import { PROTOCOL_VERSION, type Envelope, type Plain } from "./types.ts";

const IV_BYTES = 12;
const PSK_BYTES = 32;

export const REPLAY_WINDOW_MS = 60_000;
export const REPLAY_RETAIN_MS = 120_000;

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importPsk(pskBase64: string): Promise<CryptoKey> {
  const raw = fromBase64(pskBase64);
  if (raw.byteLength !== PSK_BYTES) {
    throw new Error(`PSK must be ${PSK_BYTES} bytes, got ${raw.byteLength}`);
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// Both ends must produce identical AAD bytes or nothing decrypts — this
// helper is the single source of that encoding.
// The copy pins the buffer type: workerd types TextEncoder.encode as
// ArrayBufferLike-backed, while WebCrypto's BufferSource demands an ArrayBuffer.
function buildAad(v: number, to: string, from: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(`${v}|${to}|${from}`));
}

export async function seal(
  key: CryptoKey,
  route: { readonly to: string; readonly from: string },
  plain: Plain,
): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: buildAad(PROTOCOL_VERSION, route.to, route.from) },
    key,
    new TextEncoder().encode(JSON.stringify(plain)),
  );
  return {
    v: PROTOCOL_VERSION,
    to: route.to,
    from: route.from,
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ct)),
  };
}

/** Throws on version mismatch, malformed IV, or auth failure (tampering / re-addressing / wrong key). */
export async function open(key: CryptoKey, env: Envelope): Promise<Plain> {
  if (env.v !== PROTOCOL_VERSION) {
    throw new Error(`unsupported envelope version ${env.v}`);
  }
  const iv = fromBase64(env.iv);
  if (iv.byteLength !== IV_BYTES) {
    throw new Error(`IV must be ${IV_BYTES} bytes, got ${iv.byteLength}`);
  }
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: buildAad(env.v, env.to, env.from) },
    key,
    fromBase64(env.ct),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as Plain;
}

export type ReplayReason = "stale" | "future" | "replayed";

export class ReplayError extends Error {
  constructor(
    readonly reason: ReplayReason,
    message: string,
  ) {
    super(message);
    this.name = "ReplayError";
  }
}

/**
 * Rejects frames outside ±windowMs of local time and IVs already seen within
 * retainMs (2× window, so the cache always outlives what the ts check
 * accepts). Pruned lazily on check.
 */
export class ReplayGuard {
  readonly #seen = new Map<string, number>();

  constructor(
    private readonly windowMs: number = REPLAY_WINDOW_MS,
    private readonly retainMs: number = REPLAY_RETAIN_MS,
  ) {}

  check(iv: string, ts: number, now: number = Date.now()): void {
    for (const [seenIv, expiry] of this.#seen) {
      if (expiry <= now) this.#seen.delete(seenIv);
    }
    if (ts < now - this.windowMs) {
      throw new ReplayError("stale", `message ts ${ts} older than ${this.windowMs}ms window`);
    }
    if (ts > now + this.windowMs) {
      throw new ReplayError("future", `message ts ${ts} more than ${this.windowMs}ms ahead`);
    }
    if (this.#seen.has(iv)) {
      throw new ReplayError("replayed", "IV already seen inside retain window");
    }
    this.#seen.set(iv, now + this.retainMs);
  }
}
