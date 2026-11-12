import { describe, expect, test } from "bun:test";
import { promptBasis } from "./amend.ts";
import { AMEND_READ_FAILURES, parseAmendDraft, sendAmend, type AmendDraft, type AmendSender } from "./amend-client.ts";
import type { StoreRefusal, TaskLookup } from "./app-client.ts";
import type { AmendRequest, Task, TaskReply } from "./types.ts";

function task(prompt: string | undefined): Task {
  return {
    id: "t-1",
    spec: { repo: "github.com/acme/app", mode: "worktree", ...(prompt === undefined ? {} : { prompt }) },
    state: "queued",
    createdAt: 1,
  };
}

/** A client whose store and leader answer from scripts, recording every call. */
function client(
  reads: readonly (TaskLookup | StoreRefusal | null)[],
  answers: readonly (TaskReply | null)[],
): AmendSender & { readonly sent: AmendRequest[]; readonly reads: number } {
  const sent: AmendRequest[] = [];
  let read = 0;
  let answered = 0;
  return {
    sent,
    get reads() {
      return read;
    },
    getTask: async () => reads[Math.min(read++, reads.length - 1)] ?? null,
    amend: async (request) => {
      sent.push(request);
      return answers[Math.min(answered++, answers.length - 1)] ?? null;
    },
  };
}

const found = (prompt: string | undefined): TaskLookup => ({ ok: true, task: { version: 1, task: task(prompt) } });
const landed: TaskReply = { task: task("do it\n\nalso") };
const changed: TaskReply = { ok: false, code: "prompt_changed", message: "moved" };
const append: AmendDraft = { taskId: "t-1", prompt: { mode: "append", text: "also" } };

describe("sendAmend", () => {
  test("a draft with no prompt is sent as it is, with no read", async () => {
    const c = client([], [landed]);
    expect(await sendAmend(c, { taskId: "t-1", title: "x" })).toEqual(landed);
    expect(c.reads).toBe(0);
    expect(c.sent).toEqual([{ taskId: "t-1", title: "x" }]);
  });

  test("a draft naming its own basis is sent with it, with no read", async () => {
    const c = client([], [landed]);
    const basis = await promptBasis("mine");
    await sendAmend(c, { ...append, basis });
    expect(c.reads).toBe(0);
    expect(c.sent).toEqual([{ ...append, basis }]);
  });

  test("a prompt without a basis reads the task and names the prompt it holds", async () => {
    const c = client([found("do it")], [landed]);
    expect(await sendAmend(c, append)).toEqual(landed);
    expect(c.sent).toEqual([{ ...append, basis: await promptBasis("do it") }]);
  });

  test("prompt_changed is sent again on the prompt read afresh, three times in all", async () => {
    const c = client([found("one"), found("two"), found("three"), found("four")], [changed]);
    expect(await sendAmend(c, append)).toEqual(changed);
    expect(c.reads).toBe(3);
    expect(c.sent.map((r) => r.basis)).toEqual([
      await promptBasis("one"),
      await promptBasis("two"),
      await promptBasis("three"),
    ]);

    const settles = client([found("one"), found("two")], [changed, landed]);
    expect(await sendAmend(settles, append)).toEqual(landed);
    expect(settles.sent).toHaveLength(2);
  });

  test("another refusal and a lost answer are never sent again: a lost one may have landed", async () => {
    const refused: TaskReply = { ok: false, code: "placed", message: "placed" };
    const r = client([found("do it")], [refused]);
    expect(await sendAmend(r, append)).toEqual(refused);
    expect(r.sent).toHaveLength(1);

    const lost = client([found("do it")], [null]);
    expect(await sendAmend(lost, append)).toBeNull();
    expect(lost.sent).toHaveLength(1);
  });

  test("a read that fails sends nothing, and says why", async () => {
    const cases: readonly [TaskLookup | StoreRefusal | null, keyof typeof AMEND_READ_FAILURES][] = [
      [null, "unread"],
      [{ ok: false, code: "rate_limited" }, "unread"],
      [{ ok: true, task: null }, "task_not_found"],
      [{ ok: true, task: { key: "task:t-1", version: 1, reason: "unopenable" } }, "unreadable"],
    ];
    for (const [read, code] of cases) {
      const c = client([read], [landed]);
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      expect(await sendAmend(c, append)).toEqual({ ok: false, code, message: AMEND_READ_FAILURES[code] });
      expect(c.sent).toEqual([]);
    }
  });
});

describe("parseAmendDraft", () => {
  test("takes a prompt with or without a basis, and drops no field it carries", () => {
    expect(parseAmendDraft(append)).toEqual(append);
    const basis = "b".repeat(64);
    expect(parseAmendDraft({ ...append, basis })).toEqual({ ...append, basis });
    expect(parseAmendDraft({ taskId: "t-1", effort: null })).toEqual({ taskId: "t-1", effort: null });
  });

  test("holds the leader parser's other rules", () => {
    expect(parseAmendDraft({ taskId: "t-1", basis: "b".repeat(64), title: "x" })).toBeNull();
    expect(parseAmendDraft({ ...append, basis: "nope" })).toBeNull();
    expect(parseAmendDraft({ ...append, prompt: { mode: "append", text: " " } })).toBeNull();
    expect(parseAmendDraft({ taskId: "t-1" })).toBeNull();
    expect(parseAmendDraft("t-1")).toBeNull();
  });
});
