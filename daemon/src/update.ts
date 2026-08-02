// The self-update pipeline. The announce that triggers it is advisory — origin
// is the arbiter: receivers fetch and ff-only against their own upstream, so a
// forged or replayed announce buys at most one extra fetch. The skips are
// deliberate refusals: a dirty, re-branched or diverged checkout is someone's
// work in progress and an update must never force it.

import type { UpdateOutcome, UpdateReport } from "@seance/shared";
import { updateAudit, type AuditSink, type UpdateAudit, type UpdateOrigin } from "./audit.ts";
import { exec, execFailure, git } from "./exec.ts";
import { log } from "./log.ts";
import { readDefaultBranch } from "./scan.ts";
import { checkoutRoot, readSource } from "./selfsource.ts";
import { selfRestartService } from "./service.ts";

export interface UpdateEffects {
  /** Dependency install at the checkout root, after a fast-forward. */
  readonly install: (root: string) => Promise<{ readonly ok: boolean; readonly detail?: string }>;
  /** Refresh the service definition if drifted, then restart this process. May not return. */
  readonly restart: () => Promise<void>;
}

export function defaultUpdateEffects(): UpdateEffects {
  return {
    install: async (root) => {
      const result = await exec(["bun", "install", "--frozen-lockfile"], { cwd: root, timeoutMs: 300_000 });
      return result.exitCode === 0 && !result.timedOut ? { ok: true } : { ok: false, detail: execFailure(result) };
    },
    restart: () => selfRestartService(),
  };
}

export interface UpdaterOpts {
  /** Persist the report and push it to the registry; `current` is never reported. */
  readonly report: (report: UpdateReport) => Promise<void>;
  readonly sink: AuditSink;
  /** Checkout to update; defaults to this one. Tests point it at a fixture. */
  readonly root?: string;
  readonly debounceMs?: number;
  readonly effects?: UpdateEffects;
}

export interface Updater {
  /**
   * Fire-and-forget. Single-flight with one coalesced trailing run: an
   * announce landing while a check is mid-fetch would otherwise be lost until
   * the next reconnect — exactly the update-wave case. Only `register` checks
   * are debounced, because only they repeat on their own (reconnect flap); an
   * announce is a discrete event that must never be dropped, or the machine
   * that missed it sits stale until the next wave.
   */
  readonly check: (origin: UpdateOrigin) => void;
  /** Resolves once nothing is in flight — tests await outcomes without polling. */
  readonly settled: () => Promise<void>;
  /**
   * Stop reporting. A run already in flight finishes (git is mid-operation on
   * a real checkout), but its report is dropped: after a config-reload swap
   * the outgoing instance's captured `state` is stale, and writing it would
   * clobber what the incoming one already saved.
   */
  readonly stop: () => void;
}

const DEBOUNCE_MS = 30_000;

interface Verdict {
  readonly outcome: UpdateOutcome;
  readonly detail?: string;
}

