export const PROTOCOL_VERSION = 1;

/** Routing id the PWA uses on the wire; daemons address responses to it. */
export const PHONE_ID = "phone";

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
export type RelayFrame = { readonly t: "msg"; readonly env: Envelope };

export type OpName = "sessions" | "spawn" | "rescan" | "machine-info";

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

/** Payload of the encrypted register blob (`op: "machine-info"`). */
export interface MachineInfo {
  readonly name: string;
  readonly platform: string;
  readonly repos: readonly RepoEntry[];
  readonly scannedAt: number;
}

export type SpawnMode = "worktree" | "here";

export interface SpawnRequest {
  readonly repo: string;
  readonly mode: SpawnMode;
  readonly prompt?: string;
  readonly title?: string;
  readonly model?: string;
  readonly effort?: string;
}

export const SPAWN_ERROR_CODES = [
  "repo_not_found",
  "fetch_failed",
  "no_default_branch",
  "tmux_error",
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
