import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_EFFORT, DEFAULT_MODEL, isTaskId, type RepoEntry, type SpawnRequest } from "@seance/shared";
import { SpawnFailure, type Continuation, type SessionAttachments, type SpawnOutcome } from "./backend.ts";
import { freshenBase } from "./base-fetch.ts";
import { git } from "./exec.ts";
import { whileRegistering } from "./exit-status.ts";
import { DEFAULT_EXCLAVE, exclaveConfigFile } from "./exclaves.ts";
import { canonical } from "./gitdir.ts";
import { hardenedGit } from "./git-hardened.ts";
import { log } from "./log.ts";
import { parseWorktreeList, parseWorktreeLock } from "./reap-git.ts";
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
import { ensureRepoTrusted } from "./trust.ts";

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

function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

interface Prepared {
  readonly launchDir: string;
  readonly resultPath: string;
  readonly worktreeFlag: readonly string[];
  readonly preamble: string;
  /**
   * The Claude session id: a task's new one (`--session-id`), or the one a continuation resumes
   * (`--resume`, `resume: true`). Always a `crypto.randomUUID()` this daemon made — for a resume, the
   * one its ledger noted at that launch — never a wire value. Absent for an untracked spawn.
   */
  readonly session?: { readonly id: string; readonly resume: boolean };
  /** Extra `NAME=value` pairs for the window's environment (tmux `-e`), literals only. */
  readonly env: readonly string[];
}

/**
 * Past these claude 2.1.310 stops a resume of a session this old and this big on a "Resume from
 * summary / full session" dialog no remote can answer (the typical OOM'd session). An initial
 * message, which a continuation always has, is what skips it; these are defence in depth.
 */
const RESUME_NEVER_ASKS = [
  "CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=99999999",
  "CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=99999999",
] as const;

/**
 * Never asserts that the dead session's background work is gone: only claude itself
 * was stopped, and a surviving child is not something the pane checks can see. The
 * wording comes from the old task's own ledger note `exit`, never from a frame: nonzero
 * is a death, anything else (zero, or none noted) a cancel.
 */
