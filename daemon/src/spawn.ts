import { lstat, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  autonomyOf,
  isTaskId,
  WORKTREE_AND_BRANCH_GONE,
  type AgentKind,
  type RepoEntry,
  type SpawnRequest,
} from "@seance/shared";
import { claudeDriver } from "./agents/claude.ts";
import { codexDriver, codexRequestRefusal, type CodexDriverOptions } from "./agents/codex.ts";
import type { AgentDriver, AgentLaunch } from "./agents/driver.ts";
import { autonomyNote } from "./autonomy.ts";
import { SpawnFailure, type Continuation, type SessionAttachments, type SpawnOutcome } from "./backend.ts";
import { defaultBaseTip, fetchBase, freshenBase } from "./base-fetch.ts";
import { git } from "./exec.ts";
import { whileRegistering } from "./exit-status.ts";
import { DEFAULT_EXCLAVE } from "./exclaves.ts";
import { canonical } from "./gitdir.ts";
import { hardenedGit, repoConfigRefusal } from "./git-hardened.ts";
import { log } from "./log.ts";
import { parseWorktreeList, parseWorktreeLock, staleClaudeLock } from "./reap-git.ts";
import { ReapBusy, withReapLock } from "./reap.ts";
import { readDefaultBranch } from "./scan.ts";
import { isRegistered, listPanes, paneRunningTask, type PaneInfo } from "./sessions.ts";
import {
  capturePane,
  EXIT_OPTION_PREFIX,
  FIELD_SEP,
  PANE_TITLED,
  resolveTargetSession,
  sanitizeWindowName,
  TASK_OPTION,
  tmux,
  tmuxOk,
  TmuxError,
} from "./tmux.ts";

function slugCore(src: string): string {
  return src
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/u, "");
}

export function slugify(src: string): string {
  const slug = slugCore(src);
  return slug === "" ? "session" : slug;
}

/**
 * The remote-control session name — what the Claude UIs list, and deliberately
 * not the tmux window name, which stays bare because the host is never in
 * question locally. Reads as `task (host)`: the task leads, since that is what
 * you scan a session list for, and the machine trails as the qualifier.
 * Parenthesised, never `@`: Claude Code's cross-session addressing reads `@`
 * as team-qualifier syntax, so an `@` in the name makes the session
 * unaddressable by `SendMessage` and it is assigned no `[ref]` to fall back
 * on. Brackets are out for the same class of reason — they collide with the
 * `name [ref]` disambiguator.
 * `slug` is already slugified, so it can carry no parens of its own and the
 * suffix can never nest. The tag is gated on its *slugified* form, not a
 * trim: a tag with no ASCII alphanumerics ("🖥️", "###") would otherwise fall
 * through to slugify's "session" fallback and stamp a phantom `(session)`
 * host on every spawn.
 */
/**
 * Puts the tag in the tmux server's global environment, so a `claude` run by
 * hand in any later window carries SEANCE_MACHINE_TAG just as a spawn does —
 * and the tmux-rename mod reads it here at rename time. Creates the session group when no
 * server is up: the daemon starts at login, before any terminal, and a tag set
 * on no server would be lost. Empty when untagged, which overwrites a stale one.
 */
export async function publishMachineTag(group: string, tag?: string): Promise<void> {
  await resolveTargetSession(group);
  await tmuxOk(["set-environment", "-g", "SEANCE_MACHINE_TAG", machineTagSlug(tag)]);
}

/**
 * `publishMachineTag` again, for whatever tmux server is up now — one started
 * after the daemon has none of it. Never creates a server: `set-environment`
 * with none running just fails, and there is then nothing to tag. Silent on
 * failure, since it runs on a timer and no server is a normal state.
 */
export async function republishMachineTag(tag?: string): Promise<void> {
  await tmux(["set-environment", "-g", "SEANCE_MACHINE_TAG", machineTagSlug(tag)]).catch(() => undefined);
}

export function sessionName(slug: string, tag?: string): string {
  const suffix = machineTagSlug(tag);
  return suffix === "" ? slug : `${slug} (${suffix})`;
}

/** The tag as it appears in the session name; empty means none. */
export function machineTagSlug(tag?: string): string {
  return tag === undefined ? "" : slugCore(tag);
}

/**
 * Sessions are short-lived, so names stay bare: no timestamp, just the slug.
 * Collisions are the exception, and a leftover branch counts as one — `git
 * worktree remove` leaves `worktree-<name>` behind, and reusing it would base
 * the new session on the old work.
 */
async function freeWorktreeName(repo: RepoEntry, slug: string): Promise<string> {
  const [dirs, refs] = await Promise.all([
    readdir(join(repo.path, ".claude", "worktrees")).catch(() => [] as string[]),
    git(repo.path, ["for-each-ref", "--format=%(refname:short)", `refs/heads/worktree-${slug}*`]),
  ]);
  const taken = new Set([...dirs, ...refs.stdout.split("\n").map((ref) => ref.trim().replace(/^worktree-/u, ""))]);
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? slug : `${slug}-${n}`;
    if (!taken.has(name)) return name;
  }
  throw new SpawnFailure("internal_error", `too many worktrees named ${slug}-* — clean some up`);
}

/** Where a session works and what it is told about it: the agent-neutral half of a launch (`LaunchSpec`). */
interface Prepared {
  /** Where the session works, and the outcome's `path`. */
  readonly cwd: string;
  /** A fresh worktree's clone and name (`LaunchSpec.worktree`). */
  readonly worktree?: { readonly clone: string; readonly name: string };
  /** A continuation's session id, as this machine's ledger noted it (`LaunchSpec.resume`). */
  readonly resume?: string;
  readonly preamble: string;
}

