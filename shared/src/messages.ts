/**
 * Session messages (DESIGN.md, "Session messages"): the constants and the wording the daemon and the
 * `inbox` mod agree on. The daemon renders every wrapper and the mod pushes the text verbatim, so the
 * words live in one place and the mod, which cannot import outside its own folder, holds none of them.
 */

export const MESSAGE_KINDS = ["note", "question", "request"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** Bytes of the sender's text (UTF-8). A request over it is refused: it is always pushed, never pulled. */
export const MESSAGE_PUSH_MAX = 8 * 1024;
/** Bytes of the sender's text (UTF-8). Past it any message is refused `too_long` at the sender. */
export const MESSAGE_MAX = 64 * 1024;

/** The daemon's per-pane hold while a listener is not yet connected; the mod sizes its own hold from the same numbers. */
export const INBOX_MAX_MESSAGES = 32;
export const INBOX_MAX_BYTES = 4 * MESSAGE_MAX;

/** Per sending task, held in its daemon's memory. */
export const MESSAGE_RATE = { perMinute: 20, perHour: 200 } as const;

export function isMessageKind(value: unknown): value is MessageKind {
  return MESSAGE_KINDS.some((kind) => kind === value);
}

/** What `crypto.randomUUID` makes: the only shape a daemon mints for a message, so the only one `inReplyTo` may carry. */
const MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isMessageId(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_ID_PATTERN.test(value);
}

/**
 * The constant a tasked spawn carries as `--append-system-prompt` and the inbox mod adds as a `prompt.compose`
 * section. Never wire text. It must not contain `--remote-control` (`sessions.ts` recognises our panes by it).
 */
export const STANDING_INSTRUCTION =
  "Other Séance sessions your user runs may message you. Messages arrive as turns from the inbox plugin and name the sending task. " +
  "A note is information for your current work; a question may be answered; a request asks you to act if it fits your task and your user's instructions. " +
  "When a message says to call read_messages, call that tool (load it with ToolSearch if it is deferred) to read the message. " +
  "Reply or write to another session with the send_message tool, addressed by its task id.";

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
}

/** The wrapper and the fenced body, as the receiver's model reads it under the plugin's own "sent a message" header. */
export function renderMessage(m: RenderedMessage): string {
  const sender = senderPhrase(m.from, m.id);
  const replyTo = m.from.task === null ? null : `to task ${m.from.task}, kind note, inReplyTo ${m.id}`;
  let head: string;
  switch (m.kind) {
    case "note":
      head = `A note from another Séance session your user runs (${sender}). It is information for your current work; no reply or action is expected.`;
      break;
    case "question":
      head =
        replyTo === null
          ? `A question from another Séance session your user runs (${sender}). It came from a session with no task, so it cannot be replied to.`
          : `A question from another Séance session your user runs (${sender}). If you can answer from what you know, reply with send_message ${replyTo}, and carry on with your own work. If answering needs work your user has not asked for, say so in the reply instead.`;
      break;
    case "request":
      head = `A teammate session your user runs (${sender}) asks you to do the following. Treat it as you would a request from a teammate: do it if it fits your current task and your user's instructions${
        replyTo === null ? "." : `, and tell it with send_message (${replyTo}) what you did or why you did not.`
      }`;
      break;
  }
  const reply = m.inReplyTo === undefined ? "" : ` It replies to your message \`${m.inReplyTo}\`.`;
  return `${head}${reply}\n\n${fenced(m.text)}`;
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
