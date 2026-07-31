import { dpapiPskPath, importDpapiPskValue, readDpapiPsk } from "./dpapi.ts";
import { importKeychainPsk, importKeychainPskValue, PSK_SERVICE, readKeychainPsk } from "./keychain.ts";
import { importTpmPskValue, readTpmPsk, tpmAvailable, tpmPskPath } from "./tpmcreds.ts";
import { isWsl } from "./wsl.ts";

/**
 * The seam the three platform key stores share. Adding a fourth is a new
 * factory plus one entry in `pskStores()` — never another platform branch in
 * `loadPsk`, `psk-import` or `doctor`, which is what this replaced.
 */

export type PskStoreSource = "keychain" | "dpapi" | "tpm";

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
  };
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
  };
}

/**
 * Every store, in resolution order. Built fresh per call because the blob paths
 * derive from `stateDir()`, which reads `SEANCE_STATE_DIR` — a module-level
 * array would freeze whatever the environment held at import time.
 */
export function pskStores(): readonly PskStore[] {
  return [keychainStore(), dpapiStore(), tpmStore()];
}

/**
 * The store this machine would use, or null where the PSK can only live in
 * config.json. Availability is mutually exclusive by platform, so first-wins
 * matches the hand-written chains this replaced.
 */
export async function availablePskStore(stores: readonly PskStore[] = pskStores()): Promise<PskStore | null> {
  for (const store of stores) {
    // oxlint-disable-next-line no-await-in-loop -- probes spawn; the first hit is the answer, so run them in order
    if (await store.available()) return store;
  }
  return null;
}
