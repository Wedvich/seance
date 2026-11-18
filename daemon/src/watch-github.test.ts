import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WATCH_REPLY_CODES } from "./watch-frame.ts";
import { unwatchGithub, watchGithub, type WatchGate } from "./watch-github.ts";

const dir = await mkdtemp(join(tmpdir(), "seance-watchgh-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const PR = "https://github.com/acme/widgets/pull/42";
const RUN = "https://github.com/acme/widgets/actions/runs/123456789";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const ID = "5f0c1c1e-8a5f-4d3a-9d6e-0a3f4a2b7c11";

const open: WatchGate = () => Promise.resolve({ ok: true });

/**
 * A daemon double on a unix socket: records each frame and answers one line, hangs up when `answer` is null, or never
 * answers when it is `"silent"`.
 */
function daemon(name: string, answer: string | null | "silent"): { path: string; frames: unknown[]; stop: () => void } {
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
        if (answer === "silent") return;
        if (answer === null) sock.end();
        else sock.write(`${answer}\n`);
      },
    },
  });
  return { path, frames, stop: () => server.stop(true) };
}

async function withDaemon<T>(
  name: string,
  answer: string | null | "silent",
  fn: (fake: { path: string; frames: unknown[] }) => Promise<T>,
): Promise<T> {
  const fake = daemon(name, answer);
  try {
    return await fn(fake);
  } finally {
    fake.stop();
  }
}

const refusal = (code: string): string => JSON.stringify({ ok: false, code });

