import type { SettingsRecord } from "@seance/shared";
import type { log as Log } from "./log.ts";
import type { SettingsStore, SettingsWrite } from "./settings-store.ts";
import { generateVapidKeys } from "./web-push.ts";

/**
 * One term's view of the settings record (DESIGN.md, Scheduler, "Settings
 * record"): read once at the term's start, held in memory, and written only
 * through `update`, which serialises the term's own writes and keeps the held
 * copy in step with every one that lands. Nothing re-reads the record per use —
 * a sender asks `current()`.
 *
 * The record is created once, ever. A record that exists but cannot be used —
 * another PSK, a newer build's shape, a version below the floor, one that
 * vanished after it was seen — leaves the holder `unavailable` for the term and
 * is never written over: every push subscription is bound to the VAPID key in
 * it, and an unreadable record is not an absent one. Push is optional, so
 * `unavailable` costs only push.
 *
 * Never logs a record's content: one warning per term, naming only the reason.
 * Scheduler-free, as `settings-store.ts` is.
 */

export type SettingsLoad = "ready" | "unavailable";

export type SettingsUpdate =
  | { readonly ok: true; readonly record: SettingsRecord }
  | {
      readonly ok: false;
      readonly code: "conflict" | "unavailable" | "too_large" | "store_full" | "indeterminate" | "refused";
    };

export interface TermSettings {
  /**
   * Reads the record, creating it only when the store has none and the floor never saw one.
   * Rejects when the store could not be read, or a write was not confirmed: nothing was
   * decided, and calling it again is safe.
   */
  readonly load: () => Promise<SettingsLoad>;
  /** The held record; null until `load` is ready, and after the holder goes unavailable. */
  readonly current: () => SettingsRecord | null;
  /**
   * Applies `mutate` to the held record and writes the result at its version; `mutate` returns null
   * for no change (nothing is written, and the held record comes back). A conflict re-reads once and
   * applies `mutate` again; a second is `conflict`.
   */
  readonly update: (
    mutate: (record: SettingsRecord) => Omit<SettingsRecord, "version"> | null,
  ) => Promise<SettingsUpdate>;
}

export interface TermSettingsOpts {
  readonly store: SettingsStore;
  readonly term: number;
  readonly log: Pick<typeof Log, "warn">;
}

function body(record: SettingsRecord): Omit<SettingsRecord, "version"> {
  const { version: _version, ...rest } = record;
  return rest;
}

type PutFailure = Extract<SettingsWrite, { readonly ok: false }>["code"];

const UNAVAILABLE: SettingsUpdate = { ok: false, code: "unavailable" };

export function createTermSettings(o: TermSettingsOpts): TermSettings {
  let held: SettingsRecord | null = null;
  let warned = false;
  let loading: Promise<SettingsLoad> | null = null;
  let writes: Promise<unknown> = Promise.resolve();

  const hold = (record: SettingsRecord): SettingsLoad => {
    held = record;
    return "ready";
  };

  const giveUp = (reason: string): SettingsLoad => {
    held = null;
    if (!warned) {
      warned = true;
      o.log.warn(`scheduler: settings unavailable (${reason}) — push is off for term ${o.term}`);
    }
    return "unavailable";
  };

  /** A write at load that did not land and was not a lost race. */
  const failed = (code: PutFailure): SettingsLoad => {
    // Nothing is decided: the create may have committed, or a later try may get through.
    if (code === "indeterminate" || code === "rate_limited") {
      throw new Error(`settings: the write was not confirmed (${code})`);
    }
    return giveUp(`write ${code}`);
  };

  /** `first` is false on the one re-read after losing a race, which must not race again. */
  const read = async (first: boolean): Promise<SettingsLoad> => {
    const found = await o.store.get();
    if (found !== null && found.reason !== undefined) return giveUp(found.reason);
    if (found?.record.vapid !== undefined) return hold(found.record);
    if (!first) return giveUp(found === null ? "missing after a lost race" : "no VAPID key after a lost race");
    const vapid = await generateVapidKeys();
    // A record without a key (only a Linear-only one, which no writer makes yet) is given one at
    // its version, so a missing key does not turn push off for good.
    const base = found === null ? {} : body(found.record);
    const write = await o.store.put(found === null ? 0 : found.version, { ...base, vapid });
    if (write.ok) return hold({ ...base, vapid, version: write.version });
    if (write.code === "version_conflict") return read(false);
    return failed(write.code);
  };

  const load = (): Promise<SettingsLoad> => {
    loading ??= read(true).finally(() => {
      loading = null;
    });
    return loading;
  };

  const apply = async (
    mutate: (record: SettingsRecord) => Omit<SettingsRecord, "version"> | null,
  ): Promise<SettingsUpdate> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const base = held;
      if (base === null) return UNAVAILABLE;
      const next = mutate(base);
      if (next === null) return { ok: true, record: base };
      // oxlint-disable-next-line no-await-in-loop -- one retry, after a re-read
      const write = await o.store.put(base.version, next);
      if (write.ok) {
        const record = { ...next, version: write.version };
        held = record;
        return { ok: true, record };
      }
      if (write.code !== "version_conflict") {
        return { ok: false, code: write.code === "rate_limited" ? "refused" : write.code };
      }
      if (attempt === 1) break;
      // oxlint-disable-next-line no-await-in-loop -- the re-read the retry applies to
      const found = await o.store.get();
      if (found === null || found.reason !== undefined) {
        giveUp(found === null ? "missing after a conflict" : found.reason);
        return UNAVAILABLE;
      }
      held = found.record;
    }
    return { ok: false, code: "conflict" };
  };

  return {
    load,
    current: () => held,
    update: (mutate) => {
      // One writer per term: two updates racing would each conflict with the other's version.
      const run = writes.then(() => apply(mutate));
      writes = run.catch(() => undefined);
      return run;
    },
  };
}
