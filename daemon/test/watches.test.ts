import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRecord,
  WATCH_SET_MAX,
  type WatchEvent,
  type WatchEventBody,
  type WatchEventResponse,
  type WatchRefusal,
  type WatchSet,
} from "@seance/shared";
import { watchAudit } from "../src/audit.ts";
import { sessionAlive } from "../src/claude-process.ts";
import { exchange } from "../src/local-client.ts";
import { startLocalSocket, type LocalSocketHandle } from "../src/local-socket.ts";
import { createMessages, type ListenerSink, type Messages, type MessagesDeps } from "../src/messages.ts";
import { paneHolds } from "../src/pane-holds.ts";
import { processNames } from "../src/peer.ts";
import { listPanePids, type BoundPane } from "../src/session-events.ts";
import { tmuxOk } from "../src/tmux.ts";
import type { LeaderVerdict, WatchLeader } from "../src/watch-leader.ts";
import { createWatches, WATCH_MACHINE_MAX, WATCH_SESSION_MAX, type Watches, type WatchesDeps } from "../src/watches.ts";
import { bunNamed, pollUntil, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";

/**
 * The daemon's watch table with the binding real: panes in a private tmux server running a `claude`-named process, the
 * kernel's process table, and a real `createMessages` whose listener is a sink double. The leader is a double that
 * records the sets it is handed and answers them as a test says. The clock is injected: a jump stands for the minutes a
 * tick would otherwise have to wait out.
 */

const BOOT = "11111111-1111-4111-8111-111111111111";
const HEAD = "a".repeat(40);
const INBOX = { v: 1, kind: "inbox" };
const AUDIT_LINE =
  /^audit watch origin=watch op=(?:add|remove|event|end) kind=(?:pr|run|-) event=[a-z_-]+ reason=[a-z_-]+ outcome=[a-z_-]+$/u;

let base: string;
let privateTmux: PrivateTmux | undefined;
let claudeBin: string;
const clock = { now: 1_000_000 };

const pr = (n: number): string => `https://github.com/octo/widgets/pull/${n}`;
const run = (n: number): string => `https://github.com/octo/widgets/actions/runs/${n}`;
const addFrame = (url: string, head?: string): object => ({
  v: 1,
  kind: "watch",
  op: "add",
  url,
  ...(head === undefined ? {} : { head }),
});
const removeFrame = (id: string): object => ({ v: 1, kind: "watch", op: "remove", id });

interface Pane {
  readonly id: string;
  readonly pid: number;
}

let counter = 0;

async function newWindow(name: string, command: readonly string[], taskId?: string): Promise<Pane> {
  const out = (
    await tmuxOk([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id} #{pane_pid}",
      "-t",
      "wat:",
      "-n",
      name,
      "-c",
      base,
      ...command,
    ])
  ).trim();
  const [id, pid] = out.split(" ");
  if (id === undefined || pid === undefined) throw new Error(`no pane from ${out}`);
  if (taskId !== undefined) await tmuxOk(["set-option", "-p", "-t", id, "@seance-task", taskId]);
  return { id, pid: Number(pid) };
}

/** A pane running a `claude`-named process: its own pid stands as the peer, which `bindPeer` resolves as a connection's would. */
async function claudePane(name: string, taskId?: string): Promise<Pane> {
  counter += 1;
  const made = await newWindow(`${name}-${counter}`, [claudeBin, "-e", "await Bun.sleep(600_000);"], taskId);
  await pollUntil(async () => (await processNames(made.pid)).includes("claude"), `${name}'s claude to exec`);
  return made;
}

function sinkDouble(): { readonly sink: ListenerSink; readonly lines: string[]; readonly drop: () => void } {
  const written: string[] = [];
  const gone = new AbortController();
  return {
    sink: {
      write: (line) => {
        written.push(line);
        return true;
      },
      close: () => gone.abort(),
      gone: gone.signal,
    },
    lines: written,
    drop: () => gone.abort(),
  };
}

interface Line {
  readonly messageKind: unknown;
  readonly push: string;
  readonly wake: unknown;
}

/** What a listener was written after its ack. */
function notes(listener: { readonly lines: readonly string[] }): readonly Line[] {
  return listener.lines.slice(1).map((raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed["push"] !== "string") throw new Error(`not an inbox line: ${raw}`);
    return { messageKind: parsed["messageKind"], push: parsed["push"], wake: parsed["wake"] };
  });
}

interface FakeLeader extends WatchLeader {
  readonly sets: WatchSet[];
  verdict: LeaderVerdict;
  /** What `send` returns: false stands for no leader term in process or a leg that is down. */
  accept: boolean;
  /** Answers every accepted set at once, as the leader does. */
  answer: boolean;
  /** Refuses every entry of a set it answers. */
  refuse: WatchRefusal | null;
  /** Held open by a test: `check` waits on it, so adds queue behind each other at the verdict. */
  gate: Promise<void> | null;
  /** Held open by a test: `send` waits on it, then answers `accept`. */
  sendGate: Promise<void> | null;
  checks: number;
  holds: number;
  releases: number;
  stopped: boolean;
  target: Watches | null;
  readonly reply: (
    set: WatchSet,
    refused?: readonly { id: string; code: WatchRefusal }[],
  ) => Promise<WatchEventResponse>;
}

