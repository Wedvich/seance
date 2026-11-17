import { processNames, processStart } from "./peer.ts";
import { CLAUDE_COMMAND } from "./sessions.ts";

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
 * name `CLAUDE_COMMAND` accepts, with its start time. Innermost, because the peer is the child of the `claude` that
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
  for (const pid of chain) {
    // oxlint-disable-next-line no-await-in-loop -- nearest the peer first, and a handful of hops
    if (!(await processNames(pid)).some((name) => CLAUDE_COMMAND.test(name))) continue;
    const start = processStart(pid);
    return start === null ? null : { pid, start, key: sessionKey(pid, start) };
  }
  return null;
}
