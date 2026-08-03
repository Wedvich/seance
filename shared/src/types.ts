export const PROTOCOL_VERSION = 1;

/** Routing id the app uses on the wire; daemons address responses to it. */
export const APP_ID = "app";

/**
 * Broadcast address: the relay fans an envelope addressed here to every
 * registered daemon socket except the sender. One seal reaches all machines —
 * the AAD binds `to`, so a group needs one shared address. Fire-and-forget:
 * no `undeliverable`, nothing correlates a broadcast; receivers allowlist
 * which ops may arrive group-addressed.
 */
export const MACHINES_ID = "machines";

/** WS upgrade paths. Role is fixed by path, so the app sends no register frame. */
export const DAEMON_PATH = "/daemon";
export const APP_PATH = "/app";
/** Browsers cannot set WS headers, so the app passes the bearer token as `?t=`. */
export const TOKEN_PARAM = "t";

/**
 * App-side close codes (4000–4999 is the app-defined range). A browser cannot
 * read the HTTP status of a failed WS handshake, so `/app` accepts the upgrade
 * and then closes with one of these; both are permanent, so the app must stop
 * reconnecting rather than back off. Daemons read the real 401 from `fetch`,
 * so `/daemon` keeps refusing pre-upgrade.
 */
export const CLOSE_BAD_REQUEST = 4400;
export const CLOSE_UNAUTHORIZED = 4401;

export const DEFAULT_MODEL = "opus";
export const DEFAULT_EFFORT = "medium";

/**
 * Encrypted envelope — all the relay sees besides routing. The 12-byte GCM
 * IV doubles as the replay nonce; `v|to|from` are bound as AAD so the relay
 * cannot re-address a captured blob.
 */
export interface Envelope {
  readonly v: number;
  readonly to: string;
  readonly from: string;
  /** base64, 12 bytes */
  readonly iv: string;
  /** base64, ciphertext + 16-byte GCM tag */
  readonly ct: string;
}

/**
 * Layer 1: plaintext daemon→relay frames. Heartbeats are the literal strings
 * "ping"/"pong" (not JSON) so DO auto-response can answer without waking.
 */
export type DaemonFrame =
  | { readonly t: "register"; readonly deviceId: string; readonly info: Envelope }
  | { readonly t: "msg"; readonly env: Envelope };

/** Layer 1: relay→daemon frames. */
export type RelayToDaemonFrame = { readonly t: "msg"; readonly env: Envelope };

/** Layer 1: app→relay frames. */
export type AppFrame = { readonly t: "msg"; readonly env: Envelope };

/** Why the relay could not hand an envelope to its target daemon. */
export type UndeliverableCode = "offline" | "unknown";

/**
 * Layer 1: relay→app frames. `registry` arrives on connect and on every
 * change. `undeliverable` correlates by `iv` — the request `id` lives inside
 * the ciphertext, so a blind relay has nothing else to echo. App-bound
 * envelopes go to every open app socket; clients drop unmatched `re`.
 */
export type RelayToAppFrame =
  | { readonly t: "registry"; readonly entries: readonly RegistryView[] }
  | { readonly t: "msg"; readonly env: Envelope }
  | {
      readonly t: "undeliverable";
      readonly to: string;
      readonly iv: string;
      readonly code: UndeliverableCode;
    };

/**
 * Machine registry as persisted by the Durable Object. Entries are permanent —
 * overwritten only by a later register.
 */
export interface RegistryEntry {
  readonly deviceId: string;
  /** Encrypted MachineInfo, AAD-bound to APP_ID. */
  readonly info: Envelope;
  /** Written on register and on close — the only liveness events the DO observes. */
  readonly lastSeen: number;
}

/**
 * A registry entry as sent to the app. `connected` is derived from open
 * sockets at read time and never persisted: heartbeats use DO auto-response
 * and never wake the object, so a stored flag would survive as a stale `true`
 * past an eviction.
 */
export type RegistryView = RegistryEntry & { readonly connected: boolean };

export type OpName = "sessions" | "spawn" | "rescan" | "machine-info" | "update-available";

/**
 * Ops that expect a response; `machine-info` is a stored blob and
 * `update-available` a fire-and-forget broadcast — neither correlates a reply.
 */
export type RequestOp = Exclude<OpName, "machine-info" | "update-available">;

/**
 * App-side response deadlines. A backstop rather than the primary error path —
 * the daemon returns a structured error on its own — so spawn's ceiling clears
 * exec.ts's 60s command timeout plus spawn.ts's 3s pane-death check.
 */
export const OP_TIMEOUT_MS = {
  sessions: 10_000,
  rescan: 15_000,
  spawn: 90_000,
} as const satisfies Record<RequestOp, number>;