function fakeLeader(): FakeLeader {
  const leader: FakeLeader = {
    sets: [],
    verdict: "ready",
    accept: true,
    answer: true,
    refuse: null,
    gate: null,
    sendGate: null,
    checks: 0,
    holds: 0,
    releases: 0,
    stopped: false,
    target: null,
    check: async () => {
      leader.checks += 1;
      await leader.gate;
      return leader.verdict;
    },
    hold: () => {
      leader.holds += 1;
    },
    release: () => {
      leader.releases += 1;
    },
    send: (set) => {
      leader.sets.push(set);
      if (leader.answer && leader.accept) {
        const { refuse } = leader;
        void Promise.resolve().then(() =>
          leader.reply(set, refuse === null ? [] : set.watches.map((w) => ({ id: w.id, code: refuse }))),
        );
      }
      return leader.sendGate === null ? Promise.resolve(leader.accept) : leader.sendGate.then(() => leader.accept);
    },
    stop: () => {
      leader.stopped = true;
    },
    reply: (set, refused = []) => {
      if (leader.target === null) throw new Error("no table to answer to");
      return leader.target.onEvent({ set: { gen: set.gen, refused }, events: [] });
    },
  };
  return leader;
}

interface Rig {
  readonly messages: Messages;
  readonly leader: FakeLeader;
  readonly watches: Watches;
  readonly path: string;
  readonly audit: string[];
  readonly latest: () => WatchSet;
}

const stoppers: (() => unknown)[] = [];
const blind = { panes: false, failNext: false };

interface RigOptions {
  readonly graceMs?: number;
  readonly leader?: FakeLeader;
  readonly path?: string;
  readonly boot?: string;
  readonly watches?: Partial<WatchesDeps>;
  readonly messages?: Partial<MessagesDeps>;
}

function rig(options: RigOptions = {}): Rig {
  const audit: string[] = [];
  const messages = createMessages({
    // A failed tmux read answers no panes, as `listPanePids` does.
    panes: () => {
      if (!blind.failNext) return listPanePids();
      blind.failNext = false;
      return Promise.resolve([]);
    },
    windowName: () => Promise.resolve("Win"),
    launchedAt: () => undefined,
    machine: "testbox",
    audit: () => Promise.resolve(),
    now: () => clock.now,
    graceMs: options.graceMs ?? 1_000,
    ...options.messages,
  });
  // Past the daemon's own start grace, so a pane with no listener is refused `nolistener`.
  clock.now += 10_000;
  const leader = options.leader ?? fakeLeader();
  counter += 1;
  const path = options.path ?? join(base, `watches-${counter}.json`);
  const watches = createWatches({
    panes: () => (blind.panes ? Promise.resolve([]) : listPanePids()),
    messages,
    leader,
    boot: options.boot ?? BOOT,
    path,
    audit: watchAudit((line) => void audit.push(line)),
    now: () => clock.now,
    addAnswerMs: 30,
    tickMs: 25,
    ...options.watches,
  });
  leader.target = watches;
  stoppers.push(
    () => messages.stop(),
    () => watches.stop(),
  );
  return {
    messages,
    leader,
    watches,
    path,
    audit,
    latest: () => leader.sets.at(-1) ?? { gen: { boot: BOOT, n: 0 }, watches: [] },
  };
}

/** A pane with a connected listener: what a session with the `inbox` mod looks like to the table. */
async function listening(
  r: Rig,
  name: string,
  taskId?: string,
): Promise<Pane & { readonly listener: ReturnType<typeof sinkDouble> }> {
  const made = await claudePane(name, taskId);
  const listener = sinkDouble();
  await r.messages.listen(INBOX, made.pid, listener.sink);
  return { ...made, listener };
}

async function added(r: Rig, target: Pane, url: string, head?: string): Promise<string> {
  const reply = await r.watches.handle(addFrame(url, head), target.pid);
  if (!reply.ok || !("id" in reply)) throw new Error(`add refused: ${JSON.stringify(reply)}`);
  return reply.id;
}

const event = (id: string, key: string, body: WatchEventBody): WatchEvent => ({ id, key, event: body });
const checksFail = (id: string): WatchEvent =>
  event(id, `checks:${HEAD}:fail`, {
    kind: "checks",
    outcome: "fail",
    head: HEAD,
    failing: [{ name: "build", required: true }],
  });
const merged = (id: string): WatchEvent => event(id, "merged", { kind: "merged" });

/** The `seen` of the first watch in the saved file. */
async function savedSeen(path: string): Promise<readonly unknown[]> {
  // A write still in flight is no file yet: the caller polls.
  const saved: unknown = await readFile(path, "utf8").then(
    (text): unknown => JSON.parse(text),
    () => null,
  );
  const entry = isRecord(saved) && Array.isArray(saved["watches"]) ? saved["watches"][0] : null;
  const seen: unknown = isRecord(entry) ? entry["seen"] : null;
  return Array.isArray(seen) ? seen : [];
}

const lineCount = (r: Rig, needle: string): number => r.audit.filter((line) => line.includes(needle)).length;
const idsOf = (set: WatchSet): readonly string[] => set.watches.map((w) => w.id);

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-watch-")));
  claudeBin = await bunNamed("claude");
  privateTmux = usePrivateTmux(base, "wat");
  await tmuxOk(["new-session", "-d", "-s", "wat", "-c", base, "sleep", "600"]);
});

afterEach(async () => {
  blind.panes = false;
  blind.failNext = false;
  const stops = stoppers.splice(0).map((stop) => stop());
  await Promise.all(stops);
});

afterAll(async () => {
  await privateTmux?.dispose();
  await rm(base, { recursive: true, force: true });
});

describe("the caps", () => {
  test("a machine's cap is the leader's per-device cap", () => {
    expect(WATCH_MACHINE_MAX).toBe(WATCH_SET_MAX);
    expect(WATCH_SESSION_MAX).toBeLessThan(WATCH_MACHINE_MAX);
  });
});

