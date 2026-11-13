import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ID,
  ARCHIVE_MACHINES_MAX,
  ENVELOPE_MAX_CT_LENGTH,
  importPsk,
  parseArchiveTasksReply,
  parseMetricsReply,
  seal,
  toBase64,
  type ArchivedMachine,
  type ArchiveTasksRequest,
  type Plain,
  type Task,
} from "@seance/shared";
import { Archive, taskRow, type ArchivedRow } from "./archive.ts";
import { MetricsArchive } from "./metrics-archive.ts";
import {
  answerArchiveMetrics,
  answerArchiveTasks,
  createMetricsAnswer,
  createTasksAnswer,
  MACHINES_BUDGET_BYTES,
} from "./query.ts";

const RAW_ACCOUNT = "11111111-2222-3333-4444-555555555555:66666666-7777-8888-9999-000000000000";
const PROMPT = "PROMPT-TEXT the launch codes";
const ATTACHMENT = "secret-plan.png";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    spec: {
      repo: "seance",
      mode: "worktree",
      prompt: PROMPT,
      title: "Do the thing",
      attachments: [
        {
          id: "0b6f0c9e-1a2b-4c3d-8e9f-000000000001",
          name: ATTACHMENT,
          type: "image/png",
          size: 3,
          hash: "A".repeat(43),
        },
      ],
      pin: { deviceId: "dev-a", account: RAW_ACCOUNT },
    },
    state: "done",
    createdAt: 1_000,
    assignment: { deviceId: "dev-a", exclave: "default", clone: "seance" },
    spillAlert: { accountId: RAW_ACCOUNT, window: "5h", reset: 0, at: 2_000 },
    failure: { code: "session_failed", message: `worktree for ${PROMPT}` },
    ...over,
  };
}

function plain(op: Plain["op"], payload: unknown, re?: string): Plain {
  return { id: "req-1", ts: Date.now(), op, payload, ...(re === undefined ? {} : { re }) };
}

const quiet = { warn: (): void => {} };

describe("archive-tasks", () => {
  let dir: string;
  let archive: Archive;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "archive-query-"));
    archive = await Archive.open(join(dir, "archive.sqlite"));
  });

  afterEach(async () => {
    archive.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("no prompt text, attachment or raw account id is ever returned, even from a row an older build wrote whole", async () => {
    const stripped = taskRow(task({ id: "t-new" }), 1, { machine: "alpha", account: "account:abc" });
    if (stripped === null) throw new Error("finished task refused");
    archive.upsertTask(stripped, 200);
    // As if a build before A14's stripping, or a hand edit, had stored the record whole.
    archive.upsertTask({ ...stripped, id: "t-old", record: JSON.stringify(task({ id: "t-old" })) }, 100);
    // A record whose JSON disagrees with its `state` column, so `forgetPrompt` alone would keep its prompt.
    archive.upsertTask(
      { ...stripped, id: "t-odd", record: JSON.stringify(task({ id: "t-odd", state: "running" })) },
      50,
    );

    const reply = await answerArchiveTasks(
      plain("archive-tasks", {}),
      APP_ID,
      createTasksAnswer(archive, quiet),
      quiet,
    );
    const text = JSON.stringify(reply);
    expect(text).not.toContain("PROMPT-TEXT");
    expect(text).not.toContain(ATTACHMENT);
    expect(text).not.toContain("attachments");
    expect(text).not.toContain(RAW_ACCOUNT);
    const parsed = parseArchiveTasksReply(reply?.payload);
    if (parsed === null || !parsed.ok) throw new Error("not an ok page");
    expect(parsed.tasks.map((entry) => entry.task.id)).toEqual(["t-new", "t-old", "t-odd"]);
    for (const { task: archived } of parsed.tasks) {
      expect(archived.spec.prompt).toBeUndefined();
      expect(archived.spec.attachments).toBeUndefined();
      expect(archived.spec.pin).toEqual({ deviceId: "dev-a" });
      expect(archived.failure).toEqual({ code: "session_failed", message: "" });
    }
  });

  test("a title search never matches prompt text, which the archive does not hold", async () => {
    const row = taskRow(task(), 1, { machine: "alpha", account: null });
    if (row === null) throw new Error("finished task refused");
    archive.upsertTask(row, 100);
    const answer = createTasksAnswer(archive, quiet);
    expect(answer({ title: "launch codes" }).tasks).toEqual([]);
    expect(answer({ title: "the thing" }).tasks).toHaveLength(1);
  });

  test("a first page lists every machine the archive holds tasks for by last known name, the filters aside; a later page none", () => {
    archive.applyFleet(
      { machines: [{ deviceId: "dev-gone", name: "old-box", platform: "linux", build: null, connected: true }], leader: null },
      10,
    );
    // Retired: it keeps its row and name (A24).
    archive.applyFleet({ machines: [], leader: null }, 20);
    const put = (id: string, deviceId: string, machine: string | null, at: number): void => {
      const row = taskRow(task({ id, assignment: { deviceId, exclave: "default", clone: "seance" } }), 1, {
        machine,
        account: null,
      });
      if (row === null) throw new Error("finished task refused");
      archive.upsertTask(row, at);
    };
    put("t-1", "dev-gone", "stale-name", 100);
    put("t-2", "dev-gone", null, 300);
    put("t-3", "dev-x", "row-box-old", 150);
    put("t-4", "dev-x", "row-box", 200);
    put("t-5", "dev-y", null, 50);
    const { assignment: _assignment, ...unassigned } = task({ id: "t-6" });
    const bare = taskRow(unassigned, 1, { machine: null, account: null });
    if (bare === null) throw new Error("finished task refused");
    archive.upsertTask(bare, 400);

    const answer = createTasksAnswer(archive, quiet);
    const machines = [
      { deviceId: "dev-gone", name: "old-box", lastSeen: 300 },
      { deviceId: "dev-x", name: "row-box", lastSeen: 200 },
      { deviceId: "dev-y", name: null, lastSeen: 50 },
    ];
    expect(answer({}).machines).toEqual(machines);
    expect(answer({ repo: "elsewhere", machine: "dev-y" }).machines).toEqual(machines);
    const later = answer({ before: { endedAt: 300, createdAt: 1_000, id: "t-2" } });
    expect(later.tasks.length).toBeGreaterThan(0);
    expect("machines" in later).toBe(false);
  });
});

