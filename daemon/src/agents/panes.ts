import type { AgentKind } from "@seance/shared";
import type { AgentPanes } from "./driver.ts";

/**
 * Claude's panes. A séance spawn's start command is its `exec … claude … --remote-control` line, and nothing a session
 * does changes a pane's start command, so the flag marks it whatever the process is called.
 *
 * What tmux reports as a claude pane's foreground command depends on the host, not on claude: macOS tmux reads the
 * kernel's comm, the *resolved* executable's basename — the native installer keeps the binary under a versioned
 * filename, so "2.1.267" — while Linux (and WSL) tmux reads argv[0], the symlink name "claude". Not "node": an
 * npm-installed claude runs as one, but so does every dev server, and under a title-setting shell such a pane would
 * list as a session. Hand-started npm claudes are the cost; séance's own are recognised by `startMark` regardless.
 */
export const CLAUDE_PANES = {
  agent: "claude",
  startMark: "*--remote-control*",
  command: /^(?:claude|\d+\.\d+\.\d+)$/u,
  process: /^(?:claude|\d+\.\d+\.\d+)$/u,
} as const satisfies AgentPanes;

/**
 * A Codex session's run dir (`agents/codex.ts`): the literal `/tmp`, never `tmpdir()`, as the custodian's
 * `/tmp/seance-cu-`, so the start command's path, and with it the mark, is the same on every host.
 */
export const CODEX_RUN_PREFIX = "/tmp/seance-cx-";

/**
 * Codex's panes: the start command is `exec [caffeinate -is ]/bin/sh '/tmp/seance-cx-…/run.sh'`, and only a run dir
 * the daemon made carries the prefix. No `command`: a hand-started `codex` runs on the owner's own home, not
 * Séance's, and is no session of Séance's to list, close or bind.
 */
export const CODEX_PANES: AgentPanes = {
  agent: "codex",
  startMark: `*${CODEX_RUN_PREFIX}*`,
  command: null,
  // The native binary's own name on every install (the npm package's `node` wrapper execs it): the server and the
  // TUI both carry it, and the server is the innermost on any chain from a tool or an MCP server.
  process: /^codex$/u,
};

/** The panes of one agent. */
export function panesOf(agent: AgentKind): AgentPanes {
  return AGENT_PANES.find((pane) => pane.agent === agent) ?? CLAUDE_PANES;
}

/** Every driver's panes (`AgentDriver.panes`): what the pane readers recognise. */
export const AGENT_PANES: readonly AgentPanes[] = [CLAUDE_PANES, CODEX_PANES];

/** The `OURS` tmux format: 1 when a pane's start command carries any driver's mark. */
export function oursFormat(panes: readonly AgentPanes[]): string {
  const marks = panes.map((pane) => `#{m:${pane.startMark},#{pane_start_command}}`);
  return marks.reduce((either, mark) => `#{||:${either},${mark}}`);
}

/**
 * The `AGENT` tmux format: the agent whose mark a pane's start command carries, else `claude` (a pane séance did not
 * start is only ever a session through Claude's `command`). Claude's mark is the fallback, never tested, so a Codex
 * start command, whose run-dir path is the daemon's, decides alone.
 */
export function agentFormat(panes: readonly AgentPanes[]): string {
  return panes
    .filter((pane) => pane.agent !== "claude")
    .reduceRight(
      (otherwise, pane) => `#{?#{m:${pane.startMark},#{pane_start_command}},${pane.agent},${otherwise}}`,
      "claude",
    );
}

/** The `AGENT` field read back: anything but a known non-Claude agent is Claude. */
export function agentOf(field: string | undefined): AgentKind {
  return AGENT_PANES.find((pane) => pane.agent === field)?.agent ?? "claude";
}

/** A pane séance did not start runs an agent when its process is called one. */
export function runsAgentCommand(command: string): boolean {
  return AGENT_PANES.some((pane) => pane.command?.test(command) === true);
}