describe("add", () => {
  test("a bound session's add is answered ok, the set carries it with an increasing n, and the table is on disk 0600", async () => {
    const r = rig();
    const target = await listening(r, "add-ok");
    const reply = await r.watches.handle(addFrame(pr(1), HEAD), target.pid);
    expect(reply).toEqual({ ok: true, id: expect.stringMatching(/^[0-9a-f-]{36}$/u), kind: "pr" });
    const id = "id" in reply ? reply.id : "";
    expect(r.leader.sets[0]).toEqual({
      gen: { boot: BOOT, n: 1 },
      watches: [{ id, kind: "pr", url: pr(1), head: HEAD, seen: [] }],
    });
    await added(r, target, run(2));
    expect(r.leader.sets[1]?.gen).toEqual({ boot: BOOT, n: 2 });
    expect(r.leader.sets[1]?.watches).toHaveLength(2);
    expect(r.leader.holds).toBeGreaterThan(0);

    await r.watches.stop();
    const saved: unknown = JSON.parse(await readFile(r.path, "utf8"));
    expect(isRecord(saved) && Array.isArray(saved["watches"]) ? saved["watches"] : []).toHaveLength(2);
    expect((await stat(r.path)).mode & 0o777).toBe(0o600);
  });

  test("an add that is not bound to a live session is refused, and nothing is sent", async () => {
    const r = rig();
    const target = await listening(r, "add-unbound");
    const bare = await newWindow(`bare-${(counter += 1)}`, ["sleep", "600"]);
    expect(await r.watches.handle(addFrame(pr(1)), null)).toEqual({ ok: false, code: "unbound" });
    expect(await r.watches.handle(addFrame(pr(1)), process.pid)).toEqual({ ok: false, code: "unbound" });
    expect(await r.watches.handle(addFrame(pr(1)), bare.pid)).toEqual({ ok: false, code: "nosession" });
    expect(
      await r.watches.handle({ v: 1, kind: "watch", op: "add", url: "https://example.com/x" }, target.pid),
    ).toEqual({
      ok: false,
      code: "invalid",
    });
    const noPeers = rig({ watches: { hostNamesPeers: () => false } });
    expect(await noPeers.watches.handle(addFrame(pr(1)), target.pid)).toEqual({ ok: false, code: "unbound" });
    expect(r.leader.sets).toHaveLength(0);
    expect(r.watches.holds(target.id)).toBe(false);
  });

  test("a pane with no listener and no grace left is refused nolistener", async () => {
    const r = rig();
    const target = await claudePane("add-nolistener");
    expect(await r.watches.handle(addFrame(pr(1)), target.pid)).toEqual({ ok: false, code: "nolistener" });
  });

  test("no leader, an unsupported one, a leader that is not handed the set, and a stopped table each refuse the add", async () => {
    const r = rig();
    const target = await listening(r, "add-leader");
    r.leader.verdict = "none";
    expect(await r.watches.handle(addFrame(pr(1)), target.pid)).toEqual({ ok: false, code: "no_leader" });
    r.leader.verdict = "unsupported";
    expect(await r.watches.handle(addFrame(pr(1)), target.pid)).toEqual({ ok: false, code: "unsupported" });
    r.leader.verdict = "ready";
    r.leader.accept = false;
    expect(await r.watches.handle(addFrame(pr(1)), target.pid)).toEqual({ ok: false, code: "no_leader" });
    // The refused add left nothing behind: the table is empty, and so is the set that follows.
    expect(r.watches.holds(target.id)).toBe(false);
    await r.watches.stop();
    expect(await r.watches.handle(addFrame(pr(1)), target.pid)).toEqual({ ok: false, code: "stopping" });
  });

  test("nine watches for one session is too_many, and a replacement is not counted and ends the old watch", async () => {
    const r = rig();
    const target = await listening(r, "add-many");
    const ids: string[] = [];
    for (let i = 1; i <= WATCH_SESSION_MAX; i++) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time, as a session makes them
      ids.push(await added(r, target, pr(i)));
    }
    expect(await r.watches.handle(addFrame(pr(99)), target.pid)).toEqual({ ok: false, code: "too_many" });
    const again = await added(r, target, pr(3));
    expect(again).not.toBe(ids[2]);
    expect(idsOf(r.latest())).toHaveLength(WATCH_SESSION_MAX);
    expect(idsOf(r.latest())).not.toContain(ids[2]);
    expect(idsOf(r.latest())).toContain(again);
    expect(lineCount(r, "op=end kind=pr event=- reason=replaced")).toBe(1);
  });

  test("past 64 watches on the machine the next is too_many, whichever session asks", async () => {
    const r = rig();
    const panes = await Promise.all(Array.from({ length: 9 }, (_, i) => listening(r, `cap-${i}`)));
    const full = panes.slice(0, 8);
    for (const [p, target] of full.entries()) {
      for (let i = 1; i <= WATCH_SESSION_MAX; i++) {
        // oxlint-disable-next-line no-await-in-loop -- one add at a time
        await added(r, target, pr(p * 100 + i));
      }
    }
    const last = panes[8];
    if (last === undefined) throw new Error("no ninth pane");
    expect(await r.watches.handle(addFrame(pr(9_999)), last.pid)).toEqual({ ok: false, code: "too_many" });
    // A replacement does not grow the table, so it is not refused.
    const first = full[0];
    if (first === undefined) throw new Error("no first pane");
    await added(r, first, pr(1));
  });

  test("a leader that refuses the add within the window removes it: fleet_full or invalid", async () => {
    const r = rig();
    const target = await listening(r, "add-refused");
    r.leader.refuse = "fleet_full";
    expect(await r.watches.handle(addFrame(pr(1)), target.pid)).toEqual({ ok: false, code: "fleet_full" });
    r.leader.refuse = "invalid";
    expect(await r.watches.handle(addFrame(pr(2)), target.pid)).toEqual({ ok: false, code: "invalid" });
    expect(r.watches.holds(target.id)).toBe(false);
    await pollUntil(() => r.latest().watches.length === 0, "the set after the refusals to be empty");
    await r.watches.stop();
    const saved: unknown = JSON.parse(await readFile(r.path, "utf8"));
    expect(isRecord(saved) ? saved["watches"] : null).toEqual([]);
  });

  test("a replacement the leader refuses, or cannot be handed, leaves the old watch in place and unaudited as ended", async () => {
    const r = rig();
    const target = await listening(r, "add-keeps");
    const old = await added(r, target, pr(1));
    r.leader.refuse = "fleet_full";
    expect(await r.watches.handle(addFrame(pr(1)), target.pid)).toEqual({ ok: false, code: "fleet_full" });
    r.leader.refuse = null;
    r.leader.accept = false;
    expect(await r.watches.handle(addFrame(pr(1)), target.pid)).toEqual({ ok: false, code: "no_leader" });
    r.leader.accept = true;
    expect(r.watches.holds(target.id)).toBe(true);
    await pollUntil(() => idsOf(r.latest()).join() === old, "the set to state the old watch again");
    expect(lineCount(r, "reason=replaced")).toBe(0);
    // The old watch still stands, so a remove by its id answers ok.
    expect(await r.watches.handle(removeFrame(old), target.pid)).toEqual({ ok: true });
  });

  test("two adds of one target from one session are made one after the other, the later replacing the earlier", async () => {
    const r = rig();
    const target = await listening(r, "add-twice");
    let open: () => void = () => undefined;
    r.leader.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = r.watches.handle(addFrame(pr(1)), target.pid);
    const second = r.watches.handle(addFrame(pr(1)), target.pid);
    // The first add reaches the verdict once its peer binding is done (a process-table and tmux read), however long that takes.
    await pollUntil(() => r.leader.checks >= 1, "the first add to reach the leader's verdict");
    // A negative: the second add must not have reached it while the first is still at it.
    await Bun.sleep(50);
    expect(r.leader.checks).toBe(1);
    open();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    const ids = [a, b].map((reply) => ("id" in reply ? reply.id : ""));
    expect(ids[0]).not.toBe(ids[1]);
    // Whichever bound first ran first (the peer's binding reads the process table): the other replaced it.
    const [survivor, ...rest] = idsOf(r.latest());
    expect(rest).toEqual([]);
    expect(ids.filter((id) => id === survivor)).toHaveLength(1);
    expect(lineCount(r, "reason=replaced")).toBe(1);
  });

  test("a remove of the old id during a pending replacement waits for it: a refused add puts the old watch back, so the remove finds it", async () => {
    const r = rig({ watches: { addAnswerMs: 5_000 } });
    const target = await listening(r, "add-remove");
    const old = await added(r, target, pr(1));
    r.leader.answer = false;
    const replacing = r.watches.handle(addFrame(pr(1)), target.pid);
    await pollUntil(() => r.leader.sets.length === 2, "the replacement's set to be sent");
    const set = r.latest();
    const next = idsOf(set)[0];
    if (next === undefined || next === old) throw new Error("the replacement's set names no new watch");
    const removing = r.watches.handle(removeFrame(old), target.pid);
    await r.leader.reply(set, [{ id: next, code: "invalid" }]);
    expect(await replacing).toEqual({ ok: false, code: "invalid" });
    expect(await removing).toEqual({ ok: true });
    expect(r.watches.holds(target.id)).toBe(false);
  });

  test("a replacement whose own watch ends while it waits is refused, and both watches are audited as ended", async () => {
    const r = rig({ watches: { addAnswerMs: 5_000 } });
    const target = await listening(r, "add-ended", "task-add-ended");
    const old = await added(r, target, pr(1));
    r.leader.answer = false;
    const replacing = r.watches.handle(addFrame(pr(1)), target.pid);
    await pollUntil(() => r.leader.sets.length === 2, "the replacement's set to be sent");
    r.watches.onEnded(target.id, "task-add-ended");
    expect(await replacing).toEqual({ ok: false, code: "nolistener" });
    expect(lineCount(r, "op=end kind=pr event=- reason=ended")).toBe(2);
    expect(lineCount(r, "reason=replaced")).toBe(0);
    expect(r.watches.holds(target.id)).toBe(false);
    expect(await r.watches.handle(removeFrame(old), target.pid)).toEqual({ ok: false, code: "unknown" });
  });

  test("a stop while an add waits on a send that fails leaves the add standing, as the file holds it", async () => {
    const r = rig();
    const target = await listening(r, "add-stopped");
    let open: () => void = () => undefined;
    r.leader.sendGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    r.leader.accept = false;
    const adding = r.watches.handle(addFrame(pr(1)), target.pid);
    await pollUntil(() => r.leader.sets.length === 1, "the add's set to be sent");
    const stopping = r.watches.stop();
    open();
    expect(await adding).toMatchObject({ ok: true, kind: "pr" });
    await stopping;
    const saved: unknown = JSON.parse(await readFile(r.path, "utf8"));
    expect(isRecord(saved) && Array.isArray(saved["watches"]) ? saved["watches"] : []).toHaveLength(1);
    expect(lineCount(r, "outcome=no_leader")).toBe(0);
  });

  test("a leader that does not answer in time is taken as ok", async () => {
    const r = rig();
    const target = await listening(r, "add-silent");
    r.leader.answer = false;
    const reply = await r.watches.handle(addFrame(pr(1)), target.pid);
    expect(reply).toMatchObject({ ok: true, kind: "pr" });
    expect(r.watches.holds(target.id)).toBe(true);
  });
});

