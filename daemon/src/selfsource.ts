// The daemon's own checkout is deliberately outside the scanned repo set, so
// version identity gets its own reader instead of a RepoEntry.

import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceInfo } from "@seance/shared";
import { git } from "./exec.ts";
import { tildify } from "./paths.ts";
import type { Runtime } from "./state.ts";

/** Checkout root — two levels above this file, same anchor as the service installers. */
export function checkoutRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

/**
 * `<sha> on <branch> (<root>)` for doctor and status. The root is there because
 * a machine can hold several seance clones, and sha and branch alone don't say
 * which one the daemon runs from — the one an update has to land in.
 */
export function describeCheckout(source: SourceInfo, root: string = checkoutRoot(), home: string = homedir()): string {
  const branch = source.branch !== null ? ` on ${source.branch}` : " (detached)";
  return `${source.sha.slice(0, 12)}${branch} (${tildify(trimRoot(root), home)})`;
}

/** `checkoutRoot()` ends in a separator; display and comparison both want it without. */
export function trimRoot(root: string): string {
  return root.length > 1 ? root.replace(/\/+$/u, "") : root;
}

/**
 * The checkout a live daemon runs from, as it recorded it in runtime.json.
 * Null when no daemon is alive or it predates the field — callers then fall
 * back to their own checkout, which is all they could say before.
 */
export function servingRoot(runtime: Runtime | null, alive: boolean): string | null {
  if (runtime === null || !alive) return null;
  const root: unknown = runtime.root;
  return typeof root === "string" && isAbsolute(root) ? trimRoot(root) : null;
}

/**
 * Git identity of the running checkout, local refs only. Null when git is
 * missing or the root isn't a repo — version reporting degrades to absent,
 * nothing else is affected.
 */
export async function readSource(root: string = checkoutRoot()): Promise<SourceInfo | null> {
  const head = await git(root, ["log", "-1", "--format=%H %ct"], 5_000);
  if (head.exitCode !== 0) return null;
  const [sha, seconds] = head.stdout.trim().split(" ");
  if (sha === undefined || !/^[0-9a-f]{40}$/u.test(sha)) return null;
  // Guarded like the sha: an unparsable timestamp must degrade to "no source",
  // never ship NaN into a field the wire types declare as a number.
  const commitTs = Number(seconds) * 1000;
  if (!Number.isFinite(commitTs)) return null;
  // Fails on detached HEAD; that is a real state worth reporting as branchless.
  const ref = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], 5_000);
  return {
    sha,
    commitTs,
    branch: ref.exitCode === 0 ? ref.stdout.trim() : null,
  };
}
