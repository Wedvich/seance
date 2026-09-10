import type { RepoEntry, SessionEntry } from "@seance/shared";
import { FIELD_SEP, PANE_TITLED, tmux } from "./tmux.ts";

// What tmux reports as a claude pane's foreground command depends on the host,
// not on claude: macOS tmux reads the kernel's comm, the *resolved* executable's
// basename — the native installer keeps the binary under a versioned filename,
// so "2.1.267" — while Linux (and WSL) tmux reads argv[0], the symlink name
// "claude". An npm install runs under "node" on both. This only says "some
// claude"; whether it has registered is the title (`PANE_TITLED`).
const CLAUDE_COMMAND = /^(?:claude|node|\d+\.\d+\.\d+)$/u;

const WORKTREE_MARKER = "/.claude/worktrees/";

function repoFor(panePath: string, repos: readonly RepoEntry[]): string | null {
  const markerAt = panePath.indexOf(WORKTREE_MARKER);
  const effective = markerAt === -1 ? panePath : panePath.slice(0, markerAt);
  let best: RepoEntry | null = null;
  for (const repo of repos) {
    if (effective !== repo.path && !effective.startsWith(`${repo.path}/`)) continue;
    if (best === null || repo.path.length > best.path.length) best = repo;
  }
  return best?.name ?? null;
}

/**
 * Pure parser over `list-panes -a` output — exported for unit tests. A pane is
 * a session when a claude process holds it *and* that claude has titled the
 * pane: the command alone is present from exec, dialog or not, and the title
 * alone would keep counting a pane whose claude exited back to a shell that
 * never reset it.
 */
export function parsePanes(raw: string, repos: readonly RepoEntry[]): readonly SessionEntry[] {
  const seen = new Set<string>();
  const sessions: SessionEntry[] = [];
  for (const line of raw.split("\n")) {
    // Path last and taken as the remainder: a separator inside it can't shift the fields.
    const [windowId, windowName, command, titled, ...rest] = line.split(FIELD_SEP);
    const panePath = rest.join(FIELD_SEP);
    if (windowId === undefined || windowName === undefined || command === undefined || panePath === "") {
      continue;
    }
    // Grouped sessions repeat every window; splits repeat the window id too.
    if (seen.has(windowId)) continue;
    if (!CLAUDE_COMMAND.test(command) || titled !== "1") continue;
    seen.add(windowId);
    sessions.push({ window: windowName, repo: repoFor(panePath, repos), path: panePath });
  }
  return sessions;
}

/**
 * Windows séance started that are alive but still untitled — the steady-state
 * form of the spawn-time miss in `spawnSession`. An alive pane whose claude
 * never titled it is one sitting on a dialog nobody local is there to answer.
 *
 * `pane_start_command` identifies our windows without keeping any state, and
 * `#{m:...}` reduces it to 0/1 inside tmux — the raw command carries
 * wire-supplied values (model, effort) that could hold the field separator. A
 * tmux too old for `m:` renders the format literally, never matches, and the
 * check just reports nothing.
 */
export function parseStuckWindows(raw: string): readonly string[] {
  const seen = new Set<string>();
  const stuck: string[] = [];
  for (const line of raw.split("\n")) {
    const [windowId, ours, dead, titled, ...rest] = line.split(FIELD_SEP);
    const windowName = rest.join(FIELD_SEP);
    if (windowId === undefined || ours !== "1" || dead !== "0" || titled === undefined) continue;
    if (titled === "1" || seen.has(windowId)) continue;
    seen.add(windowId);
    stuck.push(windowName === "" ? windowId : windowName);
  }
  return stuck;
}

export async function listStuckWindows(): Promise<readonly string[]> {
  const result = await tmux([
    "list-panes",
    "-a",
    "-F",
    `#{window_id}${FIELD_SEP}#{m:*--remote-control*,#{pane_start_command}}${FIELD_SEP}` +
      `#{pane_dead}${FIELD_SEP}${PANE_TITLED}${FIELD_SEP}#{s/[${FIELD_SEP}]/-/:window_name}`,
  ]);
  if (result.exitCode !== 0) return [];
  return parseStuckWindows(result.stdout);
}

export async function listClaudeSessions(repos: readonly RepoEntry[]): Promise<readonly SessionEntry[]> {
  const result = await tmux([
    "list-panes",
    "-a",
    "-F",
    // Window names are unvalidated wire text (SpawnRequest.title), so tmux
    // substitutes the separator out of them before the line reaches us.
    `#{window_id}${FIELD_SEP}#{s/[${FIELD_SEP}]/-/:window_name}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}` +
      `${PANE_TITLED}${FIELD_SEP}#{pane_current_path}`,
  ]);
  if (result.exitCode !== 0) return []; // no tmux server — nothing running
  return parsePanes(result.stdout, repos);
}