describe("remove", () => {
  test("ok from the session that made it, unknown from another's and for a random id, and the next set lacks it", async () => {
    const r = rig();
    const target = await listening(r, "rm-a");
    const other = await listening(r, "rm-b");
    const id = await added(r, target, pr(1));
    const keep = await added(r, target, pr(2));
    expect(await r.watches.handle(removeFrame(id), other.pid)).toEqual({ ok: false, code: "unknown" });
    expect(await r.watches.handle(removeFrame("5f0c1c1e-8a5f-4d3a-9d6e-0a3f4a2b7c11"), target.pid)).toEqual({
      ok: false,
      code: "unknown",
    });
    expect(await r.watches.handle(removeFrame(id), null)).toEqual({ ok: false, code: "unbound" });
    expect(r.watches.holds(target.id)).toBe(true);
    expect(await r.watches.handle(removeFrame(id), target.pid)).toEqual({ ok: true });
    await pollUntil(() => !idsOf(r.latest()).includes(id), "the set after the remove");
    expect(idsOf(r.latest())).toEqual([keep]);
    expect(await r.watches.handle(removeFrame(id), target.pid)).toEqual({ ok: false, code: "unknown" });
  });
});

describe("a leader's events", () => {
  test("a wake note reaches the session's listener, and a suspension that heals by itself is appended without a wake", async () => {
    const r = rig();
    const target = await listening(r, "ev-wake");
    const id = await added(r, target, pr(1));
    expect(await r.watches.onEvent({ events: [checksFail(id)] })).toEqual({ ok: true, delivered: [id] });
    const [wake] = notes(target.listener);
    expect(wake).toMatchObject({ messageKind: "note", wake: true });
    expect(wake?.push).toContain(id);
    expect(wake?.push).toContain("A check failed");
    expect(wake?.push).toContain("build (required)");

    const limited = event(id, "suspended:limited", { kind: "suspended", reason: "limited", since: 1 });
    expect(await r.watches.onEvent({ events: [limited] })).toEqual({ ok: true, delivered: [id] });
    const [, quiet] = notes(target.listener);
    expect(quiet?.wake).toBeUndefined();
    expect(lineCount(r, "op=event kind=pr event=checks reason=- outcome=delivered")).toBe(1);
    expect(lineCount(r, "op=event kind=pr event=suspended reason=- outcome=delivered")).toBe(1);
  });

  test("two events for one watch in one frame are one note and one delivered id", async () => {
    const r = rig();
    const target = await listening(r, "ev-two");
    const id = await added(r, target, pr(1));
    const conflict = event(id, `conflict:${HEAD}`, { kind: "conflict", head: HEAD });
    expect(await r.watches.onEvent({ events: [checksFail(id), conflict] })).toEqual({ ok: true, delivered: [id] });
    expect(notes(target.listener)).toHaveLength(1);
    expect(lineCount(r, "op=event")).toBe(2);
  });

  test("an event already in seen is not delivered twice, but its id is listed", async () => {
    const r = rig();
    const target = await listening(r, "ev-seen");
    const id = await added(r, target, pr(1));
    await r.watches.onEvent({ events: [checksFail(id)] });
    expect(await r.watches.onEvent({ events: [checksFail(id)] })).toEqual({ ok: true, delivered: [id] });
    expect(notes(target.listener)).toHaveLength(1);
    // The delivered key is what the next set tells the leader, so a new leader does not repeat it.
    await r.watches.start();
    await pollUntil(() => r.latest().watches[0]?.seen.length === 1, "the next set to carry the delivered key");
    expect(r.latest().watches[0]?.seen).toEqual([`checks:${HEAD}:fail`]);
  });

  test("an id the table does not know is omitted, and the set is restated", async () => {
    const r = rig();
    const target = await listening(r, "ev-unknown");
    await added(r, target, pr(1));
    const before = r.leader.sets.length;
    const stranger = "5f0c1c1e-8a5f-4d3a-9d6e-0a3f4a2b7c11";
    expect(await r.watches.onEvent({ events: [merged(stranger)] })).toEqual({ ok: true, delivered: [] });
    await pollUntil(() => r.leader.sets.length > before, "a set after the unknown id");
  });

  test("a terminal event ends the watch, and the next set lacks it", async () => {
    const r = rig();
    const target = await listening(r, "ev-terminal");
    const id = await added(r, target, pr(1));
    const other = await added(r, target, pr(2));
    expect(await r.watches.onEvent({ events: [merged(id)] })).toEqual({ ok: true, delivered: [id] });
    expect(notes(target.listener)[0]?.push).toContain("The PR was merged");
    await pollUntil(() => !idsOf(r.latest()).includes(id), "the set after the end");
    expect(idsOf(r.latest())).toEqual([other]);
    expect(lineCount(r, "op=end kind=pr event=- reason=terminal")).toBe(1);

    const gone = event(other, "unreadable", { kind: "unreadable" });
    await r.watches.onEvent({ events: [gone] });
    expect(lineCount(r, "op=end kind=pr event=- reason=unreadable")).toBe(1);
    expect(r.watches.holds(target.id)).toBe(false);
  });

  test("a note held for a listener that dropped is listed delivered, and ends the watch when its grace runs out", async () => {
    const r = rig({ graceMs: 60 });
    const target = await listening(r, "ev-held");
    const id = await added(r, target, pr(1));
    target.listener.drop();
    expect(await r.watches.onEvent({ events: [checksFail(id)] })).toEqual({ ok: true, delivered: [id] });
    await pollUntil(() => !r.watches.holds(target.id), "the held note's fate to end the watch");
    expect(lineCount(r, "op=end kind=pr event=- reason=nolistener")).toBe(1);
  });

  test("a held note's keys are saved with the table, so a restart that loses the note does not have it sent again (accepted)", async () => {
    const r = rig({ graceMs: 5_000 });
    const target = await listening(r, "ev-held-saved");
    const id = await added(r, target, pr(1));
    target.listener.drop();
    expect(await r.watches.onEvent({ events: [checksFail(id)] })).toEqual({ ok: true, delivered: [id] });
    await r.watches.stop();
    // The leader keeps its per-watch `seen` and acknowledgements across a daemon's restart, so a key left out of the
    // file would be skipped there all the same; the file and the set carry the same `seen`.
    expect(await savedSeen(r.path)).toEqual([`checks:${HEAD}:fail`]);
  });

  test("an event in flight when the table stops is not delivered: the leader sends it to the next instance, and no end is lost", async () => {
    const r = rig();
    const target = await listening(r, "ev-stopping");
    const id = await added(r, target, pr(1));
    const pending = r.watches.onEvent({ events: [merged(id)] });
    const stopping = r.watches.stop();
    expect(await pending).toEqual({ ok: true, delivered: [] });
    await stopping;
    const saved: unknown = JSON.parse(await readFile(r.path, "utf8"));
    expect(isRecord(saved) && Array.isArray(saved["watches"]) ? saved["watches"] : []).toHaveLength(1);
    expect(lineCount(r, "op=end")).toBe(0);
  });

  test("a stopped table ends nothing and writes nothing: a held note's late fate leaves the file as the stop left it", async () => {
    const r = rig({ graceMs: 60 });
    const target = await listening(r, "ev-stopped");
    const id = await added(r, target, pr(1));
    target.listener.drop();
    await r.watches.onEvent({ events: [checksFail(id)] });
    await r.watches.stop();
    const before = await readFile(r.path, "utf8");
    // A negative: the grace runs out after the stop and must change nothing.
    await Bun.sleep(200);
    await r.watches.stop();
    expect(await readFile(r.path, "utf8")).toBe(before);
    expect(lineCount(r, "op=end")).toBe(0);
  });

  test("a note that finds the pane carrying another task ends the watch as task, not session", async () => {
    const r = rig();
    const target = await listening(r, "ev-moved", "task-moved-1");
    const id = await added(r, target, pr(1));
    await tmuxOk(["set-option", "-p", "-t", target.id, "@seance-task", "task-moved-2"]);
    expect(await r.watches.onEvent({ events: [checksFail(id)] })).toEqual({ ok: true, delivered: [] });
    expect(lineCount(r, "op=end kind=pr event=- reason=task")).toBe(1);
    expect(lineCount(r, "reason=session")).toBe(0);
  });

  test("a failed pane read delivers nothing and ends nothing, and the next event delivers (review finding 2)", async () => {
    const r = rig();
    const target = await listening(r, "ev-unreadable");
    const id = await added(r, target, pr(1));
    blind.failNext = true;
    expect(await r.watches.onEvent({ events: [checksFail(id)] })).toEqual({ ok: true, delivered: [] });
    expect(notes(target.listener)).toHaveLength(0);
    expect(r.watches.holds(target.id)).toBe(true);
    expect(lineCount(r, "op=end")).toBe(0);
    expect(await r.watches.onEvent({ events: [checksFail(id)] })).toEqual({ ok: true, delivered: [id] });
    expect(notes(target.listener)).toHaveLength(1);
  });

  test("a late fleet_full is told once with a wake note, and the watch stays", async () => {
    const r = rig();
    const target = await listening(r, "ev-full");
    r.leader.answer = false;
    const id = await added(r, target, pr(1));
    const refusal = [{ id, code: "fleet_full" as const }];
    await r.leader.reply(r.latest(), refusal);
    const [told] = notes(target.listener);
    expect(told).toMatchObject({ wake: true });
    expect(told?.push).toContain("capacity for GitHub watches is full");
    expect(r.watches.holds(target.id)).toBe(true);
    await r.leader.reply(r.latest(), refusal);
    expect(notes(target.listener)).toHaveLength(1);
    expect(lineCount(r, "op=event kind=pr event=fleet_full")).toBe(1);
  });

  test("a late invalid refusal is told and ends the watch", async () => {
    const r = rig();
    const target = await listening(r, "ev-invalid");
    r.leader.answer = false;
    const id = await added(r, target, pr(1));
    await r.leader.reply(r.latest(), [{ id, code: "invalid" }]);
    expect(notes(target.listener)[0]?.push).toContain("refused this watch as invalid");
    expect(r.watches.holds(target.id)).toBe(false);
    expect(lineCount(r, "op=end kind=pr event=- reason=invalid")).toBe(1);
  });

  test("a refusal for an older set is superseded by a later one", async () => {
    const r = rig();
    const target = await listening(r, "ev-superseded");
    r.leader.answer = false;
    const id = await added(r, target, pr(1));
    const first = r.latest();
    await added(r, target, pr(2));
    await r.leader.reply(first, [{ id, code: "fleet_full" }]);
    expect(notes(target.listener)).toHaveLength(0);
  });
});

