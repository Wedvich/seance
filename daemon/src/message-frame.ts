// Apart from `messages.ts` so `seanced mcp` (`send-message.ts`) and `seanced inbox` (`inbox-cli.ts`) load only these
// and not the daemon's side (tmux, the launch ledger, the FFI parent walk), and neither reaches `log.ts`: one is
// the MCP server's JSON-RPC channel, the other the inbox mod's data channel.
import { isMessageId, isRecord, isTaskId, MESSAGE_KINDS, type MessageKind } from "@seance/shared";

export const MESSAGE_FRAME_VERSION = 1;

/**
 * How long a session may still be starting, or a listener reconnecting, before a missing listener means the
 * session has no inbox mod. Measured from the ledger's launch record or from the listener's disconnect. Here, not
 * in `messages.ts`, because `send_message` words it and must not load a module that logs.
 */
export const LISTENER_GRACE_MS = 120_000;

/** A session's message to another task on this machine, sent by `seanced mcp`'s `send_message`. */
export const MESSAGE_FRAME_KIND = "message";

/** The inbox mod's listener, `seanced inbox`: the first frame that hands text out. */
export const INBOX_FRAME_KIND = "inbox";

export const MESSAGE_REPLY_CODES = [
  /** Not a frame this daemon reads. */
  "invalid",
  /** The sender is in no live pane this daemon can bind by peer pid (or the host names no peers). */
  "unbound",
  /** This daemon runs no message delivery. */
  "unsupported",
  "stopping",
  /** No task this machine launched carries that id. */
  "unknown",
  /** The task was launched here and has no live session, or the session has no inbox listener (`reason: "nolistener"`). */
  "ended",
  "too_long",
  "rate_limited",
  /** Non-terminal: the task is launched here but has no pane yet. Nothing was kept; send again shortly. */
  "held",
] as const;

export type MessageReplyCode = (typeof MESSAGE_REPLY_CODES)[number];

export type MessageReply =
  /** `delivered`: written to a live listener. `sent`: held in the daemon's inbox until the listener connects. */
  | { readonly ok: true; readonly id: string; readonly outcome: "delivered" | "sent" }
  | { readonly ok: false; readonly code: MessageReplyCode; readonly reason?: "nolistener" };

export const INBOX_REFUSAL_CODES = ["invalid", "unbound", "unsupported", "stopping"] as const;

/** The first line a listener reads. `instruction` only for a pane carrying a task (an untasked one is not addressable). */
export type InboxAck =
  | {
      readonly ok: true;
      readonly instruction?: string;
      readonly keep: { readonly messages: number; readonly bytes: number };
    }
  | { readonly ok: false; readonly code: (typeof INBOX_REFUSAL_CODES)[number] };

/**
 * One delivery, one line. `push` is what the mod submits or appends; `body` is the full rendered message,
 * present only when `push` is a stub the model pulls with `read_messages`.
 */
export interface InboxLine {
  readonly v: 1;
  readonly id: string;
  readonly messageKind: MessageKind;
  readonly push: string;
  readonly body?: string;
}

/** Routed on `kind` ahead of the `Plain` check, as session events are. */
export function isMessageFrameKind(raw: unknown): boolean {
  return isRecord(raw) && raw["kind"] === MESSAGE_FRAME_KIND;
}

export function isInboxFrameKind(raw: unknown): boolean {
  return isRecord(raw) && raw["kind"] === INBOX_FRAME_KIND;
}

export interface MessageFrame {
  readonly to: string;
  readonly messageKind: MessageKind;
  readonly text: string;
  readonly inReplyTo?: string;
}

const MESSAGE_FIELDS: ReadonlySet<string> = new Set(["v", "kind", "to", "messageKind", "text", "inReplyTo"]);

/** No `pane` field, on purpose: the sender is bound by the kernel's peer pid and nothing it claims. */
export function parseMessageFrame(raw: unknown): MessageFrame | null {
  if (!isRecord(raw)) return null;
  if (Object.keys(raw).some((key) => !MESSAGE_FIELDS.has(key))) return null;
  if (raw["v"] !== MESSAGE_FRAME_VERSION || raw["kind"] !== MESSAGE_FRAME_KIND) return null;
  const { to, messageKind, text, inReplyTo } = raw;
  if (!isTaskId(to)) return null;
  const kind = MESSAGE_KINDS.find((k) => k === messageKind);
  if (kind === undefined) return null;
  if (typeof text !== "string" || text === "") return null;
  if (inReplyTo !== undefined && !isMessageId(inReplyTo)) return null;
  return { to, messageKind: kind, text, ...(inReplyTo === undefined ? {} : { inReplyTo }) };
}

/** Exactly `{v:1, kind:"inbox"}`: the frame carries no `pane`, so there is no claimed pane to fall back to. */
export function parseInboxFrame(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    Object.keys(raw).length === 2 &&
    raw["v"] === MESSAGE_FRAME_VERSION &&
    raw["kind"] === INBOX_FRAME_KIND
  );
}
