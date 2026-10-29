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
    /** With `task_running`: the `SessionEntry.id` already running the task. */
    readonly id?: string,
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
  /**
   * The tmux server pid, present when the task's pane keeps its dead pane and its `pane-died` hook for
   * harvest (`remain-on-exit on` past registration). Absent when it could not be read or the hook was
   * not set: the task is then never judged `vanished`. Backend-scoped: never goes on the wire.
   */
  readonly server?: number;
  /**
   * The Claude session id the task's session runs under: chosen by the backend for a new task
   * (`--session-id`), the continued one's for a continuation (`--resume`). Noted in the launch
   * ledger; backend-scoped, never on the wire.
   */
  readonly session?: string;
}

/** What a frontend resolved of a continued task's last launch from its own ledger. */
export interface Continuation {
  readonly path: string;
  /** The session id that launch's ledger note holds, which the continuation resumes. */
  readonly session: string;
  /** The continued task's exit status as its own ledger note recorded; absent when none was noted. Words the seed only. */
  readonly exit?: number;
  /** The earlier window was closed from outside (`TaskProgress.vanished`); worded in the preamble. */
  readonly vanished?: true;
}

/** One fetched attachment, for the seed: `name` is display text only, never part of `path`. */
export interface StagedFile {
  readonly path: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

/**
 * What the frontend fetched for a spawn (`attachments.ts`): directories the session may read
 * (`--add-dir`), and the files to list in its seed. A continuation gets the directories its
 * worktree's earlier tasks fetched and no files. Daemon paths, never wire values.
 */
export interface SessionAttachments {
  readonly dirs: readonly string[];
  readonly files: readonly StagedFile[];
}

export interface SessionBackend {
  /**
   * Resolves `request.repo` by name against `repos` — the cached scan set, never
   * a path join (threat model). Throws `SpawnFailure` with a wire code. A
   * `taskId` must survive the daemon (a restarted one still refuses its
   * duplicate) and be reported back by `sessions`; a duplicate throws
   * `task_running` carrying the running session's id.
   *
   * `continuation` is the frontend's own resolution of a `mode: "continue"` request's
   * worktree, from its launch ledger and already checked — it never rides the wire
   * request; its `exit` comes from the ledger too. A backend that cannot continue a session throws
   * `SpawnFailure("not_continuable")`.
   *
   * `attachments` is what the frontend already fetched and verified; a backend hands the session
   * every directory and lists every file, or must not start it.
   */
  readonly spawn: (
    request: SpawnRequest,
    repos: readonly RepoEntry[],
    continuation?: Continuation,
    attachments?: SessionAttachments,
  ) => Promise<SpawnOutcome>;
  readonly sessions: (repos: readonly RepoEntry[]) => Promise<readonly SessionEntry[]>;
  /**
   * Ends the session `id` names — a `SessionEntry.id` this backend handed out,
   * which it must validate before acting on: the id is wire-supplied. Throws
   * `DespawnFailure` with a wire code. Optional: a backend that can't stop a
   * session can still start them, and the frontend answers for it.
   */
  readonly despawn?: (
    id: string,
    opts: {
      readonly force: boolean;
      readonly closing?: (taskId: string) => Promise<unknown>;
      readonly leaveDeadTask?: boolean;
    },
  ) => Promise<DespawnResult>;
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
  /** Undoes whatever `start` left running; called on every daemon stop, started or not. */
  readonly stop?: () => void;
}
