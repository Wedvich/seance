import {
  APP_ID,
  ENVELOPE_MAX_CT_LENGTH,
  IDENTITY_PUBLIC_KEY_BYTES,
  IDENTITY_SIGNATURE_BYTES,
  base64Length,
  isRecord,
  isTerm,
  MACHINES_ID,
  MAX_REGISTER_ROLES,
  parseEnvelope as parseEnvelopeShape,
  ROUTING_ID_CHARS,
  ROUTING_ID_MAX_LENGTH,
  SCHEDULER_ID,
  STATUS_MAX_CT_LENGTH,
  STORE_CREATE_MAX_CT_LENGTH,
  STORE_KEY_PATTERN,
  STORE_MAX_CT_LENGTH,
  STORE_PREFIXES,
  type AppFrame,
  type DaemonFrame,
  type Envelope,
  type StoreErrorCode,
  type StorePrefix,
  type StoreRequestFrame,
} from "@seance/shared";

/**
 * Which socket a frame arrived on, fixed by the upgrade path (`auth.ts`
 * re-exports it). Defined here because the pure modules and their tests reach
 * it, and `auth.ts` uses a workerd-only API the test project's types lack.
 */
export type Role = "daemon" | "app";

/**
 * Bounds, not shapes. `deviceId` is an identifier rather than a credential, so
 * the job here is to stop a bearer-token holder writing absurd storage keys or
 * oversized values — not to prove an id well-formed. Enforcing exact UUIDs
 * would buy no security property the length and charset caps don't.
 */
const MAX_ID_LENGTH = ROUTING_ID_MAX_LENGTH;
const MAX_IV_LENGTH = 32;

const SAFE_ID = new RegExp(`^[${ROUTING_ID_CHARS}]+$`, "u");

/**
 * A `lead-proof` seals one small fixed-shape payload (`{ term }` plus the
 * envelope's id, ts and op), about 160 base64 chars; this leaves headroom
 * without letting it carry anything else into the leader record.
 */
export const LEAD_PROOF_MAX_CT_LENGTH = 512;

/**
 * A register's key and signature are fixed-size for the one algorithm in use,
 * so the bound is exact: anything else is refused here, before the digest and
 * the verify in `#register` are paid for.
 */
const KEY_LENGTH = base64Length(IDENTITY_PUBLIC_KEY_BYTES);
const SIG_LENGTH = base64Length(IDENTITY_SIGNATURE_BYTES);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

function exactBase64(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length === length && BASE64.test(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value !== "" && value.length <= max;
}

/** Routing ids reach storage keys and logs, so they stay short and boring. */
function routableId(value: unknown): value is string {
  return boundedString(value, MAX_ID_LENGTH) && SAFE_ID.test(value);
}

/**
 * What a register may name itself. APP_ID, MACHINES_ID and SCHEDULER_ID are wire
 * addresses, not machines: a daemon squatting one would show up as a machine
 * called "app", swallow every broadcast addressed to the group, or every
 * envelope for the leader.
 */
export function isDeviceId(value: unknown): value is string {
  return routableId(value) && value !== APP_ID && value !== MACHINES_ID && value !== SCHEDULER_ID;
}

/**
 * Raw, not narrowed to the roles this relay knows: the signature covers the
 * list as sent, so dropping an unknown one here would fail a newer daemon's
 * register outright. The id charset is what keeps v2's `,`-joined message
 * unambiguous (`shared/src/identity.ts`).
 */
function parseRoles(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_REGISTER_ROLES) return null;
  return value.every(routableId) ? [...value] : null;
}

/** A term is a counter the relay minted, so anything but a non-negative integer is malformed. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * The shared shape check plus this tier's bounds. The relay never opens an
 * envelope — `iv`/`ct` stay opaque strings to it — but they reach DO storage
 * keys and logs, which is what the caps and charset protect.
 */
export function parseEnvelope(value: unknown, maxCtLength = ENVELOPE_MAX_CT_LENGTH): Envelope | null {
  const env = parseEnvelopeShape(value);
  if (env === null) return null;
  if (!routableId(env.to) || !routableId(env.from)) return null;
  if (!boundedString(env.iv, MAX_IV_LENGTH)) return null;
  if (!boundedString(env.ct, maxCtLength)) return null;
  return env;
}

/**
 * A store request the relay can correlate but not accept. Never on the wire: the
 * hub answers it `store-refused`. A frame without a usable `id` has nothing to
 * answer to and parses to null instead.
 */
export interface StoreRejected {
  readonly t: "store-rejected";
  readonly id: string;
  readonly code: Extract<StoreErrorCode, "invalid_request" | "too_large">;
}

const STORE_REQUEST_TYPES: ReadonlySet<unknown> = new Set(["store-list", "store-get", "store-put", "store-delete"]);

/** Narrows to the store requests of whichever leg's union it is handed, term-less app variants included. */
export function isStoreRequest<T extends { readonly t: string }>(
  frame: T,
): frame is Extract<T, { readonly t: StoreRequestFrame["t"] }> {
  return STORE_REQUEST_TYPES.has(frame.t);
}

