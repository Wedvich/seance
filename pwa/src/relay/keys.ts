import { importPsk } from "@seance/shared";

/**
 * Credential storage. The PSK is kept as a non-extractable CryptoKey in
 * IndexedDB and its base64 is never persisted: an XSS can then use the key
 * while it runs, but cannot exfiltrate 32 bytes that would otherwise grant
 * permanent authority over every machine. The bearer token has to stay
 * readable — it goes on the URL as `?t=` — and by design authorizes nothing
 * destructive.
 */

const DB_NAME = "seance";
const DB_VERSION = 1;
const STORE = "keys";
const PSK_ID = "psk";

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

/** Rejects if the base64 does not decode to 32 bytes. Cannot tell a wrong key from a right one. */
export async function storePsk(pskBase64: string): Promise<CryptoKey> {
  const key = await importPsk(pskBase64);
  await withStore("readwrite", (store) => store.put(key, PSK_ID));
  return key;
}

export async function loadPsk(): Promise<CryptoKey | null> {
  const stored = await withStore<unknown>("readonly", (store) => store.get(PSK_ID) as IDBRequest<unknown>);
  return stored instanceof CryptoKey ? stored : null;
}

export async function clearPsk(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(PSK_ID));
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
