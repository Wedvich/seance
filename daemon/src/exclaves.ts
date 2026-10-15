import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord, type ExclaveInfo, type RepoEntry } from "@seance/shared";

/**
 * The `~/.exclaves` contract (DESIGN.md, "Exclaves"): one name per line, each
 * naming a tree at `~/<name>` with its Claude Code config dir at
 * `~/.claude-<name>`; `default` (`~`, `~/.claude`) is implied and never
 * listed. The file has two readers — the owner's shell hook maintains it, the
 * daemon only reads it — and this regex is the agreement between them.
 */
export const EXCLAVE_NAME = /^[a-z0-9][a-z0-9-]*$/u;
export const DEFAULT_EXCLAVE = "default";

export interface Exclave {
  readonly id: string;
  /** Canonical tree root, so the scan's realpath'd repo paths prefix-match it. */
  readonly root: string;
  readonly configDir: string;
}

export interface ExclaveScan {
  /** Position here is what a `status` quota entry indexes — `info[i]` describes `exclaves[i]`. */
  readonly exclaves: readonly Exclave[];
  readonly info: readonly ExclaveInfo[];
  /** Lines that failed the contract, for one log line; a stray line costs one exclave, never the scan. */
  readonly rejected: readonly string[];
}

async function canonical(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}

async function readLines(file: string): Promise<readonly string[]> {
  try {
    return (await readFile(file, "utf8")).split(/\r?\n/u);
  } catch {
    return []; // no file — a machine with only `default`
  }
}

async function exclaveAt(id: string, root: string, configDir: string): Promise<Exclave> {
  return { id, root: await canonical(root), configDir };
}

/** The named exclaves, in file order, deduplicated; `default` on the file is a stray line (it is implied). */
export async function listExclaves(home: string): Promise<{
  readonly exclaves: readonly Exclave[];
  readonly rejected: readonly string[];
}> {
  const names: string[] = [];
  const rejected: string[] = [];
  for (const raw of await readLines(join(home, ".exclaves"))) {
    const line = raw.trim();
    if (line === "") continue;
    if (!EXCLAVE_NAME.test(line) || line === DEFAULT_EXCLAVE) {
      rejected.push(line);
      continue;
    }
    if (!names.includes(line)) names.push(line);
  }
  const exclaves = await Promise.all([
    exclaveAt(DEFAULT_EXCLAVE, home, join(home, ".claude")),
    ...names.map((name) => exclaveAt(name, join(home, name), join(home, `.claude-${name}`))),
  ]);
  return { exclaves, rejected };
}

/**
 * Account presence as Claude Code records it in its config dir's `.claude.json`.
 * Only `oauthAccount`'s ids and the extra-usage flag are read — never a token,
 * which that file does not hold anyway. A missing or unreadable file is a
 * signed-out exclave, not an error: the daemon reports, it doesn't require.
 */
export async function describeExclave(exclave: Exclave): Promise<ExclaveInfo> {
  const [account, skills] = await Promise.all([
    readAccount(join(exclave.configDir, ".claude.json")),
    listSkills(join(exclave.configDir, "skills")),
  ]);
  return { id: exclave.id, ...account, skills };
}

async function readAccount(file: string): Promise<Pick<ExclaveInfo, "accountId" | "extraUsageEnabled" | "authOk">> {
  const signedOut = { accountId: null, extraUsageEnabled: null, authOk: false };
  let config: unknown;
  try {
    config = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return signedOut;
  }
  if (!isRecord(config)) return signedOut;
  const account = config["oauthAccount"];
  if (!isRecord(account)) return signedOut;
  const org = account["organizationUuid"];
  const acct = account["accountUuid"];
  const extra = account["hasExtraUsageEnabled"];
  return {
    accountId: typeof org === "string" && typeof acct === "string" ? `${org}:${acct}` : null,
    extraUsageEnabled: typeof extra === "boolean" ? extra : null,
    authOk: true,
  };
}

/** Skill names are directory names under `<configDir>/skills/` — what `/skill` resolves. */
async function listSkills(dir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map((e) => e.name)
      .toSorted();
  } catch {
    return [];
  }
}

export async function scanExclaves(home: string = homedir()): Promise<ExclaveScan> {
  const { exclaves, rejected } = await listExclaves(home);
  const info = await Promise.all(exclaves.map(describeExclave));
  return { exclaves, info, rejected };
}

/**
 * Longest-prefix match on the named roots; everything else — the rest of `~`,
 * and anything outside it — is `default`. A clone's location decides which
 * config dir Claude runs with (the shell hook sets it by cwd), so the daemon
 * reports location and nothing more.
 */
export function exclaveOf(path: string, exclaves: readonly Exclave[]): string {
  let best: Exclave | null = null;
  for (const exclave of exclaves) {
    if (exclave.id === DEFAULT_EXCLAVE) continue;
    if (path !== exclave.root && !path.startsWith(`${exclave.root}/`)) continue;
    if (best === null || exclave.root.length > best.root.length) best = exclave;
  }
  return best?.id ?? DEFAULT_EXCLAVE;
}

export function tagExclaves(repos: readonly RepoEntry[], exclaves: readonly Exclave[]): readonly RepoEntry[] {
  return repos.map((repo) => ({ ...repo, exclave: exclaveOf(repo.path, exclaves) }));
}

export function exclaveInfoEqual(a: readonly ExclaveInfo[], b: readonly ExclaveInfo[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
