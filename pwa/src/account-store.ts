import type { AccountEntry, AccountRecord, UnreadableRecord } from "@seance/shared";
import {
  accountRecord,
  failureReasonText,
  isStoreKey,
  RequestFailure,
  sentence,
  STORE_PREFIXES,
  type RelayClient,
} from "@seance/shared";
import type { AccountsState } from "./state.ts";
import type { AppState } from "./view.ts";

/** One retry of a first listing the relay refused: the `account:` list bucket is shared by every app, so a cold load can lose it. */
export const LIST_RETRY_MS = 8_000;

const TOO_LONG = "Names are at most 64 characters";
const CONFLICT = "Renamed elsewhere — showing the latest name; rename again to replace it";

function refusalText(code: string): string {
  switch (code) {
    case "store_full":
      return "The relay holds its limit of account records";
    case "rate_limited":
      return "Too many writes — try again in a minute";
    default:
      return `Rename refused (${code})`;
  }
}

/**
 * The app's side of account aliases, apart from `Store`: lists `account:` when
 * the socket reopens, re-reads one key when another client's write nudges it,
 * and renames by compare-and-set. What it shows lives in the `AppState`
 * `Store` holds (`accounts`), read and patched through the constructor's two
 * seams. An alias is display-only: it never leaves this module as anything but
 * text for a card.
 */
export class AccountStore {
  readonly #client: RelayClient;
  readonly #getState: () => AppState;
  readonly #patch: (next: Partial<AppState>) => void;
  /** Relay version per store key, unreadable records included: a rename overwrites at it. */
  readonly #versions = new Map<string, number>();
  /** The account a readable record at a key names; an unreadable one has none. */
  readonly #accountByKey = new Map<string, string>();
  /** Keys read singly (a nudge, a rename) since the last reopen: a listing sent before such a read may be older than it. */
  readonly #read = new Set<string>();
  /** Whether a listing has landed on this socket: until then `#versions` may miss records the relay holds. */
  #listed = false;
  /** Bumped on every reopen: a listing sent on an earlier socket answers for a view since replaced. */
  #generation = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  /** A nudge came while the tab was hidden: showing it again lists whole, as a reopen does. */
  #missedHidden = false;

  constructor(client: RelayClient, getState: () => AppState, patch: (next: Partial<AppState>) => void) {
    this.#client = client;
    this.#getState = getState;
    this.#patch = patch;
  }

