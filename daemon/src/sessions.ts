import type { RepoEntry, SessionEntry } from "@seance/shared";
import { FIELD_SEP, tmux } from "./tmux.ts";

// claude retitles its process to its bare version string (e.g. "2.1.220") —
// undocumented, but the only mark it leaves on a pane. If a release changes
// the convention the session list goes visibly empty and this is the fix.
const CLAUDE_TITLE = /^\d+\.\d+\.\d+$/u;

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
    // Path last and taken as the remainder: a separator inside it can't shift the fields.
    const [windowId, windowName, command, ...rest] = line.split(FIELD_SEP);
    const panePath = rest.join(FIELD_SEP);
    if (windowId === undefined || windowName === undefined || command === undefined || panePath === "") {
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
    // Window names are unvalidated wire text (SpawnRequest.title), so tmux
    // substitutes the separator out of them before the line reaches us.
    `#{window_id}${FIELD_SEP}#{s/[${FIELD_SEP}]/-/:window_name}${FIELD_SEP}#{pane_current_command}${FIELD_SEP}#{pane_current_path}`,
  ]);
  if (result.exitCode !== 0) return []; // no tmux server — nothing running
  return parsePanes(result.stdout, repos);
}
