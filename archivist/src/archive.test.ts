import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCHIVE_TASK_OUTCOMES, parseTask, statesIn, type ArchiveTasksRequest, type Task } from "@seance/shared";
import {
  Archive,
  ARCHIVE_SCHEMA_VERSION,
  ARCHIVED_SUCCEEDS_ACCOUNT,
  archivedTask,
  taskRow,
  type Fleet,
  type FleetMachine,
  type TaskContext,
} from "./archive.ts";

const RAW_ACCOUNT = "11111111-2222-3333-4444-555555555555:66666666-7777-8888-9999-000000000000";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    spec: {
      repo: "seance",
      mode: "worktree",
      prompt: "PROMPT-TEXT do the thing",
      title: "Do the thing",
      attachments: [{ id: "a".repeat(32), name: "secret-plan.png", type: "image/png", size: 3, hash: "h".repeat(43) }],
      pin: { deviceId: "dev-a", account: RAW_ACCOUNT },
    },
    state: "done",
    createdAt: 1_000,
    assignment: { deviceId: "dev-a", exclave: "default", clone: "seance" },
    spillAlert: { accountId: RAW_ACCOUNT, window: "5h", reset: 0, at: 2_000 },
    prUrl: "https://github.com/o/r/pull/1",
    pr: { state: "open", at: 2_000 },
    doneBy: "session",
    ...over,
  };
}

const context = { machine: "alpha", account: "account:abc" };

let dir: string;
let path: string;
let archive: Archive;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "archive-"));
  path = join(dir, "archive.sqlite");
  archive = await Archive.open(path);
});

afterEach(async () => {
  archive.close();
  await rm(dir, { recursive: true, force: true });
});

function rows<T>(sql: string): T[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<T, []>(sql).all();
  } finally {
    db.close();
  }
}

