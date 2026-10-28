import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachmentHash,
  importPsk,
  mintAttachmentId,
  sealAttachment,
  SCHEDULER_CLIENT,
  toBase64,
  type AttachmentRef,
  type RepoEntry,
  type SpawnResponse,
} from "@seance/shared";
import {
  attachmentDirsFor,
  fetchAttachments,
  pruneAttachments,
  taskAttachments,
  type AttachmentSource,
} from "../src/attachments.ts";
import { reapAudit, type AuditSink } from "../src/audit.ts";
import { createBackend } from "../src/backend-default.ts";
import type { Config } from "../src/config.ts";
import { createHandler, createLocalOps, type HandlerContext } from "../src/handlers.ts";
import { scanRepos } from "../src/scan.ts";
import { listPanes } from "../src/sessions.ts";
import { TASK_OPTION, tmux, tmuxOk } from "../src/tmux.ts";
import { startTestRelay, type TestRelay } from "./harness.ts";
import {
  makeClaudeStub,
  makeGitFixture,
  pollUntil,
  usePrivateTmux,
  type ClaudeStub,
  type GitFixture,
  type PrivateTmux,
} from "./fixtures.ts";

const TOKEN = "attachments-bearer";
const PSK = toBase64(new Uint8Array(32).fill(7));
const DAY_MS = 24 * 60 * 60 * 1000;

let base: string;
let privateTmux: PrivateTmux | undefined;
let fixture: GitFixture;
let stub: ClaudeStub;
let repos: readonly RepoEntry[];
let relay: TestRelay;
let key: CryptoKey;
let source: AttachmentSource;
let ctx: HandlerContext;
let tasks = 0;

const lines: string[] = [];
const collect: AuditSink = (line) => void lines.push(line);

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-attach-"));
  privateTmux = usePrivateTmux(base, "attach");
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config");
  const home = join(base, "home");
  await mkdir(home, { recursive: true });
  fixture = await makeGitFixture(base);
  stub = await makeClaudeStub(base);
  process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
  repos = await scanRepos([fixture.root]);
  relay = startTestRelay(TOKEN);
  key = await importPsk(PSK);
  // The daemon's config URL, socket path and all: the fetch derives its origin from it.
  source = { relayUrl: `${relay.url}/daemon`, bearerToken: TOKEN, key, root: join(base, "attachments") };
  const config: Config = {
    name: "AttachMac",
    relayUrl: source.relayUrl,
    bearerToken: TOKEN,
    psk: PSK,
    repoRoots: [fixture.root],
    tmuxSession: "main",
  };
  ctx = {
    backend: createBackend(config, { home, waitMs: 5_000 }),
    getRepos: () => repos,
    rescan: () => Promise.resolve(repos),
    auditSink: collect,
    attachments: taskAttachments(source),
  };
});

