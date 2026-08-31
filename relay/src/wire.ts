import {
  APP_ID,
  isRecord,
  MACHINES_ID,
  parseEnvelope as parseEnvelopeShape,
  type AppFrame,
  type DaemonFrame,
  type Envelope,
} from "@seance/shared";

/**
 * Bounds, not shapes. `deviceId` is an identifier rather than a credential, so
 * the job here is to stop a bearer-token holder writing absurd storage keys or
 * oversized values — not to prove an id well-formed. Enforcing exact UUIDs
 * would buy no security property the length and charset caps don't.
 */
const MAX_ID_LENGTH = 64;
const MAX_IV_LENGTH = 32;

/** A DO value caps at 128 KiB; a register blob for ~60 repos is nearer 12 KiB. */
const MAX_CT_LENGTH = 64 * 1024;

const SAFE_ID = /^[A-Za-z0-9._-]+$/u;

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value !== "" && value.length <= max;
}

/** Routing ids reach storage keys and logs, so they stay short and boring. */
function routableId(value: unknown): value is string {
  return boundedString(value, MAX_ID_LENGTH) && SAFE_ID.test(value);
}

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
export function parseEnvelope(value: unknown): Envelope | null {
  const env = parseEnvelopeShape(value);
  if (env === null) return null;
  if (!routableId(env.to) || !routableId(env.from)) return null;
  if (!boundedString(env.iv, MAX_IV_LENGTH)) return null;
  if (!boundedString(env.ct, MAX_CT_LENGTH)) return null;
  return env;
}

export function parseDaemonFrame(text: string): DaemonFrame | null {
  const value = parseJson(text);
  if (!isRecord(value)) return null;
  if (value["t"] === "register") {
    const info = parseEnvelope(value["info"]);
    if (info === null || !routableId(value["deviceId"])) return null;
    // APP_ID and MACHINES_ID are wire addresses, not machines: a daemon
    // squatting one would show up as a machine called "app" or swallow every
    // broadcast addressed to the group.
    if (value["deviceId"] === APP_ID || value["deviceId"] === MACHINES_ID) return null;
    return { t: "register", deviceId: value["deviceId"], info };
  }
  if (value["t"] === "msg") {
    const env = parseEnvelope(value["env"]);
    return env === null ? null : { t: "msg", env };
  }
  return null;
}

export function parseAppFrame(text: string): AppFrame | null {
  const value = parseJson(text);
  if (!isRecord(value)) return null;
  if (value["t"] === "forget") {
    // Same bounds as a register's deviceId: it reaches a storage key and a log line.
    return routableId(value["deviceId"]) ? { t: "forget", deviceId: value["deviceId"] } : null;
  }
  if (value["t"] !== "msg") return null;
  const env = parseEnvelope(value["env"]);
  return env === null ? null : { t: "msg", env };
}
