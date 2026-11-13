import { watch } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { isRecord, isTraitName, TRAIT_LIMITS, TRAIT_NAME_PATTERN } from "@seance/shared";
import { EXCLAVE_NAME } from "./exclaves.ts";
import { log } from "./log.ts";
import { configPath, expandTilde } from "./paths.ts";
import { pskStores, type PskStore, type PskStoreSource } from "./psk-store.ts";

export interface Config {
  readonly name: string;
  readonly relayUrl: string;
  readonly bearerToken: string;
  /** Empty is legitimate on macOS, WSL, and Linux with a TPM: `loadPsk` then reads the platform store. */
  readonly psk: string;
  /** Tilde-expanded parent roots scanned for repos at depth 2. */
  readonly repoRoots: readonly string[];
  /** tmux session group daemon-spawned windows land in. */
  readonly tmuxSession: string;
  /**
   * Appended to the remote-control session name as ` (tag)`, so the Claude UIs
   * say which box a session is on. Absent means no suffix — never inferred
   * from `name`, which is a display string and makes an ugly tag.
   */
  readonly machineTag?: string;
  /**
   * `seanced reap`'s settings; absent means the defaults, with the schedule off. Always set under `custodian`, whose
   * defaults (`CUSTODIAN_REAP_DEFAULTS`) fill the fields the key leaves out.
   */
  readonly reap?: ReapConfig;
  /** Present when the machine's config carries a `custodian` key (docs/custodian.md, C2). */
  readonly custodian?: CustodianConfig;
  /** The `/usage` refresh's settings; absent means the defaults. */
  readonly quota?: QuotaConfig;
  /** Auth health's settings (`auth-health.ts`); absent means the defaults. */
  readonly authHealth?: AuthHealthConfig;
  /**
   * Traits this machine declares about itself (DESIGN.md, "Traits"): the only place one is
   * ever declared, so no frame, client or other machine can make this one claim anything.
   */
  readonly traits?: TraitsConfig;
}

/** Trait name → where it applies. `exclaves` absent means every exclave of this machine. */
export type TraitsConfig = Readonly<Record<string, TraitScope>>;

export interface TraitScope {
  readonly exclaves?: readonly string[];
  readonly probe?: TraitProbeConfig;
  /** Ask the leader to prefer other machines for tasks that don't require this trait: a score penalty, never a filter. Stored only when true. */
  readonly keepFree?: true;
}

/**
 * A trait's health probe (`trait-probes.ts`): an argv array run as the daemon's user with the
 * env a session gets, never through a shell. Exit 0 is healthy, any other exit failing, and a
 * timeout or a spawn failure unknown (which still routes).
 */
export interface TraitProbeConfig {
  readonly argv: readonly string[];
  readonly everyMinutes: number;
  readonly timeoutSeconds: number;
}

export const TRAIT_PROBE_DEFAULTS = { everyMinutes: 30, timeoutSeconds: 10 } as const;

/** Five minutes is the floor (a probe is a command to run, not a poll); the cap keeps a day-long probe inside a 32-bit `setTimeout` and catches a milliseconds typo. */
export const TRAIT_PROBE_LIMITS = {
  argvWords: 32,
  wordLength: 1024,
  minEveryMinutes: 5,
  maxEveryMinutes: 1440,
  minTimeoutSeconds: 1,
  maxTimeoutSeconds: 30,
} as const;

/**
 * Strict, as `parseAuthHealth` is: a trait dropped silently would route work away from (or, worse,
 * onto) a machine on the strength of a typo. Any mistake fails the load, naming where.
 */
