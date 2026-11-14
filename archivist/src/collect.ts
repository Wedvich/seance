import {
  accountStoreKey,
  STORE_PREFIXES,
  TASK_PHASES,
  type AccountListing,
  type AccountLookup,
  type Machine,
  type QueueChanged,
  type RelayState,
  type StoreRefusal,
  type Task,
  type TaskListing,
  type TaskLookup,
  type TaskRecord,
} from "@seance/shared";
import { isRowRefusal, taskRow, type Archive, type Fleet } from "./archive.ts";
import type { IngestClock } from "./ingest-clock.ts";

/**
 * The read slice of the shared app-role client the collector uses — reads and
 * listeners only, so nothing here can write the store or send an op. Every
 * record arrives already opened by the client's own readers (`openTaskRecord`
 * then `bindTaskRecord`; `openAccountRecord`), and what they could not read is
 * reported, never handed over (A13).
 */
export interface ArchiveSource {
  readonly getState: () => RelayState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly listTasks: () => Promise<TaskListing | StoreRefusal | null>;
  readonly getTask: (taskId: string) => Promise<TaskLookup | StoreRefusal | null>;
  readonly listAccounts: () => Promise<AccountListing | StoreRefusal | null>;
  readonly getAccountRecord: (key: string) => Promise<AccountLookup | StoreRefusal | null>;
  readonly onQueueChanged: (listener: (change: QueueChanged) => void) => () => void;
  readonly onStoreChanged: (listener: (key: string, version: number) => void) => () => void;
}

export interface CollectTimings {
  /**
   * Least time between two listings of one prefix. The relay lets a socket list
   * a prefix 4 times a minute (`MAX_LISTS_PER_WINDOW`) and every socket shares a
   * bucket of one per 8 s, so 20 s leaves room for the PWA and the CLIs.
   */
  readonly listGapMs: number;
  /** The catch-up listing when no nudge came: a missed `queue-changed` costs at most this. */
  readonly pollMs: number;
  /** After a refused or failed read. */
  readonly retryMs: number;
}

export const COLLECT_TIMINGS: CollectTimings = { listGapMs: 20_000, pollMs: 10 * 60_000, retryMs: 60_000 };

export interface CollectorOpts {
  readonly source: ArchiveSource;
  readonly archive: Archive;
  /** HMAC key `account:` records are filed under: the only way an account id enters the archive (A15). */
  readonly accountKey: CryptoKey;
  /** The seat's own id: never a machine (A9), whatever a registry says. */
  readonly selfId: string;
  readonly log: { readonly info: (line: string) => void; readonly warn: (line: string) => void };
  /** Noted when data lands (a listing or a get answered, a fleet written), never on an attempt. */
  readonly clock: IngestClock;
  readonly timings?: Partial<CollectTimings>;
}

export interface Collector {
  readonly stop: () => void;
}

/**
 * Runs `read` at most once per `gapMs`, coalescing kicks that land while one
 * runs or waits; a read that reports failure is tried again after `retryMs`.
 */
export class Paced {
  readonly #gapMs: number;
  readonly #retryMs: number;
  readonly #read: () => Promise<boolean>;
  #last = Number.NEGATIVE_INFINITY;
  #running = false;
  #again = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(gapMs: number, retryMs: number, read: () => Promise<boolean>) {
    this.#gapMs = gapMs;
    this.#retryMs = retryMs;
    this.#read = read;
  }

  kick(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    if (this.#timer !== null) return;
    const wait = this.#last + this.#gapMs - Date.now();
    if (wait > 0) {
      this.#arm(wait);
      return;
    }
    this.#running = true;
    this.#last = Date.now();
    void this.#read().then((ok) => {
      this.#running = false;
      if (!ok) this.#arm(this.#retryMs);
      else if (this.#again) {
        this.#again = false;
        this.kick();
      }
    });
  }

  #arm(ms: number): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.kick();
    }, ms);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

/** The registry as the archive records it: decrypted machines only, never the seat, and only a verified leader. */
export function fleetOf(state: RelayState, selfId: string): Fleet {
  const machines = state.machines
    .filter((machine) => machine.deviceId !== selfId)
    .map((machine) => ({
      deviceId: machine.deviceId,
      name: machine.name,
      platform: machine.platform,
      build: machine.source?.sha ?? null,
      connected: machine.connected,
    }));
  const { scheduler } = state;
  return {
    machines,
    leader: scheduler.kind === "ready" ? { deviceId: scheduler.deviceId, term: scheduler.term } : null,
  };
}

/**
 * The archivist's collection over its app leg (DESIGN.md, Archivist, A13–A16,
 * A18): finished tasks and account aliases from the store, fleet events from
 * the registry. Read-only on the wire: it lists and gets, and writes only
 * `archive.sqlite`. A record it cannot read is counted and skipped; one that
 * leaves the store leaves its row as it was.
 */