describe("page filling", () => {
  /** Rows as large as a record gets once its prompt is gone: the longest repo and title a task may carry. */
  function rows(n: number): ArchivedRow[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `t-${String(i).padStart(3, "0")}`,
      endedAt: 10_000 - i,
      createdAt: 1_000,
      machine: "alpha",
      account: null,
      alias: null,
      record: JSON.stringify({
        id: `t-${String(i).padStart(3, "0")}`,
        spec: { repo: "r".repeat(512), mode: "worktree", title: "t".repeat(200) },
        state: "done",
        createdAt: 1_000,
      }),
    }));
  }

  function fake(
    all: readonly ArchivedRow[],
    machines: readonly ArchivedMachine[] = [],
  ): Pick<Archive, "queryTasks" | "taskMachines"> & { readonly asked: number[] } {
    const asked: number[] = [];
    return {
      asked,
      queryTasks: (_request: ArchiveTasksRequest, limit: number) => {
        asked.push(limit);
        return { rows: all.slice(0, limit), total: all.length };
      },
      taskMachines: (limit: number) => machines.slice(0, limit),
    };
  }

  test("a first page's machines are cut to their budget, newest first, and the rows still seal inside an envelope", async () => {
    const machines = Array.from({ length: ARCHIVE_MACHINES_MAX }, (_, i) => ({
      deviceId: `dev-${i}`,
      name: "n".repeat(200),
      lastSeen: 10_000 - i,
    }));
    const reply = await answerArchiveTasks(
      plain("archive-tasks", { limit: 50 }),
      APP_ID,
      createTasksAnswer(fake(rows(60), machines), quiet),
      quiet,
    );
    if (reply === null) throw new Error("dropped");
    const parsed = parseArchiveTasksReply(reply.payload);
    if (parsed === null || !parsed.ok) throw new Error("not an ok page");
    const listed = parsed.machines ?? [];
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(ARCHIVE_MACHINES_MAX);
    expect(listed).toEqual(machines.slice(0, listed.length));
    expect(JSON.stringify(listed).length).toBeLessThanOrEqual(MACHINES_BUDGET_BYTES);
    expect(parsed.tasks.length).toBeGreaterThan(0);
    const key = await importPsk(toBase64(crypto.getRandomValues(new Uint8Array(32))));
    const sealed = await seal(key, { to: APP_ID, from: "archivist" }, reply);
    expect(sealed.ct.length).toBeLessThanOrEqual(ENVELOPE_MAX_CT_LENGTH);
  });

  test("a full page of the largest rows is cut to the budget, seals inside an envelope, and points past its last row", async () => {
    const archive = fake(rows(60));
    const reply = await answerArchiveTasks(
      plain("archive-tasks", { limit: 50 }),
      APP_ID,
      createTasksAnswer(archive, quiet),
      quiet,
    );
    if (reply === null) throw new Error("dropped");
    const parsed = parseArchiveTasksReply(reply.payload);
    if (parsed === null || !parsed.ok) throw new Error("not an ok page");
    expect(archive.asked).toEqual([51]);
    expect(parsed.tasks.length).toBeGreaterThan(0);
    expect(parsed.tasks.length).toBeLessThan(50);
    expect(parsed.total).toBe(60);
    const last = parsed.tasks.at(-1);
    if (last === undefined) throw new Error("empty page");
    expect(parsed.next).toEqual({ endedAt: last.endedAt, createdAt: 1_000, id: last.task.id });
    const key = await importPsk(toBase64(crypto.getRandomValues(new Uint8Array(32))));
    const sealed = await seal(key, { to: APP_ID, from: "archivist" }, reply);
    expect(sealed.ct.length).toBeLessThanOrEqual(ENVELOPE_MAX_CT_LENGTH);
  });

  test("next is null once the last match is in the page, and an unreadable record is skipped but consumed", () => {
    const [good, bad, tail] = rows(3);
    if (good === undefined || bad === undefined || tail === undefined) throw new Error("rows");
    const warnings: string[] = [];
    const answer = createTasksAnswer(fake([good, { ...bad, record: "{ not json" }, tail]), {
      warn: (line) => warnings.push(line),
    });
    const whole = answer({ limit: 3 });
    expect(whole.tasks.map((entry) => entry.task.id)).toEqual([good.id, tail.id]);
    expect(whole.next).toBeNull();
    expect(warnings).toEqual(["archive tasks: skipped 1 unreadable record(s)"]);
    // A page ending on the unreadable row still moves past it.
    const first = answer({ limit: 2 });
    expect(first.next).toEqual({ endedAt: bad.endedAt, createdAt: bad.createdAt, id: bad.id });
  });
});

