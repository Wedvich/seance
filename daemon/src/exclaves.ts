import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXCLAVE, isRecord, type ExclaveInfo, type RepoEntry } from "@seance/shared";
import { canonical } from "./gitdir.ts";

/**
 * The `~/.exclaves` contract (DESIGN.md, "Exclaves"): one name per line, each
 * naming a tree at `~/<name>` with its Claude Code config dir at
 * `~/.claude-<name>`; `default` (`~`, `~/.claude`) is implied and never
 * listed. The file has two readers — the owner's shell hook maintains it, the
 * daemon only reads it — and this regex is the agreement between them.
 */
export const EXCLAVE_NAME = /^[a-z0-9][a-z0-9-]*$/u;
export { DEFAULT_EXCLAVE };

export interface Exclave {
  readonly id: string;
  /** Canonical tree root, so the scan's realpath'd repo paths prefix-match it. */
  readonly root: string;
  readonly configDir: string;
  /**
   * Claude Code's `.claude.json`. Inside `configDir` only when `CLAUDE_CONFIG_DIR`
   * is set, as it is for every named exclave; `default` runs without it, so its
   * file is `~/.claude.json` and `~/.claude/.claude.json`, when present, is a stub.
   */
  readonly configFile: string;
}

export interface ExclaveScan {
  /** Position here is what a `status` quota entry indexes — `info[i]` describes `exclaves[i]`. */
  readonly exclaves: readonly Exclave[];
  readonly info: readonly ExclaveInfo[];
  /** Lines that failed the contract, for one log line; a stray line costs one exclave, never the scan. */
  readonly rejected: readonly string[];
}

async function readLines(file: string): Promise<readonly string[]> {
  try {
    return (await readFile(file, "utf8")).split(/\r?\n/u);
  } catch {
    return []; // no file — a machine with only `default`
  }
}

function exclaveConfigDir(home: string, id: string): string {
  return id === DEFAULT_EXCLAVE ? join(home, ".claude") : join(home, `.claude-${id}`);
}

/** The `.claude.json` an exclave's sessions read — `Exclave.configFile`, from the id alone. */
export function exclaveConfigFile(home: string, id: string): string {
  return id === DEFAULT_EXCLAVE ? join(home, ".claude.json") : join(exclaveConfigDir(home, id), ".claude.json");
}

async function exclaveAt(home: string, id: string, root: string): Promise<Exclave> {
  return {
    id,
    root: await canonical(root),
    configDir: exclaveConfigDir(home, id),
    configFile: exclaveConfigFile(home, id),
  };
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
    exclaveAt(home, DEFAULT_EXCLAVE, home),
    ...names.map((name) => exclaveAt(home, name, join(home, name))),
  ]);
  return { exclaves, rejected };
}

/**
 * Account presence as Claude Code records it in the exclave's `.claude.json`.
 * Only `oauthAccount`'s ids, email and extra-usage flag are read — never a
 * token, which that file does not hold anyway. A missing file is a signed-out
 * exclave, not an error: the daemon reports, it doesn't require.
 *
 * An unparsable file keeps `previous`'s account: every running session
 * rewrites its exclave's `.claude.json`, so a read can land mid-write, and a
 * torn read reported as signed out would re-register and stick until the next
 * scan. With no previous reading (the first scan) it is signed out.
 */
export async function describeExclave(exclave: Exclave, previous?: ExclaveInfo): Promise<ExclaveInfo> {
  const [account, skills] = await Promise.all([
    readAccount(exclave.configFile),
    listSkills(join(exclave.configDir, "skills")),
  ]);
  if (account !== UNPARSABLE) return { id: exclave.id, ...account, skills };
  const { accountId, email, extraUsageEnabled, authOk } = previous ?? SIGNED_OUT;
  return { id: exclave.id, accountId, ...(email === undefined ? {} : { email }), extraUsageEnabled, authOk, skills };
}

type Account = Pick<ExclaveInfo, "accountId" | "email" | "extraUsageEnabled" | "authOk">;

const SIGNED_OUT: Account = { accountId: null, extraUsageEnabled: null, authOk: false };
const UNPARSABLE = Symbol("unparsable");

async function readAccount(file: string): Promise<Account | typeof UNPARSABLE> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return SIGNED_OUT;
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return UNPARSABLE;
  }
  if (!isRecord(config)) return SIGNED_OUT;
  const account = config["oauthAccount"];
  if (!isRecord(account)) return SIGNED_OUT;
  const org = account["organizationUuid"];
  const acct = account["accountUuid"];
  const extra = account["hasExtraUsageEnabled"];
  const email = account["emailAddress"];
  return {
    accountId: typeof org === "string" && typeof acct === "string" ? `${org}:${acct}` : null,
    ...(typeof email === "string" && email !== "" ? { email } : {}),
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

/** `previous` is the last scan's `info`, matched by id, so a torn read keeps that exclave's account. */
export async function scanExclaves(
  home: string = homedir(),
  previous: readonly ExclaveInfo[] = [],
): Promise<ExclaveScan> {
  const { exclaves, rejected } = await listExclaves(home);
  const info = await Promise.all(
    exclaves.map((exclave) =>
      describeExclave(
        exclave,
        previous.find((p) => p.id === exclave.id),
      ),
    ),
  );
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

/** One Claude config dir a user-scope registration (`mcp install`) has to reach, and the env that selects it. */
export interface ClaudeConfigTarget {
  /** An exclave id, or the ambient dir's path when it is no exclave's. */
  readonly label: string;
  readonly configDir: string;
  /** `undefined` unsets: `default` is the config reached without `CLAUDE_CONFIG_DIR`. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Every exclave, plus the ambient `CLAUDE_CONFIG_DIR` when it names a dir no
 * exclave owns — the shell hook sets it by cwd, so a session outside every
 * exclave tree with a hand-set dir is still somewhere the user runs Claude.
 * Exported for tests.
 */
export function claudeConfigTargets(
  exclaves: readonly Exclave[],
  ambient: string | undefined,
): readonly ClaudeConfigTarget[] {
  const targets: ClaudeConfigTarget[] = exclaves.map((exclave) => ({
    label: exclave.id,
    configDir: exclave.configDir,
    env: { CLAUDE_CONFIG_DIR: exclave.id === DEFAULT_EXCLAVE ? undefined : exclave.configDir },
  }));
  if (ambient === undefined || ambient === "" || targets.some((t) => t.configDir === ambient)) return targets;
  return [...targets, { label: ambient, configDir: ambient, env: { CLAUDE_CONFIG_DIR: ambient } }];
}
