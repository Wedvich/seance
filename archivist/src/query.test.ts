import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ID,
  ENVELOPE_MAX_CT_LENGTH,
  importPsk,
  parseArchiveTasksReply,
  parseMetricsReply,
  seal,
  toBase64,
  type ArchiveTasksRequest,
  type Plain,
  type Task,
} from "@seance/shared";
import { Archive, taskRow, type ArchivedRow } from "./archive.ts";
import { MetricsArchive } from "./metrics-archive.ts";
import { answerArchiveMetrics, answerArchiveTasks, createMetricsAnswer, createTasksAnswer } from "./query.ts";

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
    expect(parsed.tasks.map((entry) => entry.task.id)).toEqual(["t-new", "t-old"]);
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

  function fake(all: readonly ArchivedRow[]): { queryTasks: Archive["queryTasks"]; readonly asked: number[] } {
    const asked: number[] = [];
    return {
      asked,
      queryTasks: (_request: ArchiveTasksRequest, limit: number) => {
        asked.push(limit);
        return { rows: all.slice(0, limit), total: all.length };
      },
    };
  }

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