function parseTraits(raw: unknown, path: string): TraitsConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new TypeError(`config at ${path}: "traits" must be an object`);
  const names = Object.keys(raw);
  if (names.length > TRAIT_LIMITS.perMachine) {
    throw new TypeError(`config at ${path}: "traits" names ${names.length} traits; at most ${TRAIT_LIMITS.perMachine}`);
  }
  const traits: Record<string, TraitScope> = {};
  for (const name of names) {
    if (!isTraitName(name)) {
      throw new TypeError(`config at ${path}: "traits.${name}" is not a trait name (${TRAIT_NAME_PATTERN})`);
    }
    const scope = raw[name];
    if (!isRecord(scope)) throw new TypeError(`config at ${path}: "traits.${name}" must be an object`);
    for (const key of Object.keys(scope)) {
      if (key === "exclaves" || key === "probe" || key === "keepFree") continue;
      throw new TypeError(
        `config at ${path}: unknown key "traits.${name}.${key}" (the keys are "exclaves", "probe" and "keepFree")`,
      );
    }
    const probe = parseTraitProbe(scope["probe"], path, name);
    const keepFreeRaw = scope["keepFree"];
    if (keepFreeRaw !== undefined && typeof keepFreeRaw !== "boolean") {
      throw new TypeError(`config at ${path}: "traits.${name}.keepFree" must be true or false`);
    }
    const extras = {
      ...(probe === undefined ? {} : { probe }),
      ...(keepFreeRaw === true ? { keepFree: true as const } : {}),
    };
    const exclaves = scope["exclaves"];
    if (exclaves === undefined) {
      traits[name] = extras;
      continue;
    }
    const valid =
      Array.isArray(exclaves) &&
      exclaves.length > 0 &&
      exclaves.every((id) => typeof id === "string" && EXCLAVE_NAME.test(id)) &&
      new Set(exclaves).size === exclaves.length;
    if (!valid) {
      throw new TypeError(
        `config at ${path}: "traits.${name}.exclaves" must be a non-empty array of distinct exclave names ("default" or one from ~/.exclaves)`,
      );
    }
    traits[name] = { exclaves: [...exclaves], ...extras };
  }
  return traits;
}

function parseTraitProbe(raw: unknown, path: string, name: string): TraitProbeConfig | undefined {
  if (raw === undefined) return undefined;
  const at = `config at ${path}: "traits.${name}.probe`;
  if (!isRecord(raw)) throw new TypeError(`${at}" must be an object`);
  for (const key of Object.keys(raw)) {
    if (key === "argv" || key === "everyMinutes" || key === "timeoutSeconds") continue;
    throw new TypeError(
      `config at ${path}: unknown key "traits.${name}.probe.${key}" (the keys are "argv", "everyMinutes" and "timeoutSeconds")`,
    );
  }
  const limits = TRAIT_PROBE_LIMITS;
  const argv = raw["argv"];
  const word = (w: unknown): w is string =>
    typeof w === "string" && w.length > 0 && w.length <= limits.wordLength && !w.includes("\0");
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > limits.argvWords || !argv.every(word)) {
    throw new TypeError(
      `${at}.argv" must be a non-empty array of at most ${limits.argvWords} strings, each 1–${limits.wordLength} characters and free of NUL`,
    );
  }
  const [program = ""] = argv;
  // A relative path has no cwd contract to resolve against; a bare name resolves through PATH at each run.
  if (!isAbsolute(program) && program.includes("/")) {
    throw new TypeError(`${at}.argv[0]" must be an absolute path or a bare program name found on PATH`);
  }
  const every = "everyMinutes" in raw ? raw["everyMinutes"] : TRAIT_PROBE_DEFAULTS.everyMinutes;
  if (
    typeof every !== "number" ||
    !Number.isInteger(every) ||
    every < limits.minEveryMinutes ||
    every > limits.maxEveryMinutes
  ) {
    throw new TypeError(
      `${at}.everyMinutes" must be a whole number of minutes, ${limits.minEveryMinutes}–${limits.maxEveryMinutes}`,
    );
  }
  const timeout = "timeoutSeconds" in raw ? raw["timeoutSeconds"] : TRAIT_PROBE_DEFAULTS.timeoutSeconds;
  if (
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout < limits.minTimeoutSeconds ||
    timeout > limits.maxTimeoutSeconds
  ) {
    throw new TypeError(
      `${at}.timeoutSeconds" must be a whole number of seconds, ${limits.minTimeoutSeconds}–${limits.maxTimeoutSeconds}`,
    );
  }
  return { argv: [...argv], everyMinutes: every, timeoutSeconds: timeout };
}

export interface AuthHealthConfig {
  /**
   * Read the macOS keychain for each exclave's login. Off by default until the item naming and a
   * no-prompt `security -w` read are checked on a Mac; until then a macOS exclave reads `unknown`
   * and nothing is read, a credentials file included (a leftover one is not the keychain login's truth).
   */
  readonly keychain: boolean;
}