describe("watchGithub", () => {
  test("sends exactly the add frame, `head` only when given, and tells the session to end its turn", async () => {
    await withDaemon("add.sock", JSON.stringify({ ok: true, id: ID, kind: "pr" }), async (fake) => {
      const made = await watchGithub({ url: PR, head: HEAD }, open, { path: fake.path });
      expect(made.ok).toBe(true);
      expect(made.id).toBe(ID);
      expect(made.kind).toBe("pr");
      expect(made.text).toContain(ID);
      expect(made.text).toContain("End your turn");
      expect(made.text).toContain("Do not poll");
      await watchGithub({ url: RUN }, open, { path: fake.path });
      expect(fake.frames).toEqual([
        { v: 1, kind: "watch", op: "add", url: PR, head: HEAD },
        { v: 1, kind: "watch", op: "add", url: RUN },
      ]);
    });
  });

  test("a URL, a head on a run or a short head is refused before the gate or the daemon is asked", async () => {
    let gated = 0;
    const gate: WatchGate = () => {
      gated += 1;
      return Promise.resolve({ ok: true });
    };
    await withDaemon("local.sock", JSON.stringify({ ok: true, id: ID, kind: "pr" }), async (fake) => {
      const opts = { path: fake.path };
      const foreign = await watchGithub({ url: "https://gitlab.com/acme/widgets/-/merge_requests/1" }, gate, opts);
      expect(foreign.ok).toBe(false);
      expect(foreign.text).toContain("not a GitHub pull request");
      const runHead = await watchGithub({ url: RUN, head: HEAD }, gate, opts);
      expect(runHead.text).toContain("pull request only");
      const shortHead = await watchGithub({ url: PR, head: "abc123" }, gate, opts);
      expect(shortHead.text).toContain("full commit sha");
      expect(gated).toBe(0);
      expect(fake.frames).toEqual([]);
    });
  });

  test("a refused gate sends nothing and says how to wait instead, rebuilt from the parsed URL", async () => {
    const gate: WatchGate = () => Promise.resolve({ ok: false, text: "no verified scheduler is leading" });
    await withDaemon("gate.sock", JSON.stringify({ ok: true, id: ID, kind: "pr" }), async (fake) => {
      const pr = await watchGithub({ url: PR }, gate, { path: fake.path });
      expect(pr).toEqual({
        ok: false,
        text: "not watched: no verified scheduler is leading; wait on it yourself instead, in the background: `gh pr checks 42 -R acme/widgets --watch -i 30 --fail-fast` (never more often than every 30 s)",
      });
      const run = await watchGithub({ url: `${RUN}/attempts/2` }, gate, { path: fake.path });
      expect(run.text).toContain("`gh run watch 123456789 -R acme/widgets -i 30 --exit-status`");
      const thrown = await watchGithub({ url: PR }, () => Promise.reject(new Error("relay down")), {
        path: fake.path,
      });
      expect(thrown.text).toStartWith("not watched: relay down; ");
      expect(fake.frames).toEqual([]);
    });
  });

  test("every refusal code has its own words and ends with the fallback", async () => {
    const texts = new Map<string, string>();
    for (const code of WATCH_REPLY_CODES) {
      // oxlint-disable-next-line no-await-in-loop -- one double per code, in turn
      const result = await withDaemon(`code-${code}.sock`, refusal(code), (fake) =>
        watchGithub({ url: PR }, open, { path: fake.path }),
      );
      expect(result.ok).toBe(false);
      expect(result.text).toStartWith("not watched: ");
      expect(result.text).toContain("gh pr checks 42 -R acme/widgets --watch -i 30 --fail-fast");
      texts.set(code, result.text);
    }
    expect(new Set(texts.values()).size).toBe(WATCH_REPLY_CODES.length);
    expect(texts.get("nolistener")).toContain("inbox mod");
    expect(texts.get("too_many")).toContain("unwatch_github");
    expect(texts.get("no_leader")).toContain("no scheduler leader");
    expect(texts.get("unbound")).toContain("tmux pane");
    expect(texts.get("stopping")).toContain("call again");
  });

  test("a dropped connection or an answer that is no watch reply reads as unsupported", async () => {
    const unsupported = await withDaemon("code-unsupported-ref.sock", refusal("unsupported"), (fake) =>
      watchGithub({ url: PR }, open, { path: fake.path }),
    );
    const closed = await withDaemon("closed.sock", null, (fake) => watchGithub({ url: PR }, open, { path: fake.path }));
    expect(closed).toEqual(unsupported);
    expect(closed.text).toContain("gh pr checks");
    for (const answer of ["not json", JSON.stringify({ ok: true }), JSON.stringify({ ok: false, code: "nope" })]) {
      // oxlint-disable-next-line no-await-in-loop -- one double per answer, in turn
      const odd = await withDaemon("odd.sock", answer, (fake) => watchGithub({ url: PR }, open, { path: fake.path }));
      expect(odd).toEqual(unsupported);
    }
  });

  test("no daemon and no answer keep their own words", async () => {
    const none = await watchGithub({ url: PR }, open, { path: join(dir, "absent.sock") });
    expect(none.ok).toBe(false);
    expect(none.text).toStartWith("not watched: the local daemon is not running");
    expect(none.text).not.toContain("may or may not");
    const silent = await withDaemon("silent.sock", "silent", (fake) =>
      watchGithub({ url: PR }, open, { path: fake.path, timeoutMs: 100 }),
    );
    expect(silent.ok).toBe(false);
    expect(silent.text).toContain("may or may not have been made");
    expect(silent.text).toContain("replaces it");
  });
});

describe("unwatchGithub", () => {
  test("sends exactly the remove frame and is not gated", async () => {
    await withDaemon("remove.sock", JSON.stringify({ ok: true }), async (fake) => {
      expect(await unwatchGithub(ID, { path: fake.path })).toEqual({ ok: true, text: `watch ${ID} removed` });
      expect(fake.frames).toEqual([{ v: 1, kind: "watch", op: "remove", id: ID }]);
    });
  });

  test("a malformed id sends nothing; unknown, a dropped connection and no daemon are worded", async () => {
    await withDaemon("remove-bad.sock", JSON.stringify({ ok: true }), async (fake) => {
      expect((await unwatchGithub("w-1", { path: fake.path })).text).toContain("not a watch id");
      expect(fake.frames).toEqual([]);
    });
    const unknown = await withDaemon("remove-unknown.sock", refusal("unknown"), (fake) =>
      unwatchGithub(ID, { path: fake.path }),
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("no such watch");
    const closed = await withDaemon("remove-closed.sock", null, (fake) => unwatchGithub(ID, { path: fake.path }));
    expect(closed.text).toContain("keeps no watches");
    const none = await unwatchGithub(ID, { path: join(dir, "absent.sock") });
    expect(none.text).toBe("the local daemon is not running; nothing was sent");
  });
});