/**
 * A session this daemon closed for its hand-off (`handedOff`, from the old task's ledger note) ended
 * cleanly at the end of its turn, so the first wording says nothing was interrupted.
 *
 * Never asserts that the dead session's background work is gone: only claude itself
 * was stopped, and a surviving child is not something the pane checks can see. The
 * wording comes from the old task's own ledger note `exit`, never from a frame: nonzero
 * is a death, anything else (zero, or none noted) a cancel.
 */
export function continuePreamble(
  path: string,
  exit: number | undefined,
  vanished?: boolean,
  handedOff?: boolean,
): string {
  const prefix = `This session was resumed by séance in the same git worktree at ${path}, after the previous session `;
  if (handedOff === true && (exit === undefined || exit === 0)) {
    return (
      prefix +
      `ended by handing its pull request off to séance (hand_off_task), which closed it at the end of its turn. ` +
      `Nothing it started was interrupted: read the note below for why it was resumed, then carry on from there.`
    );
  }
  if (exit === undefined && vanished === true) {
    return (
      prefix +
      `ended when its window was closed (closed by hand, or its tmux server or machine stopped) partway ` +
      `through. Its last tool call may not have finished, and processes it started in the background may ` +
      `still be running: check the worktree's state and running processes before restarting anything, ` +
      `then carry on where it left off.`
    );
  }
  if (exit !== undefined && exit !== 0) {
    return (
      prefix +
      `ended unexpectedly (killed, crashed or out of memory) partway through. Its last tool call may not ` +
      `have finished, and processes it started in the background may still be running (only claude itself ` +
      `was killed): check the worktree's state and running processes before restarting anything, then ` +
      `carry on where it left off.`
    );
  }
  return (
    prefix +
    `was stopped before it finished (cancelled from séance). Its last tool call may not have finished, and ` +
    `processes it started in the background may still be running (only claude itself was stopped): check ` +
    `the worktree's state and running processes before restarting anything, then carry on where it left off.`
  );
}

/**
 * Worktree mode creates no worktree, deliberately — bar a stacked spawn, whose base claude has no flag for
 * (`addStackedWorktree`). `claude --worktree` resolves
 * the default branch and runs `git worktree add --no-track -B <branch> <path>
 * origin/<default>` itself — its `worktree.baseRef` setting defaults to
 * `"fresh"`, meaning exactly that, and only a machine that sets it to `"head"`
 * branches off the checkout instead. Claude fetches only when `FETCH_HEAD` is
 * over a day old, though, so `freshenBase` fetches first (DESIGN.md, "Worktree
 * spawns fetch first").
 *
 * This used to also `git merge --ff-only origin/<default>` in the main
 * checkout, ported from `/spawn` on the belief that claude branches off HEAD.
 * That belief was already wrong: the ff never moved the base, only the machine
 * owner's HEAD, and the two notes it emitted when the checkout was dirty or on
 * another branch told the phone something untrue. Don't restore it — a remote
 * spawn has no business moving a local HEAD.
 */
function prepareWorktree(repo: RepoEntry, worktreeName: string, agent: AgentKind): Prepared {
  const worktreePath = join(repo.path, ".claude", "worktrees", worktreeName);
  const { who, instructions } = AGENT_WORDS[agent];
  return {
    cwd: worktreePath,
    worktree: { clone: repo.path, name: worktreeName },
    preamble:
      `You are a new independent ${who} session in a FRESH git worktree at ${worktreePath}, ` +
      `on branch worktree-${worktreeName}. Before starting the task, set this worktree up per ` +
      `the repo's own docs (check ${instructions}'s worktree-setup section and/or README), including ` +
      `copying any .env from the main checkout at ${repo.path}.`,
  };
}

/**
 * How the seed names the session and the repo's instructions to it: Codex reads AGENTS.md where a directory has one,
 * else CLAUDE.md (docs/codex.md, S9). Constants, never wire text.
 */
const AGENT_WORDS: Readonly<Record<AgentKind, { readonly who: string; readonly instructions: string }>> = {
  claude: { who: "Claude", instructions: "CLAUDE.md" },
  codex: { who: "Codex", instructions: "AGENTS.md or CLAUDE.md" },
};

/**
 * A stacked worktree, made by `addStackedWorktree` at its base's tip before launch: `claude --worktree <name>`
 * finds it there and runs in it as it stands (spiked on 2.1.325, interactive and `-p`: no reset, no second
 * add), so the flag, the launch dir and the `.claude/worktrees` layout stay a plain worktree spawn's.
 * `base` passed `isBranchName`; the seed is a file, never the shell string, and the session is told its PR's
 * base, since a PR against the default branch of a squash-merging repo carries the predecessor's commits.
 */
function prepareStacked(repo: RepoEntry, worktreeName: string, base: string, agent: AgentKind): Prepared {
  const worktree = prepareWorktree(repo, worktreeName, agent);
  return {
    ...worktree,
    preamble:
      `${worktree.preamble}\n\n` +
      `This task is STACKED on \`${base}\`, the branch of the task it depends on: the worktree starts from ` +
      `origin/${base}, not from the default branch, so its commits are already in your history. Its pull request ` +
      `is your handoff: read it first (\`gh pr view ${base}\`: its description, diff and review comments). ` +
      `Open your own pull request against that branch (\`gh pr create --base ${base}\`), never against the ` +
      `default branch: the repo squash-merges, so a pull request there would carry ${base}'s commits too and ` +
      `could merge them unreviewed. Once ${base}'s pull request merges, this branch needs a rebase onto the ` +
      `default branch and its pull request retargeted; séance does not do that for you.`,
  };
}

/**
 * A task that would have stacked on a predecessor that left nothing to stack on (`SpawnRequest.noBase`, decided
 * #4): a plain worktree spawn, from the default branch, whose preamble says why. A constant: no wire text.
 */
function prepareUnstacked(repo: RepoEntry, worktreeName: string, agent: AgentKind): Prepared {
  const worktree = prepareWorktree(repo, worktreeName, agent);
  return {
    ...worktree,
    preamble:
      `${worktree.preamble}\n\n` +
      `This task depends on another that left nothing to stack on (it finished with no pull request or pushed ` +
      `branch), so the worktree starts from the default branch as usual.`,
  };
}