afterAll(async () => {
  relay.stop();
  await privateTmux?.dispose();
  delete process.env["SEANCE_CLAUDE_BIN"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  lines.length = 0;
});

function nextTask(): string {
  tasks += 1;
  return `attach-task-${tasks}`;
}

/** Seals `text` as the PWA would and stores it on the relay; the manifest entry names it. */
async function upload(text: string, name: string, type: string): Promise<AttachmentRef> {
  const id = mintAttachmentId();
  const plain = new Uint8Array(new TextEncoder().encode(text));
  const object = await sealAttachment(key, id, plain);
  relay.putAttachment(id, object);
  return { id, name, type, size: plain.byteLength, hash: await attachmentHash(object) };
}

/** A spawn as the leader dispatches it in process: sealed `from` the scheduler, its client. */
function leaderSpawn(taskId: string, attachments: readonly AttachmentRef[], extra: Record<string, unknown> = {}) {
  return createLocalOps(ctx, "leader").spawn({
    repo: "myrepo",
    mode: "here",
    title: taskId,
    client: SCHEDULER_CLIENT,
    taskId,
    attachments,
    ...extra,
  });
}

async function refusal(reply: Promise<unknown>): Promise<string> {
  const answer = (await reply) as SpawnResponse;
  if (answer.ok) throw new Error("spawn was not refused");
  expect(answer.code).toBe("attachment_unavailable");
  return answer.message;
}

/** Nothing of a refused task's: no directory, no staging, no sidecar. */
async function leftFor(taskId: string): Promise<readonly string[]> {
  const entries = await readdir(source.root).catch(() => []);
  return entries.filter((name) => name.includes(taskId));
}

describe("a spawn carrying attachments", () => {
  test("fetches them before launch, hands the directory over and lists the files in the seed", async () => {
    const taskId = nextTask();
    const shot = await upload("\u0089PNG fake", 'screen "one".png', "image/png");
    const notes = await upload("plain notes", "notes", "application/x-unknown");
    await rm(stub.argvFile, { force: true });
    await rm(stub.stdinFile, { force: true });

    const reply = (await leaderSpawn(taskId, [shot, notes], { prompt: "look at these" })) as SpawnResponse;
    try {
      expect(reply).toMatchObject({ ok: true });
      const dir = join(source.root, taskId);
      expect((await stat(source.root)).mode & 0o777).toBe(0o700);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      // The extension from the fixed map, none for an unmapped type; never the name.
      expect((await readdir(dir)).toSorted()).toEqual(["1.png", "2"]);
      expect(await Bun.file(join(dir, "1.png")).text()).toBe("\u0089PNG fake");
      expect((await stat(join(dir, "2"))).mode & 0o777).toBe(0o600);

      const argv = await stub.argv();
      const at = argv.indexOf("--add-dir");
      expect(argv[at + 1]).toBe(dir);
      expect(argv[at + 2]).toBe("--model");

      const seed = await stub.stdin();
      expect(seed).toContain("Task: look at these\n");
      expect(seed).toContain(
        `Attached files (the user's originals, at these paths):\n` +
          `- ${join(dir, "1.png")} — ${JSON.stringify('screen "one".png')}, image/png, ${shot.size} bytes\n` +
          `- ${join(dir, "2")} — "notes", application/x-unknown, ${notes.size} bytes\n`,
      );
      // Names stay off argv: the seed travels on stdin.
      expect(argv.join("\0")).not.toContain("screen");

      const audit = lines.join("\n");
      expect(audit).toContain(`attachments=2 attachmentBytes=${shot.size + notes.size} `);
      for (const secret of ["screen", "notes", shot.id, shot.hash]) expect(audit).not.toContain(secret);
    } finally {
      await tmux(["kill-window", "-t", `main:${taskId}`]);
    }
  });

  test("with no prompt, the seed still lists them", async () => {
    const taskId = nextTask();
    const file = await upload("x", "x.txt", "text/plain");
    await rm(stub.stdinFile, { force: true });
    const reply = (await leaderSpawn(taskId, [file])) as SpawnResponse;
    try {
      expect(reply).toMatchObject({ ok: true });
      const seed = await stub.stdin();
      expect(seed).not.toContain("Task:");
      expect(seed).toContain(`- ${join(source.root, taskId, "1.txt")} — "x.txt", text/plain, 1 bytes\n`);
    } finally {
      await tmux(["kill-window", "-t", `main:${taskId}`]);
    }
  });

  test("a worktree spawn notes its worktree, which is how a continuation finds the directory", async () => {
    const taskId = nextTask();
    const file = await upload("y", "y.md", "text/markdown");
    const reply = (await leaderSpawn(taskId, [file], { mode: "worktree" })) as SpawnResponse;
    try {
      if (!reply.ok) throw new Error(reply.message);
      expect(await attachmentDirsFor(source.root, reply.path)).toEqual([join(source.root, taskId)]);
      expect(await attachmentDirsFor(source.root, join(base, "elsewhere"))).toEqual([]);
    } finally {
      await tmux(["kill-window", "-t", `main:${taskId}`]);
    }
  });

  test("a hash mismatch refuses the spawn, launches nothing and leaves nothing behind", async () => {
    const taskId = nextTask();
    const good = await upload("good", "a.txt", "text/plain");
    const other = await upload("evil", "b.txt", "text/plain");
    await rm(stub.argvFile, { force: true });
    // The manifest pins other bytes than the relay serves under that id.
    const message = await refusal(leaderSpawn(taskId, [other, { ...good, hash: other.hash }]));
    expect(message).toBe("attachment 2 of 2: hash mismatch");
    expect(await leftFor(taskId)).toEqual([]);
    expect(await Bun.file(stub.argvFile).exists()).toBe(false);
    expect(lines.join("\n")).toContain("failed code=attachment_unavailable");
  });

  test("a missing object refuses as not found", async () => {
    const taskId = nextTask();
    const file = await upload("z", "z.txt", "text/plain");
    const message = await refusal(leaderSpawn(taskId, [{ ...file, id: mintAttachmentId() }]));
    expect(message).toBe("attachment 1 of 1: not found (expired or never stored)");
    expect(await leftFor(taskId)).toEqual([]);
  });

  test("a length other than the manifest's refuses before the body is trusted", async () => {
    const taskId = nextTask();
    const file = await upload("four", "f.txt", "text/plain");
    const message = await refusal(leaderSpawn(taskId, [{ ...file, size: 3 }]));
    expect(message).toStartWith("attachment 1 of 1: wrong length");
  });

  test("a 5xx is retried once; a second one refuses", async () => {
    const file = await upload("retry", "r.txt", "text/plain");
    const before = relay.attachmentGets();
    relay.failNextAttachmentGets(503);
    const fetched = await fetchAttachments(source, nextTask(), [file]);
    expect(fetched.files).toHaveLength(1);
    expect(relay.attachmentGets() - before).toBe(2);

    const taskId = nextTask();
    relay.failNextAttachmentGets(503, 502);
    const message = await refusal(leaderSpawn(taskId, [file]));
    expect(message).toBe("attachment 1 of 1: relay answered 502");
    expect(await leftFor(taskId)).toEqual([]);
  });

  test("a relay that cannot be reached, or a wrong token, refuses", async () => {
    const file = await upload("net", "n.txt", "text/plain");
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const deadUrl = `ws://127.0.0.1:${closed.port}/daemon`;
    await closed.stop(true);
    const taskId = nextTask();
    await expect(fetchAttachments({ ...source, relayUrl: deadUrl }, taskId, [file])).rejects.toThrow(
      /^attachment 1 of 1: fetch failed/u,
    );
    expect(await leftFor(taskId)).toEqual([]);
    await expect(fetchAttachments({ ...source, bearerToken: "wrong" }, nextTask(), [file])).rejects.toThrow(
      "attachment 1 of 1: relay answered 401",
    );
  });

  test("past the deadline nothing is written", async () => {
    const file = await upload("slow", "s.txt", "text/plain");
    const taskId = nextTask();
    const hang: AttachmentSource["fetch"] = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(fetchAttachments({ ...source, fetch: hang, deadlineMs: 50 }, taskId, [file])).rejects.toThrow(
      "attachment 1 of 1: deadline passed",
    );
    expect(await leftFor(taskId)).toEqual([]);
  });

  test("only the scheduler hands a session files: nothing is fetched for anyone else", async () => {
    const file = await upload("gate", "g.txt", "text/plain");
    const before = relay.attachmentGets();
    for (const handle of [createHandler(ctx, "local"), createHandler(ctx)]) {
      // oxlint-disable-next-line no-await-in-loop -- each surface in turn
      const reply = await handle({
        id: "req",
        ts: Date.now(),
        op: "spawn",
        payload: { repo: "myrepo", mode: "here", client: SCHEDULER_CLIENT, taskId: nextTask(), attachments: [file] },
      });
      expect(reply?.payload).toMatchObject({
        ok: false,
        code: "attachment_unavailable",
        message: "only the scheduler hands a session attachments",
      });
    }
    expect(relay.attachmentGets()).toBe(before);
  });
});

describe("pruneAttachments", () => {
  async function plant(root: string, taskId: string, sidecar: Record<string, unknown> | null): Promise<void> {
    await mkdir(join(root, taskId), { recursive: true });
    await writeFile(join(root, taskId, "1.png"), "x");
    if (sidecar !== null) await writeFile(join(root, `${taskId}.json`), JSON.stringify({ v: 1, ...sidecar }));
  }

  test("removes a gone worktree's and an aged unused task's files, keeps the rest, audits ids only", async () => {
    const root = join(base, "prune");
    const now = Date.now();
    const live = join(base, "live-worktree");
    await mkdir(live, { recursive: true });
    await plant(root, "gone", { at: now, worktree: join(base, "no-such-worktree") });
    await plant(root, "fresh", { at: now, worktree: live });
    await plant(root, "aged-here", { at: now - 31 * DAY_MS });
    await plant(root, "aged-running", { at: now - 31 * DAY_MS });
    await plant(root, "aged-in-use", { at: now - 31 * DAY_MS, worktree: live });
    await plant(root, "no-sidecar", null);
    const old = new Date(now - 31 * DAY_MS);
    await utimes(join(root, "no-sidecar"), old, old);
    await mkdir(join(root, ".stale.123"));
    await utimes(join(root, ".stale.123"), new Date(now - 2 * 3_600_000), new Date(now - 2 * 3_600_000));
    await mkdir(join(root, ".busy.456"));

    // A live pane tagged with one task, and one sitting in the other's worktree.
    const tagged = (
      await tmuxOk(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "prune", "-c", base, "sleep 60"])
    ).trim();
    await tmuxOk(["set-option", "-p", "-t", tagged, TASK_OPTION, "aged-running"]);
    await tmuxOk(["new-window", "-d", "-t", "prune:", "-c", live, "sleep 60"]);
    try {
      // A new pane reports the server's cwd until its child has changed directory.
      let panes = await listPanes();
      await pollUntil(async () => {
        panes = await listPanes();
        return panes.some((pane) => pane.path === live);
      }, "the pane inside the worktree");
      expect(panes.find((pane) => pane.paneId === tagged)?.taskId).toBe("aged-running");

      const dry = await pruneAttachments({ root, now, dryRun: true, audit: reapAudit("cli", collect), panes });
      expect(lines).toEqual([]);
      expect(await readdir(root)).toContain("gone");

      const pruned = await pruneAttachments({ root, now, dryRun: false, audit: reapAudit("cli", collect), panes });
      expect(pruned.toSorted((a, b) => a.task.localeCompare(b.task))).toEqual([
        { task: ".stale.123", reason: "staging" },
        { task: "aged-here", reason: "aged" },
        { task: "gone", reason: "worktree-gone" },
        { task: "no-sidecar", reason: "aged" },
      ]);
      expect(dry).toEqual(pruned);
      expect((await readdir(root)).toSorted()).toEqual([
        ".busy.456",
        "aged-in-use",
        "aged-in-use.json",
        "aged-running",
        "aged-running.json",
        "fresh",
        "fresh.json",
      ]);
      expect(lines).toContain('audit reap origin=cli removed-attachments task="gone" reason=worktree-gone');
      expect(lines.join("\n")).not.toContain("1.png");
    } finally {
      await tmux(["kill-session", "-t", "prune"]);
    }
  });
});