async function pipeline(root: string, effects: UpdateEffects, audit: UpdateAudit): Promise<Verdict> {
  const source = await readSource(root);
  if (source === null) {
    return { outcome: "fetch_failed", detail: "checkout version unreadable — not a git checkout?" };
  }
  await audit.checking(source.sha);

  let branch = await readDefaultBranch(root);
  if (branch === null) {
    await git(root, ["remote", "set-head", "origin", "-a"]);
    branch = await readDefaultBranch(root);
  }
  if (branch === null) return { outcome: "skipped_branch", detail: "no default branch resolvable" };
  if (source.branch !== branch) {
    return { outcome: "skipped_branch", detail: `on '${source.branch ?? "detached HEAD"}', not ${branch}` };
  }

  const unstagedClean = (await git(root, ["diff", "--quiet"])).exitCode === 0;
  const stagedClean = (await git(root, ["diff", "--cached", "--quiet"])).exitCode === 0;
  if (!unstagedClean || !stagedClean) {
    return { outcome: "skipped_dirty", detail: "working tree has uncommitted changes" };
  }

  const fetch = await git(root, ["fetch", "origin", branch]);
  if (fetch.timedOut || fetch.exitCode !== 0) return { outcome: "fetch_failed", detail: execFailure(fetch) };

  const counts = await git(root, ["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`]);
  if (counts.exitCode !== 0) return { outcome: "fetch_failed", detail: execFailure(counts) };
  const [behind = 0, ahead = 0] = counts.stdout.trim().split(/\s+/u).map(Number);
  if (ahead > 0) {
    return { outcome: "skipped_diverged", detail: `${ahead} local commit${ahead === 1 ? "" : "s"} origin lacks` };
  }
  if (behind === 0) return { outcome: "current" };

  const ff = await git(root, ["merge", "--ff-only", `origin/${branch}`]);
  // rev-list already proved ahead === 0, so a refusal here is not divergence:
  // an untracked file in the way, or another git holding the index lock.
  if (ff.exitCode !== 0) return { outcome: "skipped_dirty", detail: execFailure(ff) };

  const install = await effects.install(root);
  if (!install.ok) {
    // No rollback of the fast-forward: the running process still serves the
    // old code from memory, and rewinding HEAD would fight whoever fixes the
    // checkout by hand. The report is what makes the stuck state visible.
    return { outcome: "install_failed", detail: install.detail ?? "install failed" };
  }

  const updated = await readSource(root);
  return { outcome: "ok", detail: `${source.sha.slice(0, 12)} → ${updated?.sha.slice(0, 12) ?? "?"}` };
}

export function createUpdater(opts: UpdaterOpts): Updater {
  const root = opts.root ?? checkoutRoot();
  const effects = opts.effects ?? defaultUpdateEffects();
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  let inflight: Promise<void> | null = null;
  let lastStart = 0;
  let stopped = false;

  const run = async (origin: UpdateOrigin): Promise<void> => {
    const audit = updateAudit(origin, opts.sink);
    const verdict = await pipeline(root, effects, audit);
    await audit.outcome(verdict.outcome, verdict.detail);
    // `current` is the steady state — reporting it would rewrite state.json and
    // push a registry update on every reconnect, for information nobody reads.
    if (verdict.outcome === "current" || stopped) return;
    await opts.report({
      at: Date.now(),
      outcome: verdict.outcome,
      ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
    });
    // After the report: the restart ends this process, and the post-restart
    // register must already carry the ok.
    if (verdict.outcome !== "ok") return;
    try {
      await effects.restart();
    } catch (err) {
      // The restart is the only step whose failure the `ok` already on disk
      // would otherwise hide: HEAD is at target, so every later check reads
      // `current` and this machine serves old code forever, claiming success.
      const detail = err instanceof Error ? err.message : String(err);
      await audit.outcome("restart_failed", detail);
      if (!stopped) await opts.report({ at: Date.now(), outcome: "restart_failed", detail });
    }
  };

  let pending: UpdateOrigin | null = null;

  const start = (origin: UpdateOrigin): void => {
    lastStart = Date.now();
    inflight = run(origin)
      .catch((err) => log.error(`self-update check crashed: ${String(err)}`))
      .finally(() => {
        inflight = null;
        if (pending !== null) {
          const next = pending;
          pending = null;
          // Bypasses the debounce on purpose: the queued origin arrived during
          // the run, so the state it reacted to postdates that run's fetch.
          start(next);
        }
      });
  };

  return {
    check: (origin: UpdateOrigin): void => {
      if (stopped) return;
      if (inflight !== null) {
        pending = origin;
        return;
      }
      // Only register checks are debounced. An announce dropped here would
      // never be retried — nothing re-fires it — so this machine would sit on
      // old code until the next unrelated wave.
      if (origin === "register" && Date.now() - lastStart < debounceMs) return;
      start(origin);
    },
    settled: async (): Promise<void> => {
      // oxlint-disable-next-line no-await-in-loop, no-unmodified-loop-condition -- each trailing run's finally replaces `inflight`
      while (inflight !== null) await inflight;
    },
    stop: (): void => {
      stopped = true;
      pending = null;
    },
  };
}