function parseAuthHealth(raw: unknown, path: string): AuthHealthConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new TypeError(`config at ${path}: "authHealth" must be an object`);
  for (const key of Object.keys(raw)) {
    if (key === "keychain") continue;
    throw new TypeError(`config at ${path}: unknown key "authHealth.${key}" (the key is "keychain")`);
  }
  const keychain = "keychain" in raw ? raw["keychain"] : false;
  if (typeof keychain !== "boolean")
    throw new TypeError(`config at ${path}: "authHealth.keychain" must be true or false`);
  return { keychain };
}

export interface QuotaConfig {
  /**
   * The spec's `quota.staleAfter`: an exclave's cached quota older than this is
   * refreshed through `claude -p /usage`. Never under 1 — Claude Code's own 60 s
   * debounce, inside which a run moves nothing.
   */
  readonly staleAfterMinutes: number;
}

export const QUOTA_DEFAULTS: QuotaConfig = { staleAfterMinutes: 10 };

function parseQuota(raw: unknown, path: string): QuotaConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(`config at ${path}: "quota" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key === "staleAfterMinutes") continue;
    throw new TypeError(`config at ${path}: unknown key "quota.${key}" (the key is "staleAfterMinutes")`);
  }
  const value = "staleAfterMinutes" in obj ? obj["staleAfterMinutes"] : QUOTA_DEFAULTS.staleAfterMinutes;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new TypeError(`config at ${path}: "quota.staleAfterMinutes" must be a number ≥ 1`);
  }
  return { staleAfterMinutes: value };
}

export interface ReapConfig {
  /** How often the daemon reaps on its own; 0 is off, the default. */
  readonly intervalHours: number;
  /** A worktree touched more recently than this is kept. Shared by the CLI and the schedule. */
  readonly minAgeDays: number;
}

export const REAP_DEFAULTS: ReapConfig = { intervalHours: 0, minAgeDays: 4 };
/** With a custodian configured (custodian C35): old worktrees are reap's, so the timer is on and the age gate short. */
export const CUSTODIAN_REAP_DEFAULTS: ReapConfig = { intervalHours: 6, minAgeDays: 1 };

/**
 * docs/custodian.md's seat config (C2). Only the key's presence is read so far — it moves reap's defaults — so no
 * field is parsed yet; the seat's own parser fills this in.
 */
export type CustodianConfig = Readonly<Record<string, never>>;

function parseCustodian(raw: unknown, path: string): CustodianConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new TypeError(`config at ${path}: "custodian" must be an object`);
  return {};
}

/** Per field: a `reap` key naming only some keeps `defaults` for the rest, a custodian's included. */
function parseReap(raw: unknown, path: string, defaults: ReapConfig): ReapConfig | undefined {
  if (raw === undefined) return defaults === REAP_DEFAULTS ? undefined : defaults;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(`config at ${path}: "reap" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const number = (key: keyof ReapConfig): number => {
    // Absent takes the default; present-but-null is a mistake worth naming.
    const value = key in obj ? obj[key] : defaults[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`config at ${path}: "reap.${key}" must be a number ≥ 0`);
    }
    return value;
  };
  return { intervalHours: number("intervalHours"), minAgeDays: number("minAgeDays") };
}

export function configSkeleton(machineName: string): string {
  const skeleton = {
    name: machineName,
    relayUrl: "wss://",
    bearerToken: "",
    psk: "",
    repoRoots: ["~/repos"],
    tmuxSession: "main",
    machineTag: "",
  };
  return `${JSON.stringify(skeleton, null, 2)}\n`;
}

function requireString(raw: Record<string, unknown>, key: string, path: string): string {
  const value = raw[key];
  if (typeof value !== "string") {
    throw new TypeError(`config at ${path}: "${key}" must be a string`);
  }
  return value;
}

/** Validates shape only — empty psk/bearerToken load fine so `doctor` can report them. */
export async function loadConfig(path: string = configPath()): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`no config at ${path} — run \`seanced init\` first`);
  }
  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    throw new Error(`config at ${path} is not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(`config at ${path} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const roots = obj["repoRoots"];
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((r) => typeof r !== "string")) {
    throw new TypeError(`config at ${path}: "repoRoots" must be a non-empty array of strings`);
  }
  const custodian = parseCustodian(obj["custodian"], path);
  const reap = parseReap(obj["reap"], path, custodian === undefined ? REAP_DEFAULTS : CUSTODIAN_REAP_DEFAULTS);
  const quota = parseQuota(obj["quota"], path);
  const authHealth = parseAuthHealth(obj["authHealth"], path);
  const traits = parseTraits(obj["traits"], path);
  return {
    ...(reap === undefined ? {} : { reap }),
    ...(custodian === undefined ? {} : { custodian }),
    ...(quota === undefined ? {} : { quota }),
    ...(authHealth === undefined ? {} : { authHealth }),
    ...(traits === undefined ? {} : { traits }),
    name: requireString(obj, "name", path),
    relayUrl: requireString(obj, "relayUrl", path),
    bearerToken: requireString(obj, "bearerToken", path),
    psk: requireString(obj, "psk", path),
    repoRoots: (roots as string[]).map(expandTilde),
    tmuxSession: typeof obj["tmuxSession"] === "string" ? (obj["tmuxSession"] as string) : "main",
    machineTag: typeof obj["machineTag"] === "string" ? (obj["machineTag"] as string) : undefined,
  };
}

