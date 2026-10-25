import { RequestFailure, STORE_PREFIXES, type AccountRecord } from "@seance/shared";
import type { AppRelay } from "./app-relay.ts";

/**
 * The account records an `auto` client resolves an alias by, read once per
 * socket generation as the PWA's `AccountStore` reads them: every app shares
 * the relay's `account:` list bucket, and one socket may list four times a
 * minute, so a listing per tool call would spend what the PWA needs. Dropped on
 * a reopen (nudges sent while down are lost) and on a `store-changed` for an
 * `account:` key — relay plaintext, only a hint to list again. A refused or
 * lost listing is not kept, and reads as null: aliases unavailable right now.
 * Listed only when a caller asks, which only an account pin does.
 */
export class AccountCache {
  readonly #client: Pick<AppRelay, "listAccounts">;
  #held: readonly AccountRecord[] | null = null;
  #pending: Promise<readonly AccountRecord[] | null> | null = null;
  /** Bumped on every drop: a listing sent before one answers for a view since replaced. */
  #generation = 0;

  constructor(client: Pick<AppRelay, "listAccounts" | "onStoreChanged" | "subscribe" | "getState">) {
    this.#client = client;
    client.onStoreChanged((key) => {
      if (key.startsWith(STORE_PREFIXES.account.prefix)) this.#drop();
    });
    let open = client.getState().status === "open";
    client.subscribe(() => {
      const now = client.getState().status === "open";
      if (now && !open) this.#drop();
      open = now;
    });
  }

  #drop(): void {
    this.#generation += 1;
    this.#held = null;
    this.#pending = null;
  }

  read(): Promise<readonly AccountRecord[] | null> {
    if (this.#held !== null) return Promise.resolve(this.#held);
    this.#pending ??= this.#list();
    return this.#pending;
  }

  async #list(): Promise<readonly AccountRecord[] | null> {
    const generation = this.#generation;
    let records: readonly AccountRecord[] | null = null;
    try {
      const listing = await this.#client.listAccounts();
      if (listing?.ok === true) records = listing.accounts.map((entry) => entry.record);
    } catch (err) {
      if (!(err instanceof RequestFailure)) throw err;
    }
    if (generation !== this.#generation) return records;
    this.#pending = null;
    this.#held = records;
    return records;
  }
}
