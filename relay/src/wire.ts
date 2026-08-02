import { APP_ID, MACHINES_ID, type AppFrame, type DaemonFrame, type Envelope } from "@seance/shared";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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

/** Shape only — the relay never opens an envelope, so `iv`/`ct` are opaque strings to it. */
export function parseEnvelope(value: unknown): Envelope | null {
  if (!isRecord(value)) return null;
  // `v`'s value is never checked: forwarding unknown versions lets the protocol
  // move without a relay deploy, and the endpoints reject what they can't open.
  if (typeof value["v"] !== "number") return null;
  if (!routableId(value["to"])) return null;
  if (!routableId(value["from"])) return null;
  if (!boundedString(value["iv"], MAX_IV_LENGTH)) return null;
  if (!boundedString(value["ct"], MAX_CT_LENGTH)) return null;
  return { v: value["v"], to: value["to"], from: value["from"], iv: value["iv"], ct: value["ct"] };
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
  if (!isRecord(value) || value["t"] !== "msg") return null;
  const env = parseEnvelope(value["env"]);
  return env === null ? null : { t: "msg", env };
}