function prepareHere(repo: RepoEntry, agent: AgentKind): Prepared {
  return {
    cwd: repo.path,
    preamble: `You are a new independent ${AGENT_WORDS[agent].who} session running in the CURRENT worktree at ${repo.path}.`,
  };
}

/** `path` is the ledger's worktree, already canonical and checked (`spawnContinued`); `session` the id it noted there. */
function prepareContinue(continuation: Continuation): Prepared {
  const { path, session, exit, vanished, handedOff } = continuation;
  return { cwd: path, resume: session, preamble: continuePreamble(path, exit, vanished, handedOff) };
}

/**
 * The seed's list of fetched files. The name is `JSON.stringify`'d display text (the parser
 * already kept it to one line); the path is the daemon's own.
 */
function attachmentsBlock(attachments: SessionAttachments | undefined): string {
  if (attachments === undefined || attachments.files.length === 0) return "";
  const rows = attachments.files.map(
    (file) => `- ${file.path} — ${JSON.stringify(file.name)}, ${file.type}, ${file.size} bytes\n`,
  );
  return `\nAttached files (the user's originals, at these paths):\n${rows.join("")}`;
}

/**
 * The opening message, or undefined for none. A resume always gets one, even with no prompt: the preamble tells the
 * model what happened, and an initial message is what keeps claude off its blocking stale-resume dialog. So do
 * fetched files: the seed is the only place their paths are listed. The level rides every seed, a resume's too: a
 * continuation may come back after a compaction or days later, and the note is what restates it. A seedless spawn
 * still has `SEANCE_AUTONOMY`.
 */
function seedText(prepared: Prepared, request: SpawnRequest, attachments?: SessionAttachments): string | undefined {
  const resume = prepared.resume !== undefined;
  const prompt = request.prompt === undefined || request.prompt === "" ? undefined : request.prompt;
  const listed = attachmentsBlock(attachments);
  if (prompt === undefined && !resume && listed === "") return undefined;
  const header = `${prepared.preamble}\n${autonomyNote(autonomyOf(request), agentOf(request))}`;
  return resume
    ? `${header}${prompt === undefined ? "" : `\nFrom the user: ${prompt}\n`}`
    : `${header}${prompt === undefined ? "" : `\nTask: ${prompt}\n`}${listed}`;
}

function agentOf(request: SpawnRequest): AgentKind {
  return request.agent ?? "claude";
}

/**
 * The driver a spawn runs, by its agent (DESIGN.md, Daemon, "Agent drivers"). Codex only on a machine whose
 * `config.json` has a `codex` block: its home and its approval settings come from nowhere else.
 */
function driverFor(request: SpawnRequest, opts: SpawnOptions): AgentDriver {
  if (agentOf(request) === "claude") return claudeDriver;
  if (opts.codex === undefined) {
    throw new SpawnFailure("launch_error", "this machine runs no Codex: its config.json has no codex block");
  }
  const refused = codexRequestRefusal(request);
  if (refused !== null) throw refused;
  return codexDriver(opts.codex);
}

/** Hands the agent-neutral half of a launch to its driver. */
function launchAgent(
  driver: AgentDriver,
  prepared: Prepared,
  name: string,
  request: SpawnRequest,
  repo: RepoEntry,
  opts: SpawnOptions,
  attachments?: SessionAttachments,
): Promise<AgentLaunch> {
  const seed = seedText(prepared, request, attachments);
  return driver.launch({
    request,
    name,
    cwd: prepared.cwd,
    ...(prepared.worktree === undefined ? {} : { worktree: prepared.worktree }),
    ...(prepared.resume === undefined ? {} : { resume: prepared.resume }),
    ...(seed === undefined ? {} : { seed }),
    readDirs: attachments?.dirs ?? [],
    home: opts.home,
    exclave: repo.exclave ?? DEFAULT_EXCLAVE,
  });
}

/**
 * What the window is showing. `history` pulls the scrollback in too: on the
 * death path the redraw scrolls the final output out of the visible screen,
 * leaving only tmux's dead-pane banner. A *live* claude is on the alternate
 * screen, which has no scrollback, so the stuck path asks for the screen alone.
 */
export async function captureWindow(windowId: string, opts: { readonly history: boolean }): Promise<string | null> {
  const screen = await capturePane(windowId, opts);
  if (screen === null) return null;
  const text = screen
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-20)
    .join("\n");
  return text === "" ? null : text;
}

/**
 * tmux new-window returns 0 as soon as the window frame exists — it knows
 * nothing about whether claude started, died, or is up. Keep the pane on exit
 * and poll it until the deadline: a dead pane means claude failed and "spawned"
 * would be a false success; a titled pane (`PANE_TITLED`) means claude is past
 * its startup gates — `isRegistered`, the predicate `sessions.ts` lists by, so
 * `true` here is a window the ack's session list contains. Polling reports either
 * as soon as it happens; reaching the deadline means only "alive but not
 * registered", the shape of a claude sitting on a dialog no remote can answer.
 * Ported from /spawn.
 *
 * Past it a task's window keeps `remain-on-exit on`, so every exit, a clean one
 * included, leaves a dead pane holding its status for `harvestExits`
 * (`exit-status.ts`) to note before it closes it (`armTask` adds the hook that
 * closes a clean one at once). A clean exit must leave a status: "no status" is
 * how a window closed from outside reads. Any other window gets `off`.
 */
