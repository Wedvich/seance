import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ATTACHMENT_PATH, attachmentHash, mintAttachmentId, queuedTask, type Task } from "@seance/shared";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { attachmentsRoot } from "../daemon/src/attachments.ts";
import { pollUntil } from "../daemon/test/fixtures.ts";
import { deriveAttachmentsAvailability } from "../pwa/src/view.ts";
import { killWindow, startApp, TOKEN, type AppHandle, type Stack } from "./harness.ts";
import { fixtureOrigin, startSuite, type Suite } from "./suite.ts";

/**
 * Attachments across all three real components (DESIGN.md, "Attachments"): the
 * PWA's store seals and PUTs each file to the relay's R2 in Miniflare, the task
 * carries the manifest, the leader places it, and the daemon fetches from
 * `attachmentUrl` of its own `ws://` config URL before it launches.
 */

let suite: Suite | undefined;
let stack: Stack;

beforeAll(async () => {
  suite = await startSuite("e2e-attachments");
  ({ stack } = suite);
});

afterAll(async () => {
  await suite?.dispose();
});

async function taskOf(id: string): Promise<Task | null> {
  return (await stack.queue().get(id))?.body ?? null;
}

/** The leader verified, advertising attachments, and the machine's repos listed: before that the form refuses files. */
async function ready(app: AppHandle): Promise<string> {
  await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
  await stack.daemon.leader.settled();
  const state = await app.waitForApp(
    (s) =>
      s.relay.scheduler.kind === "ready" &&
      s.relay.machines.some((m) => m.deviceId === stack.deviceId && m.connected && m.repos.length > 0) &&
      deriveAttachmentsAvailability(s.relay),
    "the leader verified and the machine listed with attachments",
  );
  const origin = fixtureOrigin(state);
  if (origin === null) throw new Error("no fixture origin listed");
  return origin;
}

describe("attachments: PWA upload to R2, leader placement, daemon fetch", () => {
  test("files picked in the PWA land decrypted on the placed machine, handed to the session and listed in its seed", async () => {
    const app = startApp(stack);
    let window: string | undefined;
    try {
      await ready(app);
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 0, 255]);
      const notes = "the user's notes\n";
      app.store.addFiles([
        new File([png], 'screen "one".png', { type: "image/png" }),
        new File([notes], "notes.md", { type: "text/markdown; charset=utf-8" }),
      ]);
      app.store.setPrompt("look at the attachments");
      await rm(stack.stub.argvFile, { force: true });
      await rm(stack.stub.stdinFile, { force: true });
      await app.store.spawn();

      const queued = await app.waitForApp(
        (s) => s.verdict?.kind === "queued" && s.verdict.task.state === "running",
        "the attachment task to run",
      );
      if (queued.verdict?.kind !== "queued") throw new Error("no queued verdict");
      const { id } = queued.verdict.task;
      const stored = await taskOf(id);
      window = stored?.assignment?.window;
      // Pick order, the type stripped of its parameter.
      expect(stored?.spec.attachments?.map((ref) => [ref.name, ref.type, ref.size])).toEqual([
        ['screen "one".png', "image/png", png.length],
        ["notes.md", "text/markdown", notes.length],
      ]);
      // Create-only on the real route: a token holder's second PUT of a stored id leaves the first object.
      const first = stored?.spec.attachments?.[0];
      if (first === undefined) throw new Error("no manifest on the stored task");
      const overwrite = await stack.relay.probe(`${ATTACHMENT_PATH}${first.id}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${TOKEN}`, "content-length": "64" },
        body: new Uint8Array(64),
      });
      expect(overwrite.status).toBe(409);
      const kept = await stack.relay.probe(`${ATTACHMENT_PATH}${first.id}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(await attachmentHash(new Uint8Array(await kept.arrayBuffer()))).toBe(first.hash);
      // The form let go of the files the task carries.
      expect(app.store.getState().attachments).toEqual([]);

      const dir = join(attachmentsRoot(), id);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await readdir(dir)).toSorted()).toEqual(["1.png", "2.md"]);
      expect(new Uint8Array(await Bun.file(join(dir, "1.png")).arrayBuffer())).toEqual(png);
      expect(await Bun.file(join(dir, "2.md")).text()).toBe(notes);

      const argv = await stack.stub.argv();
      const at = argv.indexOf("--add-dir");
      expect(argv[at + 1]).toBe(dir);
      expect(argv[at + 2]).toBe("--model");
      expect(argv.join("\0")).not.toContain("screen");

      const seed = await stack.stub.stdin();
      expect(seed).toContain("Task: look at the attachments");
      expect(seed).toContain(
        `Attached files (the user's originals, at these paths):\n` +
          `- ${join(dir, "1.png")} — ${JSON.stringify('screen "one".png')}, image/png, ${png.length} bytes\n` +
          `- ${join(dir, "2.md")} — "notes.md", text/markdown, ${notes.length} bytes\n`,
      );
    } finally {
      if (window !== undefined) await killWindow(window);
      app.stop();
    }
  }, 60_000);

  test("a manifest naming an object R2 does not hold fails the task attachment_unavailable, launching nothing", async () => {
    const app = startApp(stack);
    try {
      const repo = await ready(app);
      // A well-formed entry for an id nobody uploaded: what an expired object looks like to the daemon.
      const task = queuedTask(
        {
          repo,
          mode: "worktree",
          prompt: "this file is gone",
          client: "pwa",
          attachments: [
            { id: mintAttachmentId(), name: "gone.txt", type: "text/plain", size: 5, hash: "A".repeat(43) },
          ],
        },
        Date.now(),
      );
      await rm(stack.stub.argvFile, { force: true });
      const created = await app.client.createTask(task);
      expect(created).toMatchObject({ ok: true });

      await pollUntil(async () => (await taskOf(task.id))?.state === "failed", "the task to fail", 30_000);
      const failed = await taskOf(task.id);
      expect(failed?.failure?.code).toBe("attachment_unavailable");
      expect(failed?.failure?.message).toContain("attachment 1 of 1: not found");
      expect(failed?.failure?.message).not.toContain("gone.txt");
      // The finishing write drops the manifest, as it drops the prompt.
      expect(failed?.spec.attachments).toBeUndefined();
      expect(await Bun.file(stack.stub.argvFile).exists()).toBe(false);
      expect(await Bun.file(join(attachmentsRoot(), task.id)).exists()).toBe(false);
    } finally {
      app.stop();
    }
  }, 60_000);
});
