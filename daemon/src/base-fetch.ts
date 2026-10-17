import type { RepoEntry, SpawnMode } from "@seance/shared";
import { execFailure } from "./exec.ts";
import { hardenedGit } from "./git-hardened.ts";
import { resolveCommonDir } from "./gitdir.ts";
import { lastFetchedAt } from "./reap-git.ts";
import { readDefaultBranch } from "./scan.ts";

/** Claude's own `--worktree` fetch timeout: an unreachable origin costs a spawn this much, no more. */
const FETCH_TIMEOUT_MS = 5_000;

type FetchResult = { readonly ok: true } | { readonly ok: false; readonly detail: string };

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
 * fetch is unneeded.
 */
function fetchDefault(repoPath: string, commonDir: string, branch: string): Promise<FetchResult> {
  const running = inFlight.get(commonDir);
  if (running !== undefined) return running;
  const run = hardenedGit(
    repoPath,
    ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    FETCH_TIMEOUT_MS,
  )
    .then((result): FetchResult => (result.exitCode === 0 ? { ok: true } : { ok: false, detail: execFailure(result) }))
    .finally(() => inFlight.delete(commonDir));
  inFlight.set(commonDir, run);
  return run;
}

function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

async function lastFetchedNote(commonDir: string, branch: string, detail: string): Promise<string> {
  const at = await lastFetchedAt(commonDir);
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
export async function freshenBase(repo: RepoEntry, mode: SpawnMode): Promise<string | undefined> {
  try {
    const [commonDir, branch] = await Promise.all([resolveCommonDir(repo.path), readDefaultBranch(repo.path)]);
    if (commonDir === null || branch === null) return undefined;
    if (mode === "here") {
      const current = await hardenedGit(repo.path, ["symbolic-ref", "--quiet", "--short", "HEAD"], 5_000);
      if (current.exitCode !== 0 || current.stdout.trim() !== branch) return undefined;
    }

    const fetched = await fetchDefault(repo.path, commonDir, branch);
    const fetchNote = fetched.ok ? undefined : await lastFetchedNote(commonDir, branch, fetched.detail);
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
