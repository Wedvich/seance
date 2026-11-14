// Apart from `messages.ts` so `seanced mcp` (`send-message.ts`) and `seanced inbox` (`inbox-cli.ts`) load only these
// and not the daemon's side (tmux, the launch ledger, the FFI parent walk), and neither reaches `log.ts`: one is
// the MCP server's JSON-RPC channel, the other the inbox mod's data channel.
import { isMessageId, isRecord, isTaskId, LISTENER_GRACE_MS, MESSAGE_KINDS, type MessageKind } from "@seance/shared";

export const MESSAGE_FRAME_VERSION = 1;

// In `shared` (a receipt's note words it too); re-exported for the daemon's modules that already import it from here.
export { LISTENER_GRACE_MS };

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
  /** A bug in the daemon's handling of the frame: not an old daemon, so `seanced update` would not help. */
  "internal",
  /** No task this machine launched carries that id. */
  "unknown",
  /** The task was launched here and has no live session, or the session has no inbox listener (`reason: "nolistener"`). */
  "ended",
  "too_long",
  "rate_limited",
  /** Non-terminal: the task is launched here but has no pane yet. Nothing was kept; send again shortly. */
  "held",
  /** Only for `route: "ask"`: the task is not deliverable here, so the caller checks the leader and resends as `send`. */
  "remote",
  /** The message could not be handed to a scheduler leader (none, or its leg is down). Nothing was kept. */
  "no_leader",
] as const;

export type MessageReplyCode = (typeof MESSAGE_REPLY_CODES)[number];

export type MessageReply =
  /**
   * `delivered`: written to a live listener. `sent`: held in the daemon's inbox until the listener connects.
   * `routed`: handed to the scheduler leader, which reports back with a receipt note, unless `receipt` is false (the
   * sending pane has no task, so there is nowhere to deliver one).
   */
  | {
      readonly ok: true;
      readonly id: string;
      readonly outcome: "delivered" | "sent" | "routed";
      readonly receipt?: false;
    }
  | { readonly ok: false; readonly code: MessageReplyCode; readonly reason?: "nolistener" | "route" };

/**
 * `unsupported`: no message delivery here, or a host that can name no peer. `unbound` and `untasked`: this pane
 * will not bind (a tmux server other than the daemon's, a hand-started session), which a retry does not change.
 */
export const INBOX_REFUSAL_CODES = ["invalid", "unbound", "unsupported", "stopping", "untasked"] as const;

/**
 * The first line a listener reads. Every bound pane is acked, an untasked one included (it can be answered by handle);
 * `untasked` stays in the codes for a daemon that predates replies and still refuses such a pane.
 */
export type InboxAck =
  | {
      readonly ok: true;
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
  /**
   * Set only by the daemon, from its own `sent` table: this line answers a question or request the receiving session
   * itself sent, so the mod submits it even when it is a note. Never a frame field, so no sender can ask for it.
   */
  readonly wake?: true;
}

/** Routed on `kind` ahead of the `Plain` check, as session events are. */
export function isMessageFrameKind(raw: unknown): boolean {
  return isRecord(raw) && raw["kind"] === MESSAGE_FRAME_KIND;
}

export function isInboxFrameKind(raw: unknown): boolean {
  return isRecord(raw) && raw["kind"] === INBOX_FRAME_KIND;
}

/**
 * `ask`: the caller can check the verified leader and resend, so a task not deliverable here is answered `remote`.
 * `send`: the caller has checked, so it is routed. Absent: the caller predates routing, and is answered as before
 * (`unknown` or `ended`), never a code it would not know.
 */
export const MESSAGE_ROUTES = ["ask", "send"] as const;
export type MessageFrameRoute = (typeof MESSAGE_ROUTES)[number];

export interface MessageFrame {
  /** Absent for a reply by handle: `inReplyTo` names the message answered and the daemon's own table says where it goes. */
  readonly to?: string;
  readonly messageKind: MessageKind;
  readonly text: string;
  readonly inReplyTo?: string;
  readonly route?: MessageFrameRoute;
}

const MESSAGE_FIELDS: ReadonlySet<string> = new Set(["v", "kind", "to", "messageKind", "text", "inReplyTo", "route"]);

/** No `pane` field, on purpose: the sender is bound by the kernel's peer pid and nothing it claims. */
export function parseMessageFrame(raw: unknown): MessageFrame | null {
  if (!isRecord(raw)) return null;
  if (Object.keys(raw).some((key) => !MESSAGE_FIELDS.has(key))) return null;
  if (raw["v"] !== MESSAGE_FRAME_VERSION || raw["kind"] !== MESSAGE_FRAME_KIND) return null;
  const { to, messageKind, text, inReplyTo, route: rawRoute } = raw;
  // A handle is an address in its own right, so `to` may be left out only where `inReplyTo` stands in for it.
  const address = to === undefined ? undefined : isTaskId(to) ? to : null;
  if (address === null || (address === undefined && inReplyTo === undefined)) return null;
  const kind = MESSAGE_KINDS.find((k) => k === messageKind);
  if (kind === undefined) return null;
  if (typeof text !== "string" || text === "") return null;
  if (inReplyTo !== undefined && !isMessageId(inReplyTo)) return null;
  const route = MESSAGE_ROUTES.find((r) => r === rawRoute);
  if (rawRoute !== undefined && route === undefined) return null;
  return {
    ...(address === undefined ? {} : { to: address }),
    messageKind: kind,
    text,
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    ...(route === undefined ? {} : { route }),
  };
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