export function startCollector(opts: CollectorOpts): Collector {
  const { source, archive, accountKey, selfId, log, clock } = opts;
  const timings = { ...COLLECT_TIMINGS, ...opts.timings };
  let stopped = false;
  const accountKeys = new Map<string, Promise<string>>();
  const noted = new Set<string>();

  const keyOf = (accountId: string): Promise<string> => {
    let key = accountKeys.get(accountId);
    if (key === undefined) {
      key = accountStoreKey(accountKey, accountId);
      accountKeys.set(accountId, key);
    }
    return key;
  };

  const machineOf = (deviceId: string): Machine | undefined =>
    source.getState().machines.find((machine) => machine.deviceId === deviceId);

  /** Where it ran, else where it was pinned: resolved now, so the account that exclave holds when archived. */
  const accountOf = async (task: Task): Promise<string | null> => {
    const placed = task.assignment;
    const accountId =
      (placed === undefined
        ? undefined
        : machineOf(placed.deviceId)?.exclaves?.find((exclave) => exclave.id === placed.exclave)?.accountId) ??
      task.spec.pin?.account;
    return accountId === undefined || accountId === null ? null : keyOf(accountId);
  };

  /** `seenAt` is the pass's one clock reading, so a listing's backfill ties on end time and `created_at`, `id` order it. */
  const archiveTask = async ({ task, version }: TaskRecord, seenAt: number): Promise<boolean> => {
    if (TASK_PHASES[task.state] !== "finished") return false;
    const held = archive.taskVersion(task.id);
    if (held !== null && held >= version) return false;
    const deviceId = task.assignment?.deviceId;
    const machine =
      deviceId === undefined ? null : (machineOf(deviceId)?.name ?? archive.machineName(deviceId) ?? null);
    const account = await accountOf(task);
    const row = taskRow(task, version, { machine, account });
    // Checked after the await: a stop in between closes the database.
    if (stopped || row === null) return false;
    return archive.upsertTask(row, seenAt);
  };

  /**
   * A row SQLite refuses skips that task and the pass goes on, counted in one warning per pass: a schema refusal
   * does not heal on retry, and one record must not keep every later one out. Any other failure ends the pass.
   * The warning carries SQLite's message (schema text) and a count, nothing of a record.
   */
  const refusals = (): {
    readonly archive: (record: TaskRecord, seenAt: number) => Promise<boolean>;
    readonly report: () => void;
  } => {
    let count = 0;
    let first = "";
    return {
      archive: async (record, seenAt) => {
        try {
          return await archiveTask(record, seenAt);
        } catch (err) {
          if (!isRowRefusal(err)) throw err;
          count += 1;
          if (count === 1) first = err.message;
          return false;
        }
      },
      report: () => {
        if (count > 0 && !stopped) log.warn(`tasks: ${count} not archived: ${first}`);
      },
    };
  };

  /** One read, its failure logged; false asks the pacer to retry. Never throws. */
  const guarded = async (what: string, read: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await read();
    } catch (err) {
      if (!stopped) log.warn(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const refusal = (what: string, answer: StoreRefusal | null): false => {
    log.warn(answer === null ? `${what}: a reply this build cannot read` : `${what} refused: ${answer.code}`);
    return false;
  };

  const tasks = new Paced(timings.listGapMs, timings.retryMs, () =>
    guarded("task listing", async () => {
      const answer = await source.listTasks();
      if (answer === null || !answer.ok) return refusal("task listing", answer);
      let archived = 0;
      const seenAt = Date.now();
      const refused = refusals();
      for (const record of answer.tasks) {
        // oxlint-disable-next-line no-await-in-loop -- sequential: each may HMAC an account, and order is the listing's
        if (await refused.archive(record, seenAt)) archived += 1;
      }
      refused.report();
      clock.note("store");
      if (archived > 0 || answer.unreadable.length > 0) {
        log.info(`tasks: archived ${archived}, skipped ${answer.unreadable.length} unreadable`);
      }
      return true;
    }),
  );

  const accounts = new Paced(timings.listGapMs, timings.retryMs, () =>
    guarded("account listing", async () => {
      const answer = await source.listAccounts();
      if (answer === null || !answer.ok) return refusal("account listing", answer);
      if (stopped) return true;
      const now = Date.now();
      for (const { key, record } of answer.accounts) archive.upsertAccount(key, record.alias, record.version, now);
      clock.note("store");
      if (answer.unreadable.length > 0) log.info(`accounts: skipped ${answer.unreadable.length} unreadable`);
      return true;
    }),
  );

  let ready = false;
  const readNamed = async (ids: readonly string[]): Promise<void> => {
    const ok = await guarded("task read", async () => {
      let archived = 0;
      const refused = refusals();
      try {
        for (const id of ids) {
          if (stopped) return true;
          // oxlint-disable-next-line no-await-in-loop -- one store-get at a time, by design
          const answer = await source.getTask(id);
          if (answer === null || !answer.ok) return refusal("task read", answer);
          clock.note("store");
          const found = answer.task;
          // Null: gone from the store (pruned, or never there) — its row, if any, stays as it was.
          if (found === null) continue;
          if ("reason" in found) {
            log.info(`tasks: skipped 1 unreadable (${found.reason})`);
            continue;
          }
          // oxlint-disable-next-line no-await-in-loop -- as above
          if (await refused.archive(found, Date.now())) archived += 1;
        }
      } finally {
        refused.report();
      }
      if (archived > 0) log.info(`tasks: archived ${archived}`);
      return true;
    });
    // A failed get falls back to the paced listing, which covers the same records.
    if (!ok) tasks.kick();
  };
  // Named ids wait in a set one worker drains, a batch at a time: a burst of nudges, or a slow relay, reads each
  // task once per round, never once per nudge.
  const named = new Set<string>();
  let draining = false;
  const drainNamed = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (named.size > 0) {
        if (stopped) return;
        const ids = [...named];
        named.clear();
        // oxlint-disable-next-line no-await-in-loop -- one batch at a time, by design
        await readNamed(ids);
      }
    } finally {
      draining = false;
    }
  };

  const onQueueChanged = (change: QueueChanged): void => {
    if (stopped) return;
    if (change.tasks === undefined) {
      tasks.kick();
      return;
    }
    // Before the registry settles no machine resolves, so an account would be missed; the listing at ready covers these.
    if (!ready) return;
    for (const id of change.tasks) named.add(id);
    void drainNamed();
  };

  const onStoreChanged = (key: string): void => {
    // Relay plaintext: only a hint to re-read through the record's own reader, which re-checks the key.
    if (stopped || !key.startsWith(STORE_PREFIXES.account.prefix)) return;
    changedAccounts.add(key);
    void drainAccounts();
  };

  const readAccount = (key: string): Promise<boolean> =>
    guarded("account read", async () => {
      const answer = await source.getAccountRecord(key);
      if (answer === null || !answer.ok) return refusal("account read", answer);
      const { entry } = answer;
      clock.note("store");
      if (entry === null || stopped) return true;
      if ("reason" in entry) {
        log.info(`accounts: skipped 1 unreadable (${entry.reason})`);
        return true;
      }
      archive.upsertAccount(answer.key, entry.alias, entry.version, Date.now());
      return true;
    });

  // As the named tasks: coalesced per key, one get at a time. A failed one falls back to the paced listing.
  const changedAccounts = new Set<string>();
  let drainingAccounts = false;
  const drainAccounts = async (): Promise<void> => {
    if (drainingAccounts) return;
    drainingAccounts = true;
    try {
      while (changedAccounts.size > 0) {
        if (stopped) return;
        const keys = [...changedAccounts];
        changedAccounts.clear();
        for (const key of keys) {
          // oxlint-disable-next-line no-await-in-loop -- one store-get at a time, by design
          if (!(await readAccount(key))) accounts.kick();
        }
      }
    } finally {
      drainingAccounts = false;
    }
  };

  let lastMachines: RelayState["machines"] | null = null;
  let lastScheduler: RelayState["scheduler"] | null = null;
  const onState = (): void => {
    if (stopped) return;
    const state = source.getState();
    // Before the registry settles an empty list means "no push yet", never "every machine left".
    const nowReady = state.status === "open" && state.registrySettled;
    if (!nowReady) {
      ready = false;
      return;
    }
    if (!ready) {
      ready = true;
      // Each (re)open catches up on what changed while the leg was down.
      tasks.kick();
      accounts.kick();
    }
    if (state.machines === lastMachines && state.scheduler === lastScheduler) return;
    // The baseline moves only once the write lands: a locked or full disk is tried again on the next change.
    try {
      const events = archive.applyFleet(fleetOf(state, selfId), Date.now());
      lastMachines = state.machines;
      lastScheduler = state.scheduler;
      clock.note("registry");
      if (events > 0) log.info(`fleet: ${events} event${events === 1 ? "" : "s"}`);
    } catch (err) {
      // A throw here would leave the shared client's listener loop and, on a registry push, kill the process.
      log.warn(`fleet write: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    noteAccounts(state.machines).catch((err: unknown) => {
      if (stopped) return;
      lastMachines = null;
      log.warn(`account note: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  /** Accounts signed in somewhere, kept by key so a removed one's rows still name a key (A24). */
  const noteAccounts = async (machines: readonly Machine[]): Promise<void> => {
    const ids = machines
      .filter((machine) => machine.deviceId !== selfId)
      .flatMap((machine) => (machine.exclaves ?? []).map((exclave) => exclave.accountId))
      .filter((accountId): accountId is string => accountId !== null);
    const keys = await Promise.all(ids.map(keyOf));
    if (stopped) return;
    const now = Date.now();
    for (const key of keys) {
      if (noted.has(key)) continue;
      // After the write: a key that failed to land is tried again on the next registry change.
      archive.noteAccount(key, now);
      noted.add(key);
    }
  };

  const unsubscribers = [
    source.subscribe(onState),
    source.onQueueChanged(onQueueChanged),
    source.onStoreChanged(onStoreChanged),
  ];
  const poll = setInterval(() => {
    if (!ready) return;
    tasks.kick();
    accounts.kick();
  }, timings.pollMs);
  onState();

  return {
    stop: (): void => {
      stopped = true;
      clearInterval(poll);
      for (const unsubscribe of unsubscribers) unsubscribe();
      tasks.stop();
      accounts.stop();
    },
  };
}
