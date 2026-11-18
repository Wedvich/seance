import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { takeRestartRequest, writeAdaptersView, type AdapterView } from "../src/adapter-control.ts";
import { adapterFingerprint, openSubscriptions } from "../src/adapter-subscriptions.ts";
import { configSkeleton } from "../src/config.ts";
import { pollUntil } from "./fixtures.ts";

const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/**
 * `seance adapter add | remove | restart | status` through the real CLI as a subprocess, on a throwaway config and
 * state dir (DESIGN.md, "Adapters", "Installing"). Where a running daemon matters, this test plays it: a live pid in
 * `runtime.json`, the status view written under that pid, and the restart request taken as the daemon's poll takes it.
 */
describe("seance adapter", () => {
  let root: string;
  let state: string;
  let configFile: string;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "seance-adapter-cli-")));
    state = join(root, "state");
    await mkdir(join(root, "config"), { recursive: true });
    configFile = join(root, "config", "config.json");
    await writeFile(configFile, configSkeleton("box"), { mode: 0o600 });
    env = { ...process.env, SEANCE_STATE_DIR: state, SEANCE_CONFIG_DIR: join(root, "config") };
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const run = async (...args: string[]): Promise<{ out: string; err: string; code: number }> => {
    const proc = Bun.spawn([process.execPath, mainPath, "adapter", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { out, err, code };
  };
  const config = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(configFile, "utf8"));
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const adapters = async (): Promise<Record<string, Record<string, unknown>> | undefined> => {
    const value = (await config())["adapters"];
    if (!isRecord(value)) return undefined;
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, isRecord(entry) ? entry : {}]));
  };
  const auditLines = async (): Promise<readonly string[]> =>
    (await readFile(join(state, "seanced.log"), "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line.includes("audit adapter"));

  const git = (dir: string, args: readonly string[]): string => {
    const proc = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    return proc.stdout.toString().trim();
  };

  /** An adapter's checkout, committed: its manifest and the file its argv names. */
  const checkout = async (name: string, manifest?: unknown): Promise<string> => {
    const dir = join(root, `seance-${name}`);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.ts"), "");
    await writeFile(
      join(dir, "seance-adapter.json"),
      JSON.stringify(manifest ?? { name, protocol: 1, argv: ["bun", "src/main.ts"] }),
    );
    git(dir, ["init", "-q"]);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "init"]);
    return dir;
  };

  /** This test process as the daemon: a live pid in `runtime.json`, and a status view under it. */
  const playDaemon = async (views: Readonly<Record<string, Partial<AdapterView>>>): Promise<void> => {
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "runtime.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const full = Object.fromEntries(
      Object.entries(views).map(([name, view]) => [
        name,
        {
          state: "running" as const,
          exits: 0,
          fingerprint: "0".repeat(64),
          restarts: 0,
          delivered: 0,
          messages: 0,
          ...view,
        },
      ]),
    );
    await writeAdaptersView({ pid: process.pid, at: Date.now(), adapters: full }, join(state, "adapter-status.json"));
  };

  test("add writes adapters.<name> from the manifest, its argv absolute, its commit and dir recorded, other keys kept", async () => {
    const dir = await checkout("chat");
    const result = await run("add", dir);
    expect(result).toMatchObject({ code: 0, err: "" });
    expect(result.out).toContain("added adapter chat");
    expect(result.out).toContain("an adapter runs as you, with everything you can reach");
    const entry = (await adapters())?.["chat"];
    expect(entry).toEqual({
      argv: ["bun", join(dir, "src", "main.ts")],
      kinds: ["note", "question"],
      commit: git(dir, ["rev-parse", "HEAD"]),
      dir,
      added: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    });
    expect((await config())["name"]).toBe("box");
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    expect(await auditLines()).toEqual([
      expect.stringMatching(
        /audit adapter origin=cli op=add name=chat argv=2 argv0="bun" kinds=note,question repos=all commit=true replaced=false$/u,
      ),
    ]);
  });

  test("add under a name already there ends that name's subscriptions, and only that name's", async () => {
    const dir = await checkout("chat");
    expect((await run("add", dir, "--kinds", "note,question,request", "--repo", "web")).code).toBe(0);
    const first = (await adapters())?.["chat"];
    const conversation = "0f3c9a8e-1b2d-4c5e-8f70-123456789abc";
    const path = join(state, "conversations.json");
    const before = openSubscriptions(path);
    before.add("chat", conversation);
    before.add("other", conversation);
    await before.flushed();

    const again = await run("add", dir);
    expect(again.code).toBe(0);
    expect(again.out).toContain("replaced adapter chat");
    expect(again.out).toContain("its subscriptions are ended");
    const after = openSubscriptions(path);
    expect(after.has("chat", conversation)).toBe(false);
    expect(after.has("other", conversation)).toBe(true);
    // Kinds and repos carry over unless given; the commit is the same, yet the fingerprint is not: a daemon that
    // rewrote the old subscriptions before its restart still has them dropped by `reconcile` at that start.
    const second = (await adapters())?.["chat"];
    expect(second).toMatchObject({ kinds: ["note", "question", "request"], repos: ["web"], commit: first?.["commit"] });
    expect(second?.["added"]).not.toBe(first?.["added"]);
    const fingerprint = (e: Record<string, unknown> | undefined): string =>
      adapterFingerprint({
        argv: Array.isArray(e?.["argv"]) ? e["argv"].filter((word): word is string => typeof word === "string") : [],
        ...(typeof e?.["commit"] === "string" ? { commit: e["commit"] } : {}),
        ...(typeof e?.["added"] === "string" ? { added: e["added"] } : {}),
      });
    expect(fingerprint(second)).not.toBe(fingerprint(first));
    expect((await auditLines()).at(-1)).toContain(
      'op=add name=chat argv=2 argv0="bun" kinds=note,question,request repos=1 commit=true replaced=true',
    );
  });

  test("a refused manifest writes nothing and audits nothing", async () => {
    const before = await readFile(configFile, "utf8");
    const dir = await checkout("chat", { name: "chat", protocol: 1, argv: ["bun", "../escape.ts"] });
    const result = await run("add", dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain("not added:");
    expect(result.err).toContain("argv[1]");
    const future = await checkout("next", { name: "next", protocol: 9, argv: ["bun"] });
    expect((await run("add", future)).err).toContain("names protocol 9");
    expect((await run("add", join(root, "nowhere"))).code).toBe(1);
    expect(await readFile(configFile, "utf8")).toBe(before);
    expect(await auditLines()).toEqual([]);
  });

  test("add refuses a fifth adapter, and a usage error is exit 2", async () => {
    for (const name of ["a1", "a2", "a3", "a4"]) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time: each rewrites config.json
      expect((await run("add", await checkout(name))).code).toBe(0);
    }
    const fifth = await run("add", await checkout("a5"));
    expect(fifth.code).toBe(1);
    expect(fifth.err).toContain("already names 4 adapters");
    expect(Object.keys((await adapters()) ?? {})).toEqual(["a1", "a2", "a3", "a4"]);
    expect((await run("add")).code).toBe(2);
    expect((await run("add", "x", "--kinds", "shout")).code).toBe(2);
    expect((await run("frobnicate")).code).toBe(2);
  });

  test("remove drops the entry and its subscriptions and leaves the adapter's own directory", async () => {
    expect((await run("add", await checkout("chat"))).code).toBe(0);
    const own = join(state, "adapters", "chat");
    await mkdir(own, { recursive: true });
    const subs = openSubscriptions(join(state, "conversations.json"));
    subs.add("chat", "0f3c9a8e-1b2d-4c5e-8f70-123456789abc");
    await subs.flushed();
    const result = await run("remove", "chat");
    expect(result.code).toBe(0);
    expect(await adapters()).toBeUndefined();
    expect(
      openSubscriptions(join(state, "conversations.json")).has("chat", "0f3c9a8e-1b2d-4c5e-8f70-123456789abc"),
    ).toBe(false);
    expect((await stat(own)).isDirectory()).toBe(true);
    expect((await auditLines()).at(-1)).toMatch(/origin=cli op=remove name=chat$/u);
    const again = await run("remove", "chat");
    expect(again.code).toBe(1);
    expect(again.err).toContain("no adapter named chat");
  });

  test("status reads config.json alone with no daemon, and the live view with one, its version scrubbed", async () => {
    expect((await run("status")).out).toContain("no adapters are configured");
    const dir = await checkout("chat");
    expect((await run("add", dir)).code).toBe(0);
    const offline = await run("status");
    expect(offline.out).toContain("the daemon is not running");
    expect(offline.out).toContain("kinds      note, question");

    await playDaemon({
      chat: {
        pid: 4242,
        startedAt: Date.now(),
        protocol: 1,
        version: "1.0\u001B[31m",
        delivered: 3,
        messages: 2,
        exits: 1,
        lastExit: { at: Date.now(), code: 3, reason: "exited" },
      },
    });
    const live = await run("status");
    expect(live.out).toContain("state      running (pid 4242");
    expect(live.out).toContain("protocol   1, version 1.0�[31m");
    expect(live.out).not.toContain("\u001B");
    expect(live.out).toContain("3 delivered in, 2 messages out, 1 exits, 0 restarts by you");
    expect(live.out).toContain("exited, code 3");
    // The view's fingerprint is not this entry's: the daemon runs an older config.
    expect(live.out).toContain("config.json changed since the daemon started it");
  });

  test("restart asks the running daemon through its request file and waits to see it act", async () => {
    expect((await run("add", await checkout("chat"))).code).toBe(0);
    const down = await run("restart", "chat");
    expect(down.code).toBe(1);
    expect(down.err).toContain("the daemon is not running");
    expect((await auditLines()).at(-1)).toMatch(/op=restart name=chat outcome=not_running$/u);

    await playDaemon({ chat: { state: "failed" } });
    const request = join(state, "adapter-restart.json");
    const pending = run("restart", "chat");
    const taken: { names: readonly string[] | null } = { names: null };
    await pollUntil(async () => {
      taken.names = await takeRestartRequest(Date.now(), request);
      return taken.names !== null;
    }, "the restart request");
    expect(taken.names).toEqual(["chat"]);
    await playDaemon({ chat: { state: "running", restarts: 1 } });
    const result = await pending;
    expect(result).toMatchObject({ code: 0 });
    expect(result.out).toContain("chat: restarted (running)");
    expect((await auditLines()).at(-1)).toMatch(/op=restart name=chat outcome=requested$/u);
    expect((await run("restart", "nope")).code).toBe(1);
  });
});
