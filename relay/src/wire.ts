import type { AppFrame, DaemonFrame, Envelope } from "@seance/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
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
  if (!nonEmptyString(value["to"])) return null;
  if (!nonEmptyString(value["from"])) return null;
  if (!nonEmptyString(value["iv"])) return null;
  if (!nonEmptyString(value["ct"])) return null;
  return { v: value["v"], to: value["to"], from: value["from"], iv: value["iv"], ct: value["ct"] };
}

export function parseDaemonFrame(text: string): DaemonFrame | null {
  const value = parseJson(text);
  if (!isRecord(value)) return null;
  if (value["t"] === "register") {
    const info = parseEnvelope(value["info"]);
    if (info === null || !nonEmptyString(value["deviceId"])) return null;
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
