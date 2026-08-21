import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EFFORT, DEFAULT_MODEL, type RepoEntry, type SpawnRequest } from "@seance/shared";
import { SpawnFailure, type SpawnOutcome } from "./backend.ts";
import { git } from "./exec.ts";
import { readDefaultBranch } from "./scan.ts";
import { resolveTargetSession, sanitizeWindowName, tmux, tmuxOk, TmuxError } from "./tmux.ts";
import { ensureRepoTrusted } from "./trust.ts";

export function slugify(src: string): string {
  const slug = src
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/u, "");
  return slug === "" ? "session" : slug;
}

/**
 * The remote-control session name — what the Claude UIs list, and deliberately
 * not the tmux window name, which stays bare because the host is never in
 * question locally. Reads as `task @ host` (spaces so the tag is scannable):
 * the task leads, since that is what you scan a session list for, and the
 * machine trails as the qualifier.
 * `slug` is already slugified, so it can carry no `@` of its own and the
 * suffix can never double up.
 */
export function sessionName(slug: string, tag?: string): string {
  if (tag === undefined || tag.trim() === "") return slug;
  return `${slug} @ ${slugify(tag)}`;
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
  readonly note?: string;
}

/** Worktree mode: resolve the default branch (network allowed here), fetch, ff-only when safe. Ported from /spawn. */
async function prepareWorktree(repo: RepoEntry, worktreeName: string): Promise<Prepared> {
  let defaultBranch = repo.defaultBranch ?? (await readDefaultBranch(repo.path));
  if (defaultBranch === null) {
    await git(repo.path, ["remote", "set-head", "origin", "-a"]);
    defaultBranch = await readDefaultBranch(repo.path);
  }
  if (defaultBranch === null) {
    throw new SpawnFailure("no_default_branch", `could not determine default branch for ${repo.name}`);
  }

  const fetch = await git(repo.path, ["fetch", "origin", defaultBranch]);
  if (fetch.timedOut) {
    throw new SpawnFailure("timeout", `git fetch origin ${defaultBranch} timed out`);
  }
  if (fetch.exitCode !== 0) {
    throw new SpawnFailure("fetch_failed", `git fetch failed: ${fetch.stderr.trim()}`);
  }

  // claude --worktree branches off current HEAD — fast-forward the local
  // default branch first so the worktree starts from latest origin. ff-only:
  // never rewrites local work, and only when default is checked out clean.
  let note: string | undefined;
  const current = (await git(repo.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  const unstagedClean = (await git(repo.path, ["diff", "--quiet"])).exitCode === 0;
  const stagedClean = (await git(repo.path, ["diff", "--cached", "--quiet"])).exitCode === 0;
  if (current === defaultBranch && unstagedClean && stagedClean) {
    const ff = await git(repo.path, ["merge", "--ff-only", `origin/${defaultBranch}`]);
    if (ff.exitCode !== 0) {
      note = `local ${defaultBranch} diverged from origin — worktree bases on local HEAD`;
    }
  } else {
    note = `checkout not on a clean ${defaultBranch} (on '${current || "detached HEAD"}') — worktree bases on current HEAD, not latest origin/${defaultBranch}`;
  }

  const worktreePath = join(repo.path, ".claude", "worktrees", worktreeName);
  const prepared: Prepared = {
    launchDir: repo.path,
    resultPath: worktreePath,
    worktreeFlag: ["--worktree", worktreeName],
    preamble:
      `You are a new independent Claude session in a FRESH git worktree at ${worktreePath}, ` +
      `on branch worktree-${worktreeName}. Before starting the task, set this worktree up per ` +
      `the repo's own docs (check CLAUDE.md's worktree-setup section and/or README), including ` +
      `copying any .env from the main checkout at ${repo.path}.`,
  };
  return note === undefined ? prepared : { ...prepared, note };
}

function prepareHere(repo: RepoEntry): Prepared {
  return {
    launchDir: repo.path,
    resultPath: repo.path,
    worktreeFlag: [],
    preamble: `You are a new independent Claude session running in the CURRENT worktree at ${repo.path}.`,
  };
}

interface InnerCommand {
  readonly command: string;
  /** Temp dir holding the seed prompt; deleted by the caller after the alive check. */
  readonly seedDir: string | null;
}

async function buildInnerCommand(prepared: Prepared, session: string, request: SpawnRequest): Promise<InnerCommand> {
  const claude = process.env["SEANCE_CLAUDE_BIN"] ?? "claude";
  const caffeinate = process.platform === "darwin" ? "caffeinate -is " : "";
  // `exec` keeps the pane's process-group-leader pid on claude itself — a
  // forked child under a compound command leaves pane_current_command as the
  // shell, hiding the window from session detection.
  //
  // No `--permission-mode`: the flag would override whatever the machine's
  // settings.json chose, so the session inherits the same default an
  // in-terminal `claude` would get on that box.
  //
  // `--remote-control [name]` takes an optional value, so it sits before the
  // other flags: trailing, it swallowed a here-mode seed prompt as the session
  // name and the session started idle. The `--` guard below is the second,
  // independent defence.
  const base =
    `exec ${caffeinate}${claude} -n ${shq(session)} --remote-control ` +
    `--model ${shq(request.model ?? DEFAULT_MODEL)} --effort ${shq(request.effort ?? DEFAULT_EFFORT)}` +
    `${prepared.worktreeFlag.length > 0 ? ` --worktree ${shq(prepared.worktreeFlag[1] ?? "")}` : ""}`;
  if (request.prompt === undefined || request.prompt === "") {
    return { command: base, seedDir: null };
  }

  const seedDir = await mkdtemp(join(tmpdir(), "seance-seed-"));
  const seedFile = join(seedDir, "seed.txt");
  await Bun.write(seedFile, `${prepared.preamble}\n\nTask: ${request.prompt}\n`);
  // the substitution runs before exec, so the file is consumed at shell start;
  // `--` ends option parsing, keeping the seed an operand rather than some
  // flag's optional value
  return { command: `${base} -- "$(cat ${shq(seedFile)})"`, seedDir };
}

/**
 * tmux new-window returns 0 as soon as the window frame exists — it knows
 * nothing about whether claude started or died. Keep the pane on exit and
 * poll pane_dead until the deadline: a dead pane means claude failed and
 * "spawned" would be a false success. Polling rather than one check at the
 * deadline reports the death as soon as it happens; "alive" still means
 * only "survived waitMs". Ported from /spawn.
 */
async function verifyPaneAlive(windowId: string, waitMs: number): Promise<void> {
  await tmuxOk(["set-option", "-w", "-t", windowId, "remain-on-exit", "on"]);
  const deadline = Bun.nanoseconds() + waitMs * 1e6;
  let dead = false;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling: each check gates the next, nothing to parallelize
    const panes = await tmux(["list-panes", "-t", windowId, "-F", "#{pane_dead}"]);
    // A vanished window is a death that beat remain-on-exit: the pane died
    // before the option landed and tmux closed the window, output and all.
    if (panes.exitCode !== 0) {
      throw new SpawnFailure("claude_died", "claude exited before the session started (window already closed)");
    }
    dead = panes.stdout.split("\n")[0]?.trim() === "1";
    if (dead || Bun.nanoseconds() >= deadline) break;
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(100);
  }
  if (dead) {
    // -S -/-E -: the death redraw scrolls the final output into history — the visible screen keeps only the dead-pane banner
    const captured = (await tmux(["capture-pane", "-p", "-S", "-", "-E", "-", "-t", windowId])).stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-20)
      .join("\n");
    await tmux(["kill-window", "-t", windowId]);
    throw new SpawnFailure("claude_died", `claude exited before the session started:\n${captured}`);
  }
  await tmuxOk(["set-option", "-w", "-t", windowId, "remain-on-exit", "off"]);
}

