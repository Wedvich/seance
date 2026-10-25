import { importPsk, importPskBase } from "@seance/shared";

/**
 * Credential storage. The PSK is kept as a non-extractable CryptoKey in
 * IndexedDB and its base64 is never persisted: an XSS can then use the key
 * while it runs, but cannot exfiltrate 32 bytes that would otherwise grant
 * permanent authority over every machine. The bearer token has to stay
 * readable — it goes on the URL as `?t=` — and by design authorizes nothing
 * destructive.
 *
 * A second, non-extractable HKDF base (`psk-base`) sits beside it: the account
 * key is derived from it at launch, so naming accounts never needs the PSK
 * typed again. An install saved before it existed lacks it until the PSK is
 * re-entered in Settings.
 */

const DB_NAME = "seance";
const DB_VERSION = 1;
const STORE = "keys";
const PSK_ID = "psk";
const PSK_BASE_ID = "psk-base";

const BEARER_KEY = "seance:bearer";
const RELAY_URL_KEY = "seance:relay-url";

export const DEV_RELAY_URL = "ws://127.0.0.1:8787/app";

function settle<T>(request: IDBRequest<T>, resolve: (value: T) => void, reject: (error: Error) => void): void {
  request.addEventListener("success", () => resolve(request.result));
  request.addEventListener("error", () => reject(request.error ?? new Error("key store request failed")));
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    });
    settle(request, resolve, reject);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      settle(run(db.transaction(STORE, mode).objectStore(STORE)), resolve, reject);
    });
  } finally {
    db.close();
  }
}

/** One transaction, resolved on `complete`: both keys land or neither does. */
async function putAll(entries: readonly (readonly [string, CryptoKey])[]): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      for (const [id, value] of entries) tx.objectStore(STORE).put(value, id);
      tx.addEventListener("complete", () => resolve());
      tx.addEventListener("error", () => reject(tx.error ?? new Error("key store write failed")));
      tx.addEventListener("abort", () => reject(tx.error ?? new Error("key store write aborted")));
    });
  } finally {
    db.close();
  }
}

/** Rejects if the base64 does not decode to 32 bytes. Cannot tell a wrong key from a right one. */
export async function storePsk(pskBase64: string): Promise<CryptoKey> {
  const key = await importPsk(pskBase64);
  const base = await importPskBase(pskBase64);
  await putAll([
    [PSK_ID, key],
    [PSK_BASE_ID, base],
  ]);
  return key;
}

async function loadKey(id: string): Promise<CryptoKey | null> {
  const stored = await withStore<unknown>("readonly", (store) => store.get(id) as IDBRequest<unknown>);
  return stored instanceof CryptoKey ? stored : null;
}

export const loadPsk = (): Promise<CryptoKey | null> => loadKey(PSK_ID);

/** Null on an install saved before the base was kept. */
export const loadPskBase = (): Promise<CryptoKey | null> => loadKey(PSK_BASE_ID);

export async function clearPsk(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(PSK_ID));
  await withStore("readwrite", (store) => store.delete(PSK_BASE_ID));
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Blocked storage costs a re-paste on next launch, not a broken session.
  }
}

export const readBearer = (): string | null => readLocal(BEARER_KEY);
export const storeBearer = (token: string): void => writeLocal(BEARER_KEY, token);

export const readRelayUrl = (): string => readLocal(RELAY_URL_KEY) ?? import.meta.env.VITE_RELAY_URL ?? DEV_RELAY_URL;
export const storeRelayUrl = (url: string): void => writeLocal(RELAY_URL_KEY, url);
