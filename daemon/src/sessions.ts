import type { RepoEntry, SessionEntry } from "@seance/shared";
import { FIELD_SEP, PANE_TITLED, tmux } from "./tmux.ts";

// What tmux reports as a claude pane's foreground command depends on the host,
// not on claude: macOS tmux reads the kernel's comm, the *resolved* executable's
// basename — the native installer keeps the binary under a versioned filename,
// so "2.1.267" — while Linux (and WSL) tmux reads argv[0], the symlink name
// "claude". Not "node": an npm-installed claude runs as one, but so does every
// dev server, and under a title-setting shell such a pane would list as a
// session. Hand-started npm claudes are the cost; séance's own are covered
// below regardless of what the process is called.
const CLAUDE_COMMAND = /^(?:claude|\d+\.\d+\.\d+)$/u;

/**
 * The one registration predicate, shared by the session list and the spawn
 * path so a `registered` outcome is by construction a window the list holds.
 * A séance window (`ours`: its start command is our `exec … claude
 * --remote-control` line) registers on the title alone — nothing else ever
 * runs in that pane, and what tmux calls the process there is a host detail
 * (`claude`, the versioned filename, `node`, or the `caffeinate` wrapper on
 * macOS). A pane séance did not start needs a claude-named process too, or a
 * shell that set a title would count.
 */
export function isRegistered(pane: {
  readonly ours: boolean;
  readonly titled: boolean;
  readonly command: string;
}): boolean {
  return pane.titled && (pane.ours || CLAUDE_COMMAND.test(pane.command));
}

/** Reduced to 0/1 inside tmux: the raw command carries wire-supplied values (model, effort). */
const OURS = "#{m:*--remote-control*,#{pane_start_command}}";

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
 * Pure parser over `list-panes -a` output — exported for unit tests. The title
 * is what says claude is up: the command is present from exec, dialog or not,
 * and the title alone would keep counting a pane whose claude exited back to a
 * shell that never reset it — hence `isRegistered`'s second half for panes
 * that are not ours.
 */
export function parsePanes(raw: string, repos: readonly RepoEntry[]): readonly SessionEntry[] {
  const seen = new Set<string>();
  const sessions: SessionEntry[] = [];
  for (const line of raw.split("\n")) {
    // Path last and taken as the remainder: a separator inside it can't shift the fields.
    const [windowId, windowName, command, ours, titled, ...rest] = line.split(FIELD_SEP);
    const panePath = rest.join(FIELD_SEP);
    if (windowId === undefined || windowName === undefined || command === undefined || panePath === "") {
      continue;
    }
    // Grouped sessions repeat every window; splits repeat the window id too.
    if (seen.has(windowId)) continue;
    if (!isRegistered({ ours: ours === "1", titled: titled === "1", command })) continue;
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
 * `pane_start_command` identifies our windows without keeping any state. A
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
    `#{window_id}${FIELD_SEP}${OURS}${FIELD_SEP}#{pane_dead}${FIELD_SEP}${PANE_TITLED}${FIELD_SEP}` +
      `#{s/[${FIELD_SEP}]/-/:window_name}`,
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
      `${OURS}${FIELD_SEP}${PANE_TITLED}${FIELD_SEP}#{pane_current_path}`,
  ]);
  if (result.exitCode !== 0) return []; // no tmux server — nothing running
  return parsePanes(result.stdout, repos);
}
