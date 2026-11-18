/**
 * Session messages (DESIGN.md, "Session messages"): the constants and the wording the daemon and the
 * `inbox` mod agree on. The daemon renders every wrapper and the mod pushes the text verbatim, so the
 * words live in one place and the mod, which cannot import outside its own folder, holds none of them.
 */

import type { ReceiptOutcome } from "./types.ts";

export const MESSAGE_KINDS = ["note", "question", "request"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** Bytes of the sender's text (UTF-8). A request over it is refused: it is always pushed, never pulled. */
export const MESSAGE_PUSH_MAX = 8 * 1024;
/** Bytes of the sender's text (UTF-8). Past it any message is refused `too_long` at the sender. */
export const MESSAGE_MAX = 64 * 1024;

/**
 * Bytes of the sender's text once JSON-escaped, for a message that crosses machines. `ENVELOPE_MAX_CT_LENGTH` (64 KiB of
 * base64) carries about 48 KiB of JSON, so `MESSAGE_MAX` cannot cross the relay; 40 000 leaves room for the `Plain`
 * wrapper and the leader's `from` fields, as `REPLY_JSON_BUDGET` does. A `TextEncoder`, not `Buffer`: shared is also
 * loaded by the PWA and Raycast.
 */
export const MESSAGE_ROUTE_MAX = 40_000;

export function routeBytes(text: string): number {
  return new TextEncoder().encode(JSON.stringify(text)).length;
}

/** The daemon's per-pane hold while a listener is not yet connected; the mod sizes its own hold from the same numbers. */
export const INBOX_MAX_MESSAGES = 32;
export const INBOX_MAX_BYTES = 4 * MESSAGE_MAX;

/**
 * How long a session may still be starting, or a listener reconnecting, before a missing listener means the
 * session has no inbox mod. Measured from the ledger's launch record or from the listener's disconnect. Here because
 * `send_message` and a receipt's note both word it, and neither may load a module that logs.
 */
export const LISTENER_GRACE_MS = 120_000;

/** Per sending task, held in its daemon's memory. */
export const MESSAGE_RATE = { perMinute: 20, perHour: 200 } as const;

/** One adapter's bucket across all its deliveries; each target also keeps `MESSAGE_RATE` (DESIGN.md, "Adapters"). */
export const ADAPTER_RATE = { perMinute: 60, perHour: 600 } as const;

export function isMessageKind(value: unknown): value is MessageKind {
  return MESSAGE_KINDS.some((kind) => kind === value);
}

/** What `crypto.randomUUID` makes: the only shape a daemon mints for a message, so the only one `inReplyTo` may carry. */
const MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isMessageId(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_ID_PATTERN.test(value);
}

/**
 * The note a leader's receipt becomes in the sender's inbox. One fixed line per outcome, never message text: the
 * receipt is the leader's account of a message it did not keep.
 */
export function receiptNote(r: {
  readonly id: string;
  /** Absent for a reply by handle, which names no task. */
  readonly to?: string;
  readonly taskId?: string;
  readonly outcome: ReceiptOutcome;
  readonly reason?: "nolistener";
}): string {
  const head =
    r.to === undefined
      ? `Séance receipt: your reply \`${r.id}\``
      : `Séance receipt: your message \`${r.id}\` to task \`${r.to}\``;
  switch (r.outcome) {
    case "delivered":
      return `${head} was delivered to its session${
        r.taskId !== undefined && r.taskId !== r.to ? ` (now carried by task \`${r.taskId}\`)` : ""
      }.`;
    case "sent":
      return `${head} is waiting for its session's inbox listener (up to ${LISTENER_GRACE_MS / 1_000} s).`;
    case "held":
      return `${head} was not delivered: the task has not started yet, and nothing was kept; send again later.`;
    case "ended":
      return r.reason === "nolistener"
        ? `${head} was not delivered: its session has no inbox listener (its account lacks the inbox mod).`
        : `${head} was not delivered: ${
            r.to === undefined ? "the session it answers has ended, or no longer waits" : "the task has no live session"
          }.`;
    case "unknown":
      return `${head} was not delivered: the scheduler holds no such task.`;
    case "unsupported":
      return `${head} was not delivered: the target machine's daemon cannot receive messages (it needs \`seance update\`).`;
    case "offline":
      return `${head} was not delivered: the target machine is offline or did not answer; if it did land, a retry may duplicate it.`;
  }
}

/**
 * The constant a tasked spawn carries as `--append-system-prompt` and the inbox mod adds as a `prompt.compose`
 * section. Never wire text. It must not contain `--remote-control` (`sessions.ts` recognises our panes by it).
 */
export const STANDING_INSTRUCTION =
  "Other Séance sessions your user runs may message you. Messages arrive as turns from the inbox plugin and name the sending task. " +
  "A note is information for your current work; a question may be answered; a request asks you to act if it fits your task and your user's instructions. " +
  "When a message says to call read_messages, call that tool (load it with ToolSearch if it is deferred) to read the message. " +
  "Reply or write to another session with the send_message tool, addressed by its task id; " +
  "to answer a message from a session that names no task, pass that message's id as inReplyTo and leave the to field out.";

const TITLE_MAX_CODE_POINTS = 80;

/**
 * The sender's tmux window name, made safe to sit inside a wrapper's quotes. A session can set its own window
 * name, so it must not break out of the quoting or forge a line. Display-only, like `assignment.window`.
 */
export function displayTitle(raw: string): string | null {
  const flat = Array.from(raw.replaceAll(/\s+/gu, " "))
    // C0, DEL and C1 controls, and the two characters the wrapper quotes with.
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return !(code <= 0x1f || (code >= 0x7f && code <= 0x9f) || char === "`" || char === '"');
    })
    .join("")
    .replaceAll(/\s+/gu, " ")
    .trim();
  const capped = Array.from(flat).slice(0, TITLE_MAX_CODE_POINTS).join("").trim();
  return capped === "" ? null : capped;
}

