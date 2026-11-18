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

/** As `daemon`, but answering each frame with the next line, so a two-frame exchange can be scripted. */
function scripted(name: string, answers: readonly string[]): { path: string; frames: unknown[]; stop: () => void } {
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
        sock.write(`${answers[frames.length - 1] ?? JSON.stringify({ ok: false, code: "internal" })}\n`);
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
      invalid: "may predate send_message (`seance update`)",
      unbound: "not in a tmux pane this machine's daemon can see",
      unsupported: "runs no message delivery",
      stopping: "is stopping",
      internal: "hit an error handling the message",
      unknown: `no launch record of task ${TO}`,
      ended: `task ${TO} has no live session on this machine`,
      too_long: "too long",
      rate_limited: "20 a minute and 200 an hour per task",
      held: "is starting on this machine and has no session yet; nothing was kept",
      remote: "cannot route through the scheduler",
      no_leader: "could not reach a scheduler leader",
      refused: "does not serve this session's repository",
    } as const;
    expect(Object.keys(wording).toSorted()).toEqual([...MESSAGE_REPLY_CODES].toSorted());
    for (const [code, text] of Object.entries(wording)) {
      const fake = daemon(`${code}.sock`, JSON.stringify({ ok: false, code }));
      try {
        // oxlint-disable-next-line no-await-in-loop -- one daemon double per code
        const result = await sendMessage(note, { path: fake.path });
        expect(result.ok).toBe(false);
        expect(result.text).toContain(text);
        expect(result.text.includes("seance update")).toBe(code === "invalid");
      } finally {
        fake.stop();
      }
    }
  });

  test("to an adapter: one exchange, the subscribed conversation named, `leave` carried, refusals naming the adapter", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const session = "00000001-aaaa-4bbb-8ccc-dddddddddddd";
    const subscribed = daemon(
      "adapter-sub.sock",
      JSON.stringify({ ok: true, id, outcome: "delivered", subscribed: true, session, adapter: "tg" }),
    );
    try {
      const result = await sendMessage({ to: "adapter:tg", kind: "question", text: "hi" }, { path: subscribed.path });
      expect(result).toMatchObject({ ok: true, session });
      expect(result.text).toContain(`This conversation, ${session}, is subscribed`);
      expect(subscribed.frames).toEqual([
        { v: 1, kind: "message", to: "adapter:tg", messageKind: "question", text: "hi" },
      ]);
    } finally {
      subscribed.stop();
    }
    const left = daemon(
      "adapter-leave.sock",
      JSON.stringify({ ok: true, id, outcome: "delivered", subscribed: false }),
    );
    try {
      const result = await sendMessage({ to: "adapter:tg", kind: "note", text: "", leave: true }, { path: left.path });
      expect(result.ok).toBe(true);
      expect(result).not.toHaveProperty("session");
      expect(result.text).toContain("subscription to it has ended");
      expect(left.frames).toEqual([
        { v: 1, kind: "message", to: "adapter:tg", messageKind: "note", text: "", leave: true },
      ]);
    } finally {
      left.stop();
    }
    const refused = daemon("adapter-refused.sock", JSON.stringify({ ok: false, code: "unknown" }));
    try {
      const result = await sendMessage({ to: "adapter:tg", kind: "note", text: "x" }, { path: refused.path });
      expect(result.ok).toBe(false);
      expect(result.text).toContain("no adapter named tg");
    } finally {
      refused.stop();
    }
  });

  test("ended with nolistener says the account lacks the inbox mod", async () => {
    const fake = daemon("nolistener.sock", JSON.stringify({ ok: false, code: "ended", reason: "nolistener" }));
    try {
      const result = await sendMessage(note, { path: fake.path });
      expect(result.ok).toBe(false);
      expect(result.text).toContain("has no inbox listener");
      expect(result.text).toContain("`seance mod install`");
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

  describe("a reply by handle", () => {
    const reply = { kind: "note", text: "it is src/a.ts", inReplyTo: MESSAGE_ID } as const;

    test("sends a frame with no `to`, words the delivery for the session that sent the message, and a `to` equal to the handle is the same reply", async () => {
      const fake = daemon("reply.sock", JSON.stringify({ ok: true, id: MESSAGE_ID, outcome: "delivered" }));
      try {
        const result = await sendMessage(reply, { path: fake.path });
        expect(result.text).toBe(`delivered to the session that sent message ${MESSAGE_ID} as message ${MESSAGE_ID}`);
        const again = await sendMessage({ ...reply, to: MESSAGE_ID }, { path: fake.path });
        expect(again.ok).toBe(true);
        for (const frame of fake.frames) {
          expect(frame).toEqual({
            v: 1,
            kind: "message",
            messageKind: "note",
            text: "it is src/a.ts",
            inReplyTo: MESSAGE_ID,
          });
        }
      } finally {
        fake.stop();
      }
    });

    test("with neither `to` nor `inReplyTo` it is refused locally and sends nothing", async () => {
      const fake = daemon("neither.sock", JSON.stringify({ ok: true, id: MESSAGE_ID, outcome: "delivered" }));
      try {
        const result = await sendMessage({ kind: "note", text: "x" }, { path: fake.path });
        expect(result.ok).toBe(false);
        expect(result.text).toContain("`inReplyTo`");
        expect(fake.frames).toEqual([]);
      } finally {
        fake.stop();
      }
    });

    test("unknown, ended and held are worded for a message, not for a task's launch record", async () => {
      for (const code of ["unknown", "ended", "held"] as const) {
        const fake = daemon(`reply-${code}.sock`, JSON.stringify({ ok: false, code }));
        try {
          // oxlint-disable-next-line no-await-in-loop -- one double per code
          const result = await sendMessage(reply, { path: fake.path });
          expect(result.ok).toBe(false);
          expect(result.text).toContain(`message ${MESSAGE_ID}`);
          expect(result.text).not.toContain("launch record");
        } finally {
          fake.stop();
        }
      }
      const unlistened = daemon(
        "reply-nolistener.sock",
        JSON.stringify({ ok: false, code: "ended", reason: "nolistener" }),
      );
      try {
        const result = await sendMessage(reply, { path: unlistened.path });
        expect(result.text).toContain("the session that sent message");
        expect(result.text).toContain("has no inbox listener");
      } finally {
        unlistened.stop();
      }
    });

    test("an invalid answer says the daemon may predate replies, and is never resent without the route key", async () => {
      const fake = scripted("reply-old.sock", [JSON.stringify({ ok: false, code: "invalid" })]);
      try {
        const result = await sendMessage(reply, {
          path: fake.path,
          routeGate: () => Promise.resolve({ ok: true }),
        });
        expect(result.ok).toBe(false);
        expect(result.text).toContain("predate replies");
        expect(result.text).toContain("`seance update`");
        expect(fake.frames).toHaveLength(1);
      } finally {
        fake.stop();
      }
    });

    test("a handle held elsewhere asks the gate for `reply`, then resends with route send", async () => {
      const fake = scripted("reply-remote.sock", [
        JSON.stringify({ ok: false, code: "remote" }),
        JSON.stringify({ ok: true, id: MESSAGE_ID, outcome: "routed" }),
      ]);
      const needs: string[] = [];
      try {
        const result = await sendMessage(reply, {
          path: fake.path,
          routeGate: (need) => {
            needs.push(need);
            return Promise.resolve({ ok: true });
          },
        });
        expect(result.ok).toBe(true);
        expect(result.text).toContain("sent through the scheduler to the session that sent message");
        expect(needs).toEqual(["reply"]);
        expect(fake.frames).toEqual([
          { v: 1, kind: "message", messageKind: "note", text: "it is src/a.ts", inReplyTo: MESSAGE_ID, route: "ask" },
          { v: 1, kind: "message", messageKind: "note", text: "it is src/a.ts", inReplyTo: MESSAGE_ID, route: "send" },
        ]);
      } finally {
        fake.stop();
      }
    });

    test("a gate refusal for replies returns its text, and no gate says the caller cannot route", async () => {
      const fake = scripted("reply-gate.sock", [JSON.stringify({ ok: false, code: "remote" })]);
      try {
        const result = await sendMessage(reply, {
          path: fake.path,
          routeGate: () => Promise.resolve({ ok: false, text: "the leader cannot route replies yet" }),
        });
        expect(result).toEqual({ ok: false, text: "the leader cannot route replies yet" });
      } finally {
        fake.stop();
      }
      const bare = scripted("reply-bare.sock", [JSON.stringify({ ok: false, code: "remote" })]);
      try {
        const result = await sendMessage(reply, { path: bare.path });
        expect(result.ok).toBe(false);
        expect(result.text).toContain("cannot route through the scheduler");
      } finally {
        bare.stop();
      }
    });
  });

  describe("routing across machines", () => {
    const remote = JSON.stringify({ ok: false, code: "remote" });
    const routed = JSON.stringify({ ok: true, id: MESSAGE_ID, outcome: "routed" });
    const gateOk = (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true });

    test("with a gate the first frame asks, a remote answer runs the gate once and the resend says send", async () => {
      const fake = scripted("route.sock", [remote, routed]);
      let asked = 0;
      try {
        const result = await sendMessage(note, {
          path: fake.path,
          routeGate: () => {
            asked += 1;
            return gateOk();
          },
        });
        expect(result.ok).toBe(true);
        expect(result.id).toBe(MESSAGE_ID);
        expect(result.text).toContain("sent through the scheduler");
        expect(result.text).toContain("receipt note");
        expect(asked).toBe(1);
        expect(fake.frames).toEqual([
          { v: 1, kind: "message", to: TO, messageKind: "note", text: "schema v2 landed", route: "ask" },
          { v: 1, kind: "message", to: TO, messageKind: "note", text: "schema v2 landed", route: "send" },
        ]);
      } finally {
        fake.stop();
      }
    });

    test("a local delivery never runs the gate, and no gate sends no route key", async () => {
      const local = scripted("local.sock", [JSON.stringify({ ok: true, id: MESSAGE_ID, outcome: "delivered" })]);
      let asked = 0;
      try {
        const result = await sendMessage(note, {
          path: local.path,
          routeGate: () => {
            asked += 1;
            return gateOk();
          },
        });
        expect(result.text).toContain("delivered to task");
        expect(asked).toBe(0);
      } finally {
        local.stop();
      }
      const bare = scripted("bare.sock", [remote]);
      try {
        const result = await sendMessage(note, { path: bare.path });
        expect(bare.frames).toEqual([{ v: 1, kind: "message", to: TO, messageKind: "note", text: "schema v2 landed" }]);
        expect(result.ok).toBe(false);
        expect(result.text).toContain("cannot route through the scheduler");
      } finally {
        bare.stop();
      }
    });

    test("a gate refusal returns its text and sends no second frame", async () => {
      const fake = scripted("refused.sock", [remote, routed]);
      try {
        const result = await sendMessage(note, {
          path: fake.path,
          routeGate: () => Promise.resolve({ ok: false, text: "the leader needs an update" }),
        });
        expect(result).toEqual({ ok: false, text: "the leader needs an update" });
        expect(fake.frames.length).toBe(1);
      } finally {
        fake.stop();
      }
    });

    test("an invalid answer to an ask resends once without the route key", async () => {
      const fake = scripted("old.sock", [
        JSON.stringify({ ok: false, code: "invalid" }),
        JSON.stringify({ ok: true, id: MESSAGE_ID, outcome: "delivered" }),
      ]);
      let asked = 0;
      try {
        const result = await sendMessage(note, {
          path: fake.path,
          routeGate: () => {
            asked += 1;
            return gateOk();
          },
        });
        expect(result.ok).toBe(true);
        expect(asked).toBe(0);
        expect(fake.frames).toEqual([
          { v: 1, kind: "message", to: TO, messageKind: "note", text: "schema v2 landed", route: "ask" },
          { v: 1, kind: "message", to: TO, messageKind: "note", text: "schema v2 landed" },
        ]);
      } finally {
        fake.stop();
      }
    });

    test("after the fallback, a task the old daemon does not hold is worded as that daemon predating routing", async () => {
      for (const code of ["unknown", "ended"] as const) {
        const fake = scripted(`old-${code}.sock`, [
          JSON.stringify({ ok: false, code: "invalid" }),
          JSON.stringify({ ok: false, code }),
        ]);
        try {
          // oxlint-disable-next-line no-await-in-loop -- one double per code
          const result = await sendMessage(note, { path: fake.path, routeGate: gateOk });
          expect(result.ok).toBe(false);
          expect(result.text).toContain("predates cross-machine messages (`seance update`)");
          expect(result.text).not.toContain("no scheduler route was asked");
        } finally {
          fake.stop();
        }
      }
    });

    test("an untasked sender is told no receipt follows, and a route-budget refusal is worded as one", async () => {
      const untasked = scripted("untasked.sock", [
        remote,
        JSON.stringify({ ok: true, id: MESSAGE_ID, outcome: "routed", receipt: false }),
      ]);
      try {
        const result = await sendMessage(note, { path: untasked.path, routeGate: gateOk });
        expect(result.text).toContain("no receipt follows");
      } finally {
        untasked.stop();
      }
      const long = scripted("long.sock", [remote, JSON.stringify({ ok: false, code: "too_long", reason: "route" })]);
      try {
        const result = await sendMessage(note, { path: long.path, routeGate: gateOk });
        expect(result.ok).toBe(false);
        expect(result.text).toContain("another machine");
        expect(result.text).toContain("40000 bytes");
      } finally {
        long.stop();
      }
    });
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
