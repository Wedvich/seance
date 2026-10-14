import { describe, expect, test } from "bun:test";
import { CONNECT_TIMEOUT_MS, LazyRelay } from "./app-relay.ts";
import { OP_TIMEOUT_MS, RequestFailure, type RequestOp } from "@seance/shared";
import { fakeRelay, machine, type FakeRelay } from "../test/fake-app-relay.ts";
import { pollUntil } from "../test/fixtures.ts";
import { createBroker, parseBrokerRequest, type Broker } from "./broker.ts";
import { brokerDeadlineMs, parseBrokerReply, parseMachines, type BrokerReply } from "./broker-protocol.ts";

const SELF = "device-self";
const REMOTE = machine({ deviceId: "device-2", name: "Linux Box" });

interface Rig {
  readonly broker: Broker;
  readonly fakes: FakeRelay[];
  readonly lines: string[];
}

function rig(
  respond: (op: RequestOp, payload: unknown) => unknown = () => ({ sessions: [], at: 1 }),
  opts: { readonly status?: "open" | "rejected"; readonly maxInFlight?: number; readonly idleMs?: number } = {},
): Rig {
  const fakes: FakeRelay[] = [];
  const lines: string[] = [];
  const relay = new LazyRelay({
    create: () => {
      const fake = fakeRelay([machine({ deviceId: SELF, name: "This Box" }), REMOTE], respond, opts.status);
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
    await broker.handle(request({ id: "a", remoteOp: "spawn", payload: { repo: "seance", mode: "here", client: "pwa" } }));
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
    const { broker } = rig(() => gate.promise.then(() => ({ sessions: [], at: 1 })), { maxInFlight: 1 });
    const first = broker.handle(request({ id: "slow" }));
    await pollUntil(async () => {
      const second = await broker.handle(request({ id: "second" }));
      return !second.ok && second.code === "busy";
    }, "the second request to be refused as busy");
    gate.resolve(null);
    expect((await first).ok).toBe(true);
    broker.stop();
  });

  test("stop fails an in-flight request as shutting_down and refuses new ones", async () => {
    const { broker, fakes } = rig(() => new Promise(() => {}));
    const pending = broker.handle(request({ remoteOp: "despawn", payload: { id: "%1" } }));
    await pollUntil(() => (fakes[0]?.requests.length ?? 0) > 0, "the request to reach the relay");
    // The fake never answers; stopping the real client is what fails its
    // pending requests, so mimic that order here.
    broker.stop();
    expect(fakes[0]?.stopped).toBe(true);
    const after = failed(await broker.handle(request({ id: "late" })));
    expect(after.code).toBe("shutting_down");
    void pending;
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

  test("a machine list with a mistyped entry is refused whole", () => {
    expect(parseMachines([{ ...REMOTE, connected: "yes" }])).toBeNull();
    expect(parseMachines([REMOTE])).toEqual([REMOTE]);
  });
});

describe("key handling", () => {
  test("nothing on the broker path can resolve a PSK of its own", async () => {
    // The broker must run on the key `startDaemon` imported — on a
    // credential-delivered box nothing else can read it, and a second lookup is
    // a second TPM touch. Structural, like raycast's layering test: the modules
    // the broker is made of never reach for the stores.
    for (const file of ["broker.ts", "broker-protocol.ts", "broker-client.ts", "app-relay.ts"]) {
      // oxlint-disable-next-line no-await-in-loop -- four small reads
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      expect(source).not.toMatch(/\bloadPsk\b|psk-store|tpmcreds|keychain|dpapi|credential\.ts/u);
    }
  });
});
