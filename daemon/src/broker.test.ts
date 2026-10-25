import { describe, expect, test } from "bun:test";
import { CONNECT_TIMEOUT_MS, LazyRelay } from "./app-relay.ts";
import {
  OP_TIMEOUT_MS,
  RequestFailure,
  STORE_LIST_TIMEOUT_MS,
  STORE_TIMEOUT_MS,
  type AccountRecord,
  type RequestOp,
  type SchedulerAvailability,
  type Task,
} from "@seance/shared";
import { fakeRelay, machine, type FakeRelay } from "../test/fake-app-relay.ts";
import { pollUntil } from "../test/fixtures.ts";
import { createBroker, parseBrokerRequest, type Broker } from "./broker.ts";
import {
  brokerDeadlineMs,
  brokerSchedulerDeadlineMs,
  parseBrokerReply,
  parseMachines,
  parseSchedulerAvailability,
  parseTaskCreated,
  type BrokerReply,
} from "./broker-protocol.ts";

const SELF = "device-self";
const REMOTE = machine({ deviceId: "device-2", name: "Linux Box" });

interface Rig {
  readonly broker: Broker;
  readonly fakes: FakeRelay[];
  readonly lines: string[];
}

function rig(
  respond: (op: RequestOp, payload: unknown) => unknown = () => ({ sessions: [], at: 1 }),
  opts: {
    readonly status?: "open" | "rejected";
    readonly maxInFlight?: number;
    readonly idleMs?: number;
    readonly now?: () => number;
    readonly scheduler?: SchedulerAvailability;
    readonly accounts?: readonly AccountRecord[];
  } = {},
): Rig {
  const fakes: FakeRelay[] = [];
  const lines: string[] = [];
  const relay = new LazyRelay({
    create: () => {
      const fake = fakeRelay([machine({ deviceId: SELF, name: "This Box" }), REMOTE], respond, opts.status);
      if (opts.scheduler !== undefined) fake.setState({ scheduler: opts.scheduler });
      if (opts.accounts !== undefined) fake.accounts = opts.accounts;
      fakes.push(fake);
      return fake;
    },
    ...(opts.idleMs === undefined ? {} : { idleMs: opts.idleMs }),
  });
  const broker = createBroker({
    selfDeviceId: SELF,
    relay,
    auditSink: (line) => void lines.push(line),
    ...(opts.maxInFlight === undefined ? {} : { maxInFlight: opts.maxInFlight }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  return { broker, fakes, lines };
}

function request(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    kind: "broker",
    id: "r1",
    action: "request",
    deviceId: "device-2",
    remoteOp: "sessions",
    payload: {},
    ...extra,
  };
}

const TASK_ID = "11111111-2222-4333-8444-555555555555";
const LEADING: SchedulerAvailability = { kind: "ready", deviceId: SELF, term: 4 };

function frame(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, kind: "broker", id: "s1", action: "scheduler", ...extra };
}

function enqueue(
  specExtra: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return frame({
    schedulerOp: "enqueue",
    taskId: TASK_ID,
    spec: { repo: "github.com/m/seance", mode: "worktree", prompt: "secret plans", client: "mcp", ...specExtra },
    ...extra,
  });
}

function parsedRequest(raw: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseBrokerRequest(raw, SELF);
  if (!("request" in parsed)) throw new Error(`expected a request, got ${parsed.code}: ${parsed.message}`);
  return { ...parsed.request };
}

function refusedCode(raw: Record<string, unknown>): string {
  const parsed = parseBrokerRequest(raw, SELF);
  if (!("code" in parsed)) throw new Error("expected a refusal");
  return parsed.code;
}

function failed(reply: BrokerReply): { code: string; message: string; reason?: string } {
  if (reply.ok) throw new Error(`expected a failure, got ${JSON.stringify(reply)}`);
  return reply;
}

describe("parseBrokerRequest refuses everything off the allowlist", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["an encryption request", request({ action: "seal" }), "unsupported"],
    ["a decryption request", request({ action: "open" }), "unsupported"],
    ["a key export", request({ action: "export-key" }), "unsupported"],
    ["a registry delete", request({ action: "forget" }), "unsupported"],
    ["a newer protocol version", request({ v: 2 }), "unsupported"],
    ["remote rescan", request({ remoteOp: "rescan" }), "op_not_allowed"],
    ["remote update-available", request({ remoteOp: "update-available" }), "op_not_allowed"],
    ["remote machine-info", request({ remoteOp: "machine-info" }), "op_not_allowed"],
    ["a forget smuggled in as an op", request({ remoteOp: "forget" }), "op_not_allowed"],
    ["the group address", request({ deviceId: "machines" }), "invalid_target"],
    ["the app address", request({ deviceId: "app" }), "invalid_target"],
    ["this machine", request({ deviceId: SELF }), "self_target"],
    ["no deviceId", request({ deviceId: undefined }), "invalid_request"],
    ["a malformed spawn", request({ remoteOp: "spawn", payload: { repo: "" } }), "invalid_request"],
    [
      "a spawn with a non-boolean plan",
      request({ remoteOp: "spawn", payload: { repo: "r", mode: "here", plan: "yes" } }),
      "invalid_request",
    ],
    ["a malformed despawn", request({ remoteOp: "despawn", payload: { id: 12 } }), "invalid_request"],
    ["no id", request({ id: undefined }), "invalid_request"],
    ["not an object", { length: 3 }, "invalid_request"],
  ];
  for (const [label, raw, code] of cases) {
    test(label, () => {
      const parsed = parseBrokerRequest(raw, SELF);
      const got: string | null = "code" in parsed ? parsed.code : null;
      expect(got).toBe(code);
    });
  }

  test("a spawn payload is rebuilt from validated fields, so nothing else reaches the wire", () => {
    const parsed = parseBrokerRequest(
      request({
        remoteOp: "spawn",
        payload: { repo: "seance", mode: "worktree", prompt: "p", client: "mcp", plan: true, smuggled: "x" },
      }),
      SELF,
    );
    if (!("request" in parsed) || parsed.request.action !== "request") throw new Error("expected a request");
    expect(parsed.request.payload).toEqual({
      repo: "seance",
      mode: "worktree",
      prompt: "p",
      plan: true,
      client: "mcp",
    });
  });

  test("sessions carries no payload at all", () => {
    const parsed = parseBrokerRequest(request({ payload: { anything: 1 } }), SELF);
    if (!("request" in parsed) || parsed.request.action !== "request") throw new Error("expected a request");
    expect(parsed.request.payload).toEqual({});
  });
});

