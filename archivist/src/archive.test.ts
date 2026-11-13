import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@seance/shared";
import { Archive, ARCHIVE_SCHEMA_VERSION, archivedTask, taskRow, type Fleet, type FleetMachine } from "./archive.ts";

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
    expect(archivedTask(task({ spec: { repo: "r", mode: "here", pin: { account: RAW_ACCOUNT } } })).spec.pin).toBe(
      undefined,
    );
    expect(row).toMatchObject({ repo: "seance", title: "Do the thing", deviceId: "dev-a", prState: "open" });
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