const LIST_PREFIXES: ReadonlySet<string> = new Set(Object.values(STORE_PREFIXES).map((rule) => rule.prefix));

function isStorePrefix(value: unknown): value is StorePrefix {
  return typeof value === "string" && LIST_PREFIXES.has(value);
}

function isStoreKeyShape(value: unknown): value is string {
  return typeof value === "string" && STORE_KEY_PATTERN.test(value);
}

/**
 * Bounds and shapes of the four store frames. The ciphertext is parsed
 * unbounded and measured after, so an oversized one is `too_large` rather than
 * indistinguishable from a malformed frame; the WebSocket message cap bounds it
 * at the transport. A `term` is a daemon-leg field only: on the app leg it is
 * dropped here, so nothing downstream can read it as authority.
 */
function parseStoreFrame(value: Record<string, unknown>, leg: Role): StoreRequestFrame | StoreRejected | null {
  const t = value["t"];
  if (!STORE_REQUEST_TYPES.has(t)) return null;
  // Nothing to correlate a reply with, so nothing to answer.
  const id = value["id"];
  if (!routableId(id)) return null;
  const reject = (code: StoreRejected["code"]): StoreRejected => ({ t: "store-rejected", id, code });

  if (t === "store-list") {
    // Other fields (`after`) are ignored: a relay without paging answers the whole prefix.
    const prefix = value["prefix"];
    return isStorePrefix(prefix) ? { t: "store-list", id, prefix } : reject("invalid_request");
  }
  const key = value["key"];
  if (!isStoreKeyShape(key)) return reject("invalid_request");
  if (t === "store-get") return { t: "store-get", id, key };

  const expect = value["expect"];
  if (!isTerm(expect)) return reject("invalid_request");
  const termValue = value["term"];
  if (leg === "daemon" && termValue !== undefined && !isTerm(termValue)) return reject("invalid_request");
  const term = leg === "daemon" && isTerm(termValue) ? { term: termValue } : {};

  if (t === "store-delete") return { t: "store-delete", id, key, expect, ...term };

  const env = parseEnvelope(value["env"], Number.POSITIVE_INFINITY);
  if (env === null) return reject("invalid_request");
  if (env.ct.length > (expect === 0 ? STORE_CREATE_MAX_CT_LENGTH : STORE_MAX_CT_LENGTH)) return reject("too_large");
  return { t: "store-put", id, key, expect, env, ...term };
}

export function parseDaemonFrame(text: string): DaemonFrame | StoreRejected | null {
  const value = parseJson(text);
  if (!isRecord(value)) return null;
  if (STORE_REQUEST_TYPES.has(value["t"])) return parseStoreFrame(value, "daemon");
  if (value["t"] === "register") {
    const info = parseEnvelope(value["info"]);
    const id = value["deviceId"];
    if (info === null || !isDeviceId(id)) return null;
    if (!exactBase64(value["key"], KEY_LENGTH) || !exactBase64(value["sig"], SIG_LENGTH)) return null;
    if (typeof value["ts"] !== "number" || !Number.isFinite(value["ts"])) return null;
    const roles = value["roles"] === undefined ? undefined : parseRoles(value["roles"]);
    if (roles === null) return null;
    return {
      t: "register",
      deviceId: id,
      info,
      key: value["key"],
      ts: value["ts"],
      sig: value["sig"],
      ...(roles === undefined ? {} : { roles }),
    };
  }
  if (value["t"] === "msg") {
    const env = parseEnvelope(value["env"]);
    return env === null ? null : { t: "msg", env };
  }
  if (value["t"] === "status") {
    // Tighter than a msg: it lands on the socket attachment (2 KiB, shared with
    // the socket's identity), not in a storage value.
    const env = parseEnvelope(value["env"], STATUS_MAX_CT_LENGTH);
    return env === null ? null : { t: "status", env };
  }
  if (value["t"] === "lead-proof") {
    const env = parseEnvelope(value["env"], LEAD_PROOF_MAX_CT_LENGTH);
    const term = value["term"];
    return env === null || !isTerm(term) ? null : { t: "lead-proof", term, env };
  }
  return null;
}

export function parseAppFrame(text: string): AppFrame | StoreRejected | null {
  const value = parseJson(text);
  if (!isRecord(value)) return null;
  if (STORE_REQUEST_TYPES.has(value["t"])) return parseStoreFrame(value, "app");
  if (value["t"] === "forget") {
    // Same bounds as a register's deviceId: it reaches a storage key and a log line.
    return routableId(value["deviceId"]) ? { t: "forget", deviceId: value["deviceId"] } : null;
  }
  if (value["t"] !== "msg") return null;
  const env = parseEnvelope(value["env"]);
  if (env === null) return null;
  const term = value["term"];
  if (term === undefined) return { t: "msg", env };
  return isTerm(term) ? { t: "msg", env, term } : null;
}
