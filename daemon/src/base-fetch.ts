import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RepoEntry, SpawnMode } from "@seance/shared";
import { execFailure } from "./exec.ts";
import { hardenedGit, networkGit, refusalDetail, type TerminalProbe } from "./git-hardened.ts";
import { resolveCommonDir } from "./gitdir.ts";
import { readDefaultBranch } from "./scan.ts";

/** Claude's own `--worktree` fetch timeout: an unreachable origin costs a spawn this much, no more. */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * `before` is read ahead of the fetch: git truncates `FETCH_HEAD` before the
 * transfer, so a fetch killed mid-pack leaves it looking minutes old.
 */
type FetchResult = { readonly ok: true } | { readonly ok: false; readonly detail: string; readonly before: number };

/**
 * Fetches in flight per common dir. Parallel spawns into one clone share a
 * fetch rather than racing for `refs/remotes/origin/<b>.lock` — the loser of
 * that race would report a failure for a fetch that in fact landed.
 */
const inFlight = new Map<string, Promise<FetchResult>>();

/**
 * The explicit `+src:dst` refspec, not a bare branch name: it says exactly
 * which ref moves, survives a force-pushed default, and can never read as an
 * option. `FETCH_HEAD` is written on purpose — it is what tells claude its own
 * fetch is unneeded. No submodule recursion: on-demand recursion can outlast the
 * timeout after the tracking ref already moved, reporting a landed fetch as failed.
 * `networkGit` refuses a repo whose own config would run a command, and keeps ssh from prompting a foreground
 * `seanced run`'s terminal, as reap's fetch does.
 */
function fetchDefault(
  repoPath: string,
  commonDir: string,
  branch: string,
  terminal: TerminalProbe | undefined,
): Promise<FetchResult> {
  const running = inFlight.get(commonDir);
  if (running !== undefined) return running;
  const run = (async (): Promise<FetchResult> => {
    const before = await lastFetchedAt(commonDir);
    const result = await networkGit(
      repoPath,
      ["fetch", "--quiet", "--no-recurse-submodules", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      FETCH_TIMEOUT_MS,
      {},
      terminal,
    );
    if ("refused" in result) return { ok: false, detail: refusalDetail(result), before };
    return result.exitCode === 0 ? { ok: true } : { ok: false, detail: execFailure(result), before };
  })().finally(() => inFlight.delete(commonDir));
  inFlight.set(commonDir, run);
  return run;
}

/**
 * The newest `FETCH_HEAD` across the clone and its worktrees: a fetch run inside
 * a linked worktree may record it in that worktree's own git dir.
 */
async function lastFetchedAt(commonDir: string): Promise<number> {
  const worktrees = await readdir(join(commonDir, "worktrees")).catch(() => [] as string[]);
  const candidates = [
    join(commonDir, "FETCH_HEAD"),
    ...worktrees.map((name) => join(commonDir, "worktrees", name, "FETCH_HEAD")),
  ];
  const times = await Promise.all(candidates.map(async (file) => (await stat(file).catch(() => null))?.mtimeMs ?? 0));
  return Math.max(0, ...times);
}

function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function lastFetchedNote(branch: string, detail: string, at: number): string {
  const when = at === 0 ? "never fetched" : `last fetched ${age(Date.now() - at)} ago`;
  return `couldn't fetch origin/${branch} (${detail}) — it may be stale: ${when}`;
}

/**
 * Brings `origin/<default>` up to date before a spawn launches, and says what
 * the caller should know about the base. Never throws and never fails a
 * spawn: offline or auth-less, the spawn goes ahead on the refs it has, and
 * the note is how that reaches the phone. Moves remote-tracking refs only —
 * never HEAD, the index or the working tree.
 *
 * Worktree mode: claude branches from `origin/<default>` but fetches only when
 * `FETCH_HEAD` is over a day old, so this fetch is the one that keeps the base
 * current, and claude's is skipped because of it. No default branch on disk →
 * nothing to fetch here: claude fetches itself when the tracking ref is missing.
 *
 * Here mode: the session runs on the checkout as found. On the default branch
 * the note says how far behind origin it is; on any other branch "behind"
 * would be measured against the wrong thing, so nothing runs at all.
 */
export async function freshenBase(
  repo: RepoEntry,
  mode: SpawnMode,
  terminal?: TerminalProbe,
): Promise<string | undefined> {
  try {
    const [commonDir, branch] = await Promise.all([resolveCommonDir(repo.path), readDefaultBranch(repo.path)]);
    if (commonDir === null || branch === null) return undefined;
    if (mode === "here") {
      // Full ref, not `--short`: a tag sharing the branch's name shortens HEAD to `heads/<b>`.
      const current = await hardenedGit(repo.path, ["symbolic-ref", "--quiet", "HEAD"], 5_000);
      if (current.exitCode !== 0 || current.stdout.trim() !== `refs/heads/${branch}`) return undefined;
    }

    const fetched = await fetchDefault(repo.path, commonDir, branch, terminal);
    const fetchNote = fetched.ok ? undefined : lastFetchedNote(branch, fetched.detail, fetched.before);
    if (mode === "worktree") return fetchNote;

    const behind = await hardenedGit(repo.path, ["rev-list", "--count", `HEAD..refs/remotes/origin/${branch}`], 5_000);
    const count = behind.exitCode === 0 ? Number(behind.stdout.trim()) : 0;
    const behindNote =
      count > 0
        ? `the checkout is ${count} commit${count === 1 ? "" : "s"} behind origin/${branch}; the session runs on it as is`
        : undefined;
    const notes = [fetchNote, behindNote].filter((n) => n !== undefined);
    return notes.length === 0 ? undefined : notes.join("\n\n");
  } catch {
    return undefined;
  }
}
