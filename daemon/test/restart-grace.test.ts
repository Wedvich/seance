import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plain, SessionsResponse } from "@seance/shared";
import { brokerMachines, brokerSchedulerCall } from "../src/broker-client.ts";
import { brokerFrameId, brokerOk, type BrokerReply } from "../src/broker-protocol.ts";
import { LocalConnectionLost, localRequest, LocalUnavailable } from "../src/local-client.ts";
import { startLocalSocket, type LocalSocketHandle } from "../src/local-socket.ts";
import { pollUntil } from "./fixtures.ts";

/**
 * A daemon restarting under a local call (DESIGN.md "Local op socket", "Fleet broker"): a call whose
 * repeat changes nothing is sent again once the daemon listens again; anything else is reported as
 * the lost call it is, sent once. Real socket on both ends; the daemon behind it is a handler double.
 */

let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-grace-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const NEVER = new Promise<never>(() => {});

/** A daemon that takes every op and answers none of them — what a restart cuts off. */
function hung(path: string, seen: unknown[], broker = false): Promise<LocalSocketHandle> {
  return startLocalSocket({
    path,
    handle: (plain) => {
      seen.push(plain);
      return NEVER;
    },
    ...(broker
      ? {
          broker: (raw: unknown): Promise<BrokerReply> => {
            seen.push(raw);
            return NEVER;
          },
        }
      : {}),
  });
}

/** The daemon after the restart: answers ops with an empty session list and broker frames with `data`. */
function answering(path: string, seen: unknown[], data: unknown = []): Promise<LocalSocketHandle> {
  return startLocalSocket({
    path,
    handle: (plain: Plain) => {
      seen.push(plain);
      const payload: SessionsResponse = { sessions: [], at: 7 };
      return Promise.resolve({ id: crypto.randomUUID(), ts: Date.now(), op: plain.op, re: plain.id, payload });
    },
    broker: (raw) => {
      seen.push(raw);
      return Promise.resolve(brokerOk(brokerFrameId(raw) ?? "", data));
    },
  });
}

/** Leaves the socket file a daemon killed outright (or a self-update's exit) leaves: there, refusing. */
async function staleSocket(path: string): Promise<void> {
  const child = Bun.spawn(
    ["bun", "-e", `Bun.listen({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); console.log("up")`],
    { stdout: "pipe" },
  );
  await child.stdout.getReader().read();
  child.kill("SIGKILL");
  await child.exited;
  expect(existsSync(path)).toBe(true);
}

const TASK_ID = "11111111-2222-4333-8444-555555555555";

/** The gap a service manager leaves between the old daemon's exit and the new one's bind. */
const DOWN_MS = 400;

describe("a daemon restarting under a call", () => {
  test("a sessions read lost mid-request is answered by the daemon that comes back, same request", async () => {
    const path = join(base, "sessions.sock");
    const before: unknown[] = [];
    const after: unknown[] = [];
    const first = await hung(path, before);
    const reply = localRequest<SessionsResponse>("sessions", {}, { path });
    await pollUntil(() => before.length === 1, "the read to reach the first daemon");
    first.stop();
    await Bun.sleep(DOWN_MS);
    const second = await answering(path, after);
    try {
      expect(await reply).toEqual({ sessions: [], at: 7 });
      // The same frame, so the same request id.
      expect(after).toEqual(before);
    } finally {
      second.stop();
    }
  });

  test("a despawn lost mid-request is reported at once and never sent again", async () => {
    const path = join(base, "despawn.sock");
    const seen: unknown[] = [];
    const first = await hung(path, seen);
    const reply = localRequest("despawn", { id: "%1" }, { path }).catch((err: unknown) => err);
    await pollUntil(() => seen.length === 1, "the despawn to reach the daemon");
    first.stop();
    expect(await reply).toBeInstanceOf(LocalConnectionLost);
    const second = await answering(path, seen);
    try {
      // A negative assertion: a retry, had there been one, would have landed by now.
      await Bun.sleep(DOWN_MS);
      expect(seen).toHaveLength(1);
    } finally {
      second.stop();
    }
  });

  test("a socket left refusing by a daemon that did not stop cleanly is waited out", async () => {
    const path = join(base, "stale.sock");
    await staleSocket(path);
    const seen: unknown[] = [];
    const machines = brokerMachines({ path });
    await Bun.sleep(DOWN_MS);
    const back = await answering(path, seen);
    try {
      expect(await machines).toEqual([]);
      expect(seen).toHaveLength(1);
    } finally {
      back.stop();
    }
  });

  test("no socket file at all is a daemon not running, said at once", async () => {
    const started = Date.now();
    const err = await localRequest("sessions", {}, { path: join(base, "absent.sock") }).catch(
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(LocalUnavailable);
    // Far short of the restart grace a waited-out socket would spend, with a loaded runner's slack.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a daemon that never comes back fails the read once the grace is spent, still as a lost call", async () => {
    const path = join(base, "gone.sock");
    const seen: unknown[] = [];
    const first = await hung(path, seen);
    const reply = localRequest("sessions", {}, { path, restartGraceMs: 600 }).catch((err: unknown) => err);
    await pollUntil(() => seen.length === 1, "the read to reach the daemon");
    first.stop();
    // The first try reached the daemon, so the last try's missing socket must not read as never sent.
    expect(await reply).toBeInstanceOf(LocalConnectionLost);
  });

  test("a brokered enqueue is sent again across a restart; a cancel is not", async () => {
    const path = join(base, "sched.sock");
    const before: unknown[] = [];
    const after: unknown[] = [];
    const created = { ok: true, version: 1, landedEarlier: true };

    let first = await hung(path, before, true);
    const enqueue = brokerSchedulerCall(
      {
        schedulerOp: "enqueue",
        taskId: TASK_ID,
        spec: { repo: "seance", mode: "worktree", client: "mcp", prompt: "x" },
      },
      { path },
    );
    await pollUntil(() => before.length === 1, "the enqueue to reach the daemon");
    first.stop();
    await Bun.sleep(DOWN_MS);
    let second = await answering(path, after, created);
    try {
      expect(await enqueue).toEqual(created);
      expect(after).toHaveLength(1);
      expect(brokerFrameId(after[0])).toBe(brokerFrameId(before[0]));
    } finally {
      second.stop();
    }

    before.length = 0;
    after.length = 0;
    first = await hung(path, before, true);
    const cancel = brokerSchedulerCall({ schedulerOp: "cancel", taskId: TASK_ID }, { path }).catch(
      (err: unknown) => err,
    );
    await pollUntil(() => before.length === 1, "the cancel to reach the daemon");
    first.stop();
    expect(await cancel).toMatchObject({ code: "daemon_closed" });
    second = await answering(path, after, null);
    try {
      await Bun.sleep(DOWN_MS);
      expect(after).toHaveLength(0);
    } finally {
      second.stop();
    }
  });
});