describe("parseBrokerRequest on scheduler frames", () => {
  test("fleet and every allowlisted scheduler op parse", () => {
    expect(parsedRequest({ v: 1, kind: "broker", id: "f", action: "fleet" })).toMatchObject({ action: "fleet" });
    expect(parsedRequest(frame({ schedulerOp: "queue" }))).toMatchObject({ schedulerOp: "queue" });
    expect(parsedRequest(frame({ schedulerOp: "accounts" }))).toMatchObject({ schedulerOp: "accounts" });
    expect(parsedRequest(frame({ schedulerOp: "cancel", taskId: TASK_ID }))).toMatchObject({
      schedulerOp: "cancel",
      taskId: TASK_ID,
    });
    expect(parsedRequest(enqueue())).toMatchObject({ schedulerOp: "enqueue", taskId: TASK_ID });
  });

  const refused: [string, Record<string, unknown>, string][] = [
    ["mark-done", frame({ schedulerOp: "mark-done", taskId: TASK_ID }), "op_not_allowed"],
    ["pause", frame({ schedulerOp: "pause" }), "op_not_allowed"],
    ["discard", frame({ schedulerOp: "discard", taskId: TASK_ID, version: 1 }), "op_not_allowed"],
    ["route-preview", frame({ schedulerOp: "route-preview" }), "op_not_allowed"],
    ["no scheduler op", frame(), "op_not_allowed"],
    ["a cancel without a task id", frame({ schedulerOp: "cancel" }), "invalid_request"],
    ["a cancel of an id that is not one", frame({ schedulerOp: "cancel", taskId: "../x" }), "invalid_request"],
    ["an enqueue with a bad task id", enqueue({}, { taskId: "not an id" }), "invalid_request"],
    ["an enqueue with no spec", frame({ schedulerOp: "enqueue", taskId: TASK_ID }), "invalid_request"],
    ["an unparseable spec", enqueue({ mode: "sideways" }), "invalid_request"],
    ["a spec over the prompt bound", enqueue({ prompt: "x".repeat(100_000) }), "invalid_request"],
    ["a spec with lineage", enqueue({ lineage: { deviceId: "device-2", exclave: "default" } }), "invalid_request"],
    ["a spec with base", enqueue({ base: { deviceId: "device-2", exclave: "default" } }), "invalid_request"],
    ["the PWA as client", enqueue({ client: "pwa" }), "invalid_request"],
    ["raycast as client", enqueue({ client: "raycast" }), "invalid_request"],
    ["the scheduler as client", enqueue({ client: "scheduler" }), "invalid_request"],
    ["no client", enqueue({ client: undefined }), "invalid_request"],
  ];
  for (const [label, raw, code] of refused) {
    test(`${label} is refused`, () => {
      expect(refusedCode(raw)).toBe(code);
    });
  }

  test("the cli is a client a keyless peer may claim", () => {
    expect(parsedRequest(enqueue({ client: "cli" }))).toMatchObject({ spec: { client: "cli" } });
  });

  test("what is sealed is the parsed spec: fields it does not know never survive, pins keep only what they carry", () => {
    const parsed = parsedRequest(
      enqueue({
        smuggled: "x",
        createdAt: 1,
        pin: { deviceId: "device-2", exclave: "default", account: "org-a:me", also: 1 },
        avoid: ["device-3"],
      }),
    );
    expect(parsed["spec"]).toEqual({
      repo: "github.com/m/seance",
      mode: "worktree",
      prompt: "secret plans",
      client: "mcp",
      pin: { deviceId: "device-2", account: "org-a:me" },
      avoid: ["device-3"],
    });
  });

  test("queue and accounts forward nothing the peer put beside them", () => {
    expect(parsedRequest(frame({ schedulerOp: "queue", taskId: TASK_ID, spec: { repo: "x" }, key: "k" }))).toEqual({
      v: 1,
      kind: "broker",
      id: "s1",
      action: "scheduler",
      schedulerOp: "queue",
    });
  });
});

