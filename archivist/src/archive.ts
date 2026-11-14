import { Database } from "bun:sqlite";
import { writeFile } from "node:fs/promises";
import {
  forgetPrompt,
  TASK_PHASES,
  type ArchivedMachine,
  type ArchiveTableStatus,
  type ArchiveTasksRequest,
  type Task,
} from "@seance/shared";

/**
 * `archive.sqlite`: the fleet's long-term history (DESIGN.md, Archivist, A16, A18,
 * A21, A23, A24). Append-only by construction — no statement here removes a row
 * (archivist/test/layering.test.ts holds that, and pins migration 2's one rebuild
 * drop, which moves rows), none lowers a task's version or
 * rewrites an event; a purge is SQL on the box. Times are ms since the epoch, as
 * the task record's own.
 */

/**
 * What a fleet event records (A18). `gone`: a machine that was up is not, whether
 * it disconnected or its entry left the registry. A machine already down when its
 * entry leaves writes none: its row's `in_registry` and `updated_at` say when.
 */
export const FLEET_EVENT_KINDS = ["first_seen", "connected", "gone", "build_changed", "term_changed"] as const;
export type FleetEventKind = (typeof FLEET_EVENT_KINDS)[number];

const kindList = FLEET_EVENT_KINDS.map((kind) => `'${kind}'`).join(", ");

/**
 * Entry `n` takes an archive at `PRAGMA user_version` n to n + 1, all in the
 * one transaction that opens it. History is never dropped by a migration: the
 * archive is the only copy of what the store has pruned. A table rebuild moves
 * its rows, count-checked, before the old table goes. Entries are frozen: each
 * builds the schema of its own version, never from a constant that moves later.
 */
