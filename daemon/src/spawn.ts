import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  type RepoEntry,
  type SpawnErrorCode,
  type SpawnRequest,
} from "@seance/shared";
import { git } from "./exec.ts";
import { readDefaultBranch } from "./scan.ts";
import { resolveTargetSession, tmux, tmuxOk, TmuxError } from "./tmux.ts";

export class SpawnFailure extends Error {
  constructor(
    readonly code: SpawnErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SpawnFailure";
  }
}

export interface SpawnOutcome {
  readonly window: string;
  readonly path: string;
  readonly note?: string;
}

export function slugify(src: string): string {
  const slug = src
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug === "" ? "session" : slug;
}

function timestamp(d: Date = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
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

async function buildInnerCommand(
  prepared: Prepared,
  windowName: string,
  request: SpawnRequest,
): Promise<InnerCommand> {
  const claude = process.env["SEANCE_CLAUDE_BIN"] ?? "claude";
  const caffeinate = process.platform === "darwin" ? "caffeinate -is " : "";
  // `exec` keeps the pane's process-group-leader pid on claude itself — a
  // forked child under a compound command leaves pane_current_command as the
  // shell, hiding the window from session detection.
  const base =
    `exec ${caffeinate}${claude} -n ${shq(windowName)} --permission-mode auto ` +
    `--model ${shq(request.model ?? DEFAULT_MODEL)} --effort ${shq(request.effort ?? DEFAULT_EFFORT)} ` +
    `--remote-control${prepared.worktreeFlag.length > 0 ? ` --worktree ${shq(prepared.worktreeFlag[1] ?? "")}` : ""}`;
  if (request.prompt === undefined || request.prompt === "") {
    return { command: base, seedDir: null };
  }

  const seedDir = await mkdtemp(join(tmpdir(), "seance-seed-"));
  const seedFile = join(seedDir, "seed.txt");
  await Bun.write(seedFile, `${prepared.preamble}\n\nTask: ${request.prompt}\n`);
  // the substitution runs before exec, so the file is consumed at shell start
  return { command: `${base} \"$(cat ${shq(seedFile)})\"`, seedDir };
}

/**
 * tmux new-window returns 0 as soon as the window frame exists — it knows
 * nothing about whether claude started or died. Keep the pane on exit, wait,
 * and check pane_dead: a dead pane means claude failed and "spawned" would
 * be a false success. Ported from /spawn.
 */
async function verifyPaneAlive(windowId: string, waitMs: number): Promise<void> {
  await tmuxOk(["set-option", "-w", "-t", windowId, "remain-on-exit", "on"]);
  await Bun.sleep(waitMs);
  const dead = (await tmux(["list-panes", "-t", windowId, "-F", "#{pane_dead}"])).stdout
    .split("\n")[0]
    ?.trim();
  if (dead === "1") {
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

export async function spawnSession(
  request: SpawnRequest,
  repos: readonly RepoEntry[],
  tmuxSessionGroup: string,
  opts: { readonly waitMs?: number } = {},
): Promise<SpawnOutcome> {
  const repo = repos.find((r) => r.name === request.repo);
  if (repo === undefined) {
    throw new SpawnFailure("repo_not_found", `no repo named "${request.repo}" — try a rescan`);
  }

  const slugSource = request.title ?? request.prompt ?? "session";
  const worktreeName = `${slugify(slugSource)}-${timestamp()}`;
  const windowName = request.title ?? worktreeName;

  const prepared =
    request.mode === "here" ? prepareHere(repo) : await prepareWorktree(repo, worktreeName);
  const inner = await buildInnerCommand(prepared, windowName, request);

  const target = await resolveTargetSession(tmuxSessionGroup);
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
      throw new SpawnFailure("tmux_error", err instanceof TmuxError ? err.message : String(err));
    }

    await verifyPaneAlive(windowId, opts.waitMs ?? 3_000);
  } finally {
    if (inner.seedDir !== null) await rm(inner.seedDir, { recursive: true, force: true });
  }

  const outcome: SpawnOutcome = { window: windowName, path: prepared.resultPath };
  return prepared.note === undefined ? outcome : { ...outcome, note: prepared.note };
}
