import {
  SPAWN_ERROR_CODES,
  type Envelope,
  type MachineInfo,
  type RepoEntry,
  type RescanResponse,
  type SpawnErrorCode,
} from "./types.ts";

/**
 * The one home for wire-shape checks every tier shares. The relay layers its
 * bounds on top (`relay/src/wire.ts`); the app-role client and the Raycast
 * cache consume these directly. One copy, so a field added to a type cannot be
 * missed by whichever hand-written duplicate a session forgot existed.
 */

/** Arrays are records to `typeof`; every shape below is a keyed object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape only — the PSK, not this, decides authenticity, and the relay never
 * opens an envelope anyway. `v`'s value is never checked: forwarding unknown
 * versions lets the protocol move without a relay deploy, and the endpoints
 * reject what they can't open.
 */
export function parseEnvelope(value: unknown): Envelope | null {
  if (!isRecord(value)) return null;
  if (typeof value["v"] !== "number") return null;
  if (typeof value["to"] !== "string" || typeof value["from"] !== "string") return null;
  if (typeof value["iv"] !== "string" || typeof value["ct"] !== "string") return null;
  return { v: value["v"], to: value["to"], from: value["from"], iv: value["iv"], ct: value["ct"] };
}

export function parseRepoEntry(value: unknown): RepoEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value["name"] !== "string" || typeof value["path"] !== "string") return null;
  const defaultBranch = value["defaultBranch"];
  if (defaultBranch !== null && typeof defaultBranch !== "string") return null;
  return { name: value["name"], path: value["path"], defaultBranch };
}

/**
 * One unreadable repo invalidates the whole list rather than silently
 * shortening it: a picker missing the repo you wanted is worse than a machine
 * that reads as unavailable.
 */
export function parseRepoList(value: unknown): readonly RepoEntry[] | null {
  if (!Array.isArray(value)) return null;
  const repos: RepoEntry[] = [];
  for (const candidate of value) {
    const repo = parseRepoEntry(candidate);
    if (repo === null) return null;
    repos.push(repo);
  }
  return repos;
}

/**
 * The decrypted register blob. Inside the PSK boundary, so this is skew
 * tolerance rather than defence: a daemon a version ahead or behind must cost
 * one machine tile, not the render — `machine.repos.map(…)` runs on every frame
 * of the spawn screen. A projection of the fields the app reads:
 * `source`/`lastUpdate` back the daemon's own doctor/status surfaces and no
 * app-role client renders them.
 */
export function parseMachineInfo(value: unknown): MachineInfo | null {
  if (!isRecord(value)) return null;
  if (typeof value["name"] !== "string" || typeof value["platform"] !== "string") return null;
  if (typeof value["scannedAt"] !== "number") return null;
  const repos = parseRepoList(value["repos"]);
  if (repos === null) return null;
  return { name: value["name"], platform: value["platform"], repos, scannedAt: value["scannedAt"] };
}

/**
 * A `rescan` reply is the same repo walk as the register blob, and the same
 * skew story: the fields land on `machine.repos`/`scannedAt` and render every
 * frame, so an unchecked reply from a daemon a version ahead is the register
 * wedge by another door.
 */
export function parseRescanResponse(value: unknown): RescanResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value["scannedAt"] !== "number") return null;
  const repos = parseRepoList(value["repos"]);
  if (repos === null) return null;
  return { repos, scannedAt: value["scannedAt"] };
}

/** Receivers never reject on this — display routing only; the wire keeps `string`. */
export function isSpawnErrorCode(value: unknown): value is SpawnErrorCode {
  return SPAWN_ERROR_CODES.some((code) => code === value);
}
