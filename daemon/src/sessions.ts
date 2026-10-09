import type { RepoEntry, SessionEntry } from "@seance/shared";
import { enclosingWorktreeCommonDir, resolveCommonDir } from "./gitdir.ts";
import { capturePane, FIELD_SEP, PANE_TITLED, tmux } from "./tmux.ts";

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
 * One pane as the classifier sees it. Every pane, not only claude's: what a
 * pane is doing is the classifier's question, and which panes are worth asking
 * about is the caller's.
 */
export interface PaneInfo {
  readonly paneId: string;
  readonly windowId: string;
  readonly windowName: string;
  /** Started by séance — the `OURS` start-command match. */
  readonly ours: boolean;
  readonly dead: boolean;
  /** When the pane died, epoch ms; null while alive, or on a tmux without `pane_dead_time`. */
  readonly deadAt: number | null;
  readonly titled: boolean;
  readonly command: string;
  readonly path: string;
}

/**
 * What a pane is doing:
 * - `dead` — its process exited and the pane stayed (only while remain-on-exit is on).
 * - `shell` — a pane séance did not start whose foreground is no longer claude:
 *   claude exited back to the shell that ran it, or never ran there. Never one
 *   of ours — séance `exec`s claude, so it is the pane's own process.
 * - `starting` — alive and untitled: claude has not cleared its startup gates,
 *   which in steady state is a dialog nobody local is there to answer.
 * - `exit-prompt` — claude is asking whether to keep or remove its worktree on
 *   the way out. Every named worktree session's `/exit` stops here.
 * - `background-prompt` — claude is asking whether to stop background work on
 *   the way out.
 * - `live` — any other claude, idle or mid-turn: the screen can't tell them
 *   apart, and the title glyph that could is kept out of the format output.
 */
export type PaneState = "dead" | "shell" | "starting" | "exit-prompt" | "background-prompt" | "live";

/**
 * Path last and taken as the remainder. The window name is unvalidated wire
 * text and the command a process name, so tmux substitutes the separator out of
 * both before the line reaches us.
 */
const PANE_INFO_FORMAT = [
  "#{pane_id}",
  "#{window_id}",
  `#{s/[${FIELD_SEP}]/-/:pane_current_command}`,
  OURS,
  "#{pane_dead}",
  "#{pane_dead_time}",
  PANE_TITLED,
  `#{s/[${FIELD_SEP}]/-/:window_name}`,
  "#{pane_current_path}",
].join(FIELD_SEP);

/** Pure parser over `list-panes -a` in `PANE_INFO_FORMAT` — exported for unit tests. */
export function parsePaneInfo(raw: string): readonly PaneInfo[] {
  const seen = new Set<string>();
  const panes: PaneInfo[] = [];
  for (const line of raw.split("\n")) {
    const [paneId, windowId, command, ours, dead, deadTime, titled, windowName, ...rest] = line.split(FIELD_SEP);
    if (paneId === undefined || windowId === undefined || command === undefined || dead === undefined) continue;
    if (deadTime === undefined || windowName === undefined || rest.length === 0) continue;
    // Grouped sessions repeat every pane; a split's panes are distinct.
    if (seen.has(paneId)) continue;
    seen.add(paneId);
    const deadSeconds = Number(deadTime);
    panes.push({
      paneId,
      windowId,
      windowName,
      ours: ours === "1",
      dead: dead === "1",
      deadAt: dead === "1" && deadSeconds > 0 ? deadSeconds * 1000 : null,
      titled: titled === "1",
      command,
      path: rest.join(FIELD_SEP),
    });
  }
  return panes;
}

export async function listPanes(): Promise<readonly PaneInfo[]> {
  const result = await tmux(["list-panes", "-a", "-F", PANE_INFO_FORMAT]);
  if (result.exitCode !== 0) return []; // no tmux server — no panes
  return parsePaneInfo(result.stdout);
}

/** What the list-panes fields settle alone; null when only the screen can tell. */
function stateWithoutScreen(pane: PaneInfo): PaneState | null {
  if (pane.dead) return "dead";
  if (!pane.ours && !CLAUDE_COMMAND.test(pane.command)) return "shell";
  if (!pane.titled) return "starting";
  return null;
}

/**
 * How far up from the bottom of the screen a dialog's last option may sit. A
 * dialog renders at the bottom, under at most a hint line and a status line;
 * anchoring there keeps a transcript that merely quotes the prompt (a session
 * discussing this very code) from reading as the prompt.
 */
const OPTIONS_FROM_BOTTOM = 8;

/**
 * The two exit dialogs, each recognised by its heading above its own two
 * options, the last of them at the bottom of the screen. Wording from Claude
 * Code 2.1.295; a release that rewords them reads as `live`, which is only
 * ever reported, never acted on.
 */
export function screenState(screen: string): "exit-prompt" | "background-prompt" | null {
  const lines = screen.split("\n").filter((line) => line.trim() !== "");
  const bottom = lines.length - OPTIONS_FROM_BOTTOM;
  const lastAt = (pattern: RegExp): number => lines.findLastIndex((line) => pattern.test(line));
  const showing = (heading: RegExp, first: RegExp, second: RegExp): boolean => {
    const secondAt = lastAt(second);
    const firstAt = lastAt(first);
    if (secondAt === -1 || secondAt < bottom || firstAt === -1 || firstAt > secondAt) return false;
    return lines.slice(0, firstAt).some((line) => heading.test(line));
  };
  if (showing(/Exiting worktree session/u, /\b1\.\s+Keep worktree/u, /\b2\.\s+Remove worktree/u)) {
    return "exit-prompt";
  }
  if (showing(/Background work is running/u, /Exit and stop tasks/u, /Move to background and exit/u)) {
    return "background-prompt";
  }
  return null;
}

/**
 * Cheap first: only a titled, live claude costs a `capture-pane`, which is why
 * this stays off the session list's path. A pane gone by the time it is
 * captured reads as `live` — reported, never acted on.
 */
export async function classifyPane(pane: PaneInfo): Promise<PaneState> {
  const settled = stateWithoutScreen(pane);
  if (settled !== null) return settled;
  const screen = await capturePane(pane.paneId, { history: false });
  return (screen === null ? null : screenState(screen)) ?? "live";
}

/**
 * Windows séance started that are alive but still untitled — the steady-state
 * form of the spawn-time miss in `spawnSession`. A tmux too old for `m:`
 * renders `OURS` literally, never matches, and this reports nothing.
 */
export function stuckWindows(panes: readonly PaneInfo[]): readonly string[] {
  const seen = new Set<string>();
  const stuck: string[] = [];
  for (const pane of panes) {
    if (!pane.ours || stateWithoutScreen(pane) !== "starting" || seen.has(pane.windowId)) continue;
    seen.add(pane.windowId);
    stuck.push(pane.windowName === "" ? pane.windowId : pane.windowName);
  }
  return stuck;
}

export async function listStuckWindows(): Promise<readonly string[]> {
  return stuckWindows(await listPanes());
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
