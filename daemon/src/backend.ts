import type {
  DespawnErrorCode,
  DespawnOutcome,
  RepoEntry,
  SessionEntry,
  SpawnErrorCode,
  SpawnRequest,
} from "@seance/shared";
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

/** `SpawnFailure`'s counterpart for `despawn`: a wire code plus a message for the human. */
export class DespawnFailure extends Error {
  constructor(
    readonly code: DespawnErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DespawnFailure";
  }
}

export interface DespawnResult {
  /** The window the session ran in, for the audit line and the reply. */
  readonly window: string;
  readonly outcome: DespawnOutcome;
}

export interface SpawnOutcome {
  readonly window: string;
  readonly path: string;
  readonly note?: string;
  /**
   * Whether the session had shown up in `sessions` by the time spawn returned.
   * `false` is the one outcome the frontend can name but not see: the process
   * is alive, so this is no failure, yet it never registered — a claude on a
   * startup dialog no remote can answer. The ack carries it as `pending`.
   */
  readonly registered: boolean;
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
  /**
   * Ends the session `id` names — a `SessionEntry.id` this backend handed out,
   * which it must validate before acting on: the id is wire-supplied. Throws
   * `DespawnFailure` with a wire code. Optional: a backend that can't stop a
   * session can still start them, and the frontend answers for it.
   */
  readonly despawn?: (id: string, opts: { readonly force: boolean }) => Promise<DespawnResult>;
  /** Backend-specific preflight for `seanced doctor`: binary presence, server probes. */
  readonly doctor: () => Promise<readonly Check[]>;
  /**
   * Whatever a started session is showing right now, for the one case the
   * frontend can diagnose but not see: spawn succeeded, the process is alive,
   * and it still never appeared in `sessions`. Optional — a backend with no
   * screen to read omits it and the ack just says less.
   */
  readonly capture?: (handle: string) => Promise<string | null>;
  /**
   * Runs on every daemon start — boot and each config reload, which restarts
   * the daemon whole. Optional; a failure is logged, never fatal.
   */
  readonly start?: () => Promise<void>;
}