describe("the tick", () => {
  test("an empty table reads no panes, at the start or at a tick, and a table with a watch does", async () => {
    let reads = 0;
    const r = rig({
      watches: {
        panes: () => {
          reads += 1;
          return listPanePids();
        },
      },
    });
    await r.watches.start();
    // A negative: several ticks (25 ms each) pass and read nothing.
    await Bun.sleep(150);
    expect(reads).toBe(0);
    const target = await listening(r, "tick-empty");
    await added(r, target, pr(1));
    const afterAdd = reads;
    await pollUntil(() => reads > afterAdd, "a tick to read the panes for the watch it holds");
  });

  test("a watch ends with its session: the claude process is gone", async () => {
    const r = rig();
    const target = await listening(r, "tick-session");
    await added(r, target, pr(1));
    await r.watches.start();
    process.kill(target.pid);
    await pollUntil(() => !r.watches.holds(target.id), "the watch to end with its session");
    expect(lineCount(r, "op=end kind=pr event=- reason=session")).toBe(1);
    await pollUntil(() => r.latest().watches.length === 0, "the set after the end");
  });

  test("a watch ends when its pane's task changes", async () => {
    const r = rig();
    const target = await listening(r, "tick-task", "task-one-1");
    await added(r, target, pr(1));
    await r.watches.start();
    await tmuxOk(["set-option", "-p", "-t", target.id, "@seance-task", "task-two-2"]);
    await pollUntil(() => !r.watches.holds(target.id), "the watch to end with its task");
    expect(lineCount(r, "op=end kind=pr event=- reason=task")).toBe(1);
  });

  test("a watch expires after 24 h with a wake note, then ends", async () => {
    const r = rig();
    const target = await listening(r, "tick-expire");
    await added(r, target, pr(1));
    await r.watches.start();
    clock.now += 25 * 60 * 60_000;
    await pollUntil(() => !r.watches.holds(target.id), "the watch to expire");
    const [told] = notes(target.listener);
    expect(told).toMatchObject({ wake: true });
    expect(told?.push).toContain("expired 24 h after");
    expect(lineCount(r, "op=end kind=pr event=- reason=expired")).toBe(1);
  });

  test("no_leader after 10 minutes without an answer is told once for a watch's life, and an answer never re-arms it", async () => {
    const r = rig();
    const target = await listening(r, "tick-noleader");
    r.leader.answer = false;
    await r.watches.start();
    await added(r, target, pr(1));
    const told = (): number => notes(target.listener).filter((n) => n.push.includes("No séance leader")).length;
    clock.now += 11 * 60_000;
    await pollUntil(() => told() === 1, "the no_leader note");
    expect(notes(target.listener).find((n) => n.push.includes("No séance leader"))?.wake).toBe(true);
    // An answer resets the clock for later watches, never for a watch already told.
    await r.leader.reply(r.latest());
    const later = await added(r, target, pr(2));
    clock.now += 11 * 60_000;
    await pollUntil(() => told() === 2, "the later watch's no_leader note");
    await Bun.sleep(150);
    expect(told()).toBe(2);
    expect(notes(target.listener).filter((n) => n.push.includes(later))).toHaveLength(1);
  });

  test("a leader that keeps answering is never told no_leader, and the heartbeat restates the set every 5 minutes", async () => {
    const r = rig();
    const target = await listening(r, "tick-beat");
    await r.watches.start();
    await added(r, target, pr(1));
    let seen = r.leader.sets.length;
    // Nothing is sent while answers are current and the heartbeat is not due.
    await Bun.sleep(150);
    expect(r.leader.sets).toHaveLength(seen);
    for (let beat = 0; beat < 3; beat++) {
      clock.now += 6 * 60_000;
      const expected = seen;
      // oxlint-disable-next-line no-await-in-loop -- a beat at a time
      await pollUntil(() => r.leader.sets.length > expected, "the heartbeat's set");
      seen = r.leader.sets.length;
    }
    expect(notes(target.listener)).toHaveLength(0);
  });

  test("a set the leader never answered is resent within a tick, and delivers once answered (review finding 1)", async () => {
    const r = rig();
    const target = await listening(r, "tick-resend");
    r.leader.answer = false;
    await r.watches.start();
    const id = await added(r, target, pr(1));
    await pollUntil(() => r.leader.sets.length >= 2, "a resend of the unanswered set");
    const [first, second] = r.leader.sets;
    // `n` still rises: the registry orders by it.
    expect(second?.gen.n).toBeGreaterThan(first?.gen.n ?? Infinity);
    expect(idsOf(second ?? first ?? r.latest())).toEqual([id]);
    r.leader.answer = true;
    await pollUntil(() => r.leader.sets.at(-1) !== second && r.leader.sets.length >= 3, "a resend that is answered");
    // Driven once: a poll callback that drives the table would deliver as often as the poll's pace says.
    expect(await r.watches.onEvent({ events: [merged(id)] })).toEqual({ ok: true, delivered: [id] });
  });

  test("an empty pane list is a failed read: it ends nothing by pane, while a dead claude still ends its watch", async () => {
    const r = rig();
    const target = await listening(r, "tick-blind");
    await added(r, target, pr(1));
    blind.panes = true;
    await r.watches.start();
    await Bun.sleep(150);
    expect(r.watches.holds(target.id)).toBe(true);
    process.kill(target.pid);
    await pollUntil(() => !r.watches.holds(target.id), "the dead claude's watch to end");
  });
});

