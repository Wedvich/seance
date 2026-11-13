import { fromBase64 } from "@seance/shared";
import { fingerprint } from "./hash.ts";

/**
 * The checks every relay-side config shares — the daemon's and the archivist's.
 * Apart from `config.ts` because that module reaches the exclave scan and the
 * broker's protocol, which the archivist must never load (archivist/test/layering.test.ts).
 */

/** The fields these checks read: the daemon's `Config` and the archivist's both carry them. */
export interface RelayConfigFields {
  readonly name: string;
  readonly relayUrl: string;
  readonly bearerToken: string;
}

/**
 * SHA-256 prefix of the raw key. Rotation touches four devices by hand and
 * there is no rollover window, so the cheap check that they agree is comparing
 * eight hex characters instead of secrets. Throws on non-base64 input.
 */
export async function pskFingerprint(psk: string): Promise<string> {
  return fingerprint(fromBase64(psk));
}

export interface RunnableOptions {
  /**
   * Set where a service manager will hand the daemon its key at start
   * (`LoadCredentialEncrypted=`). Resolving none is then the expected result
   * everywhere except inside that service, so it isn't a problem to report —
   * `doctor` sets this, `run` never does, because a `run` that resolved no key
   * genuinely cannot serve.
   */
  readonly pskDelivered?: boolean;
}

/**
 * Everything `seanced` (run) needs beyond shape. Returns problems instead of
 * throwing so doctor can list them all. `psk` is the *resolved* key from
 * `loadPsk` — config field or a platform store — not `config.psk`.
 */
export function runnableProblems(
  config: RelayConfigFields,
  psk: string | null,
  opts: RunnableOptions = {},
): readonly string[] {
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
    if (!opts.pskDelivered) {
      problems.push(
        "no psk — paste 32 random bytes into config (openssl rand -base64 32), or run `seanced psk-import`",
      );
    }
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
