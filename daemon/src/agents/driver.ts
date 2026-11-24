import type { AgentKind, SpawnRequest } from "@seance/shared";
import type { PaneInfo } from "../sessions.ts";

/**
 * The seam between the spawn path and the agent a pane runs (DESIGN.md, Daemon, "Agent drivers"). The spawn path
 * owns everything agent-neutral: the gates, the ledger, the worktree's name and any worktree it makes itself, the
 * seed's text, the window, the task tag, registration and harvest. A driver owns what only its agent knows: how a
 * session starts and resumes, what its pane looks like, and how it is asked to leave. Named driver, never adapter:
 * an adapter is messaging's (DESIGN.md, "Adapters").
 *
 * Small on purpose. Codex's session (`agents/codex.ts`; DESIGN.md, Daemon, "Codex sessions") is a second
 * implementation of exactly this: its run dir and script are `launch`, its `thread/start`, seed turn and thread id are
 * `started`, its run-dir mark is `panes`.
 */
export interface AgentDriver {
  readonly panes: AgentPanes;
  /**
   * Readies the agent to start in `spec.cwd` with no dialog a remote cannot answer (trust, fail-open) and returns
   * what the pane runs. Nothing runs yet: the spawn path opens the window, and calls `started` once it is tagged.
   */
  launch(spec: LaunchSpec): Promise<AgentLaunch>;
  /**
   * Asks the agent in `pane` to leave; true once the pane is gone (or, with `leaveDead`, dead), false when it
   * outlived `graceMs`. The caller kills a pane that outlived it, and its processes (`despawn.ts`, `killPane`).
   */
  close(pane: PaneInfo, opts: CloseOptions): Promise<boolean>;
}

/**
 * How a pane running this agent is told apart. Pure data, so the pane readers (`sessions.ts`, `tmux.ts`), which must
 * load no module that logs, can hold every driver's (`AGENT_PANES`) without loading any driver.
 */
export interface AgentPanes {
  readonly agent: AgentKind;
  /** A tmux `#{m:}` glob over `pane_start_command` that only a pane this driver launched matches (`OURS`). */
  readonly startMark: string;
  /** What tmux or `ps` calls the agent's process in a pane séance did not start; null when no such pane is a session. */
  readonly command: RegExp | null;
}

export interface LaunchSpec {
  /** Model, effort, autonomy and task id are read from it; every wire value reaching a shell string goes through `shq`. */
  readonly request: SpawnRequest;
  /** The session's display name (`sessionName`): what the agent's own UIs list. */
  readonly name: string;
  /** Where the session works: the worktree, or the checkout itself. A daemon path, canonical. */
  readonly cwd: string;
  /**
   * A fresh worktree spawn: the clone it belongs to and its name under `.claude/worktrees`. The worktree at `cwd`
   * may not exist yet; a driver whose agent does not make it is handed one the spawn path made.
   */
  readonly worktree?: { readonly clone: string; readonly name: string };
  /** A continuation: the session id this machine's own launch ledger noted for the continued task, never a wire value. */
  readonly resume?: string;
  /** The opening message, the spawn path's text: delivered as data, never argv. */
  readonly seed?: string;
  /** Directories the session may read besides `cwd` (fetched attachments). Daemon paths. */
  readonly readDirs: readonly string[];
  /** The owner's home, where exclaves live (`exclaves.ts`), and the exclave the repo sits in. */
  readonly home: string;
  readonly exclave: string;
}

export interface AgentLaunch {
  /** The window's start directory (tmux `-c`). */
  readonly dir: string;
  /** The pane's one shell string (DESIGN.md threat model: every wire value through `shq`). */
  readonly command: string;
  /** Extra `NAME=value` pairs for the window's environment (tmux `-e`), literals only. */
  readonly env: readonly string[];
  /**
   * Called once the window exists and carries its task, before registration is awaited: the session id to note in
   * the launch ledger, or undefined for an untracked spawn. A throw fails the spawn and the window is killed.
   */
  started(window: string): Promise<string | undefined>;
  /** After registration, whatever its outcome: removes what `launch` left on disk for the start (the seed file). */
  dispose(): Promise<void>;
}

export interface CloseOptions {
  readonly graceMs: number;
  /** A pane that dies is left for harvest to note and close (`despawn.ts`, `leaveDeadTask`). */
  readonly leaveDead: boolean;
}
