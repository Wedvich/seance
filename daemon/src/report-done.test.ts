import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportDone } from "./report-done.ts";

const dir = await mkdtemp(join(tmpdir(), "seance-report-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

/** A daemon double on a unix socket: records the frame it was sent and answers one line. */
function daemon(name: string, answer: string): { path: string; frames: unknown[]; stop: () => void } {
  const path = join(dir, name);
  const frames: unknown[] = [];
  const server = Bun.listen<undefined>({
    unix: path,
    socket: {
      data: (sock, chunk) => {
        frames.push(JSON.parse(chunk.toString("utf8")));
        sock.write(`${answer}\n`);
      },
    },
  });
  return { path, frames, stop: () => server.stop(true) };
}

describe("reportDone", () => {
  test("sends a done session-event frame carrying the pane, and says reported on ok", async () => {
    const fake = daemon("ok.sock", JSON.stringify({ ok: true }));
    try {
      expect(await reportDone({ path: fake.path, pane: "%7" })).toEqual({
        ok: true,
        text: "sent — settles the task if it was queued to settle on its report",
      });
      expect(fake.frames).toEqual([{ v: 1, kind: "session-event", state: "done", pane: "%7" }]);
    } finally {
      fake.stop();
    }
  });

  test("each refusal is worded for the agent, and a reply it cannot read is not taken as ok", async () => {
    const wording = {
      untasked: "this session runs no scheduler task",
      unbound: "not in a tmux pane",
      invalid: "predates done reports; run `seanced update`",
      unsupported: "runs no session-event ingest",
      unrecorded: "holds no launch of this session's task",
      unwritten: "sent to the scheduler, but this machine's daemon could not save the report",
      stopping: "daemon is stopping",
    } as const;
    for (const [code, text] of Object.entries(wording)) {
      const fake = daemon(`${code}.sock`, JSON.stringify({ ok: false, code }));
      try {
        // oxlint-disable-next-line no-await-in-loop -- one daemon double per code
        const result = await reportDone({ path: fake.path, pane: "%1" });
        expect(result.ok).toBe(false);
        expect(result.text).toContain(text);
        // Only a daemon that predates the frame has anything to update.
        expect(result.text.includes("seanced update")).toBe(code === "invalid");
      } finally {
        fake.stop();
      }
    }
    const odd = daemon("odd.sock", JSON.stringify({ ok: false, code: "new_code" }));
    try {
      expect((await reportDone({ path: odd.path, pane: "%1" })).ok).toBe(false);
    } finally {
      odd.stop();
    }
  });

  test("no daemon listening is said plainly", async () => {
    expect(await reportDone({ path: join(dir, "absent.sock"), pane: "%1" })).toEqual({
      ok: false,
      text: "the local daemon is not running",
    });
  });
});
