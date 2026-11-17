import { SCHEDULER_SETTINGS_KEY, type SchedulerLimits } from "@seance/shared";
import { WRITE_ATTEMPTS, type QueueStore, type StoredLimits, type UnreadableLimits } from "./ports.ts";

/**
 * The limits in `settings:scheduler` (DESIGN.md, Scheduler, "Routing caps"):
 * what a person set to bound the queue, kept in the store so it outlives the
 * leader that took it. No record is no limit.
 */

/** `set-limits`: the limits after the change. `conflict`: the record kept changing under the write. */
export type LimitsResult =
  | { readonly ok: true; readonly limits: SchedulerLimits }
  | { readonly ok: false; readonly code: "conflict" };

interface Held {
  readonly version: number;
  readonly limits: SchedulerLimits;
  readonly unreadable: boolean;
}

function sameLimits(a: SchedulerLimits, b: SchedulerLimits): boolean {
  return a.fleet === b.fleet;
}

/** `settings:scheduler` as last read or written (version 0 before the first limit) and the one way it is written. */
export class LimitsRecord {
  readonly #store: QueueStore;
  readonly #onError: (err: unknown) => void;
  #held: Held = { version: 0, limits: {}, unreadable: false };
  /** The tail of its writes: one at a time, as the pause's are. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(store: QueueStore, onError: (err: unknown) => void) {
    this.#store = store;
    this.#onError = onError;
  }

  /** The limits as stored; none while the record is unreadable. */
  get limits(): SchedulerLimits {
    return this.#held.limits;
  }

  get unreadable(): boolean {
    return this.#held.unreadable;
  }

  /**
   * What routing enforces. Unreadable fails closed, as the pause does: a fleet
   * limit of 0 until a `set-limits` overwrites the record. A limit is a person's
   * bound on spending or load, and running free through one nobody can read is
   * the costlier guess.
   */
  enforced(): SchedulerLimits {
    return this.#held.unreadable ? { fleet: 0 } : this.#held.limits;
  }

  async load(): Promise<void> {
    this.#held = this.#of(await this.#store.getLimits());
  }

  /**
   * `wanted` in place of the limits, written. A conflict or a lost reply re-reads
   * and writes again; after a lost reply the one version past ours is ours, the
   * record being the leader's alone. The limits already in force write nothing,
   * unless the record is unreadable: then the write is what replaces it.
   */
  write(wanted: SchedulerLimits): Promise<LimitsResult> {
    const turn = this.#chain.then(() => this.#write(wanted));
    this.#chain = turn.catch(() => undefined);
    return turn;
  }

  async #write(next: SchedulerLimits): Promise<LimitsResult> {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const held = this.#held;
      if (!held.unreadable && sameLimits(next, held.limits)) return { ok: true, limits: held.limits };
      // oxlint-disable-next-line no-await-in-loop -- each attempt follows the refresh before it
      const write = await this.#store.putLimits(held.version, next);
      if (write.ok) {
        this.#held = { version: write.version, limits: next, unreadable: false };
        return { ok: true, limits: next };
      }
      if (write.code !== "version_conflict" && write.code !== "indeterminate") {
        throw new Error(`store refused put of ${SCHEDULER_SETTINGS_KEY}: ${write.code}`);
      }
      // oxlint-disable-next-line no-await-in-loop -- as above
      const fresh = await this.#store.getLimits();
      if (write.code === "indeterminate" && fresh?.reason === undefined && fresh?.version === held.version + 1) {
        this.#held = { version: fresh.version, limits: next, unreadable: false };
        return { ok: true, limits: next };
      }
      this.#held = this.#of(fresh);
    }
    return { ok: false, code: "conflict" };
  }

  #of(read: StoredLimits | UnreadableLimits | null): Held {
    if (read === null) return { version: 0, limits: {}, unreadable: false };
    if (read.reason === undefined) return { version: read.version, limits: read.limits, unreadable: false };
    this.#onError(
      new Error(
        `${SCHEDULER_SETTINGS_KEY} is unreadable (${read.reason}): nothing is placed until a set-limits overwrites it`,
      ),
    );
    return { version: read.version, limits: {}, unreadable: true };
  }
}
