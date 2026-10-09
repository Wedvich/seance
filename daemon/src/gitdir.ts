import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * File reads only, never a git subprocess: the scan runs this per directory and
 * the session list per pane, and both have to stay cheap.
 */

/**
 * What a directory's `.git` makes it:
 * - `none` — no `.git` at all.
 * - `main` — a repo of its own: a `.git` dir, or a pointer whose git dir has no
 *   `commondir` (a submodule, a `--separate-git-dir` clone).
 * - `linked` — a linked worktree: its git dir carries `commondir`, which names the
 *   common dir it shares with its main clone.
 * - `broken` — a `.git` that can't stand for a repo: an unparsable pointer, or one
 *   naming a git dir that is gone (main clone deleted under its worktrees; a
 *   Windows `C:/…` pointer seen from WSL), or an empty `commondir`.
 * - `unreadable` — an I/O error other than absence, which may clear up.
 *
 * Existence classifies and content only resolves, so nothing that fails to read
 * passes for a main clone.
 */
export type Checkout =
  | { readonly kind: "none" }
  | { readonly kind: "main" | "linked"; readonly commonDir: string }
  | { readonly kind: "broken" | "unreadable" };

const NONE: Checkout = { kind: "none" };
const BROKEN: Checkout = { kind: "broken" };
const UNREADABLE: Checkout = { kind: "unreadable" };

type Presence = "file" | "dir" | "absent" | "error";

async function presence(path: string): Promise<Presence> {
  try {
    return (await stat(path)).isDirectory() ? "dir" : "file";
  } catch (err) {
    const code = err instanceof Error && "code" in err ? err.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "error";
  }
}

/**
 * Relative targets (`worktree.useRelativePaths`, and `commondir` always) resolve
 * against `base`'s real path: the kernel walks `..` physically, so a lexical
 * `resolve` through a symlinked base would land somewhere else. `undefined` when
 * the file can't be read, `null` when it reads but names nothing.
 */
async function readPointer(file: string, pattern: RegExp, base: string): Promise<string | null | undefined> {
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch {
    return undefined;
  }
  const target = text.match(pattern)?.[1]?.trim();
  if (target === undefined || target === "") return null;
  if (isAbsolute(target)) return target;
  return resolve(await realpath(base).catch(() => base), target);
}

export async function inspectCheckout(dir: string): Promise<Checkout> {
  const dotGit = `${dir}/.git`;
  const dotGitIs = await presence(dotGit);
  if (dotGitIs === "absent") return NONE;
  if (dotGitIs === "error") return UNREADABLE;
  if (dotGitIs === "dir") return { kind: "main", commonDir: dotGit };

  const gitDir = await readPointer(dotGit, /^gitdir:\s*(.+)$/mu, dir);
  if (gitDir === undefined) return UNREADABLE;
  if (gitDir === null) return BROKEN;
  const gitDirIs = await presence(gitDir);
  if (gitDirIs === "error") return UNREADABLE;
  if (gitDirIs !== "dir") return BROKEN;

  const commondir = `${gitDir}/commondir`;
  const commondirIs = await presence(commondir);
  if (commondirIs === "absent") return { kind: "main", commonDir: gitDir };
  if (commondirIs === "error") return UNREADABLE;
  const commonDir = await readPointer(commondir, /^(.+)$/mu, gitDir);
  if (commonDir === undefined) return UNREADABLE;
  if (commonDir === null) return BROKEN;
  return { kind: "linked", commonDir };
}

/** Canonical, so it compares equal however each checkout's pointer spelled it. */
export async function canonical(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}

/** The common dir — refs and objects — of the checkout at `dir`; null when it is none, or a broken one. */
export async function resolveCommonDir(dir: string): Promise<string | null> {
  const checkout = await inspectCheckout(dir);
  return "commonDir" in checkout ? canonical(checkout.commonDir) : null;
}

/**
 * The common dir of the linked worktree a path sits in, walking up to its root
 * — or null. Checkouts that aren't linked worktrees are walked past, so a pane in
 * a submodule or vendored clone inside a worktree still reaches it.
 * `definitive: false` marks a null that an I/O error produced and that may not
 * hold on the next try; any other answer is as stable as the tree it read.
 */
export async function enclosingWorktreeCommonDir(
  path: string,
): Promise<{ readonly commonDir: string | null; readonly definitive: boolean }> {
  for (let dir = path; ; dir = dirname(dir)) {
    // oxlint-disable-next-line no-await-in-loop -- the nearest worktree wins; each level gates the next
    const checkout = await inspectCheckout(dir);
    // oxlint-disable-next-line no-await-in-loop
    if (checkout.kind === "linked") return { commonDir: await canonical(checkout.commonDir), definitive: true };
    if (checkout.kind === "unreadable") return { commonDir: null, definitive: false };
    if (dirname(dir) === dir) return { commonDir: null, definitive: true };
  }
}