describe("the table's own reads", () => {
  test("onEnded ends the pane's watches, and holds says which pane and task a watch waits on", async () => {
    const r = rig();
    const tasked = await listening(r, "own-tasked", "task-own-1");
    const bare = await listening(r, "own-bare");
    await added(r, tasked, pr(1));
    await added(r, bare, pr(2));
    expect(r.watches.holds(tasked.id)).toBe(true);
    expect(r.watches.holds(tasked.id, "task-own-1")).toBe(true);
    expect(r.watches.holds(tasked.id, "task-other")).toBe(false);
    expect(r.watches.holds(tasked.id, null)).toBe(false);
    expect(r.watches.holds(bare.id, null)).toBe(true);
    expect(r.watches.holds(bare.id, "task-own-1")).toBe(false);
    expect(r.watches.holds("%99999")).toBe(false);
    r.watches.onEnded(tasked.id, "task-own-1");
    await pollUntil(() => !r.watches.holds(tasked.id), "the pane's watch to end");
    expect(lineCount(r, "op=end kind=pr event=- reason=ended")).toBe(1);
    expect(r.watches.holds(bare.id)).toBe(true);
  });
});

describe("what the table holds open", () => {
  test("a live watch makes its pane and task await a wake for the custodian, and is no part of untouchable", async () => {
    const r = rig();
    const target = await listening(r, "holds-a", "task-holds-1");
    const holds = paneHolds({ events: () => undefined, drain: () => undefined, watches: () => r.watches });
    expect(holds.awaitsWake(target.id)).toBe(false);
    const id = await added(r, target, pr(1));
    expect(holds.awaitsWake(target.id)).toBe(true);
    expect(holds.awaitsWake(target.id, "task-holds-1")).toBe(true);
    expect(holds.awaitsWake(target.id, "task-other")).toBe(false);
    expect(holds.awaitsWake("%99999")).toBe(false);
    expect(holds.seatHolds(target.id)).toBe(true);
    expect(holds.untouchable(target.id)).toBe(false);
    expect(await r.watches.handle(removeFrame(id), target.pid)).toEqual({ ok: true });
    expect(holds.awaitsWake(target.id)).toBe(false);
    expect(holds.seatHolds(target.id)).toBe(false);
  });
});