/** A body inside a backtick fence one longer than any run in it (minimum 3), so the text cannot end its own block. */
export function fenced(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/gu) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

export interface MessageSender {
  /** The sending pane's task, null for an untasked session. */
  readonly task: string | null;
  /** Display-only, already through `displayTitle`. */
  readonly title: string | null;
  readonly machine: string;
}

function senderPhrase(from: MessageSender, id: string): string {
  if (from.task === null) return `an untasked session on \`${from.machine}\`, message \`${id}\``;
  const title = from.title === null ? "" : ` "${from.title}",`;
  return `task \`${from.task}\`,${title} on \`${from.machine}\`, message \`${id}\``;
}

export interface RenderedMessage {
  readonly kind: MessageKind;
  readonly id: string;
  readonly from: MessageSender;
  readonly text: string;
  readonly inReplyTo?: string;
  /**
   * Whether this message can be answered by its id alone (the receiving daemon keeps a handle for it). False for one
   * a leader that predates replies forwarded: an untasked sender then has no way to be answered, and says so.
   */
  readonly byHandle?: boolean;
}

/** The wrapper and the fenced body, as the receiver's model reads it under the plugin's own "sent a message" header. */
export function renderMessage(m: RenderedMessage): string {
  const sender = senderPhrase(m.from, m.id);
  // A tasked sender is answered by its task id, which every daemon and leader reads; an untasked one has no task id,
  // so the message's id alone is its address.
  const replyTo =
    m.from.task !== null
      ? `to task ${m.from.task}, kind note, inReplyTo ${m.id}`
      : m.byHandle === false
        ? null
        : `kind note, inReplyTo ${m.id}, and no \`to\``;
  let head: string;
  switch (m.kind) {
    case "note":
      head = `A note from another Séance session your user runs (${sender}). It is information for your current work; no reply or action is expected.`;
      break;
    case "question":
      head =
        replyTo === null
          ? `A question from another Séance session your user runs (${sender}). It cannot be answered from here: that session has no task and this message carries no handle. Use what you can from it in your own work.`
          : `A question from another Séance session your user runs (${sender}). If you can answer from what you know, reply with send_message ${replyTo}, and carry on with your own work. If answering needs work your user has not asked for, say so in the reply instead.`;
      break;
    case "request":
      head =
        replyTo === null
          ? `A teammate session your user runs (${sender}) asks you to do the following. Treat it as you would a request from a teammate: do it if it fits your current task and your user's instructions. It cannot be replied to: that session has no task and this message carries no handle.`
          : `A teammate session your user runs (${sender}) asks you to do the following. Treat it as you would a request from a teammate: do it if it fits your current task and your user's instructions, and tell it with send_message (${replyTo}) what you did or why you did not.`;
      break;
  }
  const reply = m.inReplyTo === undefined ? "" : ` It replies to your message \`${m.inReplyTo}\`.`;
  return `${head}${reply}\n\n${fenced(m.text)}`;
}

