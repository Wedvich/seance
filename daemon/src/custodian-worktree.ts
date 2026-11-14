import { join, sep } from "node:path";
import type { RepoEntry } from "@seance/shared";
import type { KeptWhy } from "./custodian-frame.ts";
import { platformFsmonitor } from "./fsmonitor.ts";
import { canonical, resolveCommonDir } from "./gitdir.ts";
import { hardenedGit } from "./git-hardened.ts";
import { inside } from "./reap.ts";
import {
  gitDirOf,
  githubRepoOf,
  lastTouched,
  nothingLost,
  parseWorktreeList,
  parseWorktreeLock,
  removeWorktree,
  staleClaudeLock,
  type NothingLost,
  type NothingLostInput,
  type WorktreeRecord,
} from "./reap-git.ts";
import { normalizeOrigin, readOriginUrl } from "./scan.ts";
import type { EndedTasks } from "./session-events.ts";
import type { PaneInfo } from "./sessions.ts";

/**
 * What the custodian's `close` does to a closed task's worktree (docs/custodian.md C31–C34; DESIGN.md, "The
 * custodian frame kind"). The path comes from the launch ledger alone and only counts under its repo's
 * `.claude/worktrees/`; it is removed only when the nothing-lost rule says `safe`, after a re-list of the panes,
 * never with `--force`, and its branch is never touched (reap's merged-branch sweep owns it). Nothing here is logged,
 * and nothing it returns carries a path or a branch.
 */

/**
 * The session's own end-of-turn writes (its transcript, a last `status`) land just after its idle frame; a worktree
 * touched later than the turn's end by more than this has had someone else at it.
 */
export const TOUCH_SLACK_MS = 120_000;

export type WorktreeOutcome = { readonly removed: true; readonly how: string } | { readonly kept: KeptWhy };

/** The git and filesystem reads, injected so the rule runs without a repo. */
export interface WorktreeIo {
  readonly canonical: (path: string) => Promise<string>;
  readonly listWorktrees: (repoPath: string) => Promise<{
    readonly records: readonly WorktreeRecord[];
    readonly lock: (path: string) => { readonly reason: string } | null;
  } | null>;
  /** `git worktree unlock`; true when it succeeded. */
  readonly unlock: (repoPath: string, path: string) => Promise<boolean>;
  readonly gitDirOf: (worktree: string) => Promise<string | null>;
  readonly lastTouched: (worktree: string, gitDir: string, aliases: readonly string[]) => Promise<number>;
  /** The GitHub repo `origin` names in the clone at `repoPath`, null for any other host or none. */
  readonly githubOf: (repoPath: string) => Promise<ReturnType<typeof githubRepoOf>>;
  readonly nothingLost: (input: NothingLostInput) => Promise<NothingLost>;
  /** Stops the worktree's fsmonitor daemon, whose socket the removal would take; never throws. */
  readonly stopMonitor: (worktree: string) => Promise<void>;
  /** Never `--force`; true when git removed it. */
  readonly remove: (repoPath: string, worktree: string) => Promise<boolean>;
}

const REAL_IO: WorktreeIo = {
  canonical,
  listWorktrees: async (repoPath) => {
    const listed = await hardenedGit(repoPath, ["worktree", "list", "--porcelain", "-z"]);
    if (listed.exitCode !== 0) return null;
    return {
      records: parseWorktreeList(listed.stdout),
      lock: (path) => parseWorktreeLock(listed.stdout, path),
    };
  },
  unlock: async (repoPath, path) => (await hardenedGit(repoPath, ["worktree", "unlock", path])).exitCode === 0,
  gitDirOf,
  lastTouched,
  githubOf: async (repoPath) => {
    const commonDir = await resolveCommonDir(repoPath);
    return githubRepoOf(normalizeOrigin((commonDir === null ? null : await readOriginUrl(commonDir)) ?? ""));
  },
  nothingLost,
  stopMonitor: async (worktree) => {
    await platformFsmonitor()
      ?.stop(worktree)
      .catch(() => false);
  },
  remove: async (repoPath, worktree) => (await removeWorktree(repoPath, worktree)).exitCode === 0,
};

export interface WorktreeRuleDeps {
  readonly tasks: Pick<EndedTasks, "worktree">;
  readonly repos: () => readonly RepoEntry[];
  readonly listPanes: () => Promise<readonly PaneInfo[]>;
  readonly io?: Partial<WorktreeIo>;
}

