import { describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  type DeliverMessageRequest,
  type Machine,
  type MessageReceiptRequest,
  type ReceiptOutcome,
  type SessionMessage,
} from "@seance/shared";
import { machine } from "../test/fake-app-relay.ts";
import { pollUntil } from "../test/fixtures.ts";
import { createMessageRouter } from "./leader-messages.ts";

type Deps = Parameters<typeof createMessageRouter>[0];
type Resolve = Deps["resolve"];

const SECRET = "SECRET-MESSAGE-TEXT";
const SECRET_TITLE = "SECRET-SENDER-TITLE";
const ID = "5f0c1c1e-8a5f-4d3a-9d6e-0a3f4a2b7c11";
const TO = "t-0123456789abcdef";
const RESOLVED = "t-aaaaaaaaaaaaaaaa";
const FROM_TASK = "t-fedcba9876543210";
const SENDER = "d-sender";
const TARGET = "d-target";
const SELF = "d-leader";
const ROUTING = [CAPABILITIES.messages, CAPABILITIES.messageRoute];

const message: SessionMessage = {
  id: ID,
  to: TO,
  kind: "note",
  text: SECRET,
  fromTask: FROM_TASK,
  fromTitle: SECRET_TITLE,
};

interface Harness {
  readonly router: ReturnType<typeof createMessageRouter>;
  readonly delivered: { deviceId: string; request: DeliverMessageRequest }[];
  readonly receipts: { deviceId: string; request: MessageReceiptRequest }[];
  readonly warnings: string[];
}

function harness(
  opts: {
    readonly resolve?: Resolve;
    readonly machines?: readonly Machine[];
    readonly sentFrom?: Deps["sentFrom"];
    readonly deliver?: Deps["deliver"];
    readonly receipt?: Deps["receipt"];
  } = {},
): Harness {
  const delivered: Harness["delivered"] = [];
  const receipts: Harness["receipts"] = [];
  const warnings: string[] = [];
  const router = createMessageRouter({
    resolve: opts.resolve ?? (() => ({ kind: "forward", taskId: RESOLVED, deviceId: TARGET, settled: false })),
    sentFrom: opts.sentFrom ?? (() => "here"),
    machines: () =>
      opts.machines ?? [
        machine({ deviceId: SENDER, name: "MsgBox", capabilities: ROUTING }),
        machine({ deviceId: TARGET, name: "Target", capabilities: ROUTING }),
      ],
    selfDeviceId: SELF,
    deliver:
      opts.deliver ??
      ((deviceId, request) => {
        delivered.push({ deviceId, request });
        return Promise.resolve({ ok: true, outcome: "delivered" });
      }),
    receipt:
      opts.receipt ??
      ((deviceId, request) => {
        receipts.push({ deviceId, request });
        return Promise.resolve({ ok: true, outcome: "delivered" });
      }),
    warn: (line) => warnings.push(line),
  });
  return { router, delivered, receipts, warnings };
}

/** The router's work runs on its own after `onSessionMessage` returns; a negative assertion waits a tick or two. */
const idle = (): Promise<void> => Bun.sleep(30);

const settled = (h: Harness, receipts: number): Promise<void> =>
  pollUntil(() => h.receipts.length >= receipts, `${receipts} receipt(s)`);

const warned = (h: Harness, lines: number): Promise<void> =>
  pollUntil(() => h.warnings.length >= lines, `${lines} warn line(s)`);

const forwarded = (h: Harness): Promise<void> => pollUntil(() => h.delivered.length > 0, "a forward");