describe("archive.sqlite", () => {
  test("is created 0600, in WAL mode, at the current schema, and reopens with its rows", async () => {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const row = taskRow(task(), 2, context);
    if (row === null) throw new Error("finished task refused");
    expect(archive.upsertTask(row, 10)).toBe(true);
    archive.close();
    archive = await Archive.open(path);
    expect(archive.taskVersion("t-1")).toBe(2);
    expect(rows<{ journal_mode: string }>("PRAGMA journal_mode")[0]?.journal_mode).toBe("wal");
    expect(rows<{ user_version: number }>("PRAGMA user_version")[0]?.user_version).toBe(ARCHIVE_SCHEMA_VERSION);
    expect((await stat(`${path}-wal`)).mode & 0o777).toBe(0o600);
  });

  test("a schema-1 archive upgrades in place: every row and column kept, the index rebuilt, superseded admitted", async () => {
    archive.close();
    await rm(path);
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
    const old = new Database(path, { strict: true });
    // Schema 1 as migration 0 → 1 wrote it: the old file's frozen shape is what this test is about.
    old.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('done', 'failed', 'cancelled')),
        repo TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL, device_id TEXT, machine TEXT, account TEXT,
        pr_url TEXT, pr_state TEXT, done_by TEXT, failure TEXT, record TEXT NOT NULL,
        first_archived_at INTEGER NOT NULL, archived_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX tasks_created ON tasks (created_at);
      CREATE TABLE accounts (key TEXT PRIMARY KEY, alias TEXT, version INTEGER NOT NULL,
        first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE machines (device_id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, build TEXT,
        connected INTEGER NOT NULL, in_registry INTEGER NOT NULL, first_seen_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('first_seen', 'connected', 'gone', 'build_changed', 'term_changed')),
        device_id TEXT NOT NULL, name TEXT, build TEXT, previous_build TEXT, term INTEGER, previous_term INTEGER) STRICT;
      CREATE INDEX events_at ON events (at);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO tasks VALUES ('t-full', 3, 'done', 'seance', 'Full', 100, 'dev-a', 'alpha', 'account:abc',
        'https://github.com/o/r/pull/1', 'merged', 'merged', NULL, '{"id":"t-full"}', 200, 300);
      INSERT INTO tasks VALUES ('t-bare', 1, 'failed', 'seance', NULL, 50, NULL, NULL, NULL,
        NULL, NULL, NULL, 'dispatch_unconfirmed', '{"id":"t-bare"}', 60, 60);
      INSERT INTO events (at, kind, device_id) VALUES (5, 'first_seen', 'dev-a');
      INSERT INTO tasks VALUES ('t-hand', 1, 'cancelled', 'seance', NULL, 70, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, 'not json {', 80, 80);
      PRAGMA user_version = 1;
    `);
    // Schema 1 kept a successor's raw `succeeds.account`.
    const succeeds = { task: "t-full", account: RAW_ACCOUNT, at: { deviceId: "dev-a", exclave: "x", clone: "c" } };
    // And an older or foreign write could leave a quota stamp, whose `accountId` is one too.
    const quotaExhausted = { accountId: RAW_ACCOUNT, window: "5h", reset: 0, at: 1, since: 1 };
    const successor = {
      id: "t-succ",
      quotaExhausted,
      spec: { repo: "seance", mode: "worktree", succeeds: { ...succeeds, trigger: "pass" } },
    };
    old
      .query(
        `INSERT INTO tasks VALUES ('t-succ', 2, 'done', 'seance', NULL, 90, 'dev-b', 'beta', 'account:def',
          NULL, NULL, 'session', NULL, ?, 95, 99)`,
      )
      .run(JSON.stringify(successor));
    type Row = Record<string, unknown> & { id: string; record: string };
    const all = (db: Database): Row[] => db.query<Row, []>("SELECT * FROM tasks ORDER BY id").all();
    const before = all(old);
    old.close();

    archive = await Archive.open(path);
    expect(rows<{ user_version: number }>("PRAGMA user_version")[0]?.user_version).toBe(ARCHIVE_SCHEMA_VERSION);
    const after = new Database(path, { readonly: true });
    try {
      const upgraded = all(after);
      // Every column of every row as it was, but the successor's raw account id, which is now the placeholder.
      expect(upgraded.map(({ record: _r, ...rest }) => rest)).toEqual(before.map(({ record: _r, ...rest }) => rest));
      const records = new Map(upgraded.map((row) => [row.id, row.record]));
      for (const row of before) {
        if (row.id !== "t-succ") expect(records.get(row.id)).toBe(row.record);
      }
      const record = records.get("t-succ") ?? "";
      expect(record).not.toContain(RAW_ACCOUNT);
      const { quotaExhausted: _quota, ...kept } = successor;
      expect(JSON.parse(record)).toEqual({
        ...kept,
        spec: { ...successor.spec, succeeds: { ...successor.spec.succeeds, account: ARCHIVED_SUCCEEDS_ACCOUNT } },
      });
    } finally {
      after.close();
    }
    expect(
      rows<{ name: string; tbl_name: string }>("SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index'"),
    ).toContainEqual({ name: "tasks_created", tbl_name: "tasks" });
    expect(rows<{ name: string }>("SELECT name FROM sqlite_schema WHERE name = 'tasks_v2'")).toEqual([]);
    // The rebuilt tables are the ones a fresh archive makes (STRICT, the CHECK and every column included).
    const schemaSql = "SELECT name, sql FROM sqlite_schema WHERE name IN ('tasks', 'tasks_created') ORDER BY name";
    const fresh = await Archive.open(join(dir, "fresh.sqlite"));
    fresh.close();
    const freshDb = new Database(join(dir, "fresh.sqlite"), { readonly: true });
    try {
      expect(rows(schemaSql)).toEqual(freshDb.query(schemaSql).all());
    } finally {
      freshDb.close();
    }
    // The freed pages and the WAL no longer hold the raw id either (`secure_delete`, then a checkpoint).
    archive.close();
    for (const file of [path, `${path}-wal`]) {
      const bytes = await Bun.file(file)
        .bytes()
        .catch(() => new Uint8Array());
      expect(Buffer.from(bytes).includes(RAW_ACCOUNT)).toBe(false);
    }
    archive = await Archive.open(path);
    expect(rows<{ n: number }>("SELECT count(*) AS n FROM events")[0]?.n).toBe(1);
    const superseded = taskRow(task({ id: "t-passed", state: "superseded" }), 2, context);
    if (superseded === null) throw new Error("superseded refused");
    expect(archive.upsertTask(superseded, 400)).toBe(true);
    expect(archive.counts().tasks.rows).toBe(5);
  });

  test("refuses a file at a schema newer than this build", async () => {
    archive.close();
    const db = new Database(path);
    db.exec(`PRAGMA user_version = ${ARCHIVE_SCHEMA_VERSION + 1}`);
    db.close();
    await expect(Archive.open(path)).rejects.toThrow(/newer than this build/u);
    archive = await Archive.open(join(dir, "other.sqlite"));
  });
});

describe("task rows", () => {
  test("only a finished task has a row", () => {
    for (const state of ["queued", "running", "awaiting-merge", "lost"] as const) {
      expect(taskRow(task({ state }), 2, context)).toBeNull();
    }
    for (const state of ["done", "failed", "cancelled"] as const) {
      expect(taskRow(task({ state }), 2, context)?.state).toBe(state);
    }
  });

  test("every finished state is written to SQLite and found by its outcome filter", () => {
    for (const state of statesIn("finished")) {
      const row = taskRow(task({ id: `t-${state}`, state }), 2, context);
      if (row === null) throw new Error(`${state} refused`);
      expect(archive.upsertTask(row, 10)).toBe(true);
    }
    for (const outcome of ARCHIVE_TASK_OUTCOMES) {
      expect(archive.queryTasks({ outcome }, 10).rows.map((r) => r.id)).toEqual([`t-${outcome}`]);
    }
  });

  test("a row holds no prompt, no attachment manifest and no raw account id", () => {
    const row = taskRow(task(), 2, context);
    expect(row).not.toBeNull();
    const text = JSON.stringify(row);
    expect(text).not.toContain("PROMPT-TEXT");
    expect(text).not.toContain("secret-plan");
    expect(text).not.toContain(RAW_ACCOUNT);
    const kept = archivedTask(task());
    expect(kept.spec.pin).toEqual({ deviceId: "dev-a" });
    expect(kept.spillAlert).toBeUndefined();
    const stamped = archivedTask(
      task({ quotaExhausted: { accountId: RAW_ACCOUNT, window: "5h", reset: 0, at: 1, since: 1 } }),
    );
    expect(stamped.quotaExhausted).toBeUndefined();
    expect(archivedTask(task({ spec: { repo: "r", mode: "here", pin: { account: RAW_ACCOUNT } } })).spec.pin).toBe(
      undefined,
    );
    expect(row).toMatchObject({ repo: "seance", title: "Do the thing", deviceId: "dev-a", prState: "open" });
  });

  test("a successor keeps its lineage but not its predecessor's raw account id, and still parses as a task", () => {
    const succeeds = {
      task: "t-0",
      account: RAW_ACCOUNT,
      at: { deviceId: "dev-z", exclave: "default", clone: "seance" },
      trigger: "quota" as const,
      since: 500,
    };
    const successor = task({
      id: "t-next",
      state: "superseded",
      successor: "t-after",
      spec: { ...task().spec, pin: undefined, succeeds },
    });
    const row = taskRow(successor, 2, context);
    if (row === null) throw new Error("superseded refused");
    expect(row.record).not.toContain(RAW_ACCOUNT);
    expect(archive.upsertTask(row, 10)).toBe(true);
    const [stored] = archive.queryTasks({ outcome: "superseded" }, 10).rows;
    const parsed = parseTask(JSON.parse(stored?.record ?? "null"));
    expect(parsed?.spec.succeeds).toEqual({ ...succeeds, account: ARCHIVED_SUCCEEDS_ACCOUNT });
    expect(parsed?.successor).toBe("t-after");
  });

  test("a record not in a finished state still loses its prompt and attachment manifest", () => {
    const { spec } = archivedTask(task({ state: "running" }));
    expect(spec.prompt).toBeUndefined();
    expect(spec.attachments).toBeUndefined();
  });

  test("nothing the prompt names reaches the record: no window, branch, failure message or routing decision", () => {
    const slug = "rotate-the-prod-stripe-key-in-kv-foo-and";
    const text = JSON.stringify(
      archivedTask(
        task({
          state: "failed",
          spec: { repo: "seance", mode: "worktree", prompt: "PROMPT-TEXT rotate the prod stripe key" },
          assignment: { deviceId: "dev-a", exclave: "default", clone: "seance", window: slug, pane: "%3" },
          branch: `worktree-${slug}`,
          failure: { code: "session_failed", message: `exited in /w/.claude/worktrees/${slug}`, exit: 1 },
          decision: {
            at: 1,
            chosen: { deviceId: "dev-a", exclave: "default", clone: "seance" },
            candidates: [
              { deviceId: "dev-b", machine: "b", exclave: null, rejected: [{ code: "skill_absent", skill: slug }] },
            ],
          },
        }),
      ),
    );
    expect(text).not.toContain(slug);
    expect(text).toContain("session_failed");
    expect(text).toContain('"pane":"%3"');
    expect(taskRow(task({ state: "failed", failure: { code: "x", message: "m" } }), 2, context)?.failure).toBe("x");
  });

  test("a task keeps the account first resolved; a later reading never moves it", () => {
    const at = (version: number, account: string | null) => {
      const row = taskRow(task(), version, { machine: "alpha", account });
      if (row === null) throw new Error("finished task refused");
      return row;
    };
    expect(archive.upsertTask(at(2, null), 10)).toBe(true);
    expect(archive.upsertTask(at(3, "account:first"), 11)).toBe(true);
    expect(archive.upsertTask(at(4, "account:later"), 12)).toBe(true);
    expect(rows<{ account: string }>("SELECT account FROM tasks")).toEqual([{ account: "account:first" }]);
  });

  test("upserts only at a higher store version, and a vanished record's row stays as it was", () => {
    const at = (version: number, over: Partial<Task> = {}) => {
      const row = taskRow(task(over), version, context);
      if (row === null) throw new Error("finished task refused");
      return row;
    };
    expect(archive.upsertTask(at(2), 10)).toBe(true);
    expect(archive.upsertTask(at(2, { pr: { state: "merged", at: 3_000 } }), 11)).toBe(false);
    expect(archive.upsertTask(at(3, { pr: { state: "merged", at: 3_000 } }), 12)).toBe(true);
    expect(archive.upsertTask(at(2), 13)).toBe(false);
    // A later reading whose machine could not be resolved keeps the name already held.
    const unresolved = taskRow(task({ pr: { state: "merged", at: 4_000 } }), 4, { machine: null, account: null });
    if (unresolved === null) throw new Error("finished task refused");
    expect(archive.upsertTask(unresolved, 14)).toBe(true);
    const [row] = rows<{
      version: number;
      pr_state: string;
      machine: string;
      account: string;
      first_archived_at: number;
    }>("SELECT version, pr_state, machine, account, first_archived_at FROM tasks");
    expect(row).toEqual({
      version: 4,
      pr_state: "merged",
      machine: "alpha",
      account: "account:abc",
      first_archived_at: 10,
    });
  });
});

describe("accounts", () => {
  test("keyed by store key; an alias moves only forward; a noted account never clobbers one", () => {
    archive.noteAccount("account:k1", 1);
    expect(archive.upsertAccount("account:k1", "Work", 1, 2)).toBe(true);
    archive.noteAccount("account:k1", 3);
    expect(archive.upsertAccount("account:k1", "Old", 1, 4)).toBe(false);
    expect(archive.upsertAccount("account:k1", null, 2, 5)).toBe(true);
    archive.noteAccount("account:k2", 6);
    expect(
      rows<{ key: string; alias: string | null; version: number }>(
        "SELECT key, alias, version FROM accounts ORDER BY key",
      ),
    ).toEqual([
      { key: "account:k1", alias: null, version: 2 },
      { key: "account:k2", alias: null, version: 0 },
    ]);
  });
});

describe("fleet events", () => {
  const machine = (over: Partial<FleetMachine> = {}): FleetMachine => ({
    deviceId: "dev-a",
    name: "alpha",
    platform: "linux",
    build: "sha1",
    connected: true,
    ...over,
  });
  const fleet = (machines: readonly FleetMachine[], leader: Fleet["leader"] = null): Fleet => ({ machines, leader });
  const events = (): {
    kind: string;
    device_id: string;
    name: string | null;
    build: string | null;
    previous_build: string | null;
    term: number | null;
    previous_term: number | null;
  }[] => rows("SELECT kind, device_id, name, build, previous_build, term, previous_term FROM events ORDER BY id");

  test("first sight, connect, gone, build change and retirement each append one event; nothing else does", () => {
    expect(
      archive.applyFleet(fleet([machine(), machine({ deviceId: "dev-b", name: "beta", connected: false })]), 1),
    ).toBe(3);
    // Unchanged: no event, however often the registry pushes.
    expect(
      archive.applyFleet(fleet([machine(), machine({ deviceId: "dev-b", name: "beta", connected: false })]), 2),
    ).toBe(0);
    expect(
      archive.applyFleet(fleet([machine({ connected: false }), machine({ deviceId: "dev-b", name: "beta" })]), 3),
    ).toBe(2);
    expect(
      archive.applyFleet(
        fleet([machine({ build: "sha2", connected: false }), machine({ deviceId: "dev-b", name: "beta" })]),
        4,
      ),
    ).toBe(1);
    // A daemon that stops saying its build is not a build change.
    expect(
      archive.applyFleet(
        fleet([machine({ build: null, connected: false }), machine({ deviceId: "dev-b", name: "beta" })]),
        5,
      ),
    ).toBe(0);
    // dev-b leaves the registry while connected: gone, and its row stays with its last name.
    expect(archive.applyFleet(fleet([machine({ build: "sha2", connected: false })]), 6)).toBe(1);
    expect(archive.machineName("dev-b")).toBe("beta");
    expect(events().map((e) => `${e.kind}:${e.device_id}`)).toEqual([
      "first_seen:dev-a",
      "connected:dev-a",
      "first_seen:dev-b",
      "gone:dev-a",
      "connected:dev-b",
      "build_changed:dev-a",
      "gone:dev-b",
    ]);
    expect(events()[5]).toMatchObject({ build: "sha2", previous_build: "sha1" });
    // Back in the registry: no second first_seen.
    expect(
      archive.applyFleet(
        fleet([machine({ build: "sha2", connected: false }), machine({ deviceId: "dev-b", name: "beta-2" })]),
        7,
      ),
    ).toBe(1);
    expect(events().at(-1)).toMatchObject({ kind: "connected", device_id: "dev-b", name: "beta-2" });
  });

  test("a restart reads its baseline from the file, so it repeats no first_seen", async () => {
    archive.applyFleet(fleet([machine()]), 1);
    archive.close();
    archive = await Archive.open(path);
    expect(archive.applyFleet(fleet([machine()]), 2)).toBe(0);
  });

  test("a term change appends one event naming the new leader, only when the verified term moves", () => {
    expect(archive.applyFleet(fleet([machine()], { deviceId: "dev-a", term: 4 }), 1)).toBe(3);
    expect(archive.applyFleet(fleet([machine()], { deviceId: "dev-a", term: 4 }), 2)).toBe(0);
    expect(archive.applyFleet(fleet([machine()], null), 3)).toBe(0);
    expect(archive.applyFleet(fleet([machine()], { deviceId: "dev-a", term: 6 }), 4)).toBe(1);
    expect(events().filter((e) => e.kind === "term_changed")).toEqual([
      {
        kind: "term_changed",
        device_id: "dev-a",
        name: "alpha",
        build: null,
        previous_build: null,
        term: 4,
        previous_term: null,
      },
      {
        kind: "term_changed",
        device_id: "dev-a",
        name: "alpha",
        build: null,
        previous_build: null,
        term: 6,
        previous_term: 4,
      },
    ]);
  });
});

describe("counts", () => {
  test("an empty archive has no rows and no oldest", () => {
    expect(archive.counts()).toEqual({ tasks: { rows: 0, oldest: null }, events: { rows: 0, oldest: null } });
  });

  test("rows and the oldest time (ms) of tasks and events", () => {
    for (const [id, createdAt] of [
      ["t-1", 5_000],
      ["t-2", 3_000],
    ] as const) {
      const row = taskRow(task({ id, createdAt }), 2, context);
      if (row === null) throw new Error("finished task refused");
      archive.upsertTask(row, 10);
    }
    archive.applyFleet(
      {
        machines: [{ deviceId: "dev-a", name: "alpha", platform: "linux", build: "sha1", connected: true }],
        leader: null,
      },
      7_000,
    );
    expect(archive.counts()).toEqual({
      tasks: { rows: 2, oldest: 3_000 },
      events: { rows: 2, oldest: 7_000 },
    });
  });
});

describe("queryTasks", () => {
  const KEY = "account:def";

  function put(id: string, archivedAt: number, over: Partial<Task> = {}, ctx: TaskContext = context): void {
    const row = taskRow(task({ id, createdAt: 1_000, ...over }), 1, ctx);
    if (row === null) throw new Error("finished task refused");
    archive.upsertTask(row, archivedAt);
  }

  function titled(title?: string): Partial<Task> {
    return { spec: { repo: "seance", mode: "worktree", ...(title === undefined ? {} : { title }) } };
  }

  const ids = (request: ArchiveTasksRequest, limit = 50): string[] =>
    archive.queryTasks(request, limit).rows.map((row) => row.id);

  test("newest first by first archive time, then created, then id; the machine's last known name and the alias", () => {
    put("t-a", 100);
    put("t-b", 300);
    put("t-c", 200, { createdAt: 900 });
    put("t-d", 200, { createdAt: 950 });
    put("t-e", 200, { createdAt: 950 });
    expect(ids({})).toEqual(["t-b", "t-e", "t-d", "t-c", "t-a"]);
    archive.applyFleet(
      {
        machines: [{ deviceId: "dev-a", name: "alpha-renamed", platform: "linux", build: null, connected: true }],
        leader: null,
      },
      400,
    );
    archive.upsertAccount(context.account, "work", 1, 400);
    expect(archive.queryTasks({}, 1).rows).toEqual([
      expect.objectContaining({
        id: "t-b",
        endedAt: 300,
        createdAt: 1_000,
        machine: "alpha-renamed",
        account: context.account,
        alias: "work",
      }),
    ]);
  });

  /** Every page of `limit` rows, followed by cursor, as the app would walk it. */
  function walk(limit: number): string[][] {
    const pages: string[][] = [];
    let before: ArchiveTasksRequest["before"];
    for (;;) {
      const { rows: page } = archive.queryTasks({ ...(before === undefined ? {} : { before }) }, limit);
      const last = page.at(-1);
      if (last === undefined) return pages;
      pages.push(page.map((row) => row.id));
      before = { endedAt: last.endedAt, createdAt: last.createdAt, id: last.id };
    }
  }

  test("a keyset page continues exactly where the last ended, and total ignores the cursor", () => {
    for (const [i, at] of [100, 200, 200, 300, 400].entries()) put(`t-${i}`, at);
    const first = archive.queryTasks({}, 2);
    expect(first.total).toBe(5);
    const last = first.rows.at(-1);
    if (last === undefined) throw new Error("empty page");
    const second = archive.queryTasks(
      { before: { endedAt: last.endedAt, createdAt: last.createdAt, id: last.id } },
      10,
    );
    expect(second.total).toBe(5);
    expect([...first.rows, ...second.rows].map((row) => row.id)).toEqual(["t-4", "t-3", "t-2", "t-1", "t-0"]);
  });

  test("a page boundary inside a tie on end time, or on end time and created, loses and repeats nothing", () => {
    for (const [i, at] of [100, 200, 200, 300, 400].entries()) put(`t-${i}`, at);
    // limit 3 cuts between the two 200s.
    expect(walk(3)).toEqual([
      ["t-4", "t-3", "t-2"],
      ["t-1", "t-0"],
    ]);
    // Equal end and created: only the id decides, and a boundary lands between each.
    for (const id of ["u-1", "u-2", "u-3"]) put(id, 500, { createdAt: 50 });
    expect(walk(1).flat()).toEqual(["u-3", "u-2", "u-1", "t-4", "t-3", "t-2", "t-1", "t-0"]);
  });

  test("each filter narrows, and they combine", () => {
    put("t-1", 100, titled("Fix the relay"));
    put("t-2", 200, { state: "failed", spec: { repo: "other", mode: "worktree", title: "Ship it" } });
    put(
      "t-3",
      300,
      { state: "cancelled", assignment: { deviceId: "dev-b", exclave: "default", clone: "x" } },
      { machine: "beta", account: KEY },
    );
    expect(ids({ repo: "other" })).toEqual(["t-2"]);
    expect(ids({ outcome: "cancelled" })).toEqual(["t-3"]);
    expect(ids({ machine: "dev-b" })).toEqual(["t-3"]);
    expect(ids({ account: KEY })).toEqual(["t-3"]);
    expect(ids({ since: 200 })).toEqual(["t-3", "t-2"]);
    expect(ids({ until: 200 })).toEqual(["t-1"]);
    expect(ids({ since: 100, until: 300 })).toEqual(["t-2", "t-1"]);
    expect(ids({ title: "RELAY" })).toEqual(["t-1"]);
    expect(ids({ repo: "seance", outcome: "failed" })).toEqual([]);
    expect(archive.queryTasks({ repo: "seance" }, 50).total).toBe(2);
  });

  test("a title search is a substring: % and _ and the escape match only themselves", () => {
    put("t-1", 100, titled("50% off"));
    put("t-2", 200, titled("500 off"));
    put("t-3", 300, titled("a_b"));
    put("t-4", 400, titled("axb"));
    put("t-5", 500, titled("back\\slash"));
    put("t-6", 600, titled());
    expect(ids({ title: "0%" })).toEqual(["t-1"]);
    expect(ids({ title: "a_b" })).toEqual(["t-3"]);
    expect(ids({ title: "\\" })).toEqual(["t-5"]);
    expect(ids({ title: "o" })).toEqual(["t-2", "t-1"]);
  });
});