export interface WorktreeRule {
  /**
   * Before the session is closed (its `/exit` writes its transcript): when the task's worktree was last touched, by
   * reap's own signals; null when the ledger names no worktree this repo's tree holds, or git cannot say.
   */
  readonly touchedAt: (taskId: string) => Promise<number | null>;
  /**
   * After it is closed: remove the task's worktree, or say why it stays. Null when there is nothing to decide (no
   * worktree noted here, or it is already gone). `turnEndedAt` and `touchedAt` are both null where no turn end was
   * observed; the touched check then does not apply.
   */
  readonly decide: (
    taskId: string,
    seen: { readonly turnEndedAt: number | null; readonly touchedAt: number | null },
  ) => Promise<WorktreeOutcome | null>;
}

type Site =
  | { readonly site: "none" }
  | { readonly site: "kept"; readonly why: KeptWhy }
  | { readonly site: "ok"; readonly entry: RepoEntry; readonly real: string };

export function createWorktreeRule(deps: WorktreeRuleDeps): WorktreeRule {
  const io: WorktreeIo = { ...REAL_IO, ...deps.io };

  /** A `refused` site was never noted here (here-mode, an evicted launch): nothing to decide. */
  const siteOf = async (taskId: string): Promise<Site> => {
    const noted = deps.tasks.worktree(taskId);
    if ("refused" in noted) return { site: "none" };
    // `repo` is the clone's path, not a name.
    const entry = deps.repos().find((repo) => repo.path === noted.repo);
    if (entry === undefined) return { site: "kept", why: "unscanned" };
    const real = await io.canonical(noted.path);
    if (real !== noted.path || !real.startsWith(join(entry.path, ".claude", "worktrees") + sep)) {
      return { site: "kept", why: "outside" };
    }
    return { site: "ok", entry, real };
  };

  const occupied = async (real: string): Promise<boolean> => {
    const panes = await deps.listPanes();
    const dirs = await Promise.all(panes.map((pane) => io.canonical(pane.path)));
    return dirs.some((dir) => inside(real, dir));
  };

  return {
    touchedAt: async (taskId) => {
      const found = await siteOf(taskId);
      if (found.site !== "ok") return null;
      const gitDir = await io.gitDirOf(found.real);
      return gitDir === null ? null : io.lastTouched(found.real, gitDir, [found.real]);
    },

    decide: async (taskId, seen) => {
      const found = await siteOf(taskId);
      if (found.site === "none") return null;
      if (found.site === "kept") return { kept: found.why };
      const { entry, real } = found;
      const listed = await io.listWorktrees(entry.path);
      if (listed === null) return { kept: "unevaluated" };
      const matches = await Promise.all(
        listed.records.map(async (record) => ((await io.canonical(record.path)) === real ? record : null)),
      );
      const record = matches.find((match) => match !== null);
      // Already gone (the session's own exit, a concurrent reap): nothing left to decide.
      if (record === undefined || record === null) return null;
      // Reap's age guard, for a `claude` or an editor working there outside tmux, which the pane list cannot see.
      if (seen.touchedAt !== null && seen.turnEndedAt !== null && seen.touchedAt > seen.turnEndedAt + TOUCH_SLACK_MS) {
        return { kept: "touched" };
      }
      if (record.locked) {
        // A killed session leaves Claude's own lock, which reap keeps for good: cleared in that one shape only, any
        // other lock is someone's.
        const reason = listed.lock(record.path)?.reason ?? "";
        if (!staleClaudeLock(reason) || !(await io.unlock(entry.path, record.path))) return { kept: "locked" };
      }
      if (await occupied(real)) return { kept: "in-use" };
      const github = await io.githubOf(entry.path);
      // No `merged`: the close has no `classifyTip` verdict, so origin and then the GitHub PR decide.
      const rule = await io.nothingLost({
        repoPath: entry.path,
        worktree: real,
        tip: record.head,
        branch: record.branch,
        github,
        fetch: true,
      });
      if (rule.kind === "unknown") return { kept: "unevaluated" };
      if (rule.kind === "fails") return { kept: rule.why };
      // The rule's network reads take time: a session started here meanwhile (a continuation) must find it still there.
      if (await occupied(real)) return { kept: "in-use" };
      await io.stopMonitor(real);
      // No reap lock: it may be held for minutes and throws when busy, and a reap removing the same worktree makes one of the two removals fail harmlessly.
      if (!(await io.remove(entry.path, real))) return { kept: "remove-failed" };
      return { removed: true, how: rule.how };
    },
  };
}
