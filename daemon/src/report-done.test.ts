import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handOff, passToSuccessor, reportDone } from "./report-done.ts";

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

describe("handOff", () => {
  test("sends a stateless handoff frame carrying the pane, and tells the session to end its turn on ok", async () => {
    const fake = daemon("handoff-ok.sock", JSON.stringify({ ok: true }));
    try {
      const result = await handOff({ path: fake.path, pane: "%7" });
      expect(result.ok).toBe(true);
      expect(result.text).toContain("End the turn now");
      expect(fake.frames).toEqual([{ v: 1, kind: "session-event", handoff: true, pane: "%7" }]);
    } finally {
      fake.stop();
    }
  });

  test("a hand-off after a pass is refused as such: there is no PR left to watch", async () => {
    const fake = daemon("handoff-passed.sock", JSON.stringify({ ok: false, code: "passed" }));
    try {
      const result = await handOff({ path: fake.path, pane: "%1" });
      expect(result.ok).toBe(false);
      expect(result.text).toContain("already passed its task to a successor");
    } finally {
      fake.stop();
    }
  });

  test("every refusal tells the session to keep watching the PR itself", async () => {
    const codes = ["untasked", "unbound", "invalid", "unsupported", "unrecorded", "unwritten", "stopping", "prless"];
    for (const code of codes) {
      const fake = daemon(`handoff-${code}.sock`, JSON.stringify({ ok: false, code }));
      try {
        // oxlint-disable-next-line no-await-in-loop -- one daemon double per code
        const result = await handOff({ path: fake.path, pane: "%1" });
        expect(result.ok).toBe(false);
        expect(result.text).toEndWith("keep watching the PR yourself");
        expect(result.text.includes("seanced update")).toBe(code === "invalid");
      } finally {
        fake.stop();
      }
    }
  });
});

describe("passToSuccessor", () => {
  const ack = { taskId: "t1", remoteBranch: "feature/x", tip: "a".repeat(40), pushed: true };

  test("sends a stateless pass frame carrying the record and pane, and returns what the daemon pushed", async () => {
    const fake = daemon("pass-ok.sock", JSON.stringify({ ok: true, pass: ack }));
    try {
      const result = await passToSuccessor("done: a; left: b", { path: fake.path, pane: "%7" });
      expect(result).toEqual({ ok: true, text: "pushed, and the pass was sent to the scheduler", pass: ack });
      expect(fake.frames).toEqual([
        { v: 1, kind: "session-event", pass: true, record: "done: a; left: b", pane: "%7" },
      ]);
    } finally {
      fake.stop();
    }
  });

  test("an ok with no readable ack is still an ok, carrying no pass", async () => {
    for (const [i, pass] of [undefined, { ...ack, remoteBranch: "bad..name" }, "junk"].entries()) {
      const fake = daemon(`pass-noack-${i}.sock`, JSON.stringify({ ok: true, pass }));
      try {
        // oxlint-disable-next-line no-await-in-loop -- one daemon double per case
        expect(await passToSuccessor("r", { path: fake.path, pane: "%1" })).toEqual({
          ok: true,
          text: "pushed, and the pass was sent to the scheduler",
        });
      } finally {
        fake.stop();
      }
    }
  });

  test("each refusal is worded for the agent, and says whether anything was pushed", async () => {
    const wording = {
      untasked: "nothing to pass",
      unbound: "not in a tmux pane",
      invalid: "predates passing; restart seanced (`seanced update`)",
      unsupported: "runs no session-event ingest",
      unrecorded: "holds no launch of this session's task",
      stopping: "daemon is stopping",
      here: "runs in place",
      dirty_worktree: "commit your changes first, or discard what should not be carried (a stash is never pushed",
      detached_head: "on no branch",
      default_branch: "default branch",
      no_upstream: "git push -u origin HEAD:<pr branch>",
      push_rejected: "nothing was forced",
      push_failed: "did not complete",
      unsent: "the branch is pushed, but",
      stopping_pushed: "the branch is pushed, but this machine's daemon is stopping and sent no pass",
      cancelled: "cancelled before the pass was sent",
      passed: "already passed its task",
    } as const;
    for (const [code, text] of Object.entries(wording)) {
      const fake = daemon(`pass-${code}.sock`, JSON.stringify({ ok: false, code }));
      try {
        // oxlint-disable-next-line no-await-in-loop -- one daemon double per code
        const result = await passToSuccessor("r", { path: fake.path, pane: "%1" });
        expect(result.ok).toBe(false);
        expect(result.text).toContain(text);
        expect(result.pass).toBeUndefined();
      } finally {
        fake.stop();
      }
    }
  });

  test("no answer is not a refusal: a lost connection or a cancelled call says the pass may have gone through", async () => {
    const path = join(dir, "silent.sock");
    const seen: string[] = [];
    const server = Bun.listen<undefined>({
      unix: path,
      socket: {
        data: (sock, chunk) => {
          seen.push(chunk.toString("utf8"));
          sock.end();
        },
      },
    });
    try {
      const lost = await passToSuccessor("r", { path, pane: "%1" });
      expect(lost.ok).toBe(false);
      expect(lost.unanswered).toBe(true);
      expect(seen).toHaveLength(1);
    } finally {
      server.stop(true);
    }

    // A cancelled call closes the connection unanswered, which is what tells the daemon the caller is gone.
    const held = join(dir, "held.sock");
    let closedByCaller: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      closedByCaller = resolve;
    });
    const slow = Bun.listen<undefined>({ unix: held, socket: { data: () => {}, close: () => closedByCaller() } });
    try {
      const controller = new AbortController();
      const pending = passToSuccessor("r", { path: held, pane: "%1", signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      const result = await pending;
      expect(result.unanswered).toBe(true);
      await closed;
      // Already aborted: no request is left standing at all.
      expect((await passToSuccessor("r", { path: held, pane: "%1", signal: controller.signal })).unanswered).toBe(true);
    } finally {
      slow.stop(true);
    }
  });

  test("a code no pass words is refused, never taken as ok", async () => {
    const odd = daemon("pass-odd.sock", JSON.stringify({ ok: false, code: "new_code" }));
    try {
      expect((await passToSuccessor("r", { path: odd.path, pane: "%1" })).ok).toBe(false);
    } finally {
      odd.stop();
    }
    expect(await passToSuccessor("r", { path: join(dir, "absent.sock"), pane: "%1" })).toEqual({
      ok: false,
      text: "the local daemon is not running",
    });
  });
});
