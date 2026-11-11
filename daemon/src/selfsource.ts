// The daemon's own checkout is deliberately outside the scanned repo set, so
// version identity gets its own reader instead of a RepoEntry.

import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { SourceInfo } from "@seance/shared";
import { git } from "./exec.ts";
import { tildify } from "./paths.ts";

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
  const trimmed = root.length > 1 ? root.replace(/[\\/]+$/u, "") : root;
  return `${source.sha.slice(0, 12)}${branch} (${tildify(trimmed, home)})`;
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
