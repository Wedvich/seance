// The `seanced` name on PATH, in one place: doctor's resolution check, and the
// symlink pair behind `link`/`unlink`. Linking is opt-in — `install` only ever
// suggests it — but `uninstall` removes it, so tearing down the service never
// leaves a name pointing into a checkout the user is about to delete. A plain
// symlink to main.ts (executable, bun shebang), never a wrapper script or
// bun's link registry: the wrapper's realpath wouldn't lead back here, which
// would blind the stale-checkout arm of the check, and the registry is
// per-name indirection another clone can silently steal.

import { constants } from "node:fs";
import { access, lstat, readlink, realpath, rm, stat, symlink } from "node:fs/promises";
import { delimiter, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Check } from "./check.ts";

/** This checkout's entry point, symlink-resolved so comparisons survive symlinked checkouts. */
export async function resolvedMain(): Promise<string> {
  const path = fileURLToPath(new URL("./main.ts", import.meta.url));
  return realpath(path).catch(() => path);
}

/**
 * The interpreter half of `resolvedMain`, for everything that records how to
 * re-launch us: bun by its PATH name, never `process.execPath`. execPath is the
 * realpath'd binary — on Homebrew `…/Cellar/bun/1.3.14/bin/bun` — and the keg is
 * deleted on upgrade, orphaning whatever recorded it. Resolving at *use* time is
 * always fine; the hazard is only in what outlives the process.
 */
export function resolvedBun(): string {
  return bunPathFor(Bun.which("bun"));
}

/**
 * execPath is the fallback rather than the default because PATH-less contexts
 * exist (a launchd agent gets /usr/bin:/bin), and a pinned path still beats none.
 * Split out for the same reason `cliOnPathCheck` is: nothing here mocks
 * `Bun.which`, so the decision has to take its result as an argument.
 */
export function bunPathFor(found: string | null): string {
  return found ?? process.execPath;
}

/**
 * The recorded interpreter against the one PATH resolves now. Nothing rewrites
 * an installed macOS plist on its own — launchd caches job definitions, so
 * `selfRestart` exits instead of rewriting — so a runtime upgrade leaves the
 * agent pointing at a deleted binary with nothing to notice. This is what makes
 * that visible while the daemon is still up. `what`/`remedy` vary per record:
 * the service writers repoint via `seanced install`, the MCP entry via
 * `seanced mcp install`. Exported for tests.
 */
export function bunDriftCheck(
  recorded: string,
  current: string,
  recordedExists: boolean,
  what = "service",
  remedy = "seanced install",
): Check {
  if (!recordedExists) {
    return {
      level: "fail",
      message: `${what} records bun at ${recorded}, which no longer exists — \`${remedy}\` repoints it`,
    };
  }
  if (recorded !== current) {
    return {
      level: "warn",
      message: `${what} records bun at ${recorded}, PATH now resolves bun to ${current} — \`${remedy}\` repoints it`,
    };
  }
  return { level: "ok", message: `${what} bun path current (${recorded})` };
}

/**
 * Null when the caller couldn't read a path out of the record: a parse miss must
 * not read as a problem. `current` overrides what the record is compared
 * against, for a record whose interpreter is resolved from a PATH that isn't the
 * caller's — a system unit carries its own `Environment="PATH="`, and comparing
 * that against the shell's would report drift every time the two merely order
 * the same directories differently.
 */
export async function recordedBunCheck(
  recorded: string | null,
  what?: string,
  remedy?: string,
  current?: string,
): Promise<Check | null> {
  if (recorded === null) return null;
  const exists = await access(recorded, constants.X_OK)
    .then(() => true)
    .catch(() => false);
  return bunDriftCheck(recorded, current ?? resolvedBun(), exists, what, remedy);
}

/**
 * init, scan, and doctor itself all print `seanced …` follow-ups, but nothing
 * installs the name unasked — so this says whether it resolves, and to *this*
 * checkout rather than a stale link to an old clone. Never a fail: `bun
 * main.ts` and shell aliases are the documented defaults, and an alias is
 * invisible to a PATH probe — which is also why a miss hedges instead of
 * asserting. The remedies spell out `bun <main> link` because the short name
 * is exactly what's missing. Exported for tests.
 */
export function cliOnPathCheck(found: string | null, target: string | null, mainPath: string): Check {
  if (found === null) {
    return {
      level: "warn",
      message: `seanced not on PATH — \`bun ${mainPath} link\` symlinks it into a PATH dir, or alias seanced='bun ${mainPath}' (a shell alias won't show here)`,
    };
  }
  if (target !== mainPath) {
    return {
      level: "warn",
      message: `seanced on PATH is ${found} → ${target}, not this checkout's ${mainPath} — \`bun ${mainPath} link\` repoints it`,
    };
  }
  return { level: "ok", message: `seanced on PATH at ${found}` };
}

export async function cliOnPath(): Promise<Check> {
  const found = Bun.which("seanced");
  return cliOnPathCheck(found, found === null ? null : await realpath(found).catch(() => found), await resolvedMain());
}

