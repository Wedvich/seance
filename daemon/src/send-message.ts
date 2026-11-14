import {
  isMessageId,
  isRecord,
  isTaskId,
  MESSAGE_MAX,
  MESSAGE_PUSH_MAX,
  MESSAGE_RATE,
  MESSAGE_ROUTE_MAX,
  type MessageKind,
} from "@seance/shared";
import { exchange, LocalConnectionLost, LocalTimedOut, LocalUnavailable } from "./local-client.ts";
import {
  LISTENER_GRACE_MS,
  MESSAGE_FRAME_KIND,
  MESSAGE_FRAME_VERSION,
  MESSAGE_REPLY_CODES,
  type MessageFrameRoute,
  type MessageReply,
  type MessageReplyCode,
} from "./message-frame.ts";
import { socketPath } from "./paths.ts";

/**
 * `seanced mcp`'s `send_message`: one `message` frame on the local socket, which the daemon binds to the sender's
 * pane by the kernel's peer pid (the MCP server is a child of the session's `claude`, itself in the pane), exactly
 * as `report_task_done` is. The text crosses on the socket, never in argv.
 *
 * Imports nothing that logs: this runs inside `seanced mcp`, whose stdout is the JSON-RPC channel, and the text is
 * prompt text. That is why the frame and its reply codes live in `message-frame.ts`.
 */

const SEND_TIMEOUT_MS = 5_000;

export interface SendMessageResult {
  readonly ok: boolean;
  readonly text: string;
  /** The message's id, on success: what a reply's `inReplyTo` carries. */
  readonly id?: string;
}

/** What the caller found out about routing: whether the verified leader can take a message for another machine. */
export type RouteGate = () => Promise<{ readonly ok: true } | { readonly ok: false; readonly text: string }>;

export interface SendMessageOpts {
  /** The local op socket; this machine's by default. */
  readonly path?: string;
  /**
   * Asked once, only when the daemon says the task is not deliverable on its machine. Present, the first frame says
   * `route: "ask"`; absent, the frame carries no `route` and a task elsewhere is answered as it was before routing.
   */
  readonly routeGate?: RouteGate;
}

const GRACE_SECONDS = LISTENER_GRACE_MS / 1_000;

const REFUSED = {
  unbound: () =>
    "this session is not in a tmux pane this machine's daemon can see, or this machine cannot name a socket's peer process; messages need both",
  unknown: (to) =>
    `this machine has no launch record of task ${to} (it was not launched here, or its record has aged out), and no scheduler route was asked`,
  ended: (to) => `task ${to} has no live session on this machine`,
  too_long: () =>
    `the message is too long: at most ${MESSAGE_MAX} bytes, and a request at most ${MESSAGE_PUSH_MAX} bytes`,
  rate_limited: () =>
    `too many messages: ${MESSAGE_RATE.perMinute} a minute and ${MESSAGE_RATE.perHour} an hour per task`,
  invalid: () => "this machine's daemon could not read the message; it may predate send_message (`seanced update`)",
  unsupported: () => "this machine's daemon runs no message delivery",
  internal: () => "this machine's daemon hit an error handling the message (see its log); nothing was sent",
  stopping: () => "this machine's daemon is stopping, so nothing was sent",
  held: (to) =>
    `task ${to} is starting on this machine and has no session yet; nothing was kept — send again in a little while`,
  remote: (to) =>
    `task ${to} is not on this machine, and this caller cannot route through the scheduler; nothing was sent`,
  no_leader: () => "this machine's daemon could not reach a scheduler leader, so nothing was sent",
} as const satisfies Record<MessageReplyCode, (to: string) => string>;

const NO_LISTENER = (to: string): string =>
  `task ${to}'s session has no inbox listener: its Claude account lacks the inbox mod (\`seanced mod install\` on that machine) or the session started before it was installed`;

const TOO_LONG_ROUTE = `too long to send to another machine: at most ${MESSAGE_ROUTE_MAX} bytes once JSON-escaped`;

const SENT = (to: string, id: string): string =>
  `held for task ${to} until its session's inbox listener connects (up to ${GRACE_SECONDS} s); if it never does — e.g. that Claude account lacks the inbox mod — the message is dropped unseen. Message id ${id}`;

const ROUTED = (to: string, id: string, receipt: boolean): string =>
  `sent through the scheduler to task ${to} as message ${id}; ${
    receipt
      ? "a receipt note saying whether it was delivered follows in your conversation, and no note means it was not"
      : "no receipt follows: this session has no task"
  }`;