describe("the broker's scheduler actions", () => {
  test("an enqueue is sealed from the parsed spec: the daemon's clock, the peer's id and claimed client", async () => {
    const { broker, fakes, lines } = rig(undefined, { now: () => 5_000 });
    const reply = await broker.handle(enqueue({ client: "cli" }));
    expect(reply).toMatchObject({ ok: true, re: "s1", data: { ok: true, landedEarlier: false } });
    expect(fakes[0]?.creates).toEqual([
      {
        id: TASK_ID,
        state: "queued",
        createdAt: 5_000,
        spec: { repo: "github.com/m/seance", mode: "worktree", prompt: "secret plans", client: "cli" },
      },
    ]);
    expect(lines).toContain(
      `audit broker origin=local-broker action=scheduler op="enqueue" task="${TASK_ID}" claimed_client="cli" id="s1"`,
    );
    expect(lines).toContain(
      `audit enqueue origin=local-broker claimed_client=cli task="${TASK_ID}" createdAt=5000 queued`,
    );
    expect(lines.join("\n")).not.toContain("secret plans");
    broker.stop();
  });

  test("a peer's createdAt is ignored, not honoured", async () => {
    const { broker, fakes } = rig(undefined, { now: () => 7_000 });
    await broker.handle(enqueue({ createdAt: 1 }, { createdAt: 1, task: { createdAt: 1 } }));
    expect(fakes[0]?.creates.map((task) => task.createdAt)).toEqual([7_000]);
    broker.stop();
  });

  // The fake takes the `Task`, not the store frame, so `expect: 0` is not observable here; e2e's real relay
  // and the shared client's own tests hold that. This is the broker's half: the answer and its audit line.
  test("a repeated id's landedEarlier answer is relayed and audited as such", async () => {
    const { broker, fakes, lines } = rig(undefined, { now: () => 5_000 });
    const seen = new Set<string>();
    // The relay's answer to a create at `expect: 0` on a key that holds a record.
    const onCreate = (task: Task): { ok: true; landedEarlier: boolean } => {
      const again = seen.has(task.id);
      seen.add(task.id);
      return { ok: true, landedEarlier: again };
    };
    const first = await broker.handle(enqueue());
    // The first dial made the fake; point its answers at the stateful relay.
    const fake = fakes[0];
    if (fake === undefined) throw new Error("expected a relay");
    fake.onCreate = onCreate;
    seen.add(TASK_ID);
    const second = await broker.handle(enqueue({}, { id: "s2" }));
    expect(first).toMatchObject({ data: { ok: true, landedEarlier: false } });
    expect(second).toMatchObject({ ok: true, re: "s2", data: { ok: true, landedEarlier: true } });
    expect(lines).toContain(
      `audit enqueue origin=local-broker claimed_client=mcp task="${TASK_ID}" createdAt=5000 queued landedEarlier=true`,
    );
    broker.stop();
  });

  test("a refused create is relayed with its code and audited as refused", async () => {
    const { broker, fakes, lines } = rig();
    await broker.handle(enqueue({}, { id: "warm" }));
    const fake = fakes[0];
    if (fake === undefined) throw new Error("expected a relay");
    fake.onCreate = () => ({ ok: false, code: "rate_limited" });
    const reply = await broker.handle(enqueue({}, { id: "s2" }));
    expect(reply).toMatchObject({ ok: true, data: { ok: false, code: "rate_limited" } });
    expect(
      lines.some((line) => line.includes("claimed_client=mcp") && line.endsWith('refused code="rate_limited"')),
    ).toBe(true);
    broker.stop();
  });

  test("a create the relay never answered is relayed as null and audited as unanswered", async () => {
    const { broker, fakes, lines } = rig();
    await broker.handle(enqueue({}, { id: "warm" }));
    const fake = fakes[0];
    if (fake === undefined) throw new Error("expected a relay");
    fake.onCreate = () => null;
    const reply = await broker.handle(enqueue({}, { id: "s2" }));
    expect(reply).toMatchObject({ ok: true, data: null });
    expect(
      lines.some((line) => line.startsWith("audit enqueue origin=local-broker") && line.endsWith("unanswered")),
    ).toBe(true);
    broker.stop();
  });

  test("a create that fails in flight keeps its reason and target and still leaves an outcome line", async () => {
    const { broker, fakes, lines } = rig();
    await broker.handle(enqueue({}, { id: "warm" }));
    const fake = fakes[0];
    if (fake === undefined) throw new Error("expected a relay");
    fake.onCreate = () => new RequestFailure("timeout", "store-put timed out", "relay");
    const reply = failed(await broker.handle(enqueue({}, { id: "s2" })));
    expect(reply).toMatchObject({ code: "request_failed", reason: "timeout", target: "relay" });
    expect(
      lines.some((line) => line.startsWith("audit enqueue origin=local-broker") && line.endsWith("unanswered")),
    ).toBe(true);
    broker.stop();
  });

  test("a create that never left the daemon leaves no outcome line, since nothing can have been stored", async () => {
    const { broker, fakes, lines } = rig();
    await broker.handle(enqueue({}, { id: "warm" }));
    const fake = fakes[0];
    if (fake === undefined) throw new Error("expected a relay");
    const before = lines.length;
    fake.onCreate = () => new RequestFailure("disconnected", "the relay hung up");
    const reply = failed(await broker.handle(enqueue({}, { id: "s2" })));
    expect(reply).toMatchObject({ code: "request_failed", reason: "disconnected" });
    expect(lines.slice(before).filter((line) => line.startsWith("audit enqueue "))).toEqual([]);
    // The failure itself is still on record, as for any brokered request.
    expect(lines.slice(before).some((line) => line.includes("failed code=request_failed reason=disconnected"))).toBe(
      true,
    );
    broker.stop();
  });

  test("queue and cancel ask the leader as an app, and refuse before sending when none is ready", async () => {
    const queue = { at: 1, tasks: [] };
    const { broker, fakes, lines } = rig((op) => (op === "queue" ? queue : { task: { id: TASK_ID } }), {
      scheduler: LEADING,
    });
    expect(await broker.handle(frame({ schedulerOp: "queue" }))).toMatchObject({ ok: true, data: queue });
    await broker.handle(frame({ id: "c1", schedulerOp: "cancel", taskId: TASK_ID }));
    expect(fakes[0]?.requests.map((sent) => [sent.op, sent.payload])).toEqual([
      ["queue", {}],
      ["cancel", { taskId: TASK_ID }],
    ]);
    expect(lines).toContain(`audit broker origin=local-broker action=scheduler op="cancel" task="${TASK_ID}" id="c1"`);
    expect(lines).toContain('audit broker origin=local-broker ok id="c1"');
    broker.stop();

    const none = rig();
    for (const raw of [frame({ schedulerOp: "queue" }), frame({ schedulerOp: "cancel", taskId: TASK_ID })]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential: each is its own broker reply
      expect(failed(await none.broker.handle(raw))).toMatchObject({ code: "request_failed", reason: "no_leader" });
    }
    expect(none.fakes[0]?.requests).toEqual([]);
    none.broker.stop();
  });

  test("an unverified leader is refused as leader_unverified, nothing sent", async () => {
    const { broker, fakes } = rig(undefined, { scheduler: { kind: "unverified", deviceId: SELF, term: 4 } });
    const reply = failed(await broker.handle(frame({ schedulerOp: "queue" })));
    expect(reply).toMatchObject({ code: "request_failed", reason: "leader_unverified" });
    expect(fakes[0]?.requests).toEqual([]);
    broker.stop();
  });

  test("accounts are listed once across calls: one socket, one list budget", async () => {
    const records: AccountRecord[] = [{ accountId: "org-a:me", alias: "personal", version: 1 }];
    const { broker, fakes } = rig(undefined, { accounts: records });
    const first = await broker.handle(frame({ schedulerOp: "accounts" }));
    const second = await broker.handle(frame({ id: "s2", schedulerOp: "accounts" }));
    expect(first).toMatchObject({ ok: true, data: records });
    expect(second).toMatchObject({ ok: true, data: records });
    expect(fakes[0]?.accountLists).toBe(1);
    broker.stop();
  });

  test("an account listing the client cannot make reads as null, never a crash", async () => {
    const { broker, fakes } = rig();
    await broker.handle(frame({ schedulerOp: "queue" }));
    const fake = fakes[0];
    if (fake === undefined) throw new Error("expected a relay");
    fake.accounts = new RequestFailure("unsupported", "no account key", "relay");
    const reply = await broker.handle(frame({ id: "a", schedulerOp: "accounts" }));
    expect(reply).toMatchObject({ ok: true, data: null });
    broker.stop();
  });

  test("fleet answers the registry and the scheduler's availability in one reply", async () => {
    const { broker, lines } = rig(undefined, { scheduler: LEADING });
    const reply = await broker.handle({ v: 1, kind: "broker", id: "f1", action: "fleet" });
    if (!reply.ok) throw new Error("expected the fleet");
    const data = reply.data;
    if (typeof data !== "object" || data === null || !("machines" in data) || !("scheduler" in data)) {
      throw new Error("expected machines and a scheduler");
    }
    expect(parseMachines(data.machines)?.map((entry) => entry.deviceId)).toEqual([SELF, "device-2"]);
    expect(parseSchedulerAvailability(data.scheduler)).toEqual(LEADING);
    expect(lines).toContain('audit broker origin=local-broker action=fleet id="f1"');
    broker.stop();
  });

  test("a refused scheduler op is logged by its scheduler op, not as op=undefined", async () => {
    const { broker } = rig();
    const reply = failed(await broker.handle(frame({ schedulerOp: "pause" })));
    expect(reply.code).toBe("op_not_allowed");
    expect(reply.message).toContain('"pause"');
    broker.stop();
  });

  test("fleet and machines are answered while the scheduler's slots are full", async () => {
    const gate = Promise.withResolvers<null>();
    const { broker, fakes } = rig(() => gate.promise.then(() => ({ at: 1, tasks: [] })), {
      maxInFlight: 1,
      scheduler: LEADING,
    });
    // A slow scheduler call holds the whole scheduler share (a cancel waits up to 25 s).
    const slow = broker.handle(frame({ schedulerOp: "queue" }));
    await pollUntil(() => (fakes[0]?.requests.length ?? 0) > 0, "the queue request to reach the relay");
    expect(failed(await broker.handle(frame({ id: "s2", schedulerOp: "queue" }))).code).toBe("busy");
    const fleet = await broker.handle({ v: 1, kind: "broker", id: "f1", action: "fleet" });
    expect(fleet).toMatchObject({ ok: true, re: "f1" });
    const machines = await broker.handle({ v: 1, kind: "broker", id: "m1", action: "machines" });
    expect(machines).toMatchObject({ ok: true, re: "m1" });
    gate.resolve(null);
    expect((await slow).ok).toBe(true);
    broker.stop();
  });

  test("scheduler ops count toward the in-flight bound", async () => {
    const gate = Promise.withResolvers<null>();
    const { broker, fakes } = rig(() => gate.promise.then(() => ({ at: 1, tasks: [] })), {
      maxInFlight: 1,
      scheduler: LEADING,
    });
    const first = broker.handle(frame({ schedulerOp: "queue" }));
    await pollUntil(() => (fakes[0]?.requests.length ?? 0) > 0, "the queue request to reach the relay");
    expect(failed(await broker.handle(frame({ id: "s2", schedulerOp: "queue" }))).code).toBe("busy");
    gate.resolve(null);
    expect((await first).ok).toBe(true);
    broker.stop();
  });
});

