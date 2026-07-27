import type { RepoEntry, SessionEntry } from "@seance/shared";
import { tmux } from "./tmux.ts";

// claude retitles its process to its bare version string (e.g. "2.1.220") —
// undocumented, but the only mark it leaves on a pane. If a release changes
// the convention the session list goes visibly empty and this is the fix.
const CLAUDE_TITLE = /^\d+\.\d+\.\d+$/;

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

/** Pure parser over `list-panes -a` output — exported for unit tests. */
export function parsePanes(raw: string, repos: readonly RepoEntry[]): readonly SessionEntry[] {
  const seen = new Set<string>();
  const sessions: SessionEntry[] = [];
  for (const line of raw.split("\n")) {
    const [windowId, windowName, command, panePath] = line.split("\t");
    if (windowId === undefined || windowName === undefined || command === undefined || panePath === undefined) {
      continue;
    }
    // Grouped sessions repeat every window; splits repeat the window id too.
    if (seen.has(windowId)) continue;
    if (!CLAUDE_TITLE.test(command)) continue;
    seen.add(windowId);
    sessions.push({ window: windowName, repo: repoFor(panePath, repos), path: panePath });
  }
  return sessions;
}

export async function listClaudeSessions(repos: readonly RepoEntry[]): Promise<readonly SessionEntry[]> {
  const result = await tmux([
    "list-panes",
    "-a",
    "-F",
    "#{window_id}\t#{window_name}\t#{pane_current_command}\t#{pane_current_path}",
  ]);
  if (result.exitCode !== 0) return []; // no tmux server — nothing running
  return parsePanes(result.stdout, repos);
}