async function awaitRegistration(windowId: string, waitMs: number, task: boolean): Promise<boolean> {
  await tmuxOk(["set-option", "-w", "-t", windowId, "remain-on-exit", "on"]);
  const deadline = Bun.nanoseconds() + waitMs * 1e6;
  let dead = false;
  let titled = false;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling: each check gates the next, nothing to parallelize
    const panes = await tmux(["list-panes", "-t", windowId, "-F", `#{pane_dead}${FIELD_SEP}${PANE_TITLED}`]);
    // A vanished window is a death that beat remain-on-exit: the pane died
    // before the option landed and tmux closed the window, output and all.
    if (panes.exitCode !== 0) {
      throw new SpawnFailure("claude_died", "claude exited before the session started (window already closed)");
    }
    const [deadField, titledField] = (panes.stdout.split("\n")[0] ?? "").trim().split(FIELD_SEP);
    dead = deadField === "1";
    // This window is ours by construction — the same call `sessions.ts` makes
    // for it, so what registers here is what the list will hold.
    titled = isRegistered({ ours: true, custodian: false, titled: titledField === "1", command: "" });
    if (dead || titled || Bun.nanoseconds() >= deadline) break;
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(100);
  }
  if (dead) {
    const captured = await captureWindow(windowId, { history: true });
    await tmux(["kill-window", "-t", windowId]);
    throw new SpawnFailure("claude_died", `claude exited before the session started:\n${captured ?? "(no output)"}`);
  }
  if (!task) await tmuxOk(["set-option", "-w", "-t", windowId, "remain-on-exit", "off"]);
  return titled;
}

/**
 * Records the task on the new window's one pane, before anything can list it.
 * Argv, so the id never reaches a shell. A pane that can't be tagged is killed:
 * running untagged, it would be the duplicate the tag exists to prevent. Left
 * open: a daemon that dies between `new-window` and this call leaves an
 * untagged pane its successor can't refuse a duplicate for.
 */
async function tagTask(windowId: string, taskId: string): Promise<void> {
  try {
    await tmuxOk(["set-option", "-p", "-t", windowId, TASK_OPTION, taskId]);
  } catch (err) {
    // Gone already: claude died before remain-on-exit could hold it — the same death `awaitRegistration` reports.
    if ((await tmux(["kill-window", "-t", windowId])).exitCode !== 0) {
      throw new SpawnFailure("claude_died", "claude exited before the session started (window already closed)");
    }
    throw new SpawnFailure("launch_error", `could not record the task on the session: ${String(err)}`);
  }
}

/**
 * The per-pane `pane-died` hook's one body: tmux commands only, no shell, the task id its only interpolation.
 * A clean exit's pane is closed unless it is the server's last: the server would exit with it (`exit-empty`)
 * and take the recorded option along, so that pane stays dead for harvest to note and close. A server whose
 * sessions are all one group shares one set of windows, so it counts as one session.
 */
function exitHook(taskId: string): string {
  const lastPane =
    "#{&&:#{||:#{==:#{server_sessions},1},#{==:#{server_sessions},#{session_group_size}}},#{&&:#{==:#{session_windows},1},#{==:#{window_panes},1}}}";
  return (
    `set-option -gF ${EXIT_OPTION_PREFIX}${taskId} '#{pane_dead_status}:#{pane_dead_signal}' ; ` +
    `if-shell -F '${lastPane}' '' 'if-shell -F "#{==:#{pane_dead_status},0}" kill-pane'`
  );
}

/**
 * Keeps a registered task's pane for harvest and hooks its death. Returns the tmux server's pid, which
 * is what lets `harvestExits` judge the pane `vanished` later; undefined (never judged) when the id
 * is not a task id, the hook could not be set, or no pid reads. Runs inside `whileRegistering`, so a
 * harvest pass leaves the pane alone meanwhile.
 *
 * The hook is per pane, never `-g`/`-ga`: it shadows a global `pane-died` for this pane only (DESIGN.md,
 * "Window closed from outside"). It records the death in a server-wide option, then closes a clean
 * exit's pane (not the server's last). The pane option beats the window's, so a pane `join-pane`d elsewhere stays kept; a
 * tmux without `-p` keeps the window-level `on` and hooks the window instead.
 */