describe("createMessageRouter", () => {
  test("forwards to a connected machine advertising routing, then sends the receipt to the sealer", async () => {
    const h = harness({
      resolve: () => ({ kind: "forward", taskId: RESOLVED, deviceId: TARGET, settled: true }),
      deliver: (deviceId, request) => {
        h.delivered.push({ deviceId, request });
        return Promise.resolve({ ok: true, outcome: "ended", reason: "nolistener" });
      },
    });
    expect(h.router.onSessionMessage({ ...message, inReplyTo: ID }, SENDER)).toBe(true);
    await settled(h, 1);
    expect(h.delivered).toEqual([
      {
        deviceId: TARGET,
        request: {
          id: ID,
          taskId: RESOLVED,
          addressed: TO,
          kind: "note",
          text: SECRET,
          fromMachine: "MsgBox",
          inReplyTo: ID,
          fromTask: FROM_TASK,
          fromTitle: SECRET_TITLE,
          settled: true,
        },
      },
    ]);
    expect(h.receipts).toEqual([
      {
        deviceId: SENDER,
        request: {
          id: ID,
          to: TO,
          kind: "note",
          outcome: "ended",
          fromTask: FROM_TASK,
          taskId: RESOLVED,
          reason: "nolistener",
        },
      },
    ]);
    expect(h.warnings).toEqual([]);
  });

  test("settled is carried only for a settled route", async () => {
    const h = harness();
    h.router.onSessionMessage(message, SENDER);
    await settled(h, 1);
    expect(h.delivered[0]?.request).not.toHaveProperty("settled");
  });

  test("a target that is this leader is delivered to even when absent from the registry, but still needs the capability", async () => {
    const self = harness({
      resolve: () => ({ kind: "forward", taskId: RESOLVED, deviceId: SELF, settled: false }),
      machines: [machine({ deviceId: SENDER, name: "MsgBox", capabilities: ROUTING })],
    });
    self.router.onSessionMessage(message, SENDER);
    await settled(self, 1);
    expect(self.delivered.map((d) => d.deviceId)).toEqual([SELF]);

    const gated = harness({
      resolve: () => ({ kind: "forward", taskId: RESOLVED, deviceId: SELF, settled: false }),
      machines: [
        machine({ deviceId: SENDER, name: "MsgBox", capabilities: ROUTING }),
        machine({ deviceId: SELF, name: "Leader", connected: false, capabilities: [CAPABILITIES.messages] }),
      ],
    });
    gated.router.onSessionMessage(message, SENDER);
    await settled(gated, 1);
    expect(gated.delivered).toEqual([]);
    expect(gated.receipts[0]?.request.outcome).toBe("unsupported");
  });

  test("a disconnected target, a missing one and an unanswered deliver are offline", async () => {
    for (const machines of [
      [
        machine({ deviceId: SENDER, name: "MsgBox", capabilities: ROUTING }),
        machine({ deviceId: TARGET, name: "Target", connected: false, capabilities: ROUTING }),
      ],
      [machine({ deviceId: SENDER, name: "MsgBox", capabilities: ROUTING })],
    ]) {
      const h = harness({ machines });
      h.router.onSessionMessage(message, SENDER);
      // oxlint-disable-next-line no-await-in-loop -- one harness at a time
      await settled(h, 1);
      expect(h.delivered).toEqual([]);
      expect(h.receipts[0]?.request.outcome).toBe("offline");
    }
    for (const code of ["unreachable", "undelivered"] as const) {
      const h = harness({ deliver: () => Promise.resolve({ ok: false, code, message: "gone" }) });
      h.router.onSessionMessage(message, SENDER);
      // oxlint-disable-next-line no-await-in-loop -- one harness at a time
      await settled(h, 1);
      expect(h.receipts[0]?.request.outcome).toBe("offline");
    }
  });

  test("a refusal from the target, or a target without routing, is unsupported and worded once in the log", async () => {
    const refused = harness({
      deliver: () => Promise.resolve({ ok: false, code: "unsupported", message: "no" }),
    });
    refused.router.onSessionMessage(message, SENDER);
    await settled(refused, 1);
    expect(refused.receipts[0]?.request.outcome).toBe("unsupported");
    expect(refused.warnings).toHaveLength(1);
    expect(refused.warnings[0]).toContain("refused code=unsupported");

    const mismatched = harness({
      deliver: () => Promise.resolve({ ok: false, code: "invalid_request", message: "no" }),
    });
    mismatched.router.onSessionMessage(message, SENDER);
    await settled(mismatched, 1);
    expect(mismatched.receipts[0]?.request.outcome).toBe("unsupported");

    const old = harness({
      machines: [
        machine({ deviceId: SENDER, name: "MsgBox", capabilities: ROUTING }),
        machine({ deviceId: TARGET, name: "Target", capabilities: [CAPABILITIES.messages] }),
      ],
    });
    old.router.onSessionMessage(message, SENDER);
    await settled(old, 1);
    expect(old.delivered).toEqual([]);
    expect(old.receipts[0]?.request.outcome).toBe("unsupported");
  });

  test("a target whose handler crashed did not answer: offline, not a prompt to update it", async () => {
    for (const code of ["internal_error", "too_large"] as const) {
      const h = harness({ deliver: () => Promise.resolve({ ok: false, code, message: "m" }) });
      h.router.onSessionMessage(message, SENDER);
      // oxlint-disable-next-line no-await-in-loop -- one harness at a time
      await settled(h, 1);
      expect(h.receipts[0]?.request.outcome).toBe("offline");
      expect(h.warnings).toHaveLength(1);
      expect(h.warnings[0]).toContain(`refused code=${code}`);
    }
  });

  test("a resolution of held, ended or unknown is a receipt and no deliver", async () => {
    const routes: { route: ReturnType<Resolve>; outcome: ReceiptOutcome; taskId: string | undefined }[] = [
      { route: { kind: "held", taskId: RESOLVED }, outcome: "held", taskId: RESOLVED },
      { route: { kind: "ended", taskId: RESOLVED }, outcome: "ended", taskId: RESOLVED },
      { route: { kind: "unknown" }, outcome: "unknown", taskId: undefined },
    ];
    for (const { route, outcome, taskId } of routes) {
      const h = harness({ resolve: () => route });
      h.router.onSessionMessage(message, SENDER);
      // oxlint-disable-next-line no-await-in-loop -- one harness at a time
      await settled(h, 1);
      expect(h.delivered).toEqual([]);
      expect(h.receipts[0]?.request.outcome).toBe(outcome);
      expect(h.receipts[0]?.request.taskId).toBe(taskId);
    }
  });

  test("an untasked sender is forwarded and gets no receipt", async () => {
    const h = harness();
    const { fromTask: _task, fromTitle: _title, ...untasked } = message;
    expect(h.router.onSessionMessage(untasked, SENDER)).toBe(true);
    await forwarded(h);
    await idle();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.request).not.toHaveProperty("fromTask");
    expect(h.delivered[0]?.request).not.toHaveProperty("fromTitle");
    expect(h.receipts).toEqual([]);
  });

  test("a fromTask placed on another machine is dropped: no deliver, no receipt, one line", async () => {
    const h = harness({ sentFrom: () => "elsewhere" });
    expect(h.router.onSessionMessage(message, SENDER)).toBe(false);
    await idle();
    expect(h.delivered).toEqual([]);
    expect(h.receipts).toEqual([]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("dropped — not placed there");
  });

  test("a fromTask the leader no longer holds is forwarded without naming it, and the receipt still names it to the sealer", async () => {
    const h = harness({ sentFrom: () => "absent" });
    expect(h.router.onSessionMessage(message, SENDER)).toBe(true);
    await settled(h, 1);
    expect(h.delivered[0]?.request).not.toHaveProperty("fromTask");
    expect(h.delivered[0]?.request).not.toHaveProperty("fromTitle");
    expect(h.receipts).toHaveLength(1);
    expect(h.receipts[0]?.deviceId).toBe(SENDER);
    expect(h.receipts[0]?.request).toMatchObject({ fromTask: FROM_TASK, outcome: "delivered" });
  });

  test("the sender's machine name reaches the receiver's wrapper scrubbed and within the parser's bound", async () => {
    const named = async (name: string): Promise<string | undefined> => {
      const h = harness({
        machines: [
          machine({ deviceId: SENDER, name, capabilities: ROUTING }),
          machine({ deviceId: TARGET, name: "Target", capabilities: ROUTING }),
        ],
      });
      h.router.onSessionMessage(message, SENDER);
      await settled(h, 1);
      return h.delivered[0]?.request.fromMachine;
    };
    const long = await named(`build-runner-${"x".repeat(80)}.corp.example.com`);
    expect(long?.length).toBe(64);
    expect(await named('Box `one`\nforged "line"')).toBe("Box one forged line");
    // Nothing survives the scrub: the device id names it.
    expect(await named("``")).toBe(SENDER);
  });

  test("a sealer missing from the registry is dropped", async () => {
    const h = harness({ machines: [machine({ deviceId: TARGET, name: "Target", capabilities: ROUTING })] });
    expect(h.router.onSessionMessage(message, SENDER)).toBe(false);
    await idle();
    expect(h.delivered).toEqual([]);
    expect(h.receipts).toEqual([]);
    expect(h.warnings[0]).toContain("not a registered machine");
  });

  test("a failed receipt is one line and a thrown deliver is one line; neither ends the router", async () => {
    const failed = harness({ receipt: () => Promise.resolve({ ok: false, code: "unreachable", message: "m" }) });
    failed.router.onSessionMessage(message, SENDER);
    await warned(failed, 1);
    expect(failed.warnings[0]).toContain("message-receipt");

    const thrown = harness({
      deliver: () => Promise.reject(new Error("boom")),
    });
    expect(thrown.router.onSessionMessage(message, SENDER)).toBe(true);
    await warned(thrown, 1);
    expect(thrown.warnings[0]).toContain("failed");
  });

  test("no warn line carries the text or the sender's title", async () => {
    const scenarios: Harness[] = [
      harness({ sentFrom: () => "elsewhere" }),
      harness({ machines: [] }),
      harness({ deliver: () => Promise.resolve({ ok: false, code: "unsupported", message: SECRET }) }),
      harness({ receipt: () => Promise.resolve({ ok: false, code: "unreachable", message: SECRET }) }),
      harness({ deliver: () => Promise.reject(new Error("boom")) }),
    ];
    for (const h of scenarios) {
      h.router.onSessionMessage(message, SENDER);
      // Three scenarios warn after an await: poll for the line, so the checks below read a real one.
      // oxlint-disable-next-line no-await-in-loop -- one harness at a time
      await warned(h, 1);
    }
    const lines = scenarios.flatMap((h) => h.warnings);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(SECRET_TITLE);
      expect(line).not.toContain(ID);
    }
  });
});