export interface PathEntry {
  readonly file: string;
  /** Raw readlink target, or null when the entry is a real file. */
  readonly target: string | null;
}

/**
 * Every `seanced` entry in PATH order. lstat, not which: a broken symlink
 * (checkout moved or deleted) fails which's exec check and would become
 * invisible to unlink, exactly when it most needs cleaning up.
 */
export async function findExisting(pathEnv: string): Promise<readonly PathEntry[]> {
  const entries: PathEntry[] = [];
  const seen = new Set<string>();
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "" || seen.has(dir)) continue;
    seen.add(dir);
    const file = join(dir, "seanced");
    try {
      // oxlint-disable-next-line no-await-in-loop -- PATH order is the result's order
      const info = await lstat(file);
      // oxlint-disable-next-line no-await-in-loop
      entries.push({ file, target: info.isSymbolicLink() ? await readlink(file) : null });
    } catch {
      // not there — the common case for almost every PATH dir
    }
  }
  return entries;
}

/**
 * PATH dirs ranked for where the link should live: ~/.local/bin, then ~/bin,
 * then anything else under $HOME, then the rest — root-owned dirs would only
 * fail the write check, but a user-writable /opt/homebrew/bin still shouldn't
 * beat the user's own bin dir. Stable within a rank, so PATH precedence breaks
 * ties. Exported for tests.
 */
export function rankLinkDirs(pathEnv: string, home: string): readonly string[] {
  const score = (dir: string): number => {
    if (dir === join(home, ".local", "bin")) return 0;
    if (dir === join(home, "bin")) return 1;
    return dir.startsWith(home + sep) ? 2 : 3;
  };
  return [...new Set(pathEnv.split(delimiter).filter((dir) => dir !== ""))].toSorted((a, b) => score(a) - score(b));
}

async function firstWritableDir(dirs: readonly string[]): Promise<string | null> {
  for (const dir of dirs) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- first hit wins, in rank order
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      // oxlint-disable-next-line no-await-in-loop
      await access(dir, constants.W_OK);
      return dir;
    } catch {
      // missing or unwritable — try the next rank
    }
  }
  return null;
}

export type LinkResult =
  | { readonly status: "created"; readonly file: string }
  | { readonly status: "repointed"; readonly file: string; readonly previous: string }
  | { readonly status: "already"; readonly file: string };

/**
 * Symlink `seanced` onto PATH. An existing symlink is repointed in place —
 * that's doctor's stale-clone remedy — but a real file named seanced is
 * someone else's and refused. `explicitDir` skips the ranking for the odd
 * PATH with no writable dir; it must already exist.
 */
export async function createLink(
  pathEnv: string,
  home: string,
  main: string,
  explicitDir?: string,
): Promise<LinkResult> {
  const existing = await findExisting(pathEnv);
  const realFile = existing.find((entry) => entry.target === null);
  if (realFile !== undefined) {
    throw new Error(`${realFile.file} is a real file, not a symlink — not touching it`);
  }
  const [current] = existing;
  if (current !== undefined) {
    const resolved = await realpath(current.file).catch(() => current.target);
    if (resolved === main || current.target === main) return { status: "already", file: current.file };
    await rm(current.file);
    await symlink(main, current.file);
    return { status: "repointed", file: current.file, previous: current.target ?? "" };
  }
  const dir = explicitDir ?? (await firstWritableDir(rankLinkDirs(pathEnv, home)));
  if (dir === null) {
    throw new Error(
      "no writable dir on PATH — mkdir -p ~/.local/bin and add it to your PATH, or pass one: seanced link <dir>",
    );
  }
  const file = join(dir, "seanced");
  await symlink(main, file);
  return { status: "created", file };
}

export interface RemovedLinks {
  readonly removed: readonly string[];
  /** Entries left alone: real files, and symlinks into some other checkout. */
  readonly kept: readonly { readonly file: string; readonly target: string }[];
}

/**
 * Remove every symlink that leads to this checkout — raw target match covers
 * broken links whose realpath no longer resolves. Anything else stays: a link
 * into another clone belongs to that clone's unlink, and deleting it here
 * would turn "uninstall on machine A" into "CLI gone for checkout B".
 */
export async function removeLinks(pathEnv: string, main: string): Promise<RemovedLinks> {
  const removed: string[] = [];
  const kept: { file: string; target: string }[] = [];
  for (const entry of await findExisting(pathEnv)) {
    if (entry.target === null) {
      kept.push({ file: entry.file, target: "(not a symlink)" });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a handful of entries at most
    const resolved = await realpath(entry.file).catch(() => entry.target);
    if (resolved === main || entry.target === main) {
      // oxlint-disable-next-line no-await-in-loop
      await rm(entry.file);
      removed.push(entry.file);
    } else {
      kept.push({ file: entry.file, target: entry.target });
    }
  }
  return { removed, kept };
}
