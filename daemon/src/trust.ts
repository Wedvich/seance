import { realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isRecord } from "@seance/shared";
import { log } from "./log.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Repo paths already ensured this run, keyed by config file — trust never un-sets itself mid-run. */
const ensured = new Set<string>();
/** Serializes read-modify-write cycles so two concurrent spawns can't drop each other's entry. */
let queue: Promise<void> = Promise.resolve();

/**
 * Claude Code blocks startup on a per-directory trust dialog
 * (`projects[<path>].hasTrustDialogAccepted` in its config) that no remote can
 * answer — spawning into an untrusted repo yields a dead session. Exposing a
 * repo to séance already grants more than the dialog guards (any PSK holder
 * starts claude in it under the machine's configured permission mode), so
 * answering it up front removes the interactive step without widening the
 * boundary. Fails open: a spawn never blocks on this — worst case the dialog
 * reappears.
 *
 * `configPath` is the `.claude.json` of the exclave the repo sits in
 * (`exclaveConfigFile`), never the daemon's own `CLAUDE_CONFIG_DIR`: the
 * owner's shell hook picks a session's config dir by cwd, so a repo under
 * `~/work` is trusted in `~/.claude-work`, whatever the daemon runs with.
 */
export async function ensureRepoTrusted(repoPath: string, configPath: string): Promise<void> {
  const key = `${configPath}\u0000${repoPath}`;
  if (ensured.has(key)) return;
  queue = queue.then(() => ensureNow(configPath, repoPath, key));
  await queue;
}

async function ensureNow(configPath: string, repoPath: string, memoKey: string): Promise<void> {
  if (ensured.has(memoKey)) return; // a queued predecessor may have handled it
  try {
    const file = Bun.file(configPath);
    // no config = claude has never run here; onboarding would block the session
    // anyway, and creating claude's own file from outside claude is worse
    if (!(await file.exists())) return;

    const config = asRecord(await file.json());
    const projects = asRecord(config?.["projects"] ?? {});
    const entry = asRecord(projects?.[repoPath] ?? {});
    if (config === null || projects === null || entry === null) {
      log.warn(`not pre-trusting ${repoPath}: unexpected shape in ${configPath}`);
      return;
    }

    if (entry["hasTrustDialogAccepted"] !== true) {
      entry["hasTrustDialogAccepted"] = true;
      projects[repoPath] = entry;
      config["projects"] = projects;
      // atomic replace, keeping claude's 2-space format and the file's mode (0600 in the wild)
      const mode = (await stat(configPath)).mode & 0o777;
      const tmp = `${configPath}.seance-${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(config, null, 2), { mode });
      await rename(tmp, configPath);
      log.info(`pre-trusted ${repoPath} for claude in ${configPath}`);
    }
    ensured.add(memoKey);
  } catch (err) {
    // unreadable config or fs error — not memoized, so the next spawn retries
    log.warn(`could not pre-trust ${repoPath}: ${String(err)}`);
  }
}

/**
 * Whether Claude Code would start in `dir` without its trust dialog: `projects[<path>].hasTrustDialogAccepted` for the
 * dir's own entry or an ancestor's (the custodian spec's verified rule). Read-only, silent and false on anything
 * unreadable: the custodian's round dir is never pre-trusted by the daemon, because `.claude.json` races every
 * running session's own rewrite of it (DESIGN.md, "Exclaves"); the owner trusts it once, which `seanced doctor`
 * says. Never logs: nothing the seat reads from there reaches a log.
 */
export async function isDirTrusted(dir: string, configFile: string): Promise<boolean> {
  let projects: unknown;
  try {
    const config: unknown = await Bun.file(configFile).json();
    projects = isRecord(config) ? config["projects"] : undefined;
  } catch {
    return false;
  }
  if (!isRecord(projects)) return false;
  // Claude Code keys `projects` by the session's real cwd, and a round runs in the real path (`ensureRoundDir`): a
  // dir reached through a symlink (a state dir under one) is trusted under the real path, which the uncreated path
  // does not spell. Either spelling counts.
  for (const start of new Set([dir, await realpathOfExisting(dir)])) {
    for (let at = start; ; at = dirname(at)) {
      const entry = projects[at];
      if (isRecord(entry) && entry["hasTrustDialogAccepted"] === true) return true;
      if (dirname(at) === at) break;
    }
  }
  return false;
}

/** `path` with its deepest existing ancestor realpath'd and the rest appended: the real path a mkdir would make. */
async function realpathOfExisting(path: string): Promise<string> {
  const rest: string[] = [];
  for (let at = path; ; at = dirname(at)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- each step up depends on the last failing
      return join(await realpath(at), ...rest.toReversed());
    } catch {
      if (dirname(at) === at) return path;
      rest.push(basename(at));
    }
  }
}