export interface SpawnOptions {
  /** tmux session group the new window lands in. */
  readonly tmuxSession: string;
  /** Machine tag suffixed onto the remote-control session name; absent means none. */
  readonly machineTag?: string;
  readonly waitMs?: number;
}

export async function spawnSession(
  request: SpawnRequest,
  repos: readonly RepoEntry[],
  opts: SpawnOptions,
): Promise<SpawnOutcome> {
  const repo = repos.find((r) => r.name === request.repo);
  if (repo === undefined) {
    throw new SpawnFailure("repo_not_found", `no repo named "${request.repo}" — try a rescan`);
  }

  // answer claude's trust dialog before it can block the session (fails open — see trust.ts)
  await ensureRepoTrusted(repo.path);

  const slug = slugify(request.title ?? request.prompt ?? "session");
  const worktreeName = request.mode === "here" ? slug : await freeWorktreeName(repo, slug);
  const windowName = sanitizeWindowName(request.title ?? worktreeName);

  const prepared = request.mode === "here" ? prepareHere(repo) : await prepareWorktree(repo, worktreeName);
  const inner = await buildInnerCommand(prepared, sessionName(worktreeName, opts.machineTag), request);

  const target = await resolveTargetSession(opts.tmuxSession);
  let windowId: string;
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
          inner.command,
        ])
      ).trim();
    } catch (err) {
      throw new SpawnFailure("launch_error", err instanceof TmuxError ? err.message : String(err));
    }

    await verifyPaneAlive(windowId, opts.waitMs ?? 3_000);
  } finally {
    if (inner.seedDir !== null) await rm(inner.seedDir, { recursive: true, force: true });
  }

  const outcome: SpawnOutcome = { window: windowName, path: prepared.resultPath };
  return prepared.note === undefined ? outcome : { ...outcome, note: prepared.note };
}