describe("persistence", () => {
  test("a second table over the same path keeps a watch whose session still runs, and sends it in its first set", async () => {
    const first = rig();
    const target = await listening(first, "keep");
    const id = await added(first, target, pr(1), HEAD);
    await first.watches.stop();

    const second = rig({ path: first.path, boot: "22222222-2222-4222-8222-222222222222" });
    await second.watches.start();
    expect(second.leader.sets[0]).toEqual({
      gen: { boot: "22222222-2222-4222-8222-222222222222", n: 1 },
      watches: [{ id, kind: "pr", url: pr(1), head: HEAD, seen: [] }],
    });
    expect(second.watches.holds(target.id)).toBe(true);
    expect(lineCount(second, "reason=restart")).toBe(0);
  });

  test("it drops one whose claude was killed, audited as a restart", async () => {
    const first = rig();
    const target = await listening(first, "drop");
    await added(first, target, pr(1));
    await first.watches.stop();
    const saved: unknown = JSON.parse(await readFile(first.path, "utf8"));
    const entry = isRecord(saved) && Array.isArray(saved["watches"]) ? saved["watches"][0] : null;
    const session: unknown = isRecord(entry) ? entry["session"] : null;
    if (typeof session !== "string") throw new Error("no saved session");
    process.kill(target.pid);
    await pollUntil(() => !sessionAlive(session), "the claude to die");

    const second = rig({ path: first.path });
    await second.watches.start();
    expect(second.leader.sets).toHaveLength(0);
    expect(second.watches.holds(target.id)).toBe(false);
    expect(lineCount(second, "op=end kind=pr event=- reason=restart")).toBe(1);
  });

  test("a table stopped without awaiting still lands its last write before the next one reads (review finding 3)", async () => {
    const first = rig();
    const target = await listening(first, "chain");
    await first.watches.start();
    const id = await added(first, target, pr(1));
    void first.watches.stop();

    const second = rig({ path: first.path, boot: "33333333-3333-4333-8333-333333333333" });
    await second.watches.start();
    expect(second.leader.sets[0]?.watches.map((w) => w.id)).toEqual([id]);
  });
});

