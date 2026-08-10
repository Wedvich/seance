import { join } from "node:path";
import { CRED_NAME } from "./tpmcreds.ts";

/**
 * PSK delivered by the service manager instead of unsealed by this process:
 * a systemd system unit with `LoadCredentialEncrypted=seance-psk:<blob>` has
 * PID 1 (root) do the TPM unseal and mount the plaintext on a service-private
 * tmpfs at $CREDENTIALS_DIRECTORY/seance-psk. This is the only TPM path on
 * systemd >= 256, which refuses seal/unseal to unprivileged callers
 * (varlink PermissionDenied) — verified 2026-08-10, see DESIGN.md.
 *
 * The credential id must equal the `--name=` sealed into the blob
 * (CRED_NAME), or systemd refuses to load it.
 */

/** Where the manager put this service's PSK, or null when no credentials were delivered. */
export function credentialPskPath(): string | null {
  const dir = process.env["CREDENTIALS_DIRECTORY"] ?? "";
  return dir === "" ? null : join(dir, CRED_NAME);
}

/**
 * Reads the delivered PSK. Null outside a credential-bearing service, or when
 * the unit loads credentials under other ids — callers fall through to the
 * platform stores.
 */
export async function readCredentialPsk(path: string | null = credentialPskPath()): Promise<string | null> {
  if (path === null) return null;
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const psk = (await file.text()).trim();
  return psk === "" ? null : psk;
}
