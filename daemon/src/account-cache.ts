import { RequestFailure, STORE_PREFIXES, type AccountRecord } from "@seance/shared";
import type { AppRelay } from "./app-relay.ts";

/**
 * The relay's bucket is DO-wide, not per socket: `LIST_BURST` (16) lists, refilling one per
 * `LIST_REFILL_MS` (8 s) — relay/src/store.ts. Every `seanced mcp` process on every box lists on
 * its first labelled call, so a refusal (empty bucket) or a loss says the bucket is spent or the
 * relay is slow; asking again at once from each tool call spends what the PWA needs. 60 s is
 * about 7 refills: by then asking is likely to succeed. Neither a reopen nor a `store-changed`
 * ends the hold, or a flapping socket or an alias-editing PWA would have N processes list
 * again at once; the price is a label that stays on the email for up to a minute. Auto's pin
 * resolution passes `bypassHold`: it needs the real answer and is a person's one-off call. So does
 * the broker, which only a pin asks (keyless labels carry no alias).
 */
export const NULL_HOLD_MS = 60_000;

/**
 * The account records an app-role daemon client resolves and shows aliases by, read once per
 * socket generation as the PWA's `AccountStore` reads them: every app shares
 * the relay's `account:` list bucket, and one socket may list four times a
 * minute, so a listing per tool call would spend what the PWA needs. Dropped on
 * a reopen (nudges sent while down are lost) and on a `store-changed` for an
 * `account:` key — relay plaintext, only a hint to list again. A refused or
 * lost listing reads as null (aliases unavailable right now) and is held as null
 * for `NULL_HOLD_MS`, for label reads only. Listed only when a caller asks: an
 * account pin, or `seanced mcp` labelling an account in `list_machines` or `get_queue`.
 */
export class AccountCache {
  readonly #client: Pick<AppRelay, "listAccounts">;
  #held: readonly AccountRecord[] | null = null;
  #pending: Promise<readonly AccountRecord[] | null> | null = null;
  /** Bumped on every drop: a listing sent before one answers for a view since replaced. */
  #generation = 0;
  /** Label reads answer null without listing until this time; survives `#drop`, see `NULL_HOLD_MS`. */
  #nullUntil = 0;
  /** Listings started; only the latest-started one writes `#nullUntil`, whatever its generation. */
  #listSeq = 0;
  readonly #now: () => number;

  constructor(
    client: Pick<AppRelay, "listAccounts" | "onStoreChanged" | "subscribe" | "getState">,
    now: () => number = Date.now,
  ) {
    this.#client = client;
    this.#now = now;
    client.onStoreChanged((key) => {
      if (key.startsWith(STORE_PREFIXES.account.prefix)) this.#drop();
    });
    let open = client.getState().status === "open";
    client.subscribe(() => {
      const isOpen = client.getState().status === "open";
      if (isOpen && !open) this.#drop();
      open = isOpen;
    });
  }

  #drop(): void {
    this.#generation += 1;
    this.#held = null;
    this.#pending = null;
  }

  read(options: { readonly bypassHold?: boolean } = {}): Promise<readonly AccountRecord[] | null> {
    if (this.#held !== null) return Promise.resolve(this.#held);
    // Join a listing already in flight (a pin's bypass) before honouring the hold.
    if (this.#pending !== null) return this.#pending;
    if (options.bypassHold !== true && this.#now() < this.#nullUntil) return Promise.resolve(null);
    this.#pending = this.#list();
    return this.#pending;
  }

  async #list(): Promise<readonly AccountRecord[] | null> {
    const generation = this.#generation;
    const seq = ++this.#listSeq;
    const setHold = (records: readonly AccountRecord[] | null): void => {
      if (seq !== this.#listSeq) return;
      this.#nullUntil = records === null ? this.#now() + NULL_HOLD_MS : 0;
    };
    let records: readonly AccountRecord[] | null = null;
    try {
      const listing = await this.#client.listAccounts();
      if (listing?.ok === true) records = listing.accounts.map((entry) => entry.record);
    } catch (err) {
      if (!(err instanceof RequestFailure)) {
        // A rejected promise left in `#pending` would poison every read of this generation.
        // Held too: a deterministic bug would otherwise list on every call.
        setHold(null);
        if (generation === this.#generation) this.#pending = null;
        throw err;
      }
    }
    setHold(records);
    if (generation !== this.#generation) return records;
    this.#pending = null;
    this.#held = records;
    return records;
  }
}

/**
 * One cache per client, so everything sharing a socket shares its listings:
 * the relay allows one socket four a minute. Weak, because an idle hang-up
 * drops the client and the next one lists afresh.
 */
export function accountCaches(): (client: AppRelay) => AccountCache {
  const caches = new WeakMap<AppRelay, AccountCache>();
  return (client) => {
    const held = caches.get(client);
    if (held !== undefined) return held;
    const cache = new AccountCache(client);
    caches.set(client, cache);
    return cache;
  };
}
