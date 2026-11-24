import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepOpenAudit } from "../src/audit.ts";
import { KEEP_OPEN_MACHINE_MAX } from "../src/keep-open-frame.ts";
import { createKeepOpen, type KeepOpen, type KeepOpenDeps } from "../src/keep-open.ts";
import { keepSessionOpen } from "../src/keep-session-open.ts";
import { startLocalSocket, type LocalSocketHandle } from "../src/local-socket.ts";
import { paneHolds } from "../src/pane-holds.ts";
import { processNames } from "../src/peer.ts";
import { listPanePids } from "../src/session-events.ts";
import { tmuxOk } from "../src/tmux.ts";
import { bunNamed, pollUntil, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";

/**
 * The keep-open table with the binding real: panes in a private tmux server running a `claude`-named process, and the
 * kernel's process table. One test sends the frame from inside a pane through `keep_session_open`'s own client and the
 * real local socket, as a session's `seance mcp` does.
 */

const AUDIT_LINE = /^audit keep-open origin=keep-open op=(?:hold|release|end) outcome=[a-z_-]+$/u;
const hold = { v: 1, kind: "keep-open", keep: true };
const release = { v: 1, kind: "keep-open", keep: false };

let base: string;
let privateTmux: PrivateTmux | undefined;
let claudeBin: string;
let counter = 0;

interface Pane {
  readonly id: string;
  readonly pid: number;
}

async function newWindow(name: string, command: readonly string[]): Promise<Pane> {
  counter += 1;
  const out = (
    await tmuxOk([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id} #{pane_pid}",
      "-t",
      "kpo:",
      "-n",
      `${name}-${counter}`,
      "-c",
      base,
      ...command,
    ])
  ).trim();
  const [id, pid] = out.split(" ");
  if (id === undefined || pid === undefined) throw new Error(`no pane from ${out}`);
  return { id, pid: Number(pid) };
}

/** A pane running a `claude`-named process: its own pid stands as the peer, which `bindPeer` resolves as a connection's would. */
async function claudePane(name: string, script = "await Bun.sleep(600_000);"): Promise<Pane> {
  const made = await newWindow(name, [claudeBin, "-e", script]);
  await pollUntil(async () => (await processNames(made.pid)).includes("claude"), `${name}'s claude to exec`);
  return made;
}

interface Rig {
  readonly table: KeepOpen;
  readonly path: string;
  readonly audit: string[];
}

const stoppers: (() => unknown)[] = [];

function rig(over: Partial<KeepOpenDeps> = {}): Rig {
  const audit: string[] = [];
  counter += 1;
  const path = over.path ?? join(base, `keep-open-${counter}.json`);
  const table = createKeepOpen({
    panes: listPanePids,
    path,
    audit: keepOpenAudit((line) => void audit.push(line)),
    ...over,
  });
  stoppers.push(() => table.stop());
  return { table, path, audit };
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-kpo-")));
  claudeBin = await bunNamed("claude");
  privateTmux = usePrivateTmux(base, "kpo");
  await tmuxOk(["new-session", "-d", "-s", "kpo", "-c", base, "sleep", "600"]);
});

afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((stop) => stop()));
});

afterAll(async () => {
  await privateTmux?.dispose();
  await rm(base, { recursive: true, force: true });
});