const MIGRATIONS: readonly ((db: Database) => void)[] = [
  // 0 → 1: tasks, accounts, machines, fleet events, and the last verified term.
  (db) =>
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('done', 'failed', 'cancelled')),
        repo TEXT NOT NULL,
        title TEXT,
        created_at INTEGER NOT NULL,
        device_id TEXT,
        machine TEXT,
        account TEXT,
        pr_url TEXT,
        pr_state TEXT,
        done_by TEXT,
        failure TEXT,
        record TEXT NOT NULL,
        first_archived_at INTEGER NOT NULL,
        archived_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX tasks_created ON tasks (created_at);
      CREATE TABLE accounts (
        key TEXT PRIMARY KEY,
        alias TEXT,
        version INTEGER NOT NULL,
        first_seen_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE machines (
        device_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        build TEXT,
        connected INTEGER NOT NULL,
        in_registry INTEGER NOT NULL,
        first_seen_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (${kindList})),
        device_id TEXT NOT NULL,
        name TEXT,
        build TEXT,
        previous_build TEXT,
        term INTEGER,
        previous_term INTEGER
      ) STRICT;
      CREATE INDEX events_at ON events (at);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `),
  // 1 → 2: `superseded` joins `state`'s CHECK. SQLite cannot alter a CHECK, so the table is rebuilt: every row copied,
  // the count checked before the old table goes (a throw rolls the whole open back to schema 1), so the drop moves
  // rows and never removes one.
  (db) => {
    db.exec(`
      CREATE TABLE tasks_v2 (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('done', 'failed', 'cancelled', 'superseded')),
        repo TEXT NOT NULL,
        title TEXT,
        created_at INTEGER NOT NULL,
        device_id TEXT,
        machine TEXT,
        account TEXT,
        pr_url TEXT,
        pr_state TEXT,
        done_by TEXT,
        failure TEXT,
        record TEXT NOT NULL,
        first_archived_at INTEGER NOT NULL,
        archived_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO tasks_v2 (id, version, state, repo, title, created_at, device_id, machine, account, pr_url, pr_state,
          done_by, failure, record, first_archived_at, archived_at)
        SELECT id, version, state, repo, title, created_at, device_id, machine, account, pr_url, pr_state,
          done_by, failure, record, first_archived_at, archived_at
        FROM tasks;
    `);
    const count = (table: "tasks" | "tasks_v2"): number =>
      db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0;
    const held = count("tasks");
    const copied = count("tasks_v2");
    if (copied !== held) {
      throw new Error(`archive.sqlite migration 2 copied ${copied} of ${held} task rows — left at schema 1`);
    }
    db.exec(`
      DROP TABLE tasks;
      ALTER TABLE tasks_v2 RENAME TO tasks;
      CREATE INDEX tasks_created ON tasks (created_at);
    `);
  },
];

export const ARCHIVE_SCHEMA_VERSION = MIGRATIONS.length;

/** One task as the archive keeps it. `record` is `archivedTask`'s JSON. */
export interface TaskRow {
  readonly id: string;
  readonly version: number;
  readonly state: Task["state"];
  readonly repo: string;
  readonly title: string | null;
  readonly createdAt: number;
  readonly deviceId: string | null;
  readonly machine: string | null;
  readonly account: string | null;
  readonly prUrl: string | null;
  readonly prState: string | null;
  readonly doneBy: string | null;
  readonly failure: string | null;
  readonly record: string;
}

/** Resolved by the caller at archive time: names and keys the record itself does not carry. */
export interface TaskContext {
  /** The assigned machine's name, last known. */
  readonly machine: string | null;
  /** The HMAC'd `account:<hex>` store key of the account the task ran (or was pinned) under, never the raw id. */
  readonly account: string | null;
}

/**
 * A task as the archive may hold it: `forgetPrompt` (prompt and attachment
 * manifest gone, A14), and the two fields that carry a raw account id
 * (`spec.pin.account`, `spillAlert`) dropped, since the archive names an
 * account only by its store key (A15). Also gone is everything the daemon or
 * the router derives from prompt text, which the store prunes and the archive
 * would keep for good: `assignment.window` and `branch` (a title-less task's
 * slug is the prompt's first words), `failure.message` (a daemon's text, which
 * may name the worktree) and `decision` (a `skill_absent` reason carries a
 * `/skill` read off the prompt). `failure.code` and the placement stay.
 */
export function archivedTask(task: Task): Task {
  const {
    spillAlert: _spill,
    decision: _decision,
    branch: _branch,
    spec,
    assignment,
    failure,
    ...rest
  } = forgetPrompt(task);
  // Dropped again whatever the phase: `forgetPrompt` leaves an unfinished record's spec whole, and a stored row's JSON is not held to its `state` column.
  const { pin, prompt: _prompt, attachments: _attachments, ...specRest } = spec;
  const deviceId = pin?.deviceId;
  return {
    ...rest,
    spec: { ...specRest, ...(deviceId === undefined ? {} : { pin: { deviceId } }) },
    ...(assignment === undefined ? {} : { assignment: withoutWindow(assignment) }),
    ...(failure === undefined ? {} : { failure: { ...failure, message: "" } }),
  };
}

function withoutWindow(assignment: NonNullable<Task["assignment"]>): NonNullable<Task["assignment"]> {
  const { window: _window, ...rest } = assignment;
  return rest;
}

/** The row for a finished task (A16); null for any other, which the archive never keeps. */
export function taskRow(task: Task, version: number, context: TaskContext): TaskRow | null {
  if (TASK_PHASES[task.state] !== "finished") return null;
  return {
    id: task.id,
    version,
    state: task.state,
    repo: task.spec.repo,
    title: task.spec.title ?? null,
    createdAt: task.createdAt,
    deviceId: task.assignment?.deviceId ?? null,
    machine: context.machine,
    account: context.account,
    prUrl: task.prUrl ?? null,
    prState: task.pr?.state ?? null,
    doneBy: task.doneBy ?? null,
    failure: task.failure?.code ?? null,
    record: JSON.stringify(archivedTask(task)),
  };
}

/** One machine as the registry shows it now, the seat excluded by the caller. */
export interface FleetMachine {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  /** The running build's commit; null from a daemon outside git or one too old to say. */
  readonly build: string | null;
  readonly connected: boolean;
}

export interface Fleet {
  readonly machines: readonly FleetMachine[];
  /** A leader whose `lead-proof` verified (`SchedulerAvailability` `ready`); null otherwise. */
  readonly leader: { readonly deviceId: string; readonly term: number } | null;
}

interface MachineRow {
  readonly device_id: string;
  readonly name: string;
  readonly platform: string;
  readonly build: string | null;
  readonly connected: number;
  readonly in_registry: number;
}

const TERM_KEY = "scheduler_term";

/** A row of `queryTasks`: the stored record as text, parsed by the caller. */
export interface ArchivedRow {
  readonly id: string;
  readonly endedAt: number;
  readonly createdAt: number;
  readonly machine: string | null;
  readonly account: string | null;
  readonly alias: string | null;
  readonly record: string;
}

/**
 * `archive-tasks`'s filters, `?1`–`?7` in `queryTasks`'s order; each null
 * matches everything. `LIKE` folds ASCII case only.
 */
const TASK_FILTERS = `(?1 IS NULL OR t.repo = ?1) AND (?2 IS NULL OR t.state = ?2)
  AND (?3 IS NULL OR t.device_id = ?3) AND (?4 IS NULL OR t.account = ?4)
  AND (?5 IS NULL OR t.first_archived_at >= ?5) AND (?6 IS NULL OR t.first_archived_at < ?6)
  AND (?7 IS NULL OR t.title LIKE ?7 ESCAPE '\\')`;

/** `TASK_FILTERS`' bindings, in order. */
type TaskFilters = [
  repo: string | null,
  outcome: string | null,
  machine: string | null,
  account: string | null,
  since: number | null,
  until: number | null,
  title: string | null,
];

/** A title search is a substring, never a pattern: the wildcards and the escape itself match only themselves. */
function likeEscaped(text: string): string {
  return text.replaceAll(/[\\%_]/gu, (c) => `\\${c}`);
}

export class Archive {
  readonly #db: Database;

  private constructor(db: Database) {
    this.#db = db;
    try {
      this.#init(db);
    } catch (err) {
      db.close();
      throw err;
    }
  }

  #init(db: Database): void {
    // A purge or a read-write shell on the same file is expected (A23): wait briefly for its lock, not fail at once.
    db.exec("PRAGMA busy_timeout = 2000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
      // An older build would write rows a newer schema reads differently: refuse rather than guess.
      if (version > ARCHIVE_SCHEMA_VERSION) {
        throw new Error(
          `archive.sqlite is at schema ${version}, newer than this build's ${ARCHIVE_SCHEMA_VERSION} — update the archivist`,
        );
      }
      for (const migrate of MIGRATIONS.slice(version)) migrate(db);
      if (version < ARCHIVE_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${ARCHIVE_SCHEMA_VERSION}`);
    })();
  }

  /**
   * Owner-only, created at that mode before SQLite opens it: SQLite gives the
   * WAL and shared-memory files the database file's mode, as `metrics-store.ts` relies on.
   */
  static async open(path: string): Promise<Archive> {
    try {
      await writeFile(path, "", { mode: 0o600, flag: "wx" });
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
    }
    return new Archive(new Database(path, { create: false, strict: true }));
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Row counts and oldest times (ms) of the two tables the health card shows.
   * `min` is an index seek, but `count(*)` walks a whole index, synchronously. Fine
   * while `tasks` and `events` stay small; `events` has no retention, so if it grows
   * large count it in chunks over `at` as `MetricsArchive.countSamples` does.
   */
  counts(): { readonly tasks: ArchiveTableStatus; readonly events: ArchiveTableStatus } {
    const one = (sql: string): ArchiveTableStatus => {
      const row = this.#db.query<{ rows: number; oldest: number | null }, []>(sql).get();
      return { rows: row?.rows ?? 0, oldest: row?.oldest ?? null };
    };
    return {
      tasks: one("SELECT count(*) AS rows, min(created_at) AS oldest FROM tasks"),
      events: one("SELECT count(*) AS rows, min(at) AS oldest FROM events"),
    };
  }

  /**
   * One page of `archive-tasks` (A34), newest first by `first_archived_at` —
   * the record carries no finish time, so the archive's first sight of it
   * finished is the nearest — then `created_at`, then `id`, a keyset after
   * `before`. Every filter is a bound parameter of one fixed statement. `total`
   * counts every match, the cursor aside. A scan of `tasks`, which stays small
   * (one row per finished task); an index on the order key is the step if it
   * grows. `machine` is the assigned machine's last known name (A24).
   */
  queryTasks(
    request: ArchiveTasksRequest,
    limit: number,
  ): { readonly rows: readonly ArchivedRow[]; readonly total: number } {
    const filters: TaskFilters = [
      request.repo ?? null,
      request.outcome ?? null,
      request.machine ?? null,
      request.account ?? null,
      request.since ?? null,
      request.until ?? null,
      request.title === undefined ? null : `%${likeEscaped(request.title)}%`,
    ];
    const { before } = request;
    const rows = this.#db
      .query<ArchivedRow, [...TaskFilters, number | null, number | null, string | null, number]>(
        `SELECT t.id, t.first_archived_at AS endedAt, t.created_at AS createdAt,
           coalesce(m.name, t.machine) AS machine, t.account, a.alias, t.record
         FROM tasks t LEFT JOIN machines m ON m.device_id = t.device_id LEFT JOIN accounts a ON a.key = t.account
         WHERE ${TASK_FILTERS}
           AND (?8 IS NULL OR (t.first_archived_at, t.created_at, t.id) < (?8, ?9, ?10))
         ORDER BY t.first_archived_at DESC, t.created_at DESC, t.id DESC
         LIMIT ?11`,
      )
      .all(...filters, before?.endedAt ?? null, before?.createdAt ?? null, before?.id ?? null, limit);
    const total =
      this.#db
        .query<{ n: number }, TaskFilters>(`SELECT count(*) AS n FROM tasks t WHERE ${TASK_FILTERS}`)
        .get(...filters)?.n ?? 0;
    return { rows, total };
  }

  /**
   * Every machine the archive holds an assigned task for, so the app can offer
   * a retired machine no page read so far names (A24, A36h). Those off the
   * registry come first (the only ones the app lacks), then newest end, so a cut
   * at the cap drops live machines.
   * The name is the machines table's, else the newest row's (SQLite's bare
   * column beside a lone `max()` comes from that row). One aggregate scan of
   * `tasks`, which every page's `total` already pays; no index, since one would
   * be a migration on every existing archive for a table that stays small.
   */
  taskMachines(limit: number): readonly ArchivedMachine[] {
    return this.#db
      .query<ArchivedMachine, [number]>(
        `SELECT t.device_id AS deviceId, coalesce(m.name, t.machine) AS name, max(t.first_archived_at) AS lastSeen
         FROM tasks t LEFT JOIN machines m ON m.device_id = t.device_id
         WHERE t.device_id IS NOT NULL
         GROUP BY t.device_id
         ORDER BY coalesce(m.in_registry, 0), lastSeen DESC, t.device_id
         LIMIT ?1`,
      )
      .all(limit);
  }

  /** The archived version of a task, or null when the archive holds none. */
  taskVersion(id: string): number | null {
    return (
      this.#db.query<{ version: number }, [string]>("SELECT version FROM tasks WHERE id = ?").get(id)?.version ?? null
    );
  }

  /**
   * Writes the row when the archive holds none or holds it at a lower store
   * version (A16): a later PR reading lands, an older blob never wins. A name the
   * caller could not resolve this time keeps the one already held, and the account
   * is the first one resolved: a later reading never moves a task to the account
   * its exclave holds by then.
   */
  upsertTask(row: TaskRow, now: number): boolean {
    const result = this.#db
      .query(
        `INSERT INTO tasks (id, version, state, repo, title, created_at, device_id, machine, account, pr_url,
           pr_state, done_by, failure, record, first_archived_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           version = excluded.version, state = excluded.state, repo = excluded.repo, title = excluded.title,
           created_at = excluded.created_at, device_id = excluded.device_id,
           machine = coalesce(excluded.machine, tasks.machine), account = coalesce(tasks.account, excluded.account),
           pr_url = excluded.pr_url, pr_state = excluded.pr_state, done_by = excluded.done_by,
           failure = excluded.failure, record = excluded.record, archived_at = excluded.archived_at
         WHERE excluded.version > tasks.version`,
      )
      .run(
        row.id,
        row.version,
        row.state,
        row.repo,
        row.title,
        row.createdAt,
        row.deviceId,
        row.machine,
        row.account,
        row.prUrl,
        row.prState,
        row.doneBy,
        row.failure,
        row.record,
        now,
        now,
      );
    return result.changes > 0;
  }

  /** An `account:` record's alias at its store version; an older version never wins (A15: display only). */
  upsertAccount(key: string, alias: string | null, version: number, now: number): boolean {
    const result = this.#db
      .query(
        `INSERT INTO accounts (key, alias, version, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET alias = excluded.alias, version = excluded.version,
           updated_at = excluded.updated_at
         WHERE excluded.version > accounts.version`,
      )
      .run(key, alias, version, now, now);
    return result.changes > 0;
  }

  /** An account seen signed in on a machine, kept by key so its history outlives its record (A24). */
  noteAccount(key: string, now: number): void {
    this.#db
      .query(
        "INSERT OR IGNORE INTO accounts (key, alias, version, first_seen_at, updated_at) VALUES (?, NULL, 0, ?, ?)",
      )
      .run(key, now, now);
  }

  /** The last name the archive knows a machine by, retired ones included (A24). */
  machineName(deviceId: string): string | null {
    return (
      this.#db.query<{ name: string }, [string]>("SELECT name FROM machines WHERE device_id = ?").get(deviceId)?.name ??
      null
    );
  }

  /**
   * Compares the registry as it stands with what the archive last recorded and
   * appends one event per change (A18), in one transaction. The baseline is the
   * table, not memory, so a restart repeats no `first_seen`. A machine that
   * leaves the registry keeps its row and name (A24). Returns the events written.
   */
  applyFleet(fleet: Fleet, now: number): number {
    const db = this.#db;
    return db.transaction((): number => {
      let written = 0;
      const insertEvent = db.query(
        `INSERT INTO events (at, kind, device_id, name, build, previous_build, term, previous_term)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const event = (
        kind: FleetEventKind,
        deviceId: string,
        fields: {
          name?: string | null;
          build?: string | null;
          previousBuild?: string | null;
          term?: number;
          previousTerm?: number | null;
        } = {},
      ): void => {
        insertEvent.run(
          now,
          kind,
          deviceId,
          fields.name ?? null,
          fields.build ?? null,
          fields.previousBuild ?? null,
          fields.term ?? null,
          fields.previousTerm ?? null,
        );
        written += 1;
      };
      const known = new Map(
        db
          .query<MachineRow, []>("SELECT device_id, name, platform, build, connected, in_registry FROM machines")
          .all()
          .map((row) => [row.device_id, row]),
      );
      const upsert = db.query(
        `INSERT INTO machines (device_id, name, platform, build, connected, in_registry, first_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET name = excluded.name, platform = excluded.platform,
           build = coalesce(excluded.build, machines.build), connected = excluded.connected, in_registry = 1,
           updated_at = excluded.updated_at`,
      );
      const present = new Set<string>();
      for (const machine of fleet.machines) {
        present.add(machine.deviceId);
        const prior = known.get(machine.deviceId);
        const { name, build } = machine;
        if (prior === undefined) {
          event("first_seen", machine.deviceId, { name, build });
          if (machine.connected) event("connected", machine.deviceId, { name });
        } else {
          const wasUp = prior.in_registry === 1 && prior.connected === 1;
          if (machine.connected && !wasUp) event("connected", machine.deviceId, { name });
          if (!machine.connected && wasUp) event("gone", machine.deviceId, { name });
          if (build !== null && build !== prior.build) {
            event("build_changed", machine.deviceId, { name, build, previousBuild: prior.build });
          }
          const unchanged =
            prior.in_registry === 1 &&
            prior.name === name &&
            prior.platform === machine.platform &&
            (build === null || build === prior.build) &&
            (prior.connected === 1) === machine.connected;
          if (unchanged) continue;
        }
        upsert.run(machine.deviceId, name, machine.platform, build, machine.connected ? 1 : 0, now, now);
      }
      const retire = db.query("UPDATE machines SET connected = 0, in_registry = 0, updated_at = ? WHERE device_id = ?");
      for (const prior of known.values()) {
        if (prior.in_registry === 0 || present.has(prior.device_id)) continue;
        if (prior.connected === 1) event("gone", prior.device_id, { name: prior.name });
        retire.run(now, prior.device_id);
      }
      const { leader } = fleet;
      if (leader !== null) {
        const stored = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(TERM_KEY);
        const previousTerm = stored === null ? null : Number(stored.value);
        if (previousTerm !== leader.term) {
          event("term_changed", leader.deviceId, {
            name: fleet.machines.find((m) => m.deviceId === leader.deviceId)?.name ?? null,
            term: leader.term,
            previousTerm,
          });
          db.query(
            "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          ).run(TERM_KEY, String(leader.term));
        }
      }
      return written;
    })();
  }
}
