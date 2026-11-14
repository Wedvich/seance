import type { MessageRoute } from "@seance/scheduler";
import {
  CAPABILITIES,
  quote,
  type DeliverMessageRequest,
  type Machine,
  type MessageReceiptRequest,
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

function advertisesRouting(machine: Machine): boolean {
  const capabilities = machine.capabilities ?? [];
  return capabilities.includes(CAPABILITIES.messages) && capabilities.includes(CAPABILITIES.messageRoute);
}

export function createMessageRouter(deps: MessageRouterDeps): MessageRouter {
  const route = async (
    message: SessionMessage,
    from: string,
    senderName: string,
    fromTask: string | undefined,
  ): Promise<void> => {
    const resolved = deps.resolve(message.to);
    let outcome: ReceiptOutcome;
    let reason: "nolistener" | undefined;
    if (resolved.kind !== "forward") {
      outcome = resolved.kind;
    } else {
      const self = resolved.deviceId === deps.selfDeviceId;
      const target = deps.machines().find((m) => m.deviceId === resolved.deviceId);
      if (!self && (target === undefined || !target.connected)) {
        outcome = "offline";
      } else if (target !== undefined && !advertisesRouting(target)) {
        // Every PR 1 daemon advertises `messages` and none handles `deliver-message`, whose unknown-op branch never
        // replies: forwarding would read as `offline` and invite a retry that can never land.
        outcome = "unsupported";
      } else {
        const reply = await deps.deliver(resolved.deviceId, {
          id: message.id,
          taskId: resolved.taskId,
          addressed: message.to,
          kind: message.kind,
          text: message.text,
          fromMachine: senderName,
          ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
          ...(fromTask === undefined ? {} : { fromTask }),
          ...(fromTask === undefined || message.fromTitle === undefined ? {} : { fromTitle: message.fromTitle }),
          ...(resolved.settled ? { settled: true as const } : {}),
        } satisfies DeliverMessageRequest);
        if ("outcome" in reply) {
          outcome = reply.outcome;
          reason = reply.reason;
        } else if (reply.code === "unreachable" || reply.code === "undelivered") {
          outcome = "offline";
        } else {
          // The target answered but would not take it: an older build, or a daemon running no messaging.
          deps.warn(
            `scheduler: session-message to=${quote(resolved.taskId)} machine=${quote(resolved.deviceId)} refused code=${reply.code}`,
          );
          outcome = "unsupported";
        }
      }
    }
    if (fromTask === undefined) return;
    const taskId = resolved.kind === "unknown" ? undefined : resolved.taskId;
    const receipt = {
      id: message.id,
      to: message.to,
      kind: message.kind,
      outcome,
      fromTask,
      ...(taskId === undefined ? {} : { taskId }),
      ...(reason === undefined ? {} : { reason }),
    } satisfies MessageReceiptRequest;
    const reply = await deps.receipt(from, receipt);
    // A receipt is a courtesy: its failure is one line and nothing else (the sender's `routed` stands).
    if (!reply.ok) deps.warn(`scheduler: message-receipt to=${quote(from)} failed code=${reply.code}`);
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
        // A task the leader pruned may still have a live session. Its wrapper must not name a task the leader cannot bind.
        if (placed === "absent") fromTask = undefined;
      }
      route(message, from, sender.name, fromTask).catch((err: unknown) => {
        deps.warn(`scheduler: session-message from=${quote(from)} failed: ${String(err)}`);
      });
      return true;
    },
  };
}
