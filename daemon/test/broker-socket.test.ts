import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestFailure, type Plain, type RequestOp, type SessionsResponse } from "@seance/shared";
import { LazyRelay } from "../src/app-relay.ts";
import { BrokerError, brokerMachines, brokerRequest } from "../src/broker-client.ts";
import type { BrokerReply } from "../src/broker-protocol.ts";
import { createBroker, type Broker } from "../src/broker.ts";
import { localRequest } from "../src/local-client.ts";
import { startLocalSocket, type LocalSocketHandle } from "../src/local-socket.ts";
import { fakeRelay, machine } from "./fake-app-relay.ts";
import { pollUntil } from "./fixtures.ts";

/**
 * The fleet broker over the real local op socket and the real client: framing,
 * correlation, refusals and the failure modes a peer can see. The relay under
 * the broker is a fake — the real one is e2e's.
 */

const SELF = "device-self";
const REMOTE = machine({ deviceId: "device-2", name: "Linux Box" });

let base: string;
let respond: (op: RequestOp, payload: unknown) => unknown = () => ({ sessions: [], at: 1 });
let machines = [machine({ deviceId: SELF, name: "This Box" }), REMOTE];
const handled: Plain[] = [];
const audit: string[] = [];

function startBroker(): Broker {
  return createBroker({
    selfDeviceId: SELF,
    relay: new LazyRelay({ create: () => fakeRelay(machines, (op, payload) => respond(op, payload)) }),
    auditSink: (line) => void audit.push(line),
  });
}

async function listen(
  path: string,
  broker: ((raw: unknown) => Promise<BrokerReply>) | undefined,
): Promise<LocalSocketHandle> {
  return startLocalSocket({
    path,
    handle: (plain) => {
      handled.push(plain);
      const payload: SessionsResponse = { sessions: [], at: 7 };
      return Promise.resolve({ id: "reply", ts: Date.now(), op: plain.op, re: plain.id, payload });
    },
    ...(broker === undefined ? {} : { broker }),
  });
}

let sockPath: string;
let broker: Broker;
let socket: LocalSocketHandle;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-brk-"));
  sockPath = join(base, "seanced.sock");
  broker = startBroker();
  socket = await listen(sockPath, broker.handle);
});

