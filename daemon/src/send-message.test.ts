import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGE_MAX, MESSAGE_PUSH_MAX } from "@seance/shared";
import { MESSAGE_REPLY_CODES } from "./message-frame.ts";
import { sendMessage } from "./send-message.ts";

const dir = await mkdtemp(join(tmpdir(), "seance-sendmsg-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const TO = "t-0123456789abcdef";
const MESSAGE_ID = "5f0c1c1e-8a5f-4d3a-9d6e-0a3f4a2b7c11";

/**
 * A daemon double on a unix socket: records the frame it was sent and answers one line, or hangs up when `answer` is
 * null. Buffers to the newline: a large frame arrives in several chunks on macOS.
 */
function daemon(name: string, answer: string | null): { path: string; frames: unknown[]; stop: () => void } {
  const path = join(dir, name);
  const frames: unknown[] = [];
  const server = Bun.listen<{ buf: string }>({
    unix: path,
    socket: {
      open: (sock) => {
        sock.data = { buf: "" };
      },
      data: (sock, chunk) => {
        sock.data.buf += chunk.toString("utf8");
        const end = sock.data.buf.indexOf("\n");
        if (end === -1) return;
        frames.push(JSON.parse(sock.data.buf.slice(0, end)));
        sock.data.buf = "";
        if (answer === null) sock.end();
        else sock.write(`${answer}\n`);
      },
    },
  });
  return { path, frames, stop: () => server.stop(true) };
}

const note = { to: TO, kind: "note", text: "schema v2 landed" } as const;

describe("sendMessage", () => {
  test("sends exactly the message frame, with no pane, and words a delivery", async () => {
    const fake = daemon("ok.sock", JSON.stringify({ ok: true, id: MESSAGE_ID, outcome: "delivered" }));
    try {
      expect(await sendMessage({ ...note, kind: "question", inReplyTo: MESSAGE_ID }, { path: fake.path })).toEqual({
        ok: true,
        id: MESSAGE_ID,
        text: `delivered to task ${TO} as message ${MESSAGE_ID}`,
      });
      expect(fake.frames).toEqual([
        { v: 1, kind: "message", to: TO, messageKind: "question", text: "schema v2 landed", inReplyTo: MESSAGE_ID },
      ]);
      const bare = await sendMessage(note, { path: fake.path });
      expect(bare.ok).toBe(true);
      expect(fake.frames[1]).toEqual({ v: 1, kind: "message", to: TO, messageKind: "note", text: "schema v2 landed" });
    } finally {
      fake.stop();
    }
  });

  test("a message held for a listener that has not connected says so, and that it can be lost", async () => {
    const fake = daemon("sent.sock", JSON.stringify({ ok: true, id: MESSAGE_ID, outcome: "sent" }));
    try {
      const result = await sendMessage(note, { path: fake.path });
      expect(result.ok).toBe(true);
      expect(result.id).toBe(MESSAGE_ID);
      expect(result.text).toContain("held for task");
      expect(result.text).toContain("120 s");
      expect(result.text).toContain("dropped unseen");
      expect(result.text).not.toContain("delivered to");
    } finally {
      fake.stop();
    }
  });

  test("every reply code has its own wording, and only a daemon that predates the frame is told to update", async () => {
    const wording = {
      invalid: "may predate send_message (`seanced update`)",
      unbound: "not in a tmux pane this machine's daemon can see",
      unsupported: "runs no message delivery",
      stopping: "is stopping",
      internal: "hit an error handling the message",
      unknown: `no launch record of task ${TO}`,
      ended: `task ${TO} has no live session on this machine`,
      too_long: "too long",
      rate_limited: "20 a minute and 200 an hour per task",
      held: "is starting on this machine and has no session yet; nothing was kept",
    } as const;
    expect(Object.keys(wording).toSorted()).toEqual([...MESSAGE_REPLY_CODES].toSorted());
    for (const [code, text] of Object.entries(wording)) {
      const fake = daemon(`${code}.sock`, JSON.stringify({ ok: false, code }));
      try {
        // oxlint-disable-next-line no-await-in-loop -- one daemon double per code
        const result = await sendMessage(note, { path: fake.path });
        expect(result.ok).toBe(false);
        expect(result.text).toContain(text);
        expect(result.text.includes("seanced update")).toBe(code === "invalid");
      } finally {
        fake.stop();
      }
    }
  });

  test("ended with nolistener says the account lacks the inbox mod", async () => {
    const fake = daemon("nolistener.sock", JSON.stringify({ ok: false, code: "ended", reason: "nolistener" }));
    try {
      const result = await sendMessage(note, { path: fake.path });
      expect(result.ok).toBe(false);
      expect(result.text).toContain("has no inbox listener");
      expect(result.text).toContain("`seanced mod install`");
    } finally {
      fake.stop();
    }
  });

  test("a message over a cap is refused locally and sends nothing", async () => {
    const fake = daemon("cap.sock", JSON.stringify({ ok: true, id: MESSAGE_ID, outcome: "delivered" }));
    try {
      const big = await sendMessage({ ...note, text: "x".repeat(MESSAGE_MAX + 1) }, { path: fake.path });
      expect(big.ok).toBe(false);
      expect(big.text).toContain("too long");
      const request = await sendMessage(
        { ...note, kind: "request", text: "x".repeat(MESSAGE_PUSH_MAX + 1) },
        { path: fake.path },
      );
      expect(request.ok).toBe(false);
      // Bytes, not characters: a multi-byte text just over the push cap is over it.
      const wide = await sendMessage(
        { ...note, kind: "request", text: "é".repeat(MESSAGE_PUSH_MAX / 2 + 1) },
        { path: fake.path },
      );
      expect(wide.ok).toBe(false);
      // A long note is not refused: it arrives as a stub.
      expect((await sendMessage({ ...note, text: "x".repeat(MESSAGE_PUSH_MAX + 1) }, { path: fake.path })).ok).toBe(
        true,
      );
      expect(fake.frames.length).toBe(1);
    } finally {
      fake.stop();
    }
  });

  test("a malformed target or reply id is refused locally", async () => {
    const fake = daemon("bad.sock", JSON.stringify({ ok: true, id: MESSAGE_ID, outcome: "delivered" }));
    try {
      expect((await sendMessage({ ...note, to: "../etc" }, { path: fake.path })).ok).toBe(false);
      expect((await sendMessage({ ...note, inReplyTo: "nope" }, { path: fake.path })).ok).toBe(false);
      expect(fake.frames).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("no daemon, a daemon that hangs up, and a reply it cannot read each say what happened", async () => {
    expect(await sendMessage(note, { path: join(dir, "absent.sock") })).toEqual({
      ok: false,
      text: "the local daemon is not running",
    });
    const hangup = daemon("hangup.sock", null);
    try {
      const result = await sendMessage(note, { path: hangup.path });
      expect(result.ok).toBe(false);
      expect(result.text).toContain("may predate send_message");
      expect(result.text).toContain("not delivered");
    } finally {
      hangup.stop();
    }
    const odd = daemon("odd.sock", JSON.stringify({ ok: "maybe" }));
    try {
      expect((await sendMessage(note, { path: odd.path })).text).toContain("not a message reply");
    } finally {
      odd.stop();
    }
  });
});
