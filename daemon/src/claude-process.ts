import type { AgentKind } from "@seance/shared";
import { CLAUDE_PANES, panesOf } from "./agents/panes.ts";
import { readAgentSession } from "./agent-session-file.ts";
import { processNames, processStart } from "./peer.ts";

/**
 * A session's `claude` process, `<pid>:<start>` (DESIGN.md, "Replies by handle", `Bound.session`). The start time is
 * what tells claude #2, which the kernel may give claude #1's recycled pid, from claude #1 (macOS wraps its pids at
 * 99 999). A string so that every comparison is `===`. Messaging binds reply handles to it, and the conversation table
 * (`conversations.ts`) keys a process's facts on it.
 */
export type SessionKey = string;

export const sessionKey = (pid: number, start: string): SessionKey => `${pid}:${start}`;

/** Whether the process a key names still runs: the pid is held by the same process that started it. */
export function sessionAlive(session: SessionKey): boolean {
  const at = session.indexOf(":");
  return processStart(Number(session.slice(0, at))) === session.slice(at + 1);
}

export interface ClaudeProcess {
  readonly pid: number;
  readonly start: string;
  readonly key: SessionKey;
}

/**
 * The `claude` process a peer belongs to: the innermost process on its chain (peer first, the pane process last) whose
 * name `CLAUDE_PANES.command` accepts, with its start time. Innermost, because the peer is the child of the `claude` that
 * started it (`seance inbox`, `seance mcp`, `seance session-event`): a wrapper above it that carries the name (a shell
 * script called `claude` that runs `claude` twice) or a `claude` that started another in a tool is never the peer's
 * session, and the wrapper, which outlives every `claude` it runs, never holds its facts. A pane that `exec`s `claude`
 * is its own pane pid, a séance spawn too (`caffeinate` on macOS is the pane's process, `claude` its child). A name is a
 * hint any process can set, but only the innermost counts: a process that takes the name is its own session, which
 * holds none of another's facts. Null when no name on the chain matches (a `claude` that runs as `node`, an npm
 * install: `sessions.ts` lists the same cost) or the process cannot be told apart from a later one (gone, or no start
 * time read).
 */
export async function claudeProcessOf(chain: readonly number[]): Promise<ClaudeProcess | null> {
  return sessionProcessOf(chain, "claude");
}

/**
 * `claudeProcessOf` for the pane's own agent (`BoundPane.agent`, from its start mark, never a frame): the innermost
 * process on the chain its driver's `process` names. For a Codex pane that is the pane's `codex app-server`, the
 * parent of `seance mcp` and of every tool the session runs (docs/codex.md, "Tools"); the TUI, its sibling, is on no
 * such chain.
 */
export async function sessionProcessOf(chain: readonly number[], agent: AgentKind): Promise<ClaudeProcess | null> {
  const named = panesOf(agent).process;
  for (const pid of chain) {
    // oxlint-disable-next-line no-await-in-loop -- nearest the peer first, and a handful of hops
    if (!(await processNames(pid)).some((name) => named.test(name))) continue;
    const start = processStart(pid);
    return start === null ? null : { pid, start, key: sessionKey(pid, start) };
  }
  return null;
}

/**
 * Whether the peer's `claude` was started by another `claude` in the pane: a `claude -p` a tool or a script ran. Its
 * mods and settings hooks are the pane's exclave's, so it reports its own start, turns and exit, which are never the
 * pane's session's. True when a process above the peer's own `claude` (`claudeProcessOf`) on the chain (peer first,
 * the pane process last) carries the name and has its own `sessions/<pid>.json` (`readAgentSession`): Claude Code
 * writes one for every process past the trust dialog, `-p` included, and a wrapper script called `claude` never does,
 * so a wrapper above the session still lets it speak for the pane, however many hops sit between them.
 */
export async function nestedClaude(chain: readonly number[], configDirs: readonly string[]): Promise<boolean> {
  const own = await claudeProcessOf(chain);
  if (own === null) return false;
  for (const pid of chain.slice(chain.indexOf(own.pid) + 1)) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of hops, each its own read
    if (!(await processNames(pid)).some((name) => CLAUDE_PANES.command.test(name))) continue;
    const start = processStart(pid);
    // oxlint-disable-next-line no-await-in-loop -- as above
    if (start !== null && (await readAgentSession(pid, start, configDirs)).kind !== "none") return true;
  }
  return false;
}