export function continuePreamble(path: string, exit: number | undefined, vanished?: boolean): string {
  const prefix = `This session was resumed by séance in the same git worktree at ${path}, after the previous session `;
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
 * Worktree mode creates no worktree, deliberately. `claude --worktree` resolves
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
function prepareWorktree(repo: RepoEntry, worktreeName: string, session: string | undefined): Prepared {
  const worktreePath = join(repo.path, ".claude", "worktrees", worktreeName);
  return {
    launchDir: repo.path,
    resultPath: worktreePath,
    worktreeFlag: ["--worktree", worktreeName],
    ...(session === undefined ? {} : { session: { id: session, resume: false } }),
    env: [],
    preamble:
      `You are a new independent Claude session in a FRESH git worktree at ${worktreePath}, ` +
      `on branch worktree-${worktreeName}. Before starting the task, set this worktree up per ` +
      `the repo's own docs (check CLAUDE.md's worktree-setup section and/or README), including ` +
      `copying any .env from the main checkout at ${repo.path}.`,
  };
}

function prepareHere(repo: RepoEntry, session: string | undefined): Prepared {
  return {
    launchDir: repo.path,
    resultPath: repo.path,
    worktreeFlag: [],
    ...(session === undefined ? {} : { session: { id: session, resume: false } }),
    env: [],
    preamble: `You are a new independent Claude session running in the CURRENT worktree at ${repo.path}.`,
  };
}

/** `path` is the ledger's worktree, already canonical and checked (`spawnContinued`); `session` the id it noted there. */
function prepareContinue(continuation: Continuation): Prepared {
  const { path, session, exit, vanished } = continuation;
  return {
    launchDir: path,
    resultPath: path,
    worktreeFlag: [],
    session: { id: session, resume: true },
    env: RESUME_NEVER_ASKS,
    preamble: continuePreamble(path, exit, vanished),
  };
}

interface InnerCommand {
  readonly command: string;
  /**
   * Temp dir holding the seed prompt; deleted by the caller after the alive
   * check. The shell opens the redirect before `exec`, so the unlink drops the
   * name, never the fd claude is reading — cleanup cannot race the read.
   */
  readonly seedDir: string | null;
}

function sessionFlag(session: Prepared["session"]): string {
  if (session === undefined) return "";
  return ` ${session.resume ? "--resume" : "--session-id"} ${shq(session.id)}`;
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

async function buildInnerCommand(
  prepared: Prepared,
  session: string,
  request: SpawnRequest,
  attachments?: SessionAttachments,
): Promise<InnerCommand> {
  const claude = process.env["SEANCE_CLAUDE_BIN"] ?? "claude";
  const caffeinate = process.platform === "darwin" ? "caffeinate -is " : "";
  // `exec` keeps the pane's process-group-leader pid on claude itself — a
  // forked child under a compound command leaves pane_current_command as the
  // shell, hiding the window from session detection.
  //
  // `--permission-mode` is omitted unless the caller asked for plan mode: passing one
  // unconditionally would override whatever the machine's settings.json chose, so by
  // default the session inherits the same mode an in-terminal `claude` gets on that box.
  // `plan` is the one exception, and only ever a tightening the caller opted into.
  //
  // `--remote-control [name]` takes an optional value, so it sits before the
  // other flags: trailing, it swallowed a here-mode seed prompt as the session
  // name and the session started idle. The seed is off argv entirely now (see
  // below), so `--` guards nothing today — it stays as the standing terminator
  // for whatever lands at the tail next.
  // `--add-dir <directories...>` is variadic, so it sits directly before `--model`, which ends it.
  // Daemon paths, never wire values, quoted like every path.
  const addDirs = (attachments?.dirs ?? []).map((dir) => `--add-dir ${shq(dir)} `).join("");
  const base =
    `exec ${caffeinate}${claude} -n ${shq(session)} --remote-control ${addDirs}` +
    `--model ${shq(request.model ?? DEFAULT_MODEL)} --effort ${shq(request.effort ?? DEFAULT_EFFORT)}` +
    // literal value, so nothing wire-supplied reaches the command line — no shq() needed
    `${request.plan === true ? " --permission-mode plan" : ""}` +
    `${prepared.worktreeFlag.length > 0 ? ` --worktree ${shq(prepared.worktreeFlag[1] ?? "")}` : ""}` +
    // A daemon-made UUID, never a wire value (`continues` is a ledger key and never reaches the command line).
    // `--resume <id>`, not `--continue`: claude files a `--worktree` session under the project it started
    // in, which may be the clone's, and `--continue` looks only in the cwd's (DESIGN.md, "Continuing a session").
    `${sessionFlag(prepared.session)}`;
  const resume = prepared.session?.resume === true;
  const prompt = request.prompt === undefined || request.prompt === "" ? undefined : request.prompt;
  // A resume always gets a seed, even with no prompt: the preamble tells the model what happened, and
  // an initial message is what keeps claude off its blocking stale-resume dialog (`RESUME_NEVER_ASKS`).
  // So do fetched files: the seed is the only place their paths are listed.
  const listed = attachmentsBlock(attachments);
  if (prompt === undefined && !resume && listed === "") {
    return { command: base, seedDir: null };
  }

  const seedDir = await mkdtemp(join(tmpdir(), "seance-seed-"));
  const seedFile = join(seedDir, "seed.txt");
  const seed = resume
    ? `${prepared.preamble}\n${prompt === undefined ? "" : `\nFrom the user: ${prompt}\n`}`
    : `${prepared.preamble}\n${prompt === undefined ? "" : `\nTask: ${prompt}\n`}${listed}`;
  await Bun.write(seedFile, seed);
  // Redirect, not an operand: an argv operand would be the expanded prompt in
  // every local process list for the session's whole life — the same text the
  // audit log deliberately reduces to a length and a hash. claude takes
  // non-tty stdin as its opening prompt and reopens /dev/tty for the UI, so
  // the pane stays interactive. `--` still terminates option parsing, and on
  // macOS `caffeinate -is` passes the fd through to claude unchanged.
  return { command: `${base} -- < ${shq(seedFile)}`, seedDir };
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
    titled = isRegistered({ ours: true, titled: titledField === "1", command: "" });
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

/**
 * Claude Code's own lock on a worktree it made, held for its process's life: `claude session
 * <name> (pid N start <procStart>)`, the ` start …` part absent on Windows. Its own parser's
 * grammar, bounds included. The start time is not compared, so a live pid (even a reused one)
 * stays a refusal: fail closed.
 */
const CLAUDE_LOCK = /^claude (?:agent|session) .{1,255} \(pid (\d{1,10})(?: start .{1,255})?\)$/u;

function underDir(dir: string, path: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/** A pid this process may not signal (EPERM) is alive; only ESRCH says gone. */
function pidGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "ESRCH";
  }
}

/**
 * A killed claude leaves the lock it took on its worktree (and it makes reap keep it). The
 * continuation clears it only in that one shape — Claude's own reason, a dead pid — and any
 * other lock is someone's, so it refuses and leaves it.
 */
async function releaseStaleLock(repo: RepoEntry, path: string): Promise<void> {
  const listed = await hardenedGit(repo.path, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.exitCode !== 0) {
    throw new SpawnFailure("not_continuable", `could not read the worktrees of ${repo.name}, so its lock is unknown`);
  }
  // Compared canonical: git prints the path as it recorded it, tmux and the ledger as the filesystem spells it.
  const records = await Promise.all(
    parseWorktreeList(listed.stdout).map(async (record) => ({ record, real: await canonical(record.path) })),
  );
  const found = records.find((entry) => entry.real === path)?.record;
  if (found === undefined) return;
  const lock = parseWorktreeLock(listed.stdout, found.path);
  if (lock === null) return;
  const pid = CLAUDE_LOCK.exec(lock.reason)?.[1];
  if (pid === undefined || !pidGone(Number(pid))) {
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
  const present = await stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!present) {
    throw new SpawnFailure("not_continuable", `its worktree ${path} is gone (removed or reaped)`);
  }
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
  await releaseStaleLock(repo, path);

  // The worktree, not the clone root, is where claude starts, so trust is asked for the worktree's own path.
  await ensureRepoTrusted(path, exclaveConfigFile(opts.home, repo.exclave ?? DEFAULT_EXCLAVE));

  const name = basename(path);
  const windowName = sanitizeWindowName(request.title ?? name);
  const prepared = prepareContinue(continuation);
  const inner = await buildInnerCommand(prepared, sessionName(name, opts.machineTag), request, attachments);
  return launchWindow(prepared, inner, windowName, request, opts);
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

  // Network, so it runs beside the local steps; it never throws, so nothing
  // between here and its await can leave it rejecting unobserved.
  const freshened = freshenBase(repo, request.mode);

  // answer claude's trust dialog before it can block the session (fails open — see trust.ts)
  await ensureRepoTrusted(repo.path, exclaveConfigFile(opts.home, repo.exclave ?? DEFAULT_EXCLAVE));

  const slug = slugify(request.title ?? request.prompt ?? "session");
  const worktreeName = request.mode === "here" ? slug : await freeWorktreeName(repo, slug);
  const windowName = sanitizeWindowName(request.title ?? worktreeName);

  // Every task gets an id of the daemon's own, so a continuation can name the conversation it resumes.
  const session = request.taskId === undefined ? undefined : crypto.randomUUID();
  const prepared = request.mode === "here" ? prepareHere(repo, session) : prepareWorktree(repo, worktreeName, session);
  const inner = await buildInnerCommand(prepared, sessionName(worktreeName, opts.machineTag), request, attachments);
  // Before launch: claude reads the tracking ref, and `FETCH_HEAD`'s age, at startup.
  const note = await freshened;
  return launchWindow(prepared, inner, windowName, request, opts, note);
}

async function launchWindow(
  prepared: Prepared,
  inner: InnerCommand,
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
  const extraEnv = prepared.env.flatMap((pair) => ["-e", pair]);
  const target = await resolveTargetSession(opts.tmuxSession);
  let windowId: string;
  let registered: boolean;
  let server: number | undefined;
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
          prepared.launchDir,
          "-n",
          windowName,
          ...tagEnv,
          ...extraEnv,
          inner.command,
        ])
      ).trim();
    } catch (err) {
      throw new SpawnFailure("launch_error", err instanceof TmuxError ? err.message : String(err));
    }
    if (request.taskId !== undefined) await tagTask(windowId, request.taskId);

    registered = await whileRegistering(windowId, async () => {
      const titled = await awaitRegistration(windowId, opts.waitMs ?? 5_000, request.taskId !== undefined);
      if (request.taskId !== undefined) server = await armTask(windowId, request.taskId);
      return titled;
    });
  } finally {
    if (inner.seedDir !== null) await rm(inner.seedDir, { recursive: true, force: true });
  }

  return {
    window: windowName,
    path: prepared.resultPath,
    registered,
    handle: windowId,
    ...(note === undefined ? {} : { note }),
    ...(server === undefined ? {} : { server }),
    ...(prepared.session === undefined ? {} : { session: prepared.session.id }),
  };
}
