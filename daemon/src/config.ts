import { fromBase64 } from "@seance/shared";
import { readDpapiPsk } from "./dpapi.ts";
import { fingerprint } from "./hash.ts";
import { readKeychainPsk } from "./keychain.ts";
import { configPath, expandTilde } from "./paths.ts";
import { readTpmPsk } from "./tpmcreds.ts";

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

export type PskSource = "config" | "keychain" | "dpapi" | "tpm";

export interface ResolvedPsk {
  readonly psk: string;
  readonly source: PskSource;
}

/**
 * The config field wins, so every box keeps one code path; an empty field
 * falls back to the platform store — macOS login keychain, WSL DPAPI blob, or
 * Linux TPM-sealed blob, each self-gated on its platform. Null when nothing
 * holds it, which `runnableProblems` reports rather than throwing.
 * `keychainService`, `dpapiPath`, and `tpmPath` exist so tests can point at a
 * name/path that cannot exist.
 */
export async function loadPsk(
  config: Config,
  keychainService?: string,
  dpapiPath?: string,
  tpmPath?: string,
): Promise<ResolvedPsk | null> {
  if (config.psk !== "") return { psk: config.psk, source: "config" };
  const keychain = await readKeychainPsk(keychainService);
  if (keychain !== null) return { psk: keychain, source: "keychain" };
  const dpapi = await readDpapiPsk(dpapiPath);
  if (dpapi !== null) return { psk: dpapi, source: "dpapi" };
  const tpm = await readTpmPsk(tpmPath);
  return tpm === null ? null : { psk: tpm, source: "tpm" };
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
 * `loadPsk` — config field or keychain — not `config.psk`.
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
