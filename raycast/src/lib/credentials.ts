import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { appRelayUrl, importPsk } from "@seance/shared";

/**
 * Generic-password service name for the PSK in the macOS login keychain. Must
 * equal `PSK_SERVICE` in daemon/src/keychain.ts — `credentials.test.ts` imports
 * both and asserts it. The mechanisms may diverge (that file is Bun, this is
 * Node under Raycast); the names may not.
 */
export const PSK_SERVICE = "seance-psk";

/**
 * A locked login keychain makes `security` raise a GUI prompt, which never
 * returns on its own. Bounding it turns an indefinite hang into a reportable
 * failure — the error text says which, because "timed out" alone would send
 * someone looking at the relay.
 */
export const KEYCHAIN_TIMEOUT_MS = 10_000;

/**
 * Everything this module touches outside the process, injected so the tests
 * need no platform gate and no keychain of their own.
 */
export interface CredentialSources {
  readonly readTextFile: (path: string) => Promise<string>;
  readonly readKeychain: (service: string) => Promise<string | null>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: () => string;
}

export interface Credentials {
  /** Already swapped to the app role — the config records the daemon endpoint. */
  readonly relayUrl: string;
  readonly bearerToken: string;
  /** Non-extractable, because `importPsk` imports it that way. */
  readonly key: CryptoKey;
}

/**
 * Mirrors `configDir()` in daemon/src/paths.ts. Both env vars are *read* and
 * neither is required: under Raycast they are unset and the defaults already
 * agree with the daemon's, but honouring them keeps a test-pointed or
 * XDG-relocated config reachable from here too. `credentials.test.ts` asserts
 * this resolution matches the daemon's under each combination.
 */
export function configDir(sources: Pick<CredentialSources, "env" | "home">): string {
  const override = sources.env["SEANCE_CONFIG_DIR"];
  if (override !== undefined) return override;
  return join(sources.env["XDG_CONFIG_HOME"] ?? join(sources.home(), ".config"), "seance");
}

export function configPath(sources: Pick<CredentialSources, "env" | "home">): string {
  return join(configDir(sources), "config.json");
}

/**
 * Absolute path, twice over: a Raycast-launched process inherits the Raycast
 * app's minimal environment rather than a login shell's PATH, and going through
 * the same `/usr/bin/security` the daemon writes with means the ACL entry
 * `security` recorded on create is the one it presents on read — so neither
 * side is prompted.
 *
 * No `-a`: the daemon sets the account only on write (see `importKeychainPsk`),
 * so matching on it here would miss a key stored any other way.
 */
function readKeychainPsk(service: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS },
      (err: (Error & { readonly killed?: boolean }) | null, stdout: string) => {
        // Killed on our timeout, not exited: `security` is sitting on an unlock
        // prompt nobody is going to answer.
        if (err !== null && err.killed === true) {
          reject(
            new Error(
              `reading the PSK from the login keychain timed out after ${KEYCHAIN_TIMEOUT_MS / 1000}s — ` +
                "the login keychain is probably locked, so `security` is waiting on an unlock prompt",
            ),
          );
          return;
        }
        // Any other non-zero exit means the item is not there (44) or is not
        // readable — the same "null, let the caller fall back" the daemon's
        // `readKeychainPsk` answers with.
        if (err !== null) {
          resolve(null);
          return;
        }
        const psk = stdout.trim();
        resolve(psk === "" ? null : psk);
      },
    );
  });
}

const defaultSources: CredentialSources = {
  readTextFile: (path) => readFile(path, "utf8"),
  readKeychain: readKeychainPsk,
  env: process.env,
  home: homedir,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(raw: Record<string, unknown>, key: string, path: string): string {
  const value = raw[key];
  if (typeof value !== "string") throw new TypeError(`config at ${path}: "${key}" must be a string`);
  return value;
}

/**
 * The extension's whole credential story, and the module that keeps "never
 * publish to the Raycast Store" reversible: everything comes from the local
 * daemon's config plus the macOS keychain, so this surface adds no second copy
 * of the PSK at rest. Raycast preferences hold defaults only.
 *
 * Precedence matches `loadPsk` in daemon/src/config.ts exactly — a non-empty
 * `psk` field wins, an empty one falls back to the keychain — so one machine
 * cannot have the daemon and this extension disagree about which key is live.
 */
export async function loadKey(overrides: Partial<CredentialSources> = {}): Promise<Credentials> {
  const sources: CredentialSources = { ...defaultSources, ...overrides };
  const path = configPath(sources);

  let text: string;
  try {
    text = await sources.readTextFile(path);
  } catch {
    throw new Error(`no Séance config at ${path} — run \`seanced init\` on this machine first`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`config at ${path} is not valid JSON`);
  }
  if (!isRecord(raw)) throw new TypeError(`config at ${path} must be a JSON object`);

  const relayUrl = requireString(raw, "relayUrl", path);
  const bearerToken = requireString(raw, "bearerToken", path);
  const configured = requireString(raw, "psk", path);

  if (bearerToken === "") throw new Error(`bearerToken is empty in ${path}`);

  const psk = configured === "" ? await sources.readKeychain(PSK_SERVICE) : configured;
  if (psk === null || psk === "") {
    throw new Error(
      `no PSK for Séance — the login keychain holds no "${PSK_SERVICE}" item and ${path} leaves psk empty; ` +
        "run `seanced psk-import`",
    );
  }

  return { relayUrl: appRelayUrl(relayUrl), bearerToken, key: await importPsk(psk) };
}