function parseReply(raw: unknown): MessageReply | null {
  if (!isRecord(raw)) return null;
  if (raw["ok"] === true) {
    const { id, outcome, receipt } = raw;
    if (typeof id !== "string") return null;
    if (outcome !== "delivered" && outcome !== "sent" && outcome !== "routed") return null;
    return { ok: true, id, outcome, ...(receipt === false ? { receipt: false as const } : {}) };
  }
  const code = MESSAGE_REPLY_CODES.find((c) => c === raw["code"]);
  if (raw["ok"] !== false || code === undefined) return null;
  const { reason } = raw;
  return reason === "nolistener" || reason === "route" ? { ok: false, code, reason } : { ok: false, code };
}

type Exchanged = { readonly reply: MessageReply } | { readonly failed: SendMessageResult };

export async function sendMessage(
  message: {
    readonly to: string;
    readonly kind: MessageKind;
    readonly text: string;
    readonly inReplyTo?: string;
  },
  opts: SendMessageOpts = {},
): Promise<SendMessageResult> {
  const { to, kind, text, inReplyTo } = message;
  if (!isTaskId(to)) return { ok: false, text: "`to` is not a task id (get_queue lists them)" };
  if (inReplyTo !== undefined && !isMessageId(inReplyTo)) {
    return { ok: false, text: "`inReplyTo` is not a message id: it is the id a message you received names" };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MESSAGE_MAX || (kind === "request" && bytes > MESSAGE_PUSH_MAX)) {
    return { ok: false, text: REFUSED.too_long() };
  }

  const exchangeFrame = async (route: MessageFrameRoute | undefined): Promise<Exchanged> => {
    let raw: unknown;
    try {
      // No restart grace: a re-sent message could be delivered twice.
      raw = await exchange(
        {
          v: MESSAGE_FRAME_VERSION,
          kind: MESSAGE_FRAME_KIND,
          to,
          messageKind: kind,
          text,
          ...(inReplyTo === undefined ? {} : { inReplyTo }),
          ...(route === undefined ? {} : { route }),
        },
        {
          path: opts.path ?? socketPath(),
          timeoutMs: SEND_TIMEOUT_MS,
          timeoutText: "no answer from this machine's daemon; the message may or may not have been delivered",
        },
      );
    } catch (err) {
      if (err instanceof LocalTimedOut) return { failed: { ok: false, text: err.message } };
      // Before `LocalUnavailable`, which it extends: the daemon took the connection and dropped it.
      if (err instanceof LocalConnectionLost) {
        return {
          failed: {
            ok: false,
            text: "this machine's daemon closed the connection without answering; it may predate send_message (`seanced update`), and the message was not delivered",
          },
        };
      }
      if (err instanceof LocalUnavailable) return { failed: { ok: false, text: "the local daemon is not running" } };
      return { failed: { ok: false, text: err instanceof Error ? err.message : String(err) } };
    }
    const reply = parseReply(raw);
    return reply === null ? { failed: { ok: false, text: "the daemon's answer was not a message reply" } } : { reply };
  };

  const { routeGate } = opts;
  let first = await exchangeFrame(routeGate === undefined ? undefined : "ask");
  // A daemon that predates routing rejects the unknown `route` key and delivered nothing: ask once more without it.
  if (routeGate !== undefined && "reply" in first && !first.reply.ok && first.reply.code === "invalid") {
    first = await exchangeFrame(undefined);
  }
  if ("failed" in first) return first.failed;
  let { reply } = first;

  if (!reply.ok && reply.code === "remote") {
    if (routeGate === undefined) return { ok: false, text: REFUSED.remote(to) };
    let gate: Awaited<ReturnType<RouteGate>>;
    try {
      gate = await routeGate();
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
    if (!gate.ok) return { ok: false, text: gate.text };
    const sent = await exchangeFrame("send");
    if ("failed" in sent) return sent.failed;
    reply = sent.reply;
  }

  if (!reply.ok) {
    if (reply.reason === "nolistener") return { ok: false, text: NO_LISTENER(to) };
    if (reply.reason === "route" && reply.code === "too_long") return { ok: false, text: TOO_LONG_ROUTE };
    return { ok: false, text: REFUSED[reply.code](to) };
  }
  if (reply.outcome === "routed")
    return { ok: true, id: reply.id, text: ROUTED(to, reply.id, reply.receipt !== false) };
  const delivered = `delivered to task ${to} as message ${reply.id}`;
  return { ok: true, id: reply.id, text: reply.outcome === "delivered" ? delivered : SENT(to, reply.id) };
}
