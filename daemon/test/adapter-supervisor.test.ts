import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { link, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AdapterDaemonFrame, DaemonHello } from "@seance/shared";
import { createAdapterSupervisor, type AdapterSupervisor, type SupervisorDeps } from "../src/adapter-supervisor.ts";
import { adapterAudit } from "../src/audit.ts";
import { exec } from "../src/exec.ts";
import { pollUntil } from "./fixtures.ts";

/**
 * The supervisor with the reference adapter (`test/bin/reference-adapter.ts`) as its child: the handshake, the
 * refusals, malformed lines, the unread cap, backoff and the `failed` hold, the stop by process group and the env.
 */

const REFERENCE = resolve(import.meta.dir, "bin/reference-adapter.ts");
const HELLO: DaemonHello = {
  kind: "hello",
  protocol: [1],
  features: [],
  machine: { deviceId: "dev-1", name: "box" },
  daemon: { version: "test" },
};

let base: string;
let adapter: string;
let runs = 0;
const supervisors: AdapterSupervisor[] = [];

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-adapter-")));
  // A link, exec'd once here: a fresh executable's first exec is scanned on macOS, never inside a timed window.
  adapter = join(base, "reference-adapter.ts");
  await link(REFERENCE, adapter);
  const warmed = await exec([adapter, "--warm"]);
  if (warmed.exitCode !== 0) throw new Error(`reference adapter failed to start: ${warmed.stderr}`);
});

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((each) => each.stop()));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

interface Harness {
  readonly supervisor: AdapterSupervisor;
  readonly dir: string;
  readonly audit: string[];
  readonly frames: () => Promise<readonly Record<string, unknown>[]>;
  readonly pid: () => Promise<number>;
}

function supervise(
  flags: readonly string[],
  opts: Partial<Omit<SupervisorDeps, "audit" | "dir" | "hello">> = {},
): Harness {
  const dir = join(base, `run-${++runs}`);
  const audit: string[] = [];
  const supervisor = createAdapterSupervisor({
    name: "ref",
    config: { argv: [adapter, ...flags], kinds: ["note", "question"] },
    dir,
    hello: HELLO,
    audit: adapterAudit((line) => {
      audit.push(line);
    }),
    snapshot: (): AdapterDaemonFrame => ({ kind: "snapshot", sessions: [] }),
    ...opts,
  });
  supervisors.push(supervisor);
  const frames = async (): Promise<readonly Record<string, unknown>[]> => {
    const text = await readFile(join(dir, "frames.jsonl"), "utf8").catch(() => "");
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line): Record<string, unknown> => JSON.parse(line));
  };
  const pid = async (): Promise<number> => {
    const file = join(dir, "adapter.pid");
    await pollUntil(async () => (await readFile(file, "utf8").catch(() => "")) !== "", "the adapter's pid");
    return Number(await readFile(file, "utf8"));
  };
  return { supervisor, dir, audit, frames, pid };
}

