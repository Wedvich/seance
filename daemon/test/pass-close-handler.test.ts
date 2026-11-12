import { beforeEach, describe, expect, test } from "bun:test";
import { APP_ID, SCHEDULER_ID, type PassCloseResponse, type Plain } from "@seance/shared";
import type { AuditSink } from "../src/audit.ts";
import type { SessionBackend } from "../src/backend.ts";
import { createHandler, createLocalOps, type HandlerContext } from "../src/handlers.ts";

/**
 * `pass-close` at the daemon holding the session: who may ask, what it arms, and what its audit line
 * names (DESIGN.md, "Passing to a successor"). The close itself, at the pane's turn end, is
 * `src/session-events.test.ts`'s.
 */

const lines: string[] = [];
const collect: AuditSink = (line) => void lines.push(line);
const armed: string[] = [];

const backend: SessionBackend = {
  spawn: () => Promise.reject(new Error("unused")),
  sessions: () => Promise.resolve([]),
  doctor: () => Promise.resolve([]),
};

function ctx(arm?: (taskId: string) => Promise<PassCloseResponse>): HandlerContext {
  return {
    backend,
    getRepos: () => [],
    rescan: () => Promise.resolve([]),
    auditSink: collect,
    ...(arm === undefined ? {} : { armPassClose: arm }),
  };
}

const ok = (taskId: string): Promise<PassCloseResponse> => {
  armed.push(taskId);
  return Promise.resolve({ ok: true });
};
const request = (payload: unknown): Plain => ({ id: "req-1", ts: Date.now(), op: "pass-close", payload });
const logged = (): string => lines.join("\n");

beforeEach(() => {
  lines.length = 0;
  armed.length = 0;
});

describe("pass-close", () => {
  test("the scheduler's seal arms the close for the task and the audit line names the task and the outcome", async () => {
    const reply = await createHandler(ctx(ok))(request({ taskId: "t-1" }), SCHEDULER_ID);
    expect(reply?.payload).toEqual({ ok: true });
    expect(armed).toEqual(["t-1"]);
    expect(logged()).toContain('audit pass-close origin=relay task="t-1" outcome=armed');
  });

  test("only the scheduler's seal may ask, and nothing is armed for anyone else", async () => {
    for (const from of [APP_ID, undefined]) {
      // oxlint-disable-next-line no-await-in-loop -- two asks, one outcome each
      const reply = await createHandler(ctx(ok))(request({ taskId: "t-1" }), from);
      expect(reply?.payload).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(armed).toEqual([]);
    expect(logged()).not.toContain("audit pass-close");
  });

  test("a malformed request is invalid_request, with nothing armed", async () => {
    for (const payload of [{}, { taskId: 7 }, { taskId: "has space" }, null, "t-1"]) {
      lines.length = 0;
      // oxlint-disable-next-line no-await-in-loop -- each case is its own reply
      const reply = await createHandler(ctx(ok))(request(payload), SCHEDULER_ID);
      expect(reply?.payload).toMatchObject({ ok: false, code: "invalid_request" });
      // Audited with no task: nothing in it parsed.
      expect(logged()).toContain("audit pass-close origin=relay task=- outcome=invalid_request");
    }
    expect(armed).toEqual([]);
  });

  test("a daemon running no session-event ingest answers unsupported", async () => {
    const reply = await createHandler(ctx())(request({ taskId: "t-1" }), SCHEDULER_ID);
    expect(reply?.payload).toMatchObject({ ok: false, code: "unsupported" });
  });

  test("a task no live pane carries is answered as the ingest says, and audited under that code", async () => {
    const reply = await createHandler(
      ctx(() => Promise.resolve({ ok: false, code: "no_pane", message: "no live pane carries the task" })),
    )(request({ taskId: "t-1" }), SCHEDULER_ID);
    expect(reply?.payload).toMatchObject({ ok: false, code: "no_pane" });
    expect(logged()).toContain('audit pass-close origin=relay task="t-1" outcome=no_pane');
  });

  test("the leader reaching its own machine runs the same op under its own origin", async () => {
    const reply = await createLocalOps(ctx(ok), "leader").passClose({ taskId: "t-1" });
    expect(reply).toEqual({ ok: true });
    expect(armed).toEqual(["t-1"]);
    expect(logged()).toContain('audit request origin=leader op="pass-close"');
    expect(logged()).toContain('audit pass-close origin=leader task="t-1" outcome=armed');
  });
});
