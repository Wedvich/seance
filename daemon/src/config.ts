import { watch } from "node:fs";
import { dirname } from "node:path";
import { fromBase64 } from "@seance/shared";
import { fingerprint } from "./hash.ts";
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
}

export function configSkeleton(machineName: string): string {
  const skeleton = {
    name: machineName,
    relayUrl: "wss://",
    bearerToken: "",
    psk: "",
    repoRoots: ["~/repos"],
    tmuxSession: "main",
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
  return {
    name: requireString(obj, "name", path),
    relayUrl: requireString(obj, "relayUrl", path),
    bearerToken: requireString(obj, "bearerToken", path),
    psk: requireString(obj, "psk", path),
    repoRoots: (roots as string[]).map(expandTilde),
    tmuxSession: typeof obj["tmuxSession"] === "string" ? (obj["tmuxSession"] as string) : "main",
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
 * is deliberately weaker than its availability probe (DESIGN.md's open item on
 * `has-tpm2` under LXC), so a box where sealing works but the probe says no
 * must still resolve its key.
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

/**
 * SHA-256 prefix of the raw key. Rotation touches four devices by hand and
 * there is no rollover window, so the cheap check that they agree is comparing
 * eight hex characters instead of secrets. Throws on non-base64 input.
 */
export async function pskFingerprint(psk: string): Promise<string> {
  return fingerprint(fromBase64(psk));
}

/**
 * Everything `seanced` (run) needs beyond shape. Returns problems instead of
 * throwing so doctor can list them all. `psk` is the *resolved* key from
 * `loadPsk` — config field or a platform store — not `config.psk`.
 */
export function runnableProblems(config: Config, psk: string | null): readonly string[] {
  const problems: string[] = [];
  if (!/^wss?:\/\/.+/u.test(config.relayUrl)) {
    problems.push(`relayUrl "${config.relayUrl}" is not a ws:// or wss:// URL`);
  }
  if (config.bearerToken === "") {
    problems.push("bearerToken is empty");
  }
  if (config.name === "") {
    problems.push("name is empty");
  }
  if (psk === null) {
    problems.push("no psk — paste 32 random bytes into config (openssl rand -base64 32), or run `seanced psk-import`");
  } else {
    try {
      const bytes = fromBase64(psk);
      if (bytes.byteLength !== 32) {
        problems.push(`psk decodes to ${bytes.byteLength} bytes, need 32`);
      }
    } catch {
      problems.push("psk is not valid base64");
    }
  }
  return problems;
}

/** base64url plus `=` padding — the intersection of what an Authorization header and a `?t=` value both carry intact. */
const URL_SAFE_TOKEN = /^[A-Za-z0-9._~=-]+$/u;

/** 32 base64url characters is 192 bits; below that the token is worth regenerating. */
const MIN_BEARER_LENGTH = 32;

/**
 * Non-fatal `bearerToken` advice. An awkwardly encoded token still
 * authenticates the daemon — its header carries any bytes — but the app passes
 * the same string as `?t=`, where `+` decodes to a space. That surfaces as a
 * silent 401 and a backoff loop rather than an error, so it is worth catching
 * here. Empty is left to `runnableProblems`, which already fails on it.
 */
export function bearerTokenWarnings(token: string): readonly string[] {
  if (token === "") return [];
  const warnings: string[] = [];
  if (!URL_SAFE_TOKEN.test(token)) {
    // Quoted: a stray space or newline from a bad paste is the likeliest
    // offender and the one that says nothing at all unrendered.
    const offenders = [...new Set(token.replaceAll(/[A-Za-z0-9._~=-]/gu, ""))]
      .map((char) => JSON.stringify(char))
      .join(" ");
    warnings.push(
      `bearerToken has characters the app's ?t= parameter mangles (${offenders}) — regenerate as base64url: ` +
        `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`,
    );
  }
  if (token.length < MIN_BEARER_LENGTH) {
    warnings.push(`bearerToken is only ${token.length} characters — use at least ${MIN_BEARER_LENGTH}`);
  }
  return warnings;
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