describe("a session's hold", () => {
  test("holds its own pane from the custodian until it releases it, in closed-value audit lines", async () => {
    const r = rig();
    const pane = await claudePane("held");
    const other = await claudePane("other");
    const holds = paneHolds({
      events: () => undefined,
      drain: () => undefined,
      watches: () => undefined,
      keepOpen: () => r.table,
    });
    expect(holds.heldOpen(pane.id)).toBe(false);

    expect(await r.table.handle(hold, pane.pid)).toEqual({ ok: true, held: true });
    expect(holds.heldOpen(pane.id)).toBe(true);
    expect(holds.seatHolds(pane.id)).toBe(true);
    expect(holds.heldOpen(other.id)).toBe(false);
    // A repeat is the same hold.
    expect(await r.table.handle(hold, pane.pid)).toEqual({ ok: true, held: true });

    // Another session's release is its own: it leaves this hold alone.
    expect(await r.table.handle(release, other.pid)).toEqual({ ok: true, held: false });
    expect(holds.heldOpen(pane.id)).toBe(true);

    expect(await r.table.handle(release, pane.pid)).toEqual({ ok: true, held: false });
    expect(holds.heldOpen(pane.id)).toBe(false);

    expect(r.audit).toEqual([
      "audit keep-open origin=keep-open op=hold outcome=ok",
      "audit keep-open origin=keep-open op=hold outcome=ok",
      "audit keep-open origin=keep-open op=release outcome=ok",
      "audit keep-open origin=keep-open op=release outcome=ok",
    ]);
    for (const line of r.audit) expect(line).toMatch(AUDIT_LINE);
  });

  test("is bound by the peer only: no peer, no pane, no claude or a field naming one is refused", async () => {
    const r = rig();
    const pane = await claudePane("bound");
    const shell = await newWindow("shell", ["sleep", "600"]);

    expect(await r.table.handle(hold, null)).toEqual({ ok: false, code: "unbound" });
    // The test process sits in no pane of this server.
    expect(await r.table.handle(hold, process.pid)).toEqual({ ok: false, code: "unbound" });
    expect(await r.table.handle(hold, shell.pid)).toEqual({ ok: false, code: "nosession" });
    expect(await r.table.handle({ ...hold, pane: pane.id }, shell.pid)).toEqual({ ok: false, code: "invalid" });
    expect(await r.table.handle({ ...hold, keep: "yes" }, pane.pid)).toEqual({ ok: false, code: "invalid" });
    expect(await r.table.handle({ ...hold, v: 2 }, pane.pid)).toEqual({ ok: false, code: "invalid" });
    expect(r.table.holds(pane.id)).toBe(false);

    const blind = rig({ hostNamesPeers: () => false });
    expect(await blind.table.handle(hold, pane.pid)).toEqual({ ok: false, code: "unbound" });
  });

  test("ends with its claude process, and the next frame drops it from the file", async () => {
    const r = rig();
    const pane = await claudePane("dies");
    const keeper = await claudePane("keeper");
    expect(await r.table.handle(hold, pane.pid)).toEqual({ ok: true, held: true });
    process.kill(pane.pid, "SIGKILL");
    await pollUntil(() => !r.table.holds(pane.id), "the dead session's hold to lapse");

    expect(await r.table.handle(hold, keeper.pid)).toEqual({ ok: true, held: true });
    expect(r.audit.filter((line) => line.includes("op=end"))).toEqual([
      "audit keep-open origin=keep-open op=end outcome=-",
    ]);
    const saved: unknown = JSON.parse(await readFile(r.path, "utf8"));
    expect(saved).toEqual({ v: 1, holds: [expect.objectContaining({ pane: keeper.id })] });
    expect((await stat(r.path)).mode & 0o777).toBe(0o600);
  });

  test("survives the daemon's restart while its claude runs, and a saved hold of a gone process does not", async () => {
    const first = rig();
    const pane = await claudePane("restart");
    const gone = await claudePane("gone");
    expect(await first.table.handle(hold, pane.pid)).toEqual({ ok: true, held: true });
    expect(await first.table.handle(hold, gone.pid)).toEqual({ ok: true, held: true });
    await first.table.stop();
    process.kill(gone.pid, "SIGKILL");
    await pollUntil(async () => !(await processNames(gone.pid)).includes("claude"), "the gone claude to exit");

    const second = rig({ path: first.path });
    await second.table.start();
    expect(second.table.holds(pane.id)).toBe(true);
    expect(second.table.holds(gone.id)).toBe(false);
    const saved: unknown = JSON.parse(await readFile(first.path, "utf8"));
    expect(saved).toEqual({ v: 1, holds: [expect.objectContaining({ pane: pane.id })] });
  });

  test("an unreadable file holds nothing and is said, never a failed start", async () => {
    const warned: string[] = [];
    const path = join(base, `keep-open-bad-${(counter += 1)}.json`);
    await writeFile(path, "{ not json");
    const r = rig({ path, warn: (line) => void warned.push(line) });
    await r.table.start();
    expect(warned).toEqual([`keep-open: ${path} is unreadable; no session is held`]);
  });

  test("the machine's cap refuses a new session's hold, never a repeat of one already held", async () => {
    // One short of full, every saved hold standing for a live session (`sessionAlive`), so none is swept.
    const path = join(base, `keep-open-full-${(counter += 1)}.json`);
    const holds = Array.from({ length: KEEP_OPEN_MACHINE_MAX - 1 }, (_, at) => ({
      pane: `%9${at}`,
      session: `${at + 1_000_000}:x`,
      at: 1,
    }));
    await writeFile(path, JSON.stringify({ v: 1, holds }));
    const r = rig({ path, sessionAlive: () => true });
    await r.table.start();
    const last = await claudePane("last");
    const over = await claudePane("over");
    expect(await r.table.handle(hold, last.pid)).toEqual({ ok: true, held: true });
    expect(await r.table.handle(hold, over.pid)).toEqual({ ok: false, code: "too_many" });
    expect(await r.table.handle(hold, last.pid)).toEqual({ ok: true, held: true });
    expect(r.audit).toEqual([
      "audit keep-open origin=keep-open op=hold outcome=ok",
      "audit keep-open origin=keep-open op=hold outcome=too_many",
      "audit keep-open origin=keep-open op=hold outcome=ok",
    ]);
  });
});

describe("through the socket", () => {
  let socket: LocalSocketHandle | undefined;
  afterEach(() => {
    socket?.stop();
    socket = undefined;
  });

  test("keep_session_open's client, run in a session's pane, holds that session; a socket with no table says it predates holds", async () => {
    const r = rig();
    await mkdir(join(base, "run"), { recursive: true, mode: 0o700 });
    const path = join(base, "run", `k-${(counter += 1)}.sock`);
    socket = await startLocalSocket({ handle: () => Promise.resolve(null), keepOpen: r.table.handle, path });
    const out = join(base, `out-${counter}.json`);
    const client = join(import.meta.dir, "..", "src", "keep-session-open.ts");
    const script = `const { keepSessionOpen } = await import(${JSON.stringify(client)}); await Bun.write(${JSON.stringify(`${out}.tmp`)}, JSON.stringify(await keepSessionOpen(true, { path: ${JSON.stringify(path)} }))); (await import("node:fs/promises")).rename(${JSON.stringify(`${out}.tmp`)}, ${JSON.stringify(out)}); await Bun.sleep(600_000);`;
    const pane = await claudePane("socket", script);
    await pollUntil(async () => (await Bun.file(out).exists()) && r.table.holds(pane.id), "the session's hold");
    const result: unknown = JSON.parse(await readFile(out, "utf8"));
    expect(result).toEqual({ ok: true, text: expect.stringContaining("held open") });

    socket.stop();
    const bare = join(base, "run", `k-${(counter += 1)}.sock`);
    socket = await startLocalSocket({ handle: () => Promise.resolve(null), path: bare });
    expect(await keepSessionOpen(true, { path: bare })).toEqual({
      ok: false,
      text: "not held: this machine's daemon predates keep_session_open (`seance update`)",
    });
  });
});