describe("the app-only gate", () => {
  const metrics = createMetricsAnswer(MetricsArchive.memory());

  test("a request from anyone but the app, or carrying re, is dropped with a warning and no reply", async () => {
    const warnings: string[] = [];
    const log = { warn: (line: string) => warnings.push(line) };
    const request = { from: 0, to: 60, step: 30, machine: "dev-a" };
    expect(await answerArchiveMetrics(plain("archive-metrics", request), "some-daemon", metrics, log)).toBeNull();
    expect(await answerArchiveMetrics(plain("archive-metrics", request, "x"), APP_ID, metrics, log)).toBeNull();
    expect(warnings).toHaveLength(2);
    expect(warnings.every((line) => line.includes("not sealed from the app"))).toBe(true);
  });

  test("a malformed request is invalid_request; a good one is a metrics reply, correlated", async () => {
    const bad = await answerArchiveMetrics(
      plain("archive-metrics", { from: 0, to: 60, step: 30 }),
      APP_ID,
      metrics,
      quiet,
    );
    expect(bad?.payload).toEqual({ ok: false, code: "invalid_request", message: "malformed archive-metrics request" });
    const good = await answerArchiveMetrics(
      plain("archive-metrics", { from: 0, to: 60, step: 30, machine: "dev-a" }),
      APP_ID,
      metrics,
      quiet,
    );
    expect(good).toMatchObject({ op: "archive-metrics", re: "req-1" });
    expect(parseMetricsReply(good?.payload)).toEqual({ series: [] });
  });

  test("a year at one day over many series is refused too_large with a message, not left to the transport", async () => {
    const archive = MetricsArchive.memory();
    const now = Math.floor(Date.now() / 1000);
    const day = now - (now % 86_400);
    const points = Array.from({ length: 366 }, (_, i): [number, number] => [
      day - i * 86_400,
      (i + 1) / 7,
    ]).toReversed();
    archive.writePulled(
      "dev-a",
      3600,
      Array.from({ length: 8 }, (_, i) => ({ metric: `m${i}`, labels: { machine: "dev-a" }, points })),
      now,
    );
    const answer = createMetricsAnswer(archive);
    const request = { from: day - 365 * 86_400, to: day, step: 86_400, machine: "dev-a" } as const;
    expect(answer(request)).toMatchObject({ ok: false, code: "too_large" });
    // The same range for one name fits.
    const one = answer({ ...request, names: ["m0"] });
    expect("series" in one && one.series).toHaveLength(1);
    archive.close();
  });

  test("a throwing archive is internal_error naming only the op", async () => {
    const reply = await answerArchiveTasks(
      plain("archive-tasks", { title: "secret words" }),
      APP_ID,
      () => {
        throw new Error("SQLITE_BUSY at /var/lib/x");
      },
      quiet,
    );
    expect(reply?.payload).toEqual({ ok: false, code: "internal_error", message: "archive tasks failed" });
  });
});
