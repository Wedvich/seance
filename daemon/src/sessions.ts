import type { RepoEntry, SessionEntry } from "@seance/shared";
import { enclosingWorktreeCommonDir, resolveCommonDir } from "./gitdir.ts";
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

/**
 * Git facts read off disk for attribution, kept out of the parser so it stays
 * pure: a pane path → the common dir of the linked worktree it sits in, and a
 * registered repo's path → its common dir. Both canonical.
 */
export interface GitLinks {
  readonly paneCommonDirs: ReadonlyMap<string, string>;
  readonly repoCommonDirs: ReadonlyMap<string, string>;
}

const NO_LINKS: GitLinks = { paneCommonDirs: new Map(), repoCommonDirs: new Map() };

/**
 * The one attribution rule. A pane in a linked worktree belongs to the
 * registered repo it shares a common dir with, wherever the worktree sits —
 * `<repo>/.claude/worktrees/<name>` or a sibling `<root>/<repo>-<name>` the scan
 * doesn't register — and whatever the common dir is called (a
 * `--separate-git-dir` clone's or a submodule's isn't `.git`). Otherwise the
 * longest registered prefix, which also still maps a `.claude/worktrees` pane
 * whose worktree is gone.
 */
function repoFor(path: string, repos: readonly RepoEntry[], links: GitLinks): string | null {
  const commonDir = links.paneCommonDirs.get(path);
  if (commonDir !== undefined) {
    const owner = repos.find((repo) => links.repoCommonDirs.get(repo.path) === commonDir);
    if (owner !== undefined) return owner.name;
  }
  let best: RepoEntry | null = null;
  for (const repo of repos) {
    if (path !== repo.path && !path.startsWith(`${repo.path}/`)) continue;
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
export function parsePanes(raw: string, repos: readonly RepoEntry[], links = NO_LINKS): readonly SessionEntry[] {
  return attribute(registeredPanes(raw), repos, links);
}

interface Pane {
  readonly window: string;
  readonly path: string;
}

function attribute(panes: readonly Pane[], repos: readonly RepoEntry[], links: GitLinks): readonly SessionEntry[] {
  return panes.map((pane) => ({ window: pane.window, repo: repoFor(pane.path, repos, links), path: pane.path }));
}

function registeredPanes(raw: string): readonly Pane[] {
  const seen = new Set<string>();
  const panes: Pane[] = [];
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
    panes.push({ window: windowName, path: panePath });
  }
  return panes;
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
  const panes = registeredPanes(result.stdout);
  const [paneCommonDirs, repoCommonDirs] = await Promise.all([
    resolveLive(
      paneMemo,
      panes.map((pane) => pane.path),
      async (path) => {
        const { commonDir, definitive } = await enclosingWorktreeCommonDir(path);
        return { value: commonDir, keep: definitive };
      },
    ),
    resolveLive(
      repoMemo,
      repos.map((repo) => repo.path),
      async (path) => ({
        value: await resolveCommonDir(path),
        keep: true,
      }),
    ),
  ]);
  return attribute(panes, repos, { paneCommonDirs, repoCommonDirs });
}

/**
 * The session list is rebuilt on every listing, and neither a path's worktree
 * nor a repo's common dir changes under it, so each key resolves once; keys no
 * pane or repo holds any more drop out per listing, keeping each memo to the
 * live set. The memos hold promises, entered before any await: listings overlap
 * (the local socket doesn't serialize requests), and each one reads only the
 * promises it took itself, so another's pruning can't strip a mapping
 * mid-listing nor a late resolution re-add a pruned key.
 */
const paneMemo = new Map<string, Promise<string | null>>();
const repoMemo = new Map<string, Promise<string | null>>();

/** `keep: false` evicts the answer once settled — a null an I/O error produced shouldn't outlive the pane. */
async function resolveLive(
  memo: Map<string, Promise<string | null>>,
  keys: readonly string[],
  compute: (key: string) => Promise<{ readonly value: string | null; readonly keep: boolean }>,
): Promise<ReadonlyMap<string, string>> {
  const live = new Set(keys);
  for (const key of memo.keys()) if (!live.has(key)) memo.delete(key);
  const pending = [...live].map(async (key): Promise<readonly [string, string | null]> => {
    let entry = memo.get(key);
    if (entry === undefined) {
      const created: Promise<string | null> = compute(key).then(({ value, keep }) => {
        if (!keep && memo.get(key) === created) memo.delete(key);
        return value;
      });
      memo.set(key, created);
      entry = created;
    }
    return [key, await entry];
  });
  const resolved = new Map<string, string>();
  for (const [key, value] of await Promise.all(pending)) if (value !== null) resolved.set(key, value);
  return resolved;
}
