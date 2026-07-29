import type { RepoEntry, SessionEntry, SpawnErrorCode, SpawnRequest } from "@seance/shared";

/**
 * The seam between the daemon's protocol frontend (relay client, handlers,
 * config/state/scan/audit) and whatever actually launches a session. A fork
 * that runs sessions somewhere other than tmux replaces one factory
 * (`backend-default.ts`) and keeps the frontend as upstream — so the contract
 * a backend has to reference lives here, not in the tmux implementation that
 * such a fork deletes.
 */

export class SpawnFailure extends Error {
  constructor(
    readonly code: SpawnErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SpawnFailure";
  }
}

export interface SpawnOutcome {
  readonly window: string;
  readonly path: string;
  readonly note?: string;
}

/** `doctor`'s three outcomes; `fail` is what makes it exit nonzero. */
export interface BackendCheck {
  readonly level: "ok" | "warn" | "fail";
  readonly message: string;
}

export interface SessionBackend {
  /**
   * Resolves `request.repo` by name against `repos` — the cached scan set, never
   * a path join (threat model). Throws `SpawnFailure` with a wire code.
   */
  readonly spawn: (request: SpawnRequest, repos: readonly RepoEntry[]) => Promise<SpawnOutcome>;
  readonly sessions: (repos: readonly RepoEntry[]) => Promise<readonly SessionEntry[]>;
  /** Backend-specific preflight for `seanced doctor`: binary presence, server probes. */
  readonly doctor: () => Promise<readonly BackendCheck[]>;
}
