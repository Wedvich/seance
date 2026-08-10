import type { Check } from "./check.ts";
import { credentialPskPath, readCredentialPsk } from "./credential.ts";
import { dpapiPskPath, dpapiRoundTrip, importDpapiPskValue, readDpapiPsk } from "./dpapi.ts";
import { importKeychainPsk, importKeychainPskValue, PSK_SERVICE, readKeychainPsk } from "./keychain.ts";
import { importTpmPskValue, readTpmPsk, tpmAvailable, tpmPskPath, tpmRoundTrip } from "./tpmcreds.ts";
import { isWsl } from "./wsl.ts";

/**
 * The seam the platform key stores share. Adding one is a new factory plus one
 * entry in `pskStores()` — never another platform branch in `loadPsk`,
 * `psk-import` or `doctor`, which is what this replaced.
 */

export type PskStoreSource = "credential" | "keychain" | "dpapi" | "tpm";

/** One platform's place to keep the PSK — the login keychain, a DPAPI blob, or a TPM-sealed blob. */
export interface PskStore {
  /** Provenance tag `loadPsk` returns and doctor prints beside the fingerprint. */
  readonly source: PskStoreSource;
  /** Noun phrase naming this store in doctor's nag: "the keychain", "a DPAPI blob". */
  readonly nag: string;
  /** Sentence `psk-import` opens with, naming what is about to be written and where. */
  readonly intro: string;
  /** What to go check when the value read back after an import doesn't match. */
  readonly readBackHint: string;
  /** What the daemon will read instead, once `psk` is cleared from config.json. */
  readonly clearHint: string;
  /** Whether this machine can use the store at all — async because the TPM probe spawns. */
  readonly available: () => Promise<boolean>;
  /** The stored PSK, or null when absent, unreadable, or off this store's platform. */
  readonly read: () => Promise<string | null>;
  /** Stores a key that reached us over stdin or a tty read, crossing to the store as stdin data. */
  readonly importValue: (psk: string) => Promise<void>;
  /** Set only where the store owns its own terminal prompt, so the key never transits this process. */
  readonly prompted?: {
    /** Line printed before the terminal is handed over. */
    readonly notice: string;
    readonly run: () => Promise<void>;
  };
  /**
   * Health probe for `doctor`, empty when this store has nothing to say. Runs
   * whether or not the store is available: a blob stranded on a machine that
   * can no longer unseal it is exactly what needs reporting.
   */
  readonly doctor: () => Promise<readonly Check[]>;
}

/**
 * PSK delivered by the service manager (systemd `LoadCredentialEncrypted=`,
 * see credential.ts) rather than unsealed by this process. First in resolution
 * order: where the manager hands us a key, it is authoritative. Never
 * importable — the delivery mount is read-only and exists only inside the
 * service, so an interactive `psk-import` never sees this store as available;
 * the blob it loads is sealed once, as root, per docs/psk.md.
 */
export function credentialStore(path: string | null = credentialPskPath()): PskStore {
  return {
    source: "credential",
    nag: "a systemd credential",
    intro: "the PSK arrives via the unit's LoadCredentialEncrypted= — there is nothing to import here.",
    readBackHint: "check the unit's LoadCredentialEncrypted= line (docs/psk.md)",
    clearHint: "the systemd credential",
    available: () => (path === null ? Promise.resolve(false) : Bun.file(path).exists()),
    read: () => readCredentialPsk(path),
    importValue: () =>
      Promise.reject(
        new Error(
          "the PSK is delivered read-only by the service manager — seal the blob with systemd-creds as root and point LoadCredentialEncrypted= at it (docs/psk.md)",
        ),
      ),
    doctor: () => credentialChecks(path),
  };
}

/**
 * Silent outside a credential-bearing service — doctor runs in a shell, where
 * absence is the normal state and says nothing. Inside one, a delivery that
 * loads under the wrong id is exactly the misconfiguration worth naming.
 */
async function credentialChecks(path: string | null): Promise<readonly Check[]> {
  if (path === null) return [];
  return (await readCredentialPsk(path)) !== null
    ? [{ level: "ok", message: "PSK delivered by the service manager (LoadCredentialEncrypted=)" }]
    : [
        {
          level: "warn",
          message: `credentials delivered but ${path} holds no PSK — check the unit's LoadCredentialEncrypted= id`,
        },
      ];
}

export function keychainStore(service: string = PSK_SERVICE): PskStore {
  return {
    source: "keychain",
    nag: "the keychain",
    intro: `storing the PSK as generic password "${service}" in the login keychain.`,
    readBackHint: `check \`security find-generic-password -s ${service} -w\``,
    clearHint: "the keychain",
    available: () => Promise.resolve(process.platform === "darwin"),
    read: () => readKeychainPsk(service),
    importValue: (psk) => importKeychainPskValue(psk, service),
    prompted: {
      notice: "security will prompt below — paste the base64 value (it will not echo).\n",
      run: () => importKeychainPsk(service),
    },
    // `security` reads and writes through the same ACL, so there is nothing to
    // probe that a failed read wouldn't already have reported.
    doctor: () => Promise.resolve([]),
  };
}