/**
 * Heartbeat cadence, shared by both socket legs (daemon↔relay and app↔relay):
 * a bare "ping" every interval, "pong" expected within the deadline, a miss
 * closes/redials. The relay sweeps a daemon socket silent for
 * HEARTBEAT_MISSES_TO_SWEEP beats — derived from the interval there, so
 * slowing the beat can never silently outpace the sweep.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_PONG_TIMEOUT_MS = 10_000;
export const HEARTBEAT_MISSES_TO_SWEEP = 3;

/**
 * Decrypted message body. `ts` feeds the ±60s replay window; `re` correlates
 * a response to its request `id`. `machine-info` blobs are data at rest in
 * the registry — receivers skip the replay check for them.
 */
export interface Plain {
  readonly id: string;
  readonly ts: number;
  readonly op: OpName;
  readonly re?: string;
  readonly payload: unknown;
}

export interface RepoEntry {
  readonly name: string;
  readonly path: string;
  /** From local refs only (origin/HEAD on disk); null when unset. */
  readonly defaultBranch: string | null;
}

export interface SessionEntry {
  readonly window: string;
  /** Repo name mapped by path prefix; null when outside every known repo. */
  readonly repo: string | null;
  readonly path: string;
}

/** Git identity of a daemon's own checkout. `commitTs` is ms, like every other wire timestamp. */
export interface SourceInfo {
  readonly sha: string;
  readonly commitTs: number;
  /** Null on detached HEAD. */
  readonly branch: string | null;
}

/**
 * Self-update outcomes. The skips are deliberate refusals — a checkout that is
 * dirty, off its default branch, or diverged is someone's work in progress, and
 * an update must never force it.
 */
export const UPDATE_OUTCOMES = [
  "ok",
  "current",
  "skipped_dirty",
  "skipped_branch",
  "skipped_diverged",
  "fetch_failed",
  "install_failed",
  /** Updated on disk, but the restart that would run the new code failed — stranded, visibly. */
  "restart_failed",
] as const;

export type UpdateOutcome = (typeof UPDATE_OUTCOMES)[number];

/** Last self-update attempt, carried in the register blob so skips aren't silent. */
export interface UpdateReport {
  readonly at: number;
  readonly outcome: UpdateOutcome;
  readonly detail?: string;
}

/**
 * Broadcast payload (`op: "update-available"`, sealed to `"machines"`): the
 * announcer's new HEAD. Advisory only — receivers verify against their own
 * origin with ff-only, so a forged sha buys at most one extra fetch.
 */
export interface UpdateAvailable {
  readonly sha: string;
  readonly commitTs: number;
}

/**
 * Payload of the encrypted register blob (`op: "machine-info"`). `source` and
 * `lastUpdate` are optional on the wire — blobs from older daemons lack them,
 * and the app renders neither in v1 (doctor/status are the visibility surface).
 */
export interface MachineInfo {
  readonly name: string;
  readonly platform: string;
  readonly repos: readonly RepoEntry[];
  readonly scannedAt: number;
  readonly source?: SourceInfo | null;
  readonly lastUpdate?: UpdateReport | null;
}

export type SpawnMode = "worktree" | "here";

export interface SpawnRequest {
  readonly repo: string;
  readonly mode: SpawnMode;
  readonly prompt?: string;
  readonly title?: string;
  readonly model?: string;
  readonly effort?: string;
  /**
   * Which app-role client formed the request ("pwa", "mcp") — audit trail only,
   * so `origin=relay` stays separable into "my phone" vs "an agent on my
   * laptop". Optional on the wire: older clients don't send it, older daemons
   * ignore it. Free text by design — a daemon must never reject a spawn over a
   * client name minted after it was built.
   */
  readonly client?: string;
}

export const SPAWN_ERROR_CODES = [
  "repo_not_found",
  "fetch_failed",
  "no_default_branch",
  "launch_error",
  "claude_died",
  "timeout",
  "internal_error",
] as const;

export type SpawnErrorCode = (typeof SPAWN_ERROR_CODES)[number];

export type SpawnResponse =
  | {
      readonly ok: true;
      readonly window: string;
      readonly path: string;
      /** Non-fatal, e.g. "default branch diverged — basing worktree on local HEAD". */
      readonly note?: string;
      readonly sessions: readonly SessionEntry[];
    }
  | { readonly ok: false; readonly code: SpawnErrorCode; readonly message: string };

export interface SessionsResponse {
  readonly sessions: readonly SessionEntry[];
  readonly at: number;
}

export interface RescanResponse {
  readonly repos: readonly RepoEntry[];
  readonly scannedAt: number;
}

/** Reply payload when an op handler crashes; `re` still correlates it to the request. */
export interface ErrorResponse {
  readonly ok: false;
  readonly code: "internal_error";
  readonly message: string;
}