async function armTask(windowId: string, taskId: string): Promise<number | undefined> {
  if (!isTaskId(taskId)) return undefined;
  const pane = (await tmux(["display-message", "-p", "-t", windowId, "#{pane_id}"])).stdout.trim();
  if (!/^%\d+$/u.test(pane)) return undefined;
  await tmux(["set-option", "-p", "-t", pane, "remain-on-exit", "on"]);
  let hooked = (await tmux(["set-hook", "-p", "-t", pane, "pane-died", exitHook(taskId)])).exitCode === 0;
  hooked ||= (await tmux(["set-hook", "-w", "-t", windowId, "pane-died", exitHook(taskId)])).exitCode === 0;
  if (!hooked) return undefined;
  const pid = Number((await tmux(["display-message", "-p", "#{pid}"])).stdout.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export interface SpawnOptions {
  /** tmux session group the new window lands in. */
  readonly tmuxSession: string;
  /** Machine tag suffixed onto the remote-control session name; absent means none. */
  readonly machineTag?: string;
  /**
   * Where the exclaves live, so a repo is pre-trusted in its own exclave's
   * config. Required, not defaulted to `homedir()`: a test that forgot it
   * would write the developer's real `~/.claude.json`.
   */
  readonly home: string;
  /**
   * How long to wait for claude to register before acking it as pending. The
   * TUI titles the pane within ~0.5s on a warm machine; `--worktree` puts a
   * fetch before that, so the default leaves room for a slow origin.
   */
  readonly waitMs?: number;
  /** This machine's Codex (`config.json`'s `codex` block and the home); absent, a Codex spawn is refused. */
  readonly codex?: CodexDriverOptions;
}

/**
 * Spawns per task id in flight, so two requests for one task never both pass
 * the duplicate check before either has tagged its pane — the relay and the
 * local socket share this process, and neither serializes. Holds only what is
 * running now; what is already spawned is read from tmux.
 */
const taskSpawns = new Map<string, Promise<unknown>>();

export async function spawnSession(
  request: SpawnRequest,
  repos: readonly RepoEntry[],
  opts: SpawnOptions,
  continuation?: Continuation,
  attachments?: SessionAttachments,
): Promise<SpawnOutcome> {
  const { taskId } = request;
  if (request.mode === "continue" && (continuation === undefined || request.continues === undefined)) {
    throw new SpawnFailure("not_continuable", "this machine's session backend cannot continue a session");
  }
  if (taskId === undefined) return spawnUntracked(request, repos, opts, attachments);
  const prior = taskSpawns.get(taskId) ?? Promise.resolve();
  const run = prior
    .catch(() => undefined)
    .then(async () => {
      // Before the repo lookup: a task already running is the answer even if a rescan has since lost its repo.
      const running = paneRunningTask(await listPanes(), taskId);
      if (running !== null) {
        const where = running.windowName === "" ? running.paneId : running.windowName;
        throw new SpawnFailure("task_running", `task ${taskId} is already running in ${where}`, running.paneId);
      }
      if (request.mode === "continue" && continuation !== undefined && request.continues !== undefined) {
        return spawnContinued(request, request.continues, repos, opts, continuation, attachments);
      }
      return spawnUntracked(request, repos, opts, attachments);
    });
  taskSpawns.set(taskId, run);
  try {
    return await run;
  } finally {
    if (taskSpawns.get(taskId) === run) taskSpawns.delete(taskId);
  }
}

/**
 * Continuations in flight per worktree: two tasks continuing one session (two taps, two
 * clients) are different task ids, so `taskSpawns` does not order them, and both would pass
 * the live-pane check before either tagged a pane.
 */
const pathSpawns = new Map<string, Promise<unknown>>();

function underDir(dir: string, path: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * A killed claude leaves the lock it took on its worktree (and it makes reap keep it). The
 * continuation clears it only in that one shape — Claude's own reason, a dead pid — and any
 * other lock is someone's, so it refuses and leaves it. True when git lists a worktree at `path`,
 * present or not.
 */
async function releaseStaleLock(repo: RepoEntry, path: string): Promise<boolean> {
  const listed = await hardenedGit(repo.path, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.exitCode !== 0) {
    throw new SpawnFailure("not_continuable", `could not read the worktrees of ${repo.name}, so its lock is unknown`);
  }
  // Compared canonical: git prints the path as it recorded it, tmux and the ledger as the filesystem spells it.
  const records = await Promise.all(
    parseWorktreeList(listed.stdout).map(async (record) => ({ record, real: await canonical(record.path) })),
  );
  const found = records.find((entry) => entry.real === path)?.record;
  if (found === undefined) return false;
  const lock = parseWorktreeLock(listed.stdout, found.path);
  if (lock === null) return true;
  if (!staleClaudeLock(lock.reason)) {
    const why = lock.reason === "" ? "no reason given" : lock.reason;
    throw new SpawnFailure("not_continuable", `its worktree is locked (${why})`);
  }
  const unlocked = await hardenedGit(repo.path, ["worktree", "unlock", found.path]);
  if (unlocked.exitCode !== 0) {
    throw new SpawnFailure(
      "not_continuable",
      `its worktree is locked and could not be unlocked: ${unlocked.stderr.trim()}`,
    );
  }
  log.info(`unlocked ${path}: the lock was a dead claude's (${lock.reason})`);
  return true;
}

function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/** A checkout of a large clone takes longer than `hardenedGit`'s default. */
const READD_TIMEOUT_MS = 60_000;

/**
 * Puts a worktree reap removed back at its noted path, on the local branch the ledger last saw it on
 * (DESIGN.md, Daemon, "Continuing a session"): never origin's, so nothing on the spawn path goes to the
 * network and no ref anyone with push access can move is checked out. `path` and `branch` are this machine's
 * ledger's, the path's parent already checked canonical by the handler. Under reap's lock: its branch sweep
 * deletes with `update-ref -d`, which does not refuse a branch checked out in a worktree.
 */
async function readdWorktree(repo: RepoEntry, path: string, branch: string | undefined): Promise<void> {
  if (branch === undefined) {
    throw new SpawnFailure(
      "not_continuable",
      `its worktree ${path} is gone, and no branch of it was noted to re-add it from`,
    );
  }
  try {
    await serialReadd(() => withReapLock(() => readdLocked(repo, path, branch)));
  } catch (err) {
    if (err instanceof SpawnFailure) throw err;
    if (err instanceof ReapBusy) {
      throw new SpawnFailure("not_continuable", `its worktree ${path} is gone and ${err.message}; try again shortly`);
    }
    // Any other throw would reach the handler as an unknown failure and mark a launch that never ran interrupted.
    const why = err instanceof Error ? err.message : String(err);
    throw new SpawnFailure("not_continuable", `its worktree ${path} is gone and re-adding it failed: ${why}`);
  }
}

/**
 * Re-adds run one at a time in this process: `withReapLock` is a cross-process lock keyed by pid, so two
 * continuations of different tasks reaching it together would refuse each other as "a reap is already running".
 */
let readdQueue: Promise<unknown> = Promise.resolve();
function serialReadd<T>(run: () => Promise<T>): Promise<T> {
  const next = readdQueue.catch(() => undefined).then(run);
  readdQueue = next;
  return next;
}

async function readdLocked(repo: RepoEntry, path: string, branch: string): Promise<void> {
  // A checkout runs the filters repo-local config names, which a session can write.
  const refused = await repoConfigRefusal(repo.path);
  if (refused !== null) {
    throw new SpawnFailure(
      "not_continuable",
      `its worktree ${path} is gone, and re-adding it is refused: repo-local ${refused}`,
    );
  }
  // Anything at the leaf now, a symlink included, is not the gone worktree the handler saw: git would write
  // the checkout through a link into an empty directory.
  if ((await lstat(path).catch(() => null)) !== null) {
    throw new SpawnFailure("not_continuable", `its worktree ${path} reappeared`);
  }
  // The branch is the one the worktree was last seen on, which a session may have switched to the default
  // branch; a re-add resumes onto it, where the session's commits and pushes would then land.
  const defaultBranch = await readDefaultBranch(repo.path);
  if (defaultBranch !== null && defaultBranch === branch) {
    throw new SpawnFailure(
      "not_continuable",
      `its worktree ${path} is gone, and it was last on the default branch (${branch}), which a re-add does not check out`,
    );
  }
  // The exact ref: no revision syntax, no tag or remote branch of the same name standing in.
  const kept = await hardenedGit(repo.path, ["show-ref", "--verify", "-s", `refs/heads/${branch}`]);
  const tip = kept.stdout.trim();
  if (kept.exitCode !== 0 || tip === "") {
    throw new SpawnFailure(
      "not_continuable",
      `its worktree ${path} ${WORKTREE_AND_BRANCH_GONE} (merged and swept by reap, or deleted)`,
    );
  }
  // A directory removed by hand stays registered, which `worktree add` refuses and which keeps the branch "in use".
  if (await releaseStaleLock(repo, path)) {
    const cleared = await hardenedGit(repo.path, ["worktree", "remove", path]);
    if (cleared.exitCode !== 0) {
      throw new SpawnFailure(
        "not_continuable",
        `its worktree ${path} is gone but still registered: ${cleared.stderr.trim()}`,
      );
    }
  }
  // Detached at the sha just read, then switched onto the branch: `worktree add <path> <branch>` on a branch
  // deleted meanwhile would make one tracking `origin/<branch>`, or detach at a tag of that name. A full oid
  // names no ref, and `--no-guess` is switch's own refusal of that remote lookup.
  const added = await hardenedGit(repo.path, ["worktree", "add", "--detach", "--", path, tip], READD_TIMEOUT_MS);
  if (added.exitCode !== 0) {
    throw new SpawnFailure(
      "not_continuable",
      `its worktree ${path} is gone and could not be re-added: ${added.stderr.trim()}`,
    );
  }
  const undo = async (why: string): Promise<never> => {
    // Plain first; `--force` only when that fails (an interrupted checkout leaves it dirty): nothing but this
    // call's own fresh checkout lives there, under the reap lock and `pathSpawns`.
    let removed = await hardenedGit(repo.path, ["worktree", "remove", path], READD_TIMEOUT_MS);
    if (removed.exitCode !== 0) {
      removed = await hardenedGit(repo.path, ["worktree", "remove", "--force", path], READD_TIMEOUT_MS);
    }
    if (removed.exitCode !== 0) {
      log.warn(`re-add of ${path} failed and the half-added tree could not be removed: ${removed.stderr.trim()}`);
      throw new SpawnFailure(
        "not_continuable",
        `its worktree ${path} could not be re-added: ${why}; the half-added tree is left at that path (${removed.stderr.trim()}): remove it before continuing`,
      );
    }
    throw new SpawnFailure("not_continuable", `its worktree ${path} could not be re-added: ${why}`);
  };
  const switched = await hardenedGit(path, ["switch", "--no-guess", "--", branch], READD_TIMEOUT_MS);
  if (switched.exitCode !== 0) return undo(`its branch could not be checked out: ${switched.stderr.trim()}`);
  const [head, onBranch] = await Promise.all([
    hardenedGit(path, ["rev-parse", "HEAD"]),
    hardenedGit(path, ["symbolic-ref", "HEAD"]),
  ]);
  if (head.stdout.trim() !== tip || onBranch.stdout.trim() !== `refs/heads/${branch}`) {
    return undo("its branch moved while it was re-added");
  }
  if ((await canonical(path)) !== path) return undo("it is not where it was noted");
  log.info(`re-added ${path} from its local branch for a continuation`);
}

/** What `addStackedWorktree` made: the worktree's name under `.claude/worktrees` and the commit it starts at. */
interface Stacked {
  readonly name: string;
  readonly sha: string;
}

/**
 * Makes a stacked spawn's worktree at `sha`, the tip `fetchBase` read of `origin/<base>` (DESIGN.md, "Stacked
 * worktrees"): `worktree add --no-track -b worktree-<name> <path> --end-of-options <sha>`, as claude's own add
 * but `-b`, never `-B` (a branch of that name is someone's, never reset), and at the sha just read rather than
 * the ref, so a fetch landing meanwhile cannot move what the ledger notes. The name is chosen inside the lock,
 * so two spawns of one slug never pick the same. Under reap's lock and the re-add queue, as a continuation's
 * re-add: reap's sweeps must not run beside a worktree being made. A failure leaves nothing behind: the
 * half-made worktree and its branch are removed.
 */
async function addStackedWorktree(repo: RepoEntry, slug: string, sha: string): Promise<Stacked> {
  try {
    return await serialReadd(() => withReapLock(() => addStackedLocked(repo, slug, sha)));
  } catch (err) {
    if (err instanceof SpawnFailure) throw err;
    if (err instanceof ReapBusy) {
      throw new SpawnFailure("launch_error", `could not make the stacked worktree: ${err.message}; try again shortly`);
    }
    const why = err instanceof Error ? err.message : String(err);
    throw new SpawnFailure("launch_error", `could not make the stacked worktree: ${why}`);
  }
}

async function addStackedLocked(repo: RepoEntry, slug: string, sha: string): Promise<Stacked> {
  // A checkout runs the filters repo-local config names, which a session can write.
  const refused = await repoConfigRefusal(repo.path);
  if (refused !== null) {
    throw new SpawnFailure("launch_error", `making a stacked worktree is refused: repo-local ${refused}`);
  }
  const name = await freeWorktreeName(repo, slug);
  const path = join(await canonical(repo.path), ".claude", "worktrees", name);
  // Anything at the leaf (a symlink included) would have git write the checkout through it.
  if ((await lstat(path).catch(() => null)) !== null) {
    throw new SpawnFailure("launch_error", `could not make the stacked worktree: ${path} already exists`);
  }
  const branch = `worktree-${name}`;
  const added = await hardenedGit(
    repo.path,
    ["worktree", "add", "--no-track", "-b", branch, path, "--end-of-options", sha],
    READD_TIMEOUT_MS,
  );
  const undo = async (why: string): Promise<never> => {
    // Nothing but this call's own fresh checkout lives there, under the reap lock and the re-add queue.
    let removed = await hardenedGit(repo.path, ["worktree", "remove", path], READD_TIMEOUT_MS);
    if (removed.exitCode !== 0) {
      removed = await hardenedGit(repo.path, ["worktree", "remove", "--force", path], READD_TIMEOUT_MS);
    }
    // Only while it still names the commit this call made it at: never a branch moved by anything else.
    await hardenedGit(repo.path, ["update-ref", "-d", `refs/heads/${branch}`, sha]);
    if (removed.exitCode !== 0 && (await lstat(path).catch(() => null)) !== null) {
      log.warn(`a stacked worktree failed and the half-made tree could not be removed: ${removed.stderr.trim()}`);
    }
    throw new SpawnFailure("launch_error", `could not make the stacked worktree: ${why}`);
  };
  if (added.exitCode !== 0) return undo(added.stderr.trim());
  const [head, onBranch] = await Promise.all([
    hardenedGit(path, ["rev-parse", "HEAD"]),
    hardenedGit(path, ["symbolic-ref", "HEAD"]),
  ]);
  if (head.stdout.trim() !== sha || onBranch.stdout.trim() !== `refs/heads/${branch}`) {
    return undo("it is not at its base");
  }
  if ((await canonical(path)) !== path) return undo("it is not under the clone's .claude/worktrees");
  return { name, sha };
}

function liveInside(panes: readonly PaneInfo[], path: string): Promise<PaneInfo | undefined> {
  return Promise.all(
    panes
      .filter((pane) => !pane.dead)
      .map(async (pane) =>
        // tmux reports a realpath, so the raw path normally matches; the canonical form covers a pane whose cwd moved through a link.
        underDir(path, pane.path) || underDir(path, await canonical(pane.path)) ? pane : undefined,
      ),
  ).then((hits) => hits.find((pane) => pane !== undefined));
}

/**
 * Resumes a failed or cancelled task's conversation in its worktree: `continuation.path` is
 * what this machine's own launch ledger noted for `continues`, canonical and checked by the
 * handler (DESIGN.md, Daemon, "Continuing a session"). No fetch and no new worktree — the session picks up
 * what the dead one left.
 */
async function spawnContinued(
  request: SpawnRequest,
  continues: string,
  repos: readonly RepoEntry[],
  opts: SpawnOptions,
  continuation: Continuation,
  attachments?: SessionAttachments,
): Promise<SpawnOutcome> {
  const { path } = continuation;
  const prior = pathSpawns.get(path) ?? Promise.resolve();
  const run = prior
    .catch(() => undefined)
    .then(() => continueLocked(request, continues, repos, opts, continuation, attachments));
  pathSpawns.set(path, run);
  try {
    return await run;
  } finally {
    if (pathSpawns.get(path) === run) pathSpawns.delete(path);
  }
}

async function continueLocked(
  request: SpawnRequest,
  continues: string,
  repos: readonly RepoEntry[],
  opts: SpawnOptions,
  continuation: Continuation,
  attachments?: SessionAttachments,
): Promise<SpawnOutcome> {
  const { path } = continuation;
  const repo = repos.find((r) => r.name === request.repo);
  if (repo === undefined) {
    throw new SpawnFailure("repo_not_found", `no repo named "${request.repo}" — try a rescan`);
  }
  const present = await isDirectory(path);
  const panes = await listPanes();
  const running = paneRunningTask(panes, continues);
  if (running !== null) {
    const where = running.windowName === "" ? running.paneId : running.windowName;
    throw new SpawnFailure("not_continuable", `the session is still running in ${where}`);
  }
  const open = await liveInside(panes, path);
  if (open !== undefined) {
    const where = open.windowName === "" ? open.paneId : open.windowName;
    throw new SpawnFailure("not_continuable", `a session is open in its worktree (${where})`);
  }
  // After the pane checks: nothing is written to git while a session may still hold the conversation.
  if (!present) await readdWorktree(repo, path, continuation.branch);
  // The handler checked a present path canonical, and a gone one only by its parent: a link may have appeared since.
  else if ((await canonical(path)) !== path) {
    throw new SpawnFailure("not_continuable", `its noted path ${path} is not a worktree of ${repo.name}`);
  }
  await releaseStaleLock(repo, path);

  const name = basename(path);
  const windowName = sanitizeWindowName(request.title ?? name);
  const prepared = prepareContinue(continuation);
  // The worktree, not the clone root, is where the session starts, so the driver trusts the worktree's own path.
  const launch = await launchAgent(
    driverFor(request, opts),
    prepared,
    sessionName(name, opts.machineTag),
    request,
    repo,
    opts,
    attachments,
  );
  const outcome = await launchWindow(prepared, launch, windowName, request, opts);
  return present ? outcome : { ...outcome, readded: true };
}

async function spawnUntracked(
  request: SpawnRequest,
  repos: readonly RepoEntry[],
  opts: SpawnOptions,
  attachments?: SessionAttachments,
): Promise<SpawnOutcome> {
  const repo = repos.find((r) => r.name === request.repo);
  if (repo === undefined) {
    throw new SpawnFailure("repo_not_found", `no repo named "${request.repo}" — try a rescan`);
  }
  // A continuation goes through `spawnContinued` and never fetches: this narrows the mode `freshenBase` takes.
  if (request.mode === "continue") {
    throw new SpawnFailure("not_continuable", "a continuation needs its launch record's worktree");
  }

  const base = request.baseBranch;
  // The handler takes a base only beside worktree mode; a backend reached any other way refuses it rather than
  // starting from the default branch, the hazard the field exists for.
  if (base !== undefined && request.mode !== "worktree") {
    throw new SpawnFailure("launch_error", "a base branch is for a worktree spawn only");
  }

  // Network, so it runs beside the local steps; it never throws, so nothing
  // between here and its await can leave it rejecting unobserved. A stacked
  // spawn fetches its base instead, before its worktree is made.
  const freshened = base === undefined ? freshenBase(repo, request.mode) : Promise.resolve(undefined);

  const slug = slugify(request.title ?? request.prompt ?? "session");
  const agent = agentOf(request);
  // Before any worktree is made: a machine that runs no such agent leaves nothing behind.
  const driver = driverFor(request, opts);
  let stacked: Stacked | undefined;
  if (base !== undefined) {
    const tip = await fetchBase(repo, base);
    if (!tip.ok) throw new SpawnFailure("base_not_found", tip.message);
    stacked = await addStackedWorktree(repo, slug, tip.sha);
  }
  // Claude makes a plain worktree itself (`--worktree`). For another agent the daemon makes it, after the fetch, at the
  // tip Claude's would start from, under the same lock and in the same layout as a stack's, so reap, the custodian,
  // continue and `pushTaskBranch` find it where they find Claude's (DESIGN.md, Daemon, "Codex sessions").
  let made = stacked;
  if (agent !== "claude" && base === undefined && request.mode === "worktree") {
    await freshened;
    const tip = await defaultBaseTip(repo);
    if (!tip.ok) throw new SpawnFailure("no_default_branch", tip.message);
    made = await addStackedWorktree(repo, slug, tip.sha);
  }

  const worktreeName = made?.name ?? (request.mode === "here" ? slug : await freeWorktreeName(repo, slug));
  const windowName = sanitizeWindowName(request.title ?? worktreeName);

  const prepared =
    request.mode === "here"
      ? prepareHere(repo, agent)
      : base !== undefined
        ? prepareStacked(repo, worktreeName, base, agent)
        : request.noBase === true
          ? prepareUnstacked(repo, worktreeName, agent)
          : prepareWorktree(repo, worktreeName, agent);
  const launch = await launchAgent(
    driver,
    prepared,
    sessionName(worktreeName, opts.machineTag),
    request,
    repo,
    opts,
    attachments,
  );
  // Before launch: claude reads the tracking ref, and `FETCH_HEAD`'s age, at startup.
  const note = await freshened;
  const outcome = await launchWindow(prepared, launch, windowName, request, opts, note);
  return stacked === undefined ? outcome : { ...outcome, stackedOn: stacked.sha };
}

async function launchWindow(
  prepared: Prepared,
  launch: AgentLaunch,
  windowName: string,
  request: SpawnRequest,
  opts: SpawnOptions,
  note?: string,
): Promise<SpawnOutcome> {
  // For the tmux-rename mod (claude-mods/), which keeps exactly this suffix on a
  // `/rename`'s session name and off its window. Per window as well as
  // `publishMachineTag`'s global one, so a spawn never depends on that having
  // succeeded. `-e` is argv, so the tag never reaches the shell string. Always
  // passed, empty when untagged: omitted, the window would inherit whatever the
  // tmux server's environment holds — a server started from inside a séance
  // session carries that session's tag.
  const tagEnv = ["-e", `SEANCE_MACHINE_TAG=${machineTagSlug(opts.machineTag)}`];
  // Always passed, for the same reason as the tag: a server started inside a séance session
  // would hand that session's level to every window. A literal of `AUTONOMY_LEVELS`, never a wire string.
  const autonomyEnv = ["-e", `SEANCE_AUTONOMY=${autonomyOf(request)}`];
  const extraEnv = launch.env.flatMap((pair) => ["-e", pair]);
  const target = await resolveTargetSession(opts.tmuxSession);
  let windowId: string;
  let registered: boolean;
  let server: number | undefined;
  let session: string | undefined;
  try {
    try {
      windowId = (
        await tmuxOk([
          "new-window",
          "-P",
          "-F",
          "#{window_id}",
          "-t",
          `${target}:`,
          "-c",
          launch.dir,
          "-n",
          windowName,
          ...tagEnv,
          ...autonomyEnv,
          ...extraEnv,
          launch.command,
        ])
      ).trim();
    } catch (err) {
      throw new SpawnFailure("launch_error", err instanceof TmuxError ? err.message : String(err));
    }
    if (request.taskId !== undefined) await tagTask(windowId, request.taskId);

    registered = await whileRegistering(windowId, async () => {
      session = await agentStarted(launch, windowId);
      const titled = await awaitRegistration(windowId, opts.waitMs ?? 5_000, request.taskId !== undefined);
      if (request.taskId !== undefined) server = await armTask(windowId, request.taskId);
      return titled;
    });
  } finally {
    await launch.dispose();
  }

  return {
    window: windowName,
    path: prepared.cwd,
    registered,
    handle: windowId,
    ...(note === undefined ? {} : { note }),
    ...(server === undefined ? {} : { server }),
    ...(session === undefined ? {} : { session }),
    ...(request.agent === undefined ? {} : { agent: request.agent }),
  };
}

/** `AgentLaunch.started`, with the window killed when it throws: a session whose start failed is never left running. */
async function agentStarted(launch: AgentLaunch, windowId: string): Promise<string | undefined> {
  try {
    return await launch.started(windowId);
  } catch (err) {
    await tmux(["kill-window", "-t", windowId]);
    if (err instanceof SpawnFailure) throw err;
    throw new SpawnFailure(
      "launch_error",
      `the session did not start: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