/**
 * A custodian round's nudge (docs/custodian.md C26; DESIGN.md, "The custodian frame kind"): always a request, always
 * pushed (the daemon refuses one over `MESSAGE_PUSH_MAX`), from the machine's custodian rather than a task. Worded like
 * a teammate's request, without the reply clause: the custodian has no task to reply to.
 */
export function custodianRequest(m: { readonly id: string; readonly machine: string; readonly text: string }): string {
  return (
    `The custodian on \`${m.machine}\` (message \`${m.id}\`), the agent your user runs to look after this machine's sessions, ` +
    "asks you to do the following. Treat it as you would a request from a teammate: do it if it fits your current task and " +
    "your user's instructions. It cannot be replied to.\n\n" +
    fenced(m.text)
  );
}

export interface AdapterSender {
  /** The adapter's `config.json` key. */
  readonly adapter: string;
  readonly machine: string;
  /** The tool's display label for who wrote it, already through `displayTitle`. */
  readonly label: string | null;
}

function adapterPhrase(from: AdapterSender, id: string): string {
  const label = from.label === null ? "" : ` from "${from.label}"`;
  return `the \`${from.adapter}\` adapter on \`${from.machine}\` relays a message${label}, message \`${id}\``;
}

/**
 * A delivery from an adapter (DESIGN.md, "Adapters"): named as the adapter and machine, its label display-only, never
 * the user or a Séance session. Answered by its id (the daemon keeps a handle for it), or anew by `adapter:<name>`.
 */
export function renderAdapterMessage(m: {
  readonly kind: MessageKind;
  readonly id: string;
  readonly from: AdapterSender;
  readonly text: string;
  readonly inReplyTo?: string;
}): string {
  const source = adapterPhrase(m.from, m.id);
  const replyTo = `kind note, inReplyTo ${m.id}, and no \`to\``;
  const fresh = `to: "adapter:${m.from.adapter}"`;
  let head: string;
  switch (m.kind) {
    case "note":
      head = `A note from a tool your user connected to Séance (${source}). It is information for your current work; no reply or action is expected.`;
      break;
    case "question":
      head = `A question from a tool your user connected to Séance (${source}). If you can answer from what you know, reply with send_message ${replyTo}, and carry on with your own work. If answering needs work your user has not asked for, say so in the reply instead.`;
      break;
    case "request":
      head = `A tool your user connected to Séance (${source}) asks you to do the following. Treat it as you would a request from a teammate: do it if it fits your current task and your user's instructions, and tell it with send_message (${replyTo}) what you did or why you did not.`;
      break;
  }
  const reply = m.inReplyTo === undefined ? "" : ` It replies to your message \`${m.inReplyTo}\`.`;
  return `${head}${reply} To write to that tool anew, use send_message with ${fresh}.\n\n${fenced(m.text)}`;
}

/** An adapter's note or question over `MESSAGE_PUSH_MAX`, pushed as a stub; the body is pulled with `read_messages`. */
export function adapterStub(m: {
  readonly kind: MessageKind;
  readonly id: string;
  readonly from: AdapterSender;
  readonly bytes: number;
}): string {
  return `A ${m.kind} from a tool your user connected to Séance (${adapterPhrase(m.from, m.id)}), ${m.bytes} bytes; call read_messages to read it.`;
}

/** What is pushed instead of a note or question over `MESSAGE_PUSH_MAX`; the body is pulled with `read_messages`. */
export function messageStub(m: {
  readonly kind: MessageKind;
  readonly id: string;
  readonly from: MessageSender;
  readonly bytes: number;
}): string {
  return `A ${m.kind} from another Séance session your user runs (${senderPhrase(m.from, m.id)}), ${m.bytes} bytes; call read_messages to read it.`;
}

/** Prepended, with a blank line, to the next delivery after a daemon inbox dropped some. */
export function droppedNotice(n: number): string {
  return `${n} earlier message(s) to this session were dropped before delivery.`;
}
