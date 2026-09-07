import type { RepoEntry, SessionEntry, SpawnErrorCode, SpawnRequest } from "@seance/shared";
import type { Check } from "./check.ts";

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
  /**
   * Backend-scoped token for the thing that was started (the tmux window id
   * here), so the frontend can ask `capture` about it later. Never crosses the
   * wire — `handleSpawn` builds the response field by field to keep it out.
   */
  readonly handle?: string;
}

export interface SessionBackend {
  /**
   * Resolves `request.repo` by name against `repos` — the cached scan set, never
   * a path join (threat model). Throws `SpawnFailure` with a wire code.
   */
  readonly spawn: (request: SpawnRequest, repos: readonly RepoEntry[]) => Promise<SpawnOutcome>;
  readonly sessions: (repos: readonly RepoEntry[]) => Promise<readonly SessionEntry[]>;
  /** Backend-specific preflight for `seanced doctor`: binary presence, server probes. */
  readonly doctor: () => Promise<readonly Check[]>;
  /**
   * Whatever a started session is showing right now, for the one case the
   * frontend can diagnose but not see: spawn succeeded, the process is alive,
   * and it still never appeared in `sessions`. Optional — a backend with no
   * screen to read omits it and the ack just says less.
   */
  readonly capture?: (handle: string) => Promise<string | null>;
}