describe("the broker", () => {
  test("dials nothing until asked, then serves the registry and reuses one connection", async () => {
    const { broker, fakes, lines } = rig();
    expect(fakes).toHaveLength(0);
    const [a, b] = await Promise.all([
      broker.handle({ v: 1, kind: "broker", id: "m1", action: "machines" }),
      broker.handle({ v: 1, kind: "broker", id: "m2", action: "machines" }),
    ]);
    await broker.handle(request());
    expect(fakes).toHaveLength(1);
    if (!a.ok || !b.ok) throw new Error("expected the registry");
    expect(a.re).toBe("m1");
    expect(b.re).toBe("m2");
    expect(parseMachines(a.data)?.map((entry) => entry.deviceId)).toEqual([SELF, "device-2"]);
    expect(lines).toContain('audit broker origin=local-broker action=machines id="m1"');
    broker.stop();
    expect(fakes[0]?.stopped).toBe(true);
  });

  test("a validation refusal never dials the relay", async () => {
    const { broker, fakes } = rig();
    for (const raw of [
      request({ remoteOp: "rescan" }),
      request({ deviceId: "machines" }),
      request({ deviceId: SELF }),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential on purpose: each must refuse alone
      expect((await broker.handle(raw)).ok).toBe(false);
    }
    expect(fakes).toHaveLength(0);
    broker.stop();
  });

  test("forwards an allowlisted op to the exact deviceId and audits metadata, never the prompt", async () => {
    const { broker, fakes, lines } = rig(() => ({ ok: true, window: "w", path: "/p", sessions: [] }));
    const reply = await broker.handle(
      request({ remoteOp: "spawn", payload: { repo: "seance", mode: "here", prompt: "secret plans", client: "mcp" } }),
    );
    expect(reply).toMatchObject({ ok: true, re: "r1", data: { ok: true, window: "w" } });
    expect(fakes[0]?.requests).toEqual([
      {
        deviceId: "device-2",
        op: "spawn",
        payload: { repo: "seance", mode: "here", prompt: "secret plans", client: "mcp" },
      },
    ]);
    const log = lines.join("\n");
    expect(log).toContain(
      'audit broker origin=local-broker action=request op="spawn" target="device-2" client="mcp" id="r1"',
    );
    expect(log).toContain('audit broker origin=local-broker ok id="r1"');
    expect(log).not.toContain("secret plans");
    broker.stop();
  });

  test("a peer's client name never reaches the target: the broker stamps mcp itself", async () => {
    const { broker, fakes, lines } = rig(() => ({ ok: true, window: "w", path: "/p", sessions: [] }));
    await broker.handle(
      request({ id: "a", remoteOp: "spawn", payload: { repo: "seance", mode: "here", client: "pwa" } }),
    );
    await broker.handle(request({ id: "b", remoteOp: "despawn", payload: { id: "%1", client: "pwa" } }));
    await broker.handle(request({ id: "c", remoteOp: "spawn", payload: { repo: "seance", mode: "here" } }));
    expect(fakes[0]?.requests.map((sent) => sent.payload)).toEqual([
      { repo: "seance", mode: "here", client: "mcp" },
      { id: "%1", client: "mcp" },
      { repo: "seance", mode: "here", client: "mcp" },
    ]);
    expect(lines.join("\n")).not.toContain('client="pwa"');
    broker.stop();
  });

  test("an id the registry does not hold is refused without a send", async () => {
    const { broker, fakes } = rig();
    const reply = failed(await broker.handle(request({ deviceId: "device-forged" })));
    expect(reply.code).toBe("unknown_target");
    expect(fakes[0]?.requests).toHaveLength(0);
    broker.stop();
  });

  test("a relay failure keeps its reason, so a timeout still reads as possibly landed", async () => {
    const { broker, lines } = rig(() => new RequestFailure("timeout", "spawn timed out after 90000ms"));
    const reply = failed(
      await broker.handle(request({ remoteOp: "spawn", payload: { repo: "seance", mode: "here" } })),
    );
    expect(reply).toMatchObject({
      code: "request_failed",
      reason: "timeout",
      message: "spawn timed out after 90000ms",
    });
    expect(lines.join("\n")).toContain("failed code=request_failed reason=timeout");
    broker.stop();
  });

  test("a relay that rejects the token is reported as unavailable, with the reason", async () => {
    const { broker } = rig(undefined, { status: "rejected" });
    const reply = failed(await broker.handle({ v: 1, kind: "broker", id: "m", action: "machines" }));
    expect(reply.code).toBe("relay_unavailable");
    expect(reply.message).toContain("bearer token");
    broker.stop();
  });

  test("a crash in the request path still answers, as internal_error", async () => {
    const { broker } = rig(() => new TypeError("boom"));
    const reply = failed(await broker.handle(request()));
    expect(reply.code).toBe("internal_error");
    expect(reply.message).toContain("boom");
    broker.stop();
  });

  test("past the in-flight bound a request is refused as busy, not queued", async () => {
    const gate = Promise.withResolvers<null>();
    const { broker, fakes } = rig(() => gate.promise.then(() => ({ sessions: [], at: 1 })), { maxInFlight: 1 });
    const first = broker.handle(request({ id: "slow" }));
    await pollUntil(() => (fakes[0]?.requests.length ?? 0) > 0, "the first request to reach the relay");
    const second = failed(await broker.handle(request({ id: "second" })));
    expect(second.code).toBe("busy");
    expect(fakes[0]?.requests).toHaveLength(1);
    gate.resolve(null);
    expect((await first).ok).toBe(true);
    broker.stop();
  });

  test("stop fails an in-flight request as stopped_in_flight and refuses new ones as shutting_down", async () => {
    const { broker, fakes } = rig(() => new Promise(() => {}));
    const pending = broker.handle(request({ remoteOp: "despawn", payload: { id: "%1" } }));
    await pollUntil(() => (fakes[0]?.requests.length ?? 0) > 0, "the request to reach the relay");
    broker.stop();
    expect(fakes[0]?.stopped).toBe(true);
    expect(failed(await pending).code).toBe("stopped_in_flight");
    const after = failed(await broker.handle(request({ id: "late" })));
    expect(after.code).toBe("shutting_down");
  });

  test("the app-role socket hangs up when idle and the next request redials", async () => {
    const { broker, fakes } = rig(undefined, { idleMs: 20 });
    await broker.handle(request());
    await pollUntil(() => fakes[0]?.stopped === true, "the idle timer to close the broker's socket");
    await broker.handle(request());
    expect(fakes).toHaveLength(2);
    broker.stop();
  });
});

describe("the broker protocol", () => {
  test("a brokered deadline covers the daemon's connect and settle, then the op's own timeout", () => {
    expect(brokerDeadlineMs("spawn")).toBeGreaterThan(CONNECT_TIMEOUT_MS + OP_TIMEOUT_MS.spawn);
    expect(brokerDeadlineMs("despawn")).toBeGreaterThan(CONNECT_TIMEOUT_MS + OP_TIMEOUT_MS.despawn);
    expect(brokerDeadlineMs("sessions")).toBeGreaterThan(CONNECT_TIMEOUT_MS + OP_TIMEOUT_MS.sessions);
    expect(brokerDeadlineMs(null)).toBeGreaterThan(CONNECT_TIMEOUT_MS);
  });

  test("a reply with a code this build does not know is unreadable, not guessed at", () => {
    expect(
      parseBrokerReply({ v: 1, kind: "broker-reply", re: "x", ok: false, code: "new_code", message: "m" }),
    ).toBeNull();
    expect(parseBrokerReply({ v: 1, kind: "broker-reply", re: "x", ok: true, data: [] })).toMatchObject({ ok: true });
  });

  test("a scheduler deadline covers the daemon's connect and settle, then the op's own budget", () => {
    expect(brokerSchedulerDeadlineMs("enqueue")).toBeGreaterThan(CONNECT_TIMEOUT_MS + STORE_TIMEOUT_MS);
    expect(brokerSchedulerDeadlineMs("accounts")).toBeGreaterThan(CONNECT_TIMEOUT_MS + STORE_LIST_TIMEOUT_MS);
    expect(brokerSchedulerDeadlineMs("queue")).toBeGreaterThan(CONNECT_TIMEOUT_MS + OP_TIMEOUT_MS.queue);
    expect(brokerSchedulerDeadlineMs("cancel")).toBeGreaterThan(CONNECT_TIMEOUT_MS + OP_TIMEOUT_MS.cancel);
  });

  test("a scheduler availability this build cannot read is no leader at all", () => {
    expect(parseSchedulerAvailability({ kind: "ready", deviceId: "d", term: 2 })).toEqual({
      kind: "ready",
      deviceId: "d",
      term: 2,
    });
    for (const garbage of [
      null,
      "ready",
      {},
      { kind: "elected", deviceId: "d", term: 1 },
      { kind: "ready", deviceId: "", term: 1 },
      { kind: "ready", deviceId: "d", term: -1 },
      { kind: "ready", deviceId: "d", term: 1.5 },
      { kind: "unverified", deviceId: "d" },
    ]) {
      expect(parseSchedulerAvailability(garbage)).toEqual({ kind: "none" });
    }
  });

  test("an enqueue answer is stored, refused, lost — or not an answer at all", () => {
    expect(parseTaskCreated({ ok: true, landedEarlier: true })).toEqual({ ok: true, landedEarlier: true });
    expect(parseTaskCreated({ ok: false, code: "too_large" })).toEqual({ ok: false, code: "too_large" });
    expect(parseTaskCreated(null)).toBeNull();
    for (const garbage of [undefined, "ok", {}, { ok: true }, { ok: false }, { ok: false, code: 3 }]) {
      expect(parseTaskCreated(garbage)).toBeUndefined();
    }
  });

  test("a machine's exclaves, capabilities and status ride the list; a malformed status drops only itself", () => {
    const exclaves = [
      { id: "default", accountId: "org-a:me", email: "me@x.no", extraUsageEnabled: null, authOk: true, skills: [] },
    ];
    const status = { at: 5, scan: 1_000 };
    const full = { ...REMOTE, exclaves, capabilities: ["taskId"], status };
    expect(parseMachines([full])).toEqual([full]);
    expect(parseMachines([{ ...full, status: { at: "now" } }])).toEqual([
      { ...REMOTE, exclaves, capabilities: ["taskId"] },
    ]);
    // A malformed exclave list costs the exclaves, never the machine.
    expect(parseMachines([{ ...REMOTE, exclaves: "default" }])).toEqual([REMOTE]);
  });

  test("a machine list with a mistyped entry is refused whole", () => {
    expect(parseMachines([{ ...REMOTE, connected: "yes" }])).toBeNull();
    expect(parseMachines([REMOTE])).toEqual([REMOTE]);
  });

  test("a machine's build and update report ride the list; a malformed one is dropped, not the machine", () => {
    const source = { sha: "b".repeat(40), commitTs: 1_700_000_000_000, branch: "main" };
    const lastUpdate = { at: 1_700_000_100_000, outcome: "fetch_failed" as const };
    expect(parseMachines([{ ...REMOTE, source, lastUpdate }])).toEqual([{ ...REMOTE, source, lastUpdate }]);
    expect(parseMachines([{ ...REMOTE, source: { sha: 1 }, lastUpdate: "ok" }])).toEqual([REMOTE]);
  });
});

describe("key handling", () => {
  test("nothing on the broker path can resolve a PSK of its own", async () => {
    // The broker must run on the key `startDaemon` imported — on a
    // credential-delivered box nothing else can read it, and a second lookup is
    // a second TPM touch. Structural, like raycast's layering test: the modules
    // the broker is made of never reach for the stores.
    for (const file of ["broker.ts", "broker-protocol.ts", "broker-client.ts", "app-relay.ts", "account-cache.ts"]) {
      // oxlint-disable-next-line no-await-in-loop -- five small reads
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      expect(source).not.toMatch(/\bloadPsk\b|psk-store|tpmcreds|keychain|dpapi|credential\.ts/u);
    }
  });
});