const kinds = async (h: Harness): Promise<readonly unknown[]> => (await h.frames()).map((frame) => frame["kind"]);
const ops = (h: Harness, op: string): readonly string[] => h.audit.filter((line) => line.includes(` op=${op} `));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the handshake", () => {
  test("the daemon's hello goes first, then the snapshot, then only what the adapter wants", async () => {
    const h = supervise(["--wants", "sessions"]);
    h.supervisor.start();
    await pollUntil(() => h.supervisor.state() === "running", "the handshake");
    await pollUntil(async () => (await kinds(h)).includes("snapshot"), "the snapshot");
    expect((await h.frames())[0]).toEqual({ ...HELLO });
    h.supervisor.send({ kind: "task", task: "t", event: "launched" });
    h.supervisor.send({ kind: "session-gone", key: "1:2", reason: "exited" });
    await pollUntil(async () => (await kinds(h)).includes("session-gone"), "the session-gone");
    // Sent after the task frame on one pipe: a task frame that went would be in the file before it.
    expect(await kinds(h)).toEqual(["hello", "snapshot", "session-gone"]);
    const start = ops(h, "start")[0] ?? "";
    expect(start).toMatch(
      /^audit adapter origin=adapter op=start name=ref argv=3 argv0="reference-adapter\.ts" pid=\d+$/u,
    );
  });

  test("a `resync` is answered with a fresh snapshot", async () => {
    const h = supervise(["--resync"]);
    h.supervisor.start();
    await pollUntil(async () => (await kinds(h)).filter((kind) => kind === "snapshot").length === 2, "two snapshots");
  });

  test("an adapter speaking no major this daemon does is refused and never restarted", async () => {
    const h = supervise(["--protocol", "2"], { backoffMs: 10 });
    h.supervisor.start();
    await pollUntil(() => ops(h, "exit").length === 1, "the exit");
    expect(h.supervisor.state()).toBe("refused");
    expect(ops(h, "refused")).toEqual(["audit adapter origin=adapter op=refused name=ref reason=protocol"]);
    expect(await kinds(h)).toEqual(["hello"]);
    await Bun.sleep(100);
    expect(ops(h, "start")).toHaveLength(1);
    expect(ops(h, "restart")).toEqual([]);
  });

  test("a hello naming another adapter is refused", async () => {
    const h = supervise(["--name", "other"]);
    h.supervisor.start();
    await pollUntil(() => ops(h, "exit").length === 1, "the exit");
    expect(ops(h, "refused")).toEqual(["audit adapter origin=adapter op=refused name=ref reason=name"]);
  });

  test("no hello in time is a restart", async () => {
    const h = supervise(["--no-hello"], { helloTimeoutMs: 100, backoffMs: 5_000 });
    h.supervisor.start();
    await pollUntil(() => ops(h, "restart").length === 1, "the restart");
    expect(ops(h, "exit")[0]).toMatch(/ reason=handshake$/u);
  });
});

describe("what the adapter writes", () => {
  test("a malformed line is answered `invalid` and the adapter runs on", async () => {
    const h = supervise(["--garbage", "1"]);
    h.supervisor.start();
    await pollUntil(async () => (await kinds(h)).includes("error"), "the error");
    expect((await h.frames()).find((frame) => frame["kind"] === "error")).toEqual({ kind: "error", code: "invalid" });
    await Bun.sleep(100);
    expect(h.supervisor.state()).toBe("running");
    expect(ops(h, "exit")).toEqual([]);
  });

  test("ten malformed lines in a minute are a restart", async () => {
    const h = supervise(["--garbage", "10"], { backoffMs: 5_000 });
    h.supervisor.start();
    await pollUntil(() => ops(h, "restart").length === 1, "the restart");
    expect(ops(h, "exit")[0]).toMatch(/ reason=invalid$/u);
    expect(ops(h, "restart")).toEqual(["audit adapter origin=adapter op=restart name=ref delay=5000ms"]);
  });

  test("an adapter that stops reading is restarted at the unread cap", async () => {
    const h = supervise(["--no-read"], { unreadMax: 64 * 1024, backoffMs: 5_000 });
    h.supervisor.start();
    await pollUntil(() => h.supervisor.state() === "running", "the handshake");
    const prUrl = `https://example.test/${"a".repeat(100 * 1024)}`;
    // Far past what the pipe and Bun's own buffer take before a write waits.
    for (let i = 0; i < 40; i++) h.supervisor.send({ kind: "task", task: `t${i}`, event: "launched", prUrl });
    await pollUntil(() => ops(h, "exit").length === 1, "the exit");
    expect(ops(h, "exit")[0]).toMatch(/ reason=unread$/u);
  });
});