describe("the audit lines", () => {
  test("every line is from the closed set, and none carries a URL, owner, repo, number, head or id", async () => {
    const r = rig();
    const target = await listening(r, "audit");
    const id = await added(r, target, pr(1234), HEAD);
    const job = await added(r, target, run(98765));
    await r.watches.onEvent({ events: [checksFail(id)] });
    await r.watches.handle(removeFrame(job), target.pid);
    await r.watches.handle(addFrame(pr(1)), null);
    await r.watches.onEvent({ events: [merged(id)] });
    await pollUntil(() => lineCount(r, "op=end") > 0, "the end line");
    expect(r.audit.length).toBeGreaterThan(4);
    for (const line of r.audit) {
      expect(line).toMatch(AUDIT_LINE);
      expect(line).not.toMatch(/github|octo|widgets|\d{3,}|[0-9a-f]{8}-|aaaa|build/u);
    }
    expect(r.audit.some((line) => line.includes("kind=run"))).toBe(true);
  });
});

describe("through the socket", () => {
  let socket: LocalSocketHandle | undefined;
  afterEach(() => {
    socket?.stop();
    socket = undefined;
  });

  const ask = (path: string): Promise<unknown> =>
    exchange(addFrame(pr(1)), { path, timeoutMs: 8_000, timeoutText: "no reply from the socket" });

  test("a frame from outside any pane is answered unbound, and a socket with no table answers unsupported", async () => {
    const r = rig();
    await mkdir(join(base, "run"), { recursive: true });
    const path = join(base, "run", `watch-${(counter += 1)}.sock`);
    socket = await startLocalSocket({ handle: () => Promise.resolve(null), watches: r.watches.handle, path });
    expect(await ask(path)).toEqual({ ok: false, code: "unbound" });
    socket.stop();

    const bare = join(base, "run", `watch-${(counter += 1)}.sock`);
    socket = await startLocalSocket({ handle: () => Promise.resolve(null), path: bare });
    expect(await ask(bare)).toEqual({ ok: false, code: "unsupported" });
  });
});

/** Kept for the type: a pane as the table reads it. */
export type { BoundPane };
