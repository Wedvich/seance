import { beforeEach, describe, expect, test } from "bun:test";
import {
  APP_ID,
  SCHEDULER_ID,
  type DeliverMessageRequest,
  type MessageReceiptRequest,
  type Plain,
} from "@seance/shared";
import type { AuditSink } from "../src/audit.ts";
import type { SessionBackend } from "../src/backend.ts";
import { createHandler, createLocalOps, type HandlerContext } from "../src/handlers.ts";

/**
 * `deliver-message` and `message-receipt` at the daemon: who may send them and what reaches the messaging module
 * (DESIGN.md, "Session messages"). What the module does with them is `messages.test.ts`'s.
 */

const ID = "5f0c1c1e-8a5f-4d3a-9d6e-0a3f4a2b7c11";
const TO = "t-0123456789abcdef";
const SECRET = "SECRET-MESSAGE-TEXT";

const backend: SessionBackend = {
  spawn: () => Promise.reject(new Error("unused")),
  sessions: () => Promise.resolve([]),
  doctor: () => Promise.resolve([]),
};

const lines: string[] = [];
const collect: AuditSink = (line) => void lines.push(line);
const delivered: DeliverMessageRequest[] = [];
const receipts: MessageReceiptRequest[] = [];

function ctx(withMessages = true): HandlerContext {
  return {
    backend,
    getRepos: () => [],
    rescan: () => Promise.resolve([]),
    auditSink: collect,
    ...(withMessages
      ? {
          messages: {
            deliverRouted: (request) => {
              delivered.push(request);
              return Promise.resolve({ ok: true, outcome: "delivered" });
            },
            receipt: (request) => {
              receipts.push(request);
              return Promise.resolve({ ok: true, outcome: "delivered" });
            },
          },
        }
      : {}),
  };
}

const deliver = {
  id: ID,
  taskId: TO,
  addressed: TO,
  kind: "note",
  text: SECRET,
  fromMachine: "MsgBox",
} as const;
const receipt = { id: ID, to: TO, kind: "note", outcome: "delivered" } as const;

const request = (op: "deliver-message" | "message-receipt", payload: unknown): Plain => ({
  id: "req-1",
  ts: Date.now(),
  op,
  payload,
});

beforeEach(() => {
  lines.length = 0;
  delivered.length = 0;
  receipts.length = 0;
});

interface OpCase {
  readonly op: "deliver-message" | "message-receipt";
  readonly valid: Readonly<Record<string, unknown>>;
  readonly seen: unknown[];
}

const CASES: readonly OpCase[] = [
  { op: "deliver-message", valid: deliver, seen: delivered },
  { op: "message-receipt", valid: receipt, seen: receipts },
];

for (const { op, valid, seen } of CASES) {
  describe(op, () => {
    test("the scheduler's seal delegates to the messaging module", async () => {
      const reply = await createHandler(ctx())(request(op, valid), SCHEDULER_ID);
      expect(reply?.payload).toMatchObject({ ok: true, outcome: "delivered" });
      expect(seen).toHaveLength(1);
    });

    test("only the scheduler may send it: an app, a daemon and an unsealed caller get invalid_request and nothing runs", async () => {
      for (const from of [APP_ID, "d-other", undefined]) {
        // oxlint-disable-next-line no-await-in-loop -- one reply per sender
        const reply = await createHandler(ctx())(request(op, valid), from);
        expect(reply?.payload).toMatchObject({ ok: false, code: "invalid_request" });
      }
      expect(seen).toEqual([]);
    });

    test("a malformed request is invalid_request, with nothing delivered", async () => {
      for (const payload of [{}, null, "text", { ...valid, id: "nope" }, { ...valid, kind: "shout" }]) {
        // oxlint-disable-next-line no-await-in-loop -- one reply per payload
        const reply = await createHandler(ctx())(request(op, payload), SCHEDULER_ID);
        expect(reply?.payload).toMatchObject({ ok: false, code: "invalid_request" });
      }
      expect(seen).toEqual([]);
    });

    test("a daemon running no messaging answers unsupported", async () => {
      const reply = await createHandler(ctx(false))(request(op, valid), SCHEDULER_ID);
      expect(reply?.payload).toMatchObject({ ok: false, code: "unsupported" });
    });

    test("no reply and no audit line carries the text", async () => {
      const reply = await createHandler(ctx())(request(op, valid), SCHEDULER_ID);
      expect(JSON.stringify(reply?.payload)).not.toContain(SECRET);
      expect(lines.join("\n")).not.toContain(SECRET);
    });
  });
}

describe("the leader reaching its own machine", () => {
  test("runs the same ops in process, under its own origin", async () => {
    const ops = createLocalOps(ctx(), "leader");
    expect(await ops.deliverMessage(deliver)).toMatchObject({ ok: true, outcome: "delivered" });
    expect(await ops.messageReceipt(receipt)).toMatchObject({ ok: true, outcome: "delivered" });
    expect(delivered).toHaveLength(1);
    expect(receipts).toHaveLength(1);
    expect(lines.join("\n")).toContain('audit request origin=leader op="deliver-message"');
    expect(lines.join("\n")).toContain('audit request origin=leader op="message-receipt"');
  });

  test("a malformed payload is still invalid_request", async () => {
    const ops = createLocalOps(ctx(), "leader");
    expect(await ops.deliverMessage({})).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await ops.messageReceipt(null)).toMatchObject({ ok: false, code: "invalid_request" });
  });
});
