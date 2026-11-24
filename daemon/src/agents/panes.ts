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
export const CLAUDE_PANES: AgentPanes = {
  startMark: "*--remote-control*",
  command: /^(?:claude|\d+\.\d+\.\d+)$/u,
};

/** Every driver's panes (`AgentDriver.panes`): what the pane readers recognise. */
export const AGENT_PANES: readonly AgentPanes[] = [CLAUDE_PANES];

/** The `OURS` tmux format: 1 when a pane's start command carries any driver's mark. */
export function oursFormat(panes: readonly AgentPanes[]): string {
  const marks = panes.map((pane) => `#{m:${pane.startMark},#{pane_start_command}}`);
  return marks.reduce((either, mark) => `#{||:${either},${mark}}`);
}

/** A pane séance did not start runs an agent when its process is called one. */
export function runsAgentCommand(command: string): boolean {
  return AGENT_PANES.some((pane) => pane.command.test(command));
}
