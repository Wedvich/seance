import type { MessageRoute } from "@seance/scheduler";
import {
  CAPABILITIES,
  displayTitle,
  quote,
  type DeliverMessageRequest,
  type Machine,
  type MessageReceiptRequest,
  ROUTING_ID_MAX_LENGTH,
  type ReceiptOutcome,
  type SessionMessage,
} from "@seance/shared";
import type { TermMessages } from "./leader-adapters.ts";

/**
 * The leader's side of a session message (DESIGN.md, "Session messages", "Cross-machine"): admit it, resolve the task
 * it names through the scheduler's own list, forward it to the machine holding the resolved task and tell the sender
 * what became of it. The leader keeps nothing and logs a line only for a message it drops or a forward that failed:
 * never the text, a title or a message id, since a line per message would be a record of who spoke to whom.
 */

export interface MessageRouterDeps {
  readonly resolve: (to: string) => MessageRoute;
  /** `absent`: the leader no longer holds that task (a pruned one whose session may live), not one placed elsewhere. */
  readonly sentFrom: (taskId: string, deviceId: string) => "here" | "elsewhere" | "absent";
  readonly machines: () => readonly Machine[];
  readonly selfDeviceId: string;
  readonly deliver: TermMessages["deliverMessage"];
  readonly receipt: TermMessages["messageReceipt"];
  readonly warn: (line: string) => void;
}

export interface MessageRouter {
  /**
   * `from` is the sealing daemon, AAD-bound (or this one, in process). True when the message was taken: the rest runs
   * on its own and never throws, since an error here must not end the term. False when it was dropped, with a warn line.
   */
  readonly onSessionMessage: (message: SessionMessage, from: string) => boolean;
}

function advertisesRouting(machine: Machine, reply: boolean): boolean {
  const capabilities = machine.capabilities ?? [];
  return (
    capabilities.includes(CAPABILITIES.messages) &&
    capabilities.includes(CAPABILITIES.messageRoute) &&
    (!reply || capabilities.includes(CAPABILITIES.messageReply))
  );
}

/**
 * The sender machine's name as the receiver's wrapper shows it. A name is any string the owner configured, and it sits
 * inside backticks there, while the receiver's parser holds `fromMachine` to `ROUTING_ID_MAX_LENGTH`: so it goes through
 * `displayTitle`'s scrub and is cut to that length, and a name nothing survives of falls back to the device id.
 */
function senderLabel(name: string, deviceId: string): string {
  let label = "";
  for (const char of displayTitle(name) ?? "") {
    if (label.length + char.length > ROUTING_ID_MAX_LENGTH) break;
    label += char;
  }
  return label === "" ? deviceId : label;
}