  get #accounts(): AccountsState {
    return this.#getState().accounts;
  }

  #set(next: Partial<AccountsState>): void {
    this.#patch({ accounts: { ...this.#accounts, ...next } });
  }

  /** A relay change with the socket open: a reopen lists again, since nudges sent meanwhile are lost. */
  onOpen(reopened: boolean): void {
    if (reopened) this.#relist();
  }

  /** Shown again on the same socket (`reconnectIfStale` found it live): lists again if a nudge was ignored meanwhile. */
  onShown(): void {
    if (this.#missedHidden) this.#relist();
  }

  #relist(): void {
    this.#missedHidden = false;
    if (!this.#client.accountsNamed) return;
    this.#generation += 1;
    this.#listed = false;
    this.#read.clear();
    this.#stopRetry();
    void this.#list(true);
  }

  dispose(): void {
    this.#generation += 1;
    this.#stopRetry();
  }

  #stopRetry(): void {
    if (this.#retry === null) return;
    clearTimeout(this.#retry);
    this.#retry = null;
  }

  async #list(mayRetry: boolean): Promise<void> {
    const generation = this.#generation;
    let landed = false;
    try {
      const listing = await this.#client.listAccounts();
      if (generation !== this.#generation) return;
      if (listing?.ok === true) {
        landed = true;
        this.#land(listing.accounts, listing.unreadable);
      }
    } catch (err) {
      // What is held stays up, and a read that fails says nothing: the name was never a promise.
      if (!(err instanceof RequestFailure)) throw err;
    }
    // A reopen or dispose while the listing was out owns the retry now.
    if (landed || this.#listed || !mayRetry || generation !== this.#generation) return;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.#list(false);
    }, LIST_RETRY_MS);
  }

  /**
   * Replaces what is held with a listing, except what a single read since the
   * reopen saw newer: a nudge's read can resolve before the listing sent first,
   * and the listing is then the older snapshot (and lacks keys made after it).
   */
  #land(accounts: readonly AccountEntry[], unreadable: readonly UnreadableRecord[]): void {
    const versions = new Map<string, number>();
    const named = new Map<string, { accountId: string; alias: string | null }>();
    for (const { key, record } of accounts) {
      versions.set(key, record.version);
      named.set(key, { accountId: record.accountId, alias: record.alias });
    }
    for (const { key, version } of unreadable) versions.set(key, version);
    for (const key of this.#read) {
      const held = this.#versions.get(key);
      if (held === undefined || held <= (versions.get(key) ?? 0)) continue;
      versions.set(key, held);
      const accountId = this.#accountByKey.get(key);
      if (accountId === undefined) named.delete(key);
      else named.set(key, { accountId, alias: this.#heldAlias(accountId) });
    }
    this.#versions.clear();
    for (const [key, version] of versions) this.#versions.set(key, version);
    this.#accountByKey.clear();
    for (const [key, { accountId }] of named) this.#accountByKey.set(key, accountId);
    this.#listed = true;
    // fromEntries, not indexed assignment: an accountId of `__proto__` must be an own entry.
    const aliases = Object.fromEntries(
      [...named.values()].flatMap(({ accountId, alias }) => (alias === null ? [] : [[accountId, alias] as const])),
    );
    this.#set({ aliases });
  }

  #heldAlias(accountId: string): string | null {
    const { aliases } = this.#accounts;
    return Object.hasOwn(aliases, accountId) ? (aliases[accountId] ?? null) : null;
  }

  /** A `store-changed` nudge: relay plaintext, so only a hint to re-read a key, and only a newer version is worth it. */
  onStoreChanged(key: string, version: number): void {
    if (!key.startsWith(STORE_PREFIXES.account.prefix) || !isStoreKey(key)) return;
    if (!this.#client.accountsNamed) return;
    // Read once the tab shows again: by `onShown` on a live socket, by the reopen after a re-dial.
    if (document.visibilityState !== "visible") {
      this.#missedHidden = true;
      return;
    }
    if (version <= (this.#versions.get(key) ?? 0)) return;
    void this.#refresh(key);
  }

  /** Re-reads one key and takes what the relay holds. False when no answer came. */
  async #refresh(key: string): Promise<boolean> {
    const generation = this.#generation;
    try {
      const lookup = await this.#client.getAccountRecord(key);
      if (generation !== this.#generation || lookup?.ok !== true) return false;
      this.#take(key, lookup.version, lookup.entry);
      return true;
    } catch (err) {
      if (!(err instanceof RequestFailure)) throw err;
      return false;
    }
  }

  /** Versions only move forward: a read resolving late must not put back what a newer one showed. */
  #take(key: string, version: number, entry: AccountRecord | UnreadableRecord | null): void {
    const held = this.#versions.get(key);
    if (held !== undefined && version < held) return;
    this.#read.add(key);
    const was = this.#accountByKey.get(key);
    this.#accountByKey.delete(key);
    if (entry === null) this.#versions.delete(key);
    else this.#versions.set(key, version);
    const aliases = { ...this.#accounts.aliases };
    if (was !== undefined) delete aliases[was];
    const named = entry !== null && "accountId" in entry ? entry : null;
    if (named === null) {
      this.#set({ aliases });
      return;
    }
    this.#accountByKey.set(key, named.accountId);
    // A computed key in a literal defines an own property, where `aliases[id] = …` would hit `__proto__`'s setter.
    this.#set({ aliases: named.alias === null ? aliases : { ...aliases, [named.accountId]: named.alias } });
  }

  /**
   * Names an account (a blank `text` clears it) at the version held for its key;
   * a lost race re-reads and says so. True only when the name landed, so a form
   * can stay open on its draft otherwise.
   */
  async rename(accountId: string, text: string): Promise<boolean> {
    if (this.#accounts.saving !== null || !this.#client.accountsNamed) return false;
    if (accountRecord(accountId, text, 1) === null) {
      this.#set({ notice: TOO_LONG });
      return false;
    }
    this.#set({ saving: accountId, notice: null });
    let landed = false;
    try {
      const key = await this.#client.accountStoreKey(accountId);
      // Without a listing the version held may be 0 for a key the relay has: read it first, or the put reads as a conflict.
      if (!this.#listed) await this.#refresh(key);
      const written = await this.#client.putAccountAlias(accountId, text, this.#versions.get(key) ?? 0);
      if (written === null) {
        this.#set({ notice: "The relay's answer was unreadable — reopen to see whether it landed" });
      } else if (written.ok) {
        this.#take(key, written.record.version, written.record);
        landed = true;
      } else if (written.code === "version_conflict") {
        await this.#refresh(key);
        this.#set({ notice: CONFLICT });
      } else {
        this.#set({ notice: refusalText(written.code) });
      }
    } catch (err) {
      this.#set({
        notice: err instanceof RequestFailure ? sentence(failureReasonText(err)) : "The rename failed",
      });
    } finally {
      this.#set({ saving: null });
    }
    return landed;
  }

  dismissNotice(): void {
    if (this.#accounts.notice !== null) this.#set({ notice: null });
  }
}