describe("supervision", () => {
  test("exits back off, doubling, and five within the window hold it `failed`", async () => {
    const h = supervise(["--exit", "3"], { backoffMs: 20, failExits: 3 });
    h.supervisor.start();
    await pollUntil(() => h.supervisor.state() === "failed", "the failed hold");
    expect(ops(h, "start")).toHaveLength(3);
    expect(ops(h, "exit")).toEqual(
      Array.from({ length: 3 }, () => "audit adapter origin=adapter op=exit name=ref code=3 reason=exited"),
    );
    expect(ops(h, "restart")).toEqual([
      "audit adapter origin=adapter op=restart name=ref delay=20ms",
      "audit adapter origin=adapter op=restart name=ref delay=40ms",
    ]);
    expect(h.audit.filter((line) => line.includes(" op=failed "))).toEqual([
      "audit adapter origin=adapter op=failed name=ref exits=3",
    ]);
    await Bun.sleep(100);
    expect(ops(h, "start")).toHaveLength(3);
  });

  test("an argv[0] that cannot be started counts as an exit", async () => {
    const audit: string[] = [];
    const supervisor = createAdapterSupervisor({
      name: "gone",
      config: { argv: ["seance-no-such-adapter"], kinds: ["note"] },
      dir: join(base, "gone"),
      hello: HELLO,
      audit: adapterAudit((line) => {
        audit.push(line);
      }),
      snapshot: () => ({ kind: "snapshot", sessions: [] }),
      backoffMs: 10,
      failExits: 2,
    });
    supervisors.push(supervisor);
    supervisor.start();
    await pollUntil(() => supervisor.state() === "failed", "the failed hold");
    expect(audit.filter((line) => line.includes(" op=exit "))).toEqual(
      Array.from({ length: 2 }, () => "audit adapter origin=adapter op=exit name=gone code=- reason=spawn"),
    );
  });

  test("stop closes stdin, signals the group, and kills what ignores SIGTERM", async () => {
    const h = supervise(["--child", "--ignore-term", "--linger"], { killAfterMs: 300 });
    h.supervisor.start();
    await pollUntil(() => h.supervisor.state() === "running", "the handshake");
    const pid = await h.pid();
    const childFile = join(h.dir, "child.pid");
    await pollUntil(async () => (await readFile(childFile, "utf8").catch(() => "")) !== "", "the grandchild");
    const child = Number(await readFile(childFile, "utf8"));
    expect(alive(child)).toBe(true);
    await h.supervisor.stop();
    expect(alive(pid)).toBe(false);
    await pollUntil(() => !alive(child), "the grandchild gone with the group");
    expect(h.supervisor.state()).toBe("stopped");
    expect(ops(h, "exit")[0]).toMatch(/ code=SIGKILL reason=stopped$/u);
    expect(h.audit.at(-1)).toBe("audit adapter origin=adapter op=stop name=ref");
  });

  test("a held daemon starts nothing until the hold lifts", async () => {
    let held = true;
    const h = supervise([], { held: () => held });
    h.supervisor.start();
    expect(h.supervisor.state()).toBe("held");
    await Bun.sleep(100);
    expect(ops(h, "start")).toEqual([]);
    held = false;
    h.supervisor.start();
    await pollUntil(() => h.supervisor.state() === "running", "the handshake");
  });

  test("its env is a session's less CREDENTIALS_DIRECTORY and TMUX*, plus its name and 0700 dir", async () => {
    const saved = {
      creds: process.env["CREDENTIALS_DIRECTORY"],
      tmux: process.env["TMUX"],
      pane: process.env["TMUX_PANE"],
    };
    process.env["CREDENTIALS_DIRECTORY"] = "/run/credentials/seance";
    process.env["TMUX"] = "/tmp/tmux-1/default,1,0";
    process.env["TMUX_PANE"] = "%1";
    try {
      const h = supervise([]);
      h.supervisor.start();
      const envFile = join(h.dir, "env.json");
      await pollUntil(async () => (await readFile(envFile, "utf8").catch(() => "")) !== "", "the env");
      const keys: readonly string[] = JSON.parse(await readFile(envFile, "utf8"));
      expect(keys).not.toContain("CREDENTIALS_DIRECTORY");
      expect(keys.filter((key) => key.startsWith("TMUX"))).toEqual([]);
      expect(keys).toContain("SEANCE_ADAPTER_NAME");
      expect(keys).toContain("SEANCE_ADAPTER_DIR");
      expect(keys).toContain("PATH");
      expect((await stat(h.dir)).mode & 0o777).toBe(0o700);
    } finally {
      for (const [key, value] of [
        ["CREDENTIALS_DIRECTORY", saved.creds],
        ["TMUX", saved.tmux],
        ["TMUX_PANE", saved.pane],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