export function dpapiStore(path: string = dpapiPskPath()): PskStore {
  return {
    source: "dpapi",
    nag: "a DPAPI blob",
    intro: `storing the PSK as a DPAPI (CurrentUser) blob at ${path}.`,
    readBackHint: "check powershell.exe interop (`seanced doctor`)",
    clearHint: "the DPAPI blob",
    available: () => Promise.resolve(isWsl()),
    read: () => readDpapiPsk(path),
    importValue: (psk) => importDpapiPskValue(psk, path),
    doctor: dpapiChecks,
  };
}

/**
 * Broken interop surfaces here as a warning, and as a FAIL in the config
 * section only when the PSK actually lives in the blob and could not be read.
 */
async function dpapiChecks(): Promise<readonly Check[]> {
  if (!isWsl()) return [];
  const interop = await dpapiRoundTrip();
  return interop === null
    ? [{ level: "ok", message: "DPAPI round-trip via powershell.exe interop" }]
    : [{ level: "warn", message: `${interop} — psk-import and a DPAPI-stored PSK won't work` }];
}

export function tpmStore(path: string = tpmPskPath()): PskStore {
  return {
    source: "tpm",
    nag: "a TPM-sealed blob",
    intro: `storing the PSK as a TPM2-sealed systemd-creds blob at ${path}.`,
    readBackHint: "check the TPM device (`seanced doctor`)",
    clearHint: "the sealed blob",
    available: tpmAvailable,
    read: () => readTpmPsk(path),
    importValue: (psk) => importTpmPskValue(psk, path),
    doctor: () => tpmChecks(path),
  };
}

/**
 * Same shape as the DPAPI probe: a broken TPM path warns here and FAILs in the
 * config section only when the PSK actually lives in the blob. Gated off WSL —
 * that box is the DPAPI store's, and `readTpmPsk` declines it for the same
 * reason — so exactly one blob store reports per machine.
 */
async function tpmChecks(path: string): Promise<readonly Check[]> {
  if (process.platform !== "linux" || isWsl()) return [];
  const stored = await Bun.file(path).exists();
  if (await tpmAvailable()) {
    if (!stored) {
      const probe = await tpmRoundTrip();
      return probe === null
        ? [
            {
              level: "ok",
              message: "TPM seal/unseal via systemd-creds (no PSK blob yet — `seanced psk-import` creates it)",
            },
          ]
        : [{ level: "warn", message: `${probe} — psk-import and a TPM-sealed PSK won't work` }];
    }
    return (await readTpmPsk(path)) !== null
      ? [{ level: "ok", message: "TPM-sealed PSK blob decrypts via systemd-creds" }]
      : [
          {
            level: "warn",
            message:
              `sealed blob at ${path} does not decrypt here — blobs are machine-bound by design; ` +
              "re-run `seanced psk-import` on this machine",
          },
        ];
  }
  return stored
    ? [
        {
          level: "warn",
          message:
            `sealed PSK blob at ${path} but this process can't unseal it — expected where a system unit ` +
            "delivers it via LoadCredentialEncrypted= (docs/psk.md); otherwise blobs are machine-bound " +
            "by design — re-run `seanced psk-import` on this machine",
        },
      ]
    : [{ level: "ok", message: "no usable TPM — psk stays in config.json" }];
}

/**
 * Every store, in resolution order. Built fresh per call because the blob paths
 * derive from `stateDir()`, which reads `SEANCE_STATE_DIR` — a module-level
 * array would freeze whatever the environment held at import time.
 */
export function pskStores(): readonly PskStore[] {
  return [credentialStore(), keychainStore(), dpapiStore(), tpmStore()];
}

/**
 * The store this machine would use, or null where the PSK can only live in
 * config.json. The platform stores are mutually exclusive by platform, and the
 * credential store answers only inside a credential-bearing service — where
 * this is never called — so first-wins matches the hand-written chains this
 * replaced.
 */
/** Doctor's key-store section. At most one store answers per machine. */
export async function pskStoreChecks(stores: readonly PskStore[] = pskStores()): Promise<readonly Check[]> {
  const checks = await Promise.all(stores.map((store) => store.doctor()));
  return checks.flat();
}

export async function availablePskStore(stores: readonly PskStore[] = pskStores()): Promise<PskStore | null> {
  for (const store of stores) {
    // oxlint-disable-next-line no-await-in-loop -- probes spawn; the first hit is the answer, so run them in order
    if (await store.available()) return store;
  }
  return null;
}