afterAll(async () => {
  socket.stop();
  broker.stop();
  await rm(base, { recursive: true, force: true });
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

/** Raw bytes in, raw text out — for frames the real client would never send. */
async function raw(payload: string, waitMs = 300): Promise<string> {
  let received = "";
  const sock = await Bun.connect<undefined>({
    unix: sockPath,
    socket: { data: (_s, chunk: Buffer): void => void (received += chunk.toString()), error: (): void => {} },
  });
  sock.write(payload);
  await Bun.sleep(waitMs);
  sock.end();
  return received;
}

describe("the fleet broker on the local op socket", () => {
  test("a keyless peer lists the fleet and reaches a remote machine, each reply correlated", async () => {
    handled.length = 0;
    respond = (op, payload) => ({ op, payload, sessions: [], at: 1 });
    const listed = await brokerMachines({ path: sockPath });
    expect(listed.map((entry) => entry.name)).toEqual(["This Box", "Linux Box"]);

    // Concurrent: one connection each, so every answer must come back to its own caller.
    const [a, b] = await Promise.all([
      brokerRequest<{ op: string }>("device-2", "sessions", {}, { path: sockPath }),
      brokerRequest<{ op: string; payload: unknown }>(
        "device-2",
        "spawn",
        { repo: "seance", mode: "here", client: "mcp" },
        { path: sockPath },
      ),
    ]);
    expect(a.op).toBe("sessions");
    expect(b).toMatchObject({ op: "spawn", payload: { repo: "seance", mode: "here", client: "mcp" } });
    // Broker frames never reach the op handler — nothing here touched this box's tmux.
    expect(handled).toHaveLength(0);
    expect(audit.join("\n")).not.toContain("origin=local ");
  });

  test("the plain local ops still reach the handler, untouched by the broker", async () => {
    handled.length = 0;
    const reply = await localRequest<SessionsResponse>("sessions", {}, { path: sockPath });
    expect(reply.at).toBe(7);
    expect(handled.map((plain) => plain.op)).toEqual(["sessions"]);
  });

  test("a relay failure arrives as the same RequestFailure the direct path throws", async () => {
    respond = () => new RequestFailure("offline", "that machine is not connected");
    const err = await rejection(
      brokerRequest("device-2", "spawn", { repo: "seance", mode: "here" }, { path: sockPath }),
    );
    expect(err).toBeInstanceOf(RequestFailure);
    expect(err).toMatchObject({ reason: "offline" });
  });

  test("refusals come back structured, over the wire", async () => {
    for (const [deviceId, op, code] of [
      ["machines", "spawn", "invalid_target"],
      [SELF, "sessions", "self_target"],
      ["device-forged", "sessions", "unknown_target"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time, each asserted alone
      const err = await rejection(brokerRequest(deviceId, op, { repo: "seance", mode: "here" }, { path: sockPath }));
      expect(err).toBeInstanceOf(BrokerError);
      expect(err).toMatchObject({ code });
    }
    const forged = await raw(
      `${JSON.stringify({ v: 1, kind: "broker", id: "x", action: "request", deviceId: "device-2", remoteOp: "rescan" })}\n`,
    );
    expect(JSON.parse(forged.trim())).toMatchObject({ re: "x", ok: false, code: "op_not_allowed" });
    const sealing = await raw(`${JSON.stringify({ v: 1, kind: "broker", id: "y", action: "seal", payload: "x" })}\n`);
    expect(JSON.parse(sealing.trim())).toMatchObject({ re: "y", ok: false, code: "unsupported" });
  });

  test("a broker frame with no id is dropped, like any malformed frame", async () => {
    expect(await raw(`${JSON.stringify({ v: 1, kind: "broker", action: "machines" })}\n`)).toBe("");
  });

  test("an answer past the frame cap is replaced by a structured refusal, not truncated", async () => {
    const repos = Array.from({ length: 12_000 }, (_, i) => ({
      name: `repo-${i}`,
      path: `/a/fairly/long/path/to/repositories/repo-${i}`,
      defaultBranch: "main",
    }));
    machines = [machine({ deviceId: SELF }), { ...REMOTE, repos }];
    const local = startBroker();
    const path = join(base, "big.sock");
    const big = await listen(path, local.handle);
    try {
      const err = await rejection(brokerMachines({ path }));
      expect(err).toMatchObject({ code: "reply_too_large" });
    } finally {
      big.stop();
      local.stop();
      machines = [machine({ deviceId: SELF, name: "This Box" }), REMOTE];
    }
  });

  test("a broker that throws still answers, as internal_error", async () => {
    const path = join(base, "throws.sock");
    const throwing = await listen(path, () => Promise.reject(new Error("kaboom")));
    try {
      const err = await rejection(brokerMachines({ path }));
      expect(err).toMatchObject({ code: "internal_error" });
    } finally {
      throwing.stop();
    }
  });

  test("a daemon with no broker says so instead of dropping the frame", async () => {
    const path = join(base, "nobroker.sock");
    const bare = await listen(path, undefined);
    try {
      expect(await rejection(brokerMachines({ path }))).toMatchObject({ code: "unsupported" });
    } finally {
      bare.stop();
    }
  });

  test("a daemon older than the broker reads as one, with the fix named", async () => {
    // What a pre-broker daemon does with a frame that is not a `Plain`: drop it
    // and close. The probe is `machines`, which cannot have done anything.
    const path = join(base, "old.sock");
    const old = Bun.listen<undefined>({ unix: path, socket: { data: (sock): void => void sock.end() } });
    try {
      const err = await rejection(brokerMachines({ path }));
      expect(err).toMatchObject({ code: "daemon_closed" });
      expect(String(err)).toContain("older than the fleet broker");
    } finally {
      old.stop(true);
    }
  });

  test("no daemon at all is unreachable, and nothing was sent", async () => {
    const err = await rejection(brokerRequest("device-2", "spawn", {}, { path: join(base, "absent.sock") }));
    expect(err).toMatchObject({ code: "daemon_unreachable" });
    expect(String(err)).not.toContain("may have landed");
  });

  test("a spawn that outlives the deadline is reported as possibly landed — and not retried", async () => {
    let asked = 0;
    const path = join(base, "slow.sock");
    const slow = await listen(path, () => {
      asked += 1;
      return new Promise(() => {});
    });
    try {
      const err = await rejection(
        brokerRequest("device-2", "spawn", { repo: "seance", mode: "here" }, { path, timeoutMs: 100 }),
      );
      expect(err).toMatchObject({ code: "daemon_timeout" });
      expect(String(err)).toContain("may have landed anyway");
      expect(asked).toBe(1);
    } finally {
      slow.stop();
    }
  });

  test("a daemon stopping mid-despawn reads as possibly landed; once it is back, calls recover", async () => {
    const path = join(base, "restart.sock");
    let reached = false;
    const first = await listen(path, () => {
      reached = true;
      return new Promise(() => {});
    });
    const pending = rejection(brokerRequest("device-2", "despawn", { id: "%1" }, { path }));
    await pollUntil(() => reached, "the despawn to reach the daemon");
    first.stop();
    const err = await pending;
    expect(err).toMatchObject({ code: "daemon_closed" });
    expect(String(err)).toContain("may have landed anyway");

    // Down: a fresh call is refused before anything is sent.
    expect(await rejection(brokerMachines({ path }))).toMatchObject({ code: "daemon_unreachable" });

    const local = startBroker();
    const second = await listen(path, local.handle);
    try {
      expect((await brokerMachines({ path })).length).toBe(2);
    } finally {
      second.stop();
      local.stop();
    }
  });
});
