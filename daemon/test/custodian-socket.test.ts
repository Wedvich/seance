import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, rmdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { CustodianReply } from "../src/custodian-frame.ts";
import {
  CUSTODIAN_SOCKET_NAME,
  custodianSocketDir,
  removeCustodianSocketDir,
  startCustodianSocket,
  type CustodianSocket,
} from "../src/custodian-socket.ts";
import { CUSTODIAN_SOCKET_DIR, ROUND_TMP } from "../src/seat-record.ts";
import { peerPidSupported } from "../src/peer.ts";
import { pollUntil } from "./fixtures.ts";

/**
 * The round's own socket with real sockets and a real directory. It lives under a literal `/tmp` (the production path
 * is `/tmp/seance-cu-s-XXXXXX/c.sock`), so each test makes its own short directory there: `tmpdir()` on macOS would
 * push the socket path past the 104 bytes a unix socket address holds.
 */

let base = "";
beforeAll(async () => {
  base = await mkdtemp("/tmp/cu-sock-");
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

let n = 0;
const socketIn = (): { readonly dir: string; readonly path: string } => {
  n += 1;
  const dir = join(base, `s${n}`);
  return { dir, path: join(dir, "c.sock") };
};

const running: CustodianSocket[] = [];
afterEach(() => {
  for (const each of running.splice(0)) if ("stop" in each) each.stop();
});

async function start(
  path: string,
  over: Partial<Parameters<typeof startCustodianSocket>[0]> = {},
): Promise<{ readonly stop: () => void; readonly path: string }> {
  const started = await startCustodianSocket({
    path,
    handle: () => Promise.resolve({ ok: true, verb: "done" }),
    warn: () => {},
    ...over,
  });
  running.push(started);
  if ("problem" in started) throw new Error(`did not start: ${started.problem}`);
  return started;
}

/** One line in, the first reply line out (or the close, with whatever arrived). */
async function exchange(path: string, line: string): Promise<{ readonly text: string; readonly closed: boolean }> {
  let text = "";
  let closed = false;
  const sock = await Bun.connect<undefined>({
    unix: path,
    socket: {
      open: (s): void => void s.write(line),
      data: (_s, chunk: Buffer): void => void (text += chunk.toString()),
      close: (): void => void (closed = true),
      error: (): void => void (closed = true),
    },
  });
  await pollUntil(() => text.includes("\n") || closed, "a reply or a close");
  sock.end();
  return { text, closed };
}

const frame = (extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ v: 1, kind: "custodian", verb: "done", summary: "s", ...extra })}\n`;

describe("custodianSocketDir", () => {
  /** Real dirs under the production prefix: each test removes what it made. */
  const made: string[] = [];
  afterEach(async () => {
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const choose = async (
    recorded: string | undefined,
  ): Promise<{ readonly dir: string; readonly reused: boolean; readonly rejected?: string }> => {
    const chosen = await custodianSocketDir(recorded);
    if ("problem" in chosen) throw new Error(chosen.problem);
    made.push(chosen.dir);
    return chosen;
  };

  test("with none recorded: a fresh 0700 dir, unguessable, short enough for a unix socket, and not a round tmp dir", async () => {
    const one = await choose(undefined);
    const two = await choose(undefined);
    expect(one.reused).toBe(false);
    expect(one.dir).toMatch(CUSTODIAN_SOCKET_DIR);
    expect(one.dir).not.toMatch(ROUND_TMP);
    expect(one.dir).not.toBe(two.dir);
    expect((await lstat(one.dir)).mode & 0o777).toBe(0o700);
    expect(Buffer.byteLength(join(one.dir, CUSTODIAN_SOCKET_NAME))).toBeLessThan(104);
  });

  test("a recorded dir of this daemon's own is reused, its mode put back to 0700, and made again when gone", async () => {
    const { dir } = await choose(undefined);
    await chmod(dir, 0o755);
    expect(await choose(dir)).toEqual({ dir, reused: true });
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    await rmdir(dir);
    expect(await choose(dir)).toEqual({ dir, reused: true });
    expect((await lstat(dir)).isDirectory()).toBe(true);
  });

  test("a recorded name planted as a symlink is not used, nothing is made through it, and a fresh dir is served", async () => {
    const target = join(base, "planted-target");
    await mkdir(target);
    // A name of the right shape nobody holds (another run may be planting its own beside it).
    const planted = `/tmp/seance-cu-s-${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`;
    await symlink(target, planted);
    made.push(planted);
    const chosen = await choose(planted);
    expect(chosen.reused).toBe(false);
    expect(chosen.dir).not.toBe(planted);
    expect(chosen.rejected).toContain("not a directory");
    expect(await readdir(target)).toEqual([]);
  });

  test("a recorded path of any other shape is never touched", async () => {
    const other = join(base, "other");
    const chosen = await choose(other);
    expect(chosen.reused).toBe(false);
    expect(chosen.rejected).toBe("not of the expected form");
    expect(await lstat(other).catch(() => null)).toBeNull();
  });
});

describe("removeCustodianSocketDir", () => {
  test("removes this daemon's own dir with the socket in it, and touches no path of another shape", async () => {
    const chosen = await custodianSocketDir(undefined);
    if ("problem" in chosen) throw new Error(chosen.problem);
    const started = await start(join(chosen.dir, CUSTODIAN_SOCKET_NAME));
    started.stop();
    // A daemon killed -9 leaves its socket file: the removal takes that too.
    await Bun.write(join(chosen.dir, CUSTODIAN_SOCKET_NAME), "");
    await removeCustodianSocketDir(chosen.dir);
    expect(await lstat(chosen.dir).catch(() => null)).toBeNull();

    const other = join(base, "keep");
    await mkdir(other);
    await removeCustodianSocketDir(other);
    expect((await lstat(other)).isDirectory()).toBe(true);
  });
});

describe("startCustodianSocket", () => {
  test("the directory is 0700 and a real directory, the socket 0600", async () => {
    const { dir, path } = socketIn();
    await start(path);
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    expect((await lstat(dir)).isDirectory()).toBe(true);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  test("a custodian frame reaches the handler with the raw frame and this process's pid", async () => {
    const { path } = socketIn();
    const seen: { raw: unknown; peer: number | null }[] = [];
    const reply: CustodianReply = { ok: true, verb: "notes", kept: ["standing"], dropped: 0 };
    await start(path, {
      handle: (raw, peer) => {
        seen.push({ raw, peer });
        return Promise.resolve(reply);
      },
    });
    const answered = await exchange(path, frame());
    expect(JSON.parse(answered.text)).toEqual(reply);
    expect(seen).toEqual([{ raw: JSON.parse(frame()), peer: peerPidSupported() ? process.pid : null }]);
  });

  test("a handler that throws is internal, with the error's name in the warning and never its text", async () => {
    const { path } = socketIn();
    const warnings: string[] = [];
    await start(path, {
      handle: () => Promise.reject(new RangeError("SECRET-NOTE")),
      warn: (line) => void warnings.push(line),
    });
    expect(JSON.parse((await exchange(path, frame())).text)).toEqual({ ok: false, code: "internal" });
    expect(warnings.join("\n")).toContain("RangeError");
    expect(warnings.join("\n")).not.toContain("SECRET");
  });

  test("plain and session-event frames are unsupported and never reach the handler; one warning a minute", async () => {
    const { path } = socketIn();
    const clock = { now: 1_000_000 };
    const warnings: string[] = [];
    let handled = 0;
    await start(path, {
      handle: () => {
        handled += 1;
        return Promise.resolve({ ok: true, verb: "done" });
      },
      warn: (line) => void warnings.push(line),
      now: () => clock.now,
    });
    const plain = `${JSON.stringify({ v: 1, op: "spawn", id: "x", repo: "r" })}\n`;
    const sessionEvent = `${JSON.stringify({ v: 1, kind: "session-event", state: "busy", pane: "%1" })}\n`;
    for (const line of [plain, sessionEvent, plain]) {
      expect(JSON.parse((await exchange(path, line)).text)).toEqual({ ok: false, code: "unsupported" });
    }
    expect(handled).toBe(0);
    expect(warnings).toHaveLength(1);
    clock.now += 60_001;
    await exchange(path, plain);
    expect(warnings).toHaveLength(2);
  });

  test("a line that is not JSON is invalid; the connection survives it", async () => {
    const { path } = socketIn();
    await start(path);
    expect(JSON.parse((await exchange(path, "not json\n")).text)).toEqual({ ok: false, code: "invalid" });
    expect(JSON.parse((await exchange(path, frame())).text)).toEqual({ ok: true, verb: "done" });
  });

  test("more than 64 KiB without a newline drops the connection, and nothing reaches the handler", async () => {
    const { path } = socketIn();
    let handled = 0;
    await start(path, {
      handle: () => {
        handled += 1;
        return Promise.resolve({ ok: true, verb: "done" });
      },
    });
    let closed = false;
    const sock = await Bun.connect<undefined>({
      unix: path,
      socket: {
        data: (): void => {},
        close: (): void => void (closed = true),
        error: (): void => void (closed = true),
      },
    });
    let buf = Buffer.alloc(70_000, 0x61);
    for (let i = 0; i < 2_000 && buf.length > 0; i += 1) {
      if (closed) break;
      let written = 0;
      try {
        written = sock.write(buf);
      } catch {
        break;
      }
      buf = buf.subarray(Math.max(written, 0));
      // oxlint-disable-next-line no-await-in-loop -- backpressure: nothing to parallelize
      if (written <= 0) await Bun.sleep(1);
    }
    await pollUntil(() => closed, "the server to drop the connection");
    expect(handled).toBe(0);
  });

  test("a symlink planted at the directory is refused, and nothing is created through it", async () => {
    const { dir, path } = socketIn();
    const target = join(base, "target");
    await mkdir(target);
    await symlink(target, dir);
    const started = await startCustodianSocket({ path, handle: () => Promise.reject(new Error("no")), warn: () => {} });
    expect(started).toEqual({ problem: expect.stringContaining("not a directory") });
    expect(await readdir(target)).toEqual([]);
  });

  test("a second start on a live socket is refused, and leaves the first one answering", async () => {
    const { path } = socketIn();
    await start(path);
    const second = await startCustodianSocket({ path, handle: () => Promise.reject(new Error("no")), warn: () => {} });
    expect(second).toEqual({ problem: expect.stringContaining("another daemon") });
    expect(JSON.parse((await exchange(path, frame())).text)).toEqual({ ok: true, verb: "done" });
  });

  test("a stale socket file (a daemon killed -9) is replaced", async () => {
    const { dir, path } = socketIn();
    await mkdir(dir, { mode: 0o700 });
    // A listener killed -9 leaves its socket file behind with nobody to answer it.
    const corpse = Bun.spawn(
      [
        process.execPath,
        "-e",
        "Bun.listen({ unix: process.argv[1], socket: { data() {} } }); console.log('up'); setInterval(() => {}, 1e6);",
        path,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    await corpse.stdout.getReader().read();
    corpse.kill("SIGKILL");
    await corpse.exited;
    expect(await lstat(path).catch(() => null)).not.toBeNull();
    await start(path);
    expect(JSON.parse((await exchange(path, frame())).text)).toEqual({ ok: true, verb: "done" });
  });

  test("stop unlinks the socket and keeps the directory, so the next instance serves the same path", async () => {
    const { dir, path } = socketIn();
    const started = await start(path);
    started.stop();
    expect(await lstat(path).catch(() => null)).toBeNull();
    expect((await lstat(dir)).isDirectory()).toBe(true);
    await start(path);
    expect(JSON.parse((await exchange(path, frame())).text)).toEqual({ ok: true, verb: "done" });
  });
});