export function createMessageRouter(deps: MessageRouterDeps): MessageRouter {
  /** Forwards one `deliver-message` to a machine, or says why not: the receipt's outcome and reason. */
  const forward = async (
    deviceId: string,
    reply: boolean,
    request: DeliverMessageRequest,
    about: string,
  ): Promise<{ readonly outcome: ReceiptOutcome; readonly reason?: "nolistener" }> => {
    const self = deviceId === deps.selfDeviceId;
    const target = deps.machines().find((m) => m.deviceId === deviceId);
    if (!self && (target === undefined || !target.connected)) return { outcome: "offline" };
    // Every PR 1 daemon advertises `messages` and none handles `deliver-message`, whose unknown-op branch never
    // replies: forwarding would read as `offline` and invite a retry that can never land. A reply is the same for a
    // daemon that predates `messageReply`.
    if (target !== undefined && !advertisesRouting(target, reply)) return { outcome: "unsupported" };
    const answer = await deps.deliver(deviceId, request);
    if ("outcome" in answer)
      return { outcome: answer.outcome, ...(answer.reason === undefined ? {} : { reason: answer.reason }) };
    // `unsupported` says "needs `seanced update`", so only a refusal of the frame itself is worded so; a handler
    // that crashed or a reply that did not parse is an answer that did not come, which `offline` says.
    if (answer.code !== "unreachable" && answer.code !== "undelivered") {
      deps.warn(`scheduler: session-message ${about} machine=${quote(deviceId)} refused code=${answer.code}`);
    }
    return { outcome: answer.code === "unsupported" || answer.code === "invalid_request" ? "unsupported" : "offline" };
  };

  const route = async (
    message: SessionMessage,
    from: string,
    senderName: string,
    /** What the forward names: only a task the leader holds, so the receiver's wrapper never names one it cannot bind. */
    fromTask: string | undefined,
    /** What the receipt names: the task the sealer's own daemon bound, which only that daemon places a note for. */
    receiptTask: string | undefined,
  ): Promise<void> => {
    const common = {
      id: message.id,
      kind: message.kind,
      text: message.text,
      fromMachine: senderName,
      origin: from,
      ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
      ...(fromTask === undefined ? {} : { fromTask }),
      ...(fromTask === undefined || message.fromTitle === undefined ? {} : { fromTitle: message.fromTitle }),
    };
    let result: { readonly outcome: ReceiptOutcome; readonly reason?: "nolistener" };
    let resolvedTask: string | undefined;
    if (message.replyTo !== undefined) {
      // A reply names the machine whose daemon holds the asker's handle: nothing is resolved, that daemon decides.
      result = await forward(message.replyTo.deviceId, true, { ...common, replyTo: message.replyTo.id }, "reply");
    } else {
      const resolved = deps.resolve(message.to);
      if (resolved.kind === "unknown") {
        result = { outcome: "unknown" };
      } else {
        resolvedTask = resolved.taskId;
        result =
          resolved.kind === "forward"
            ? await forward(
                resolved.deviceId,
                false,
                {
                  ...common,
                  taskId: resolved.taskId,
                  addressed: message.to,
                  ...(resolved.settled ? { settled: true as const } : {}),
                },
                `to=${quote(resolved.taskId)}`,
              )
            : { outcome: resolved.kind };
      }
    }
    // Every admitted message is answered, an untasked sender's included: the sealer's own `sent` table finds the pane.
    // A daemon that predates replies drops a receipt it has no task for, which costs nothing.
    const receipt = {
      id: message.id,
      kind: message.kind,
      outcome: result.outcome,
      ...(message.to === undefined ? {} : { to: message.to }),
      ...(receiptTask === undefined ? {} : { fromTask: receiptTask }),
      ...(resolvedTask === undefined ? {} : { taskId: resolvedTask }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    } satisfies MessageReceiptRequest;
    const answered = await deps.receipt(from, receipt);
    // A receipt is a courtesy: its failure is one line and nothing else (the sender's `routed` stands).
    if (!answered.ok) deps.warn(`scheduler: message-receipt to=${quote(from)} failed code=${answered.code}`);
  };

  return {
    onSessionMessage: (message, from) => {
      const sender = deps.machines().find((m) => m.deviceId === from);
      if (sender === undefined) {
        deps.warn(`scheduler: session-message from=${quote(from)} dropped — not a registered machine`);
        return false;
      }
      let fromTask = message.fromTask;
      if (fromTask !== undefined) {
        const placed = deps.sentFrom(fromTask, from);
        if (placed === "elsewhere") {
          // No receipt: it would tell the sealer about a task it does not hold.
          deps.warn(
            `scheduler: session-message task=${quote(fromTask)} from=${quote(from)} dropped — not placed there`,
          );
          return false;
        }
        // A task the leader pruned may still have a live session: its receipt still goes to the sealer, which bound it.
        if (placed === "absent") fromTask = undefined;
      }
      route(message, from, senderLabel(sender.name, from), fromTask, message.fromTask).catch((err: unknown) => {
        deps.warn(`scheduler: session-message from=${quote(from)} failed: ${String(err)}`);
      });
      return true;
    },
  };
}
