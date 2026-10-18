import { MAX_PAUSE_HOLDS, PAUSE_KEY, type PauseHold, type Reason } from "@seance/shared";
import { WRITE_ATTEMPTS, type QueueStore, type StoredPause, type UnreadablePause } from "./ports.ts";

/**
 * The holds in `queue:pause` (DESIGN.md, Scheduler, "Pause"): one on the whole
 * queue, or one per account. The functions are pure, so routing and the writer
 * (`PauseRecord`) share one reading of which hold is in force.
 */

/**
 * `pause` and `resume`: every hold in force after the change, or why not.
 * `full`: past `MAX_PAUSE_HOLDS`, one of them kept for the whole-queue hold
 * (account holds stop at one fewer, so a queue `pause` always fits).
 * `conflict`: the record kept changing under the write.
 */
export type PauseResult =
  | { readonly ok: true; readonly holds: readonly PauseHold[] }
  | { readonly ok: false; readonly code: "reset_unknown" | "conflict" | "full" };

interface Held {
  readonly version: number;
  readonly holds: readonly PauseHold[];
}

/** A reset hold lifts at its `resumeAt` with no write; a resume hold waits for a `resume`. */
export function isActive(hold: PauseHold, now: number): boolean {
  return hold.until === "resume" || (hold.resumeAt !== undefined && hold.resumeAt > now);
}

export function activeHolds(holds: readonly PauseHold[], now: number): readonly PauseHold[] {
  return holds.filter((h) => isActive(h, now));
}

/** The whole-queue hold among active ones, as the reason every candidate carries. */
export function queuePause(holds: readonly PauseHold[]): Reason | null {
  const hold = holds.find((h) => h.account === undefined);
  return hold === undefined ? null : { code: "paused", until: hold.until, scope: "queue" };
}

/** `accountId`'s hold among active ones, as the reason its candidates carry. */
export function accountPause(holds: readonly PauseHold[], accountId: string): Reason | null {
  const hold = holds.find((h) => h.account === accountId);
  return hold === undefined ? null : { code: "paused", until: hold.until, scope: "account" };
}

/**
 * `hold` in place of whatever held its scope, expired holds dropped. The same
 * hold already in force is kept as it was, so asking twice writes nothing.
 */
export function withHold(holds: readonly PauseHold[], hold: PauseHold, now: number): readonly PauseHold[] {
  const live = activeHolds(holds, now);
  const current = live.find((h) => h.account === hold.account);
  if (current !== undefined && current.until === hold.until && current.resumeAt === hold.resumeAt) return live;
  return [...live.filter((h) => h.account !== hold.account), hold];
}

/** The hold on `account` (the whole queue when absent) lifted, expired holds dropped. */
export function withoutHold(
  holds: readonly PauseHold[],
  account: string | undefined,
  now: number,
): readonly PauseHold[] {
  return activeHolds(holds, now).filter((h) => h.account !== account);
}

export function sameHolds(a: readonly PauseHold[], b: readonly PauseHold[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `queue:pause` as last read or written — version 0 before the first pause —
 * and the one way it is written.
 */
export class PauseRecord {
  readonly #store: QueueStore;
  readonly #now: () => number;
  readonly #onError: (err: unknown) => void;
  #held: Held = { version: 0, holds: [] };
  /** The tail of its writes: one at a time, as a task's are. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(store: QueueStore, now: () => number, onError: (err: unknown) => void) {
    this.#store = store;
    this.#now = now;
    this.#onError = onError;
  }

  /** Every hold as stored, lifted or not: routing judges a reset hold's `resumeAt` itself. */
  get holds(): readonly PauseHold[] {
    return this.#held.holds;
  }

  /** The holds in force now: a reset hold past its `resumeAt` has lifted, written or not. */
  active(): readonly PauseHold[] {
    return activeHolds(this.#held.holds, this.#now());
  }

  async load(): Promise<void> {
    this.#held = this.#of(await this.#store.getPause());
  }

  /**
   * `change` applied to the holds and written. A conflict or a lost reply
   * re-reads and applies it again, as a task's write does; after a lost reply
   * the one version past ours is ours, the pause being the leader's alone. A
   * change that leaves the holds as they are writes nothing.
   */
  write(change: (holds: readonly PauseHold[]) => readonly PauseHold[]): Promise<PauseResult> {
    const turn = this.#chain.then(() => this.#write(change));
    this.#chain = turn.catch(() => undefined);
    return turn;
  }

  async #write(change: (holds: readonly PauseHold[]) => readonly PauseHold[]): Promise<PauseResult> {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const held = this.#held;
      const next = change(held.holds);
      if (next.filter((h) => h.account !== undefined).length >= MAX_PAUSE_HOLDS) return { ok: false, code: "full" };
      if (sameHolds(next, held.holds)) return { ok: true, holds: this.active() };
      // oxlint-disable-next-line no-await-in-loop -- each attempt follows the refresh before it
      const write = await this.#store.putPause(held.version, next);
      if (write.ok) {
        this.#held = { version: write.version, holds: next };
        return { ok: true, holds: this.active() };
      }
      if (write.code !== "version_conflict" && write.code !== "indeterminate") {
        throw new Error(`store refused put of ${PAUSE_KEY}: ${write.code}`);
      }
      // oxlint-disable-next-line no-await-in-loop -- as above
      const fresh = await this.#store.getPause();
      if (write.code === "indeterminate" && fresh?.reason === undefined && fresh?.version === held.version + 1) {
        this.#held = { version: fresh.version, holds: next };
        return { ok: true, holds: this.active() };
      }
      this.#held = this.#of(fresh);
    }
    return { ok: false, code: "conflict" };
  }

  /**
   * `queue:pause` as read. Unreadable fails closed — the whole queue held until
   * a `resume`, which overwrites it at its version: a pause is usually about
   * spending, and dispatching through one nobody can read is the costlier guess.
   */
  #of(read: StoredPause | UnreadablePause | null): Held {
    if (read === null) return { version: 0, holds: [] };
    if (read.reason === undefined) return { version: read.version, holds: read.holds };
    this.#onError(
      new Error(`${PAUSE_KEY} is unreadable (${read.reason}): the whole queue is held until a resume overwrites it`),
    );
    return { version: read.version, holds: [{ until: "resume", at: this.#now() }] };
  }
}