export type PskSource = "config" | PskStoreSource;

export interface ResolvedPsk {
  readonly psk: string;
  readonly source: PskSource;
}

/**
 * The config field wins, so every box keeps one code path; an empty field falls
 * back to the platform stores in order, each self-gated on its platform. Null
 * when nothing holds it, which `runnableProblems` reports rather than throwing.
 * `stores` exists so tests can point at names/paths that cannot exist.
 *
 * Every store is *read* regardless of `available()`: the TPM store's read gate
 * is deliberately weaker than its availability probe (`has-tpm2` reports
 * partial under LXC even with a working seal path — verified, see DESIGN.md),
 * so a box where unsealing works but the probe says no must still resolve its
 * key.
 */
export async function loadPsk(config: Config, stores: readonly PskStore[] = pskStores()): Promise<ResolvedPsk | null> {
  if (config.psk !== "") return { psk: config.psk, source: "config" };
  for (const store of stores) {
    // oxlint-disable-next-line no-await-in-loop -- ordered fallback: the first store holding a key wins
    const psk = await store.read();
    if (psk !== null) return { psk, source: store.source };
  }
  return null;
}

/** Editors and shell redirects both burst several fs events per save; one reload is enough. */
const WATCH_DEBOUNCE_MS = 250;

/** How long to wait before re-arming a watch that errored or could not be established. */
const WATCH_RETRY_MS = 5_000;

/**
 * Watches the config's *directory*, not the file: a tool that writes
 * temp-plus-rename replaces the inode, which a file-level watch stops
 * following after the first save. Unfiltered on purpose — Bun's `fs.watch`
 * reports that rename under the *temp* file's name, on macOS and Linux both,
 * so filtering by filename would miss the case the directory watch exists for.
 * Neighbours in `~/.config/seance` are rare and the caller re-reads and
 * compares anyway. Watcher errors are logged, not thrown — a daemon that can
 * no longer see edits must still relay — but they are also retried: the runtime
 * closes the watcher after an `error` event, so hitting an inotify limit or
 * having the directory replaced wholesale would otherwise end hot reload for
 * the rest of the process while the README still promises it. Repeat failures
 * log once per outage, not once per retry.
 */
export function watchConfigFile(
  onChange: () => void,
  path: string = configPath(),
  debounceMs: number = WATCH_DEBOUNCE_MS,
  retryMs: number = WATCH_RETRY_MS,
): () => void {
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let watcher: ReturnType<typeof watch> | null = null;
  let closed = false;
  let degraded = false;

  const scheduleRetry = (reason: string): void => {
    if (closed) return;
    watcher = null;
    if (!degraded) {
      degraded = true;
      log.error(
        `cannot watch ${path} for changes (${reason}) — config hot reload is off; retrying every ${retryMs / 1000}s`,
      );
    }
    retry = setTimeout(arm, retryMs);
  };

  function arm(): void {
    if (closed) return;
    retry = null;
    try {
      watcher = watch(dirname(path), () => {
        if (debounce !== null) clearTimeout(debounce);
        debounce = setTimeout(onChange, debounceMs);
      });
    } catch (err) {
      scheduleRetry(err instanceof Error ? err.message : String(err));
      return;
    }
    watcher.on("error", (err: Error) => {
      watcher?.close();
      scheduleRetry(err.message);
    });
    if (degraded) {
      degraded = false;
      log.info(`watching ${path} for changes again`);
    }
  }

  arm();

  return (): void => {
    closed = true;
    if (debounce !== null) clearTimeout(debounce);
    if (retry !== null) clearTimeout(retry);
    watcher?.close();
  };
}
