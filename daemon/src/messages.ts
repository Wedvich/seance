import {
  custodianRequest,
  displayTitle,
  droppedNotice,
  INBOX_MAX_BYTES,
  INBOX_MAX_MESSAGES,
  MESSAGE_MAX,
  MESSAGE_PUSH_MAX,
  MESSAGE_RATE,
  MESSAGE_ROUTE_MAX,
  messageStub,
  receiptNote,
  renderMessage,
  REPLAY_RETAIN_MS,
  routeBytes,
  type DeliverMessageRequest,
  type DeliverMessageResponse,
  type MessageKind,
  type MessageReceiptRequest,
  type MessageReceiptResponse,
  type MessageSender,
  type SessionMessage,
} from "@seance/shared";
import { CUSTODIAN_SENDER, type CustodianSender, type MessageAudit } from "./audit.ts";
import { log } from "./log.ts";
import {
  LISTENER_GRACE_MS,
  parseInboxFrame,
  parseMessageFrame,
  type InboxAck,
  type InboxLine,
  type MessageReply,
} from "./message-frame.ts";
import { ancestorIn, peerPidSupported } from "./peer.ts";
import type { BoundPane } from "./session-events.ts";

/**
 * Session messages on this machine (DESIGN.md, "Session messages"): the daemon side of the `message` and
 * `inbox` local-socket frames. A session's `send_message` is a `message` frame, bound to its pane by the
 * kernel-reported peer pid; the `inbox` mod's `seanced inbox` child is a long-lived `inbox` connection bound
 * the same way. Neither binds by a field, and neither falls back to a claimed pane on a host that names no
 * peer: unlike a session event, which only claims a state, an `inbox` frame hands text out.
 *
 * Memory only. A message is written once to the listener of the pane carrying the target task (which this
 * machine's launch ledger must hold a launch of), or held for a listener that has not connected yet, and is
 * never at rest on disk. No log line here carries message text, a title or a message id.
 */

/** Unread output a listener's connection may hold before the daemon drops it: a mod that stopped reading. */
export const LISTENER_OUTBOUND_MAX = 2 * 1_048_576;

export { LISTENER_GRACE_MS };

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface ListenerSink {
  /** One JSON line. False when the connection is gone or its unread output passed `LISTENER_OUTBOUND_MAX` (it is then closed). */
  readonly write: (line: string) => boolean;
  readonly close: () => void;
  readonly gone: AbortSignal;
}

export interface MessagesDeps {
  readonly panes: () => Promise<readonly BoundPane[]>;
  /** A pane's window name: the sender's display title, sanitised before it is rendered. */
  readonly windowName: (pane: string) => Promise<string | null>;
  /** The launch's `recordedAt` when this machine's ledger holds the task, else undefined. */
  readonly launchedAt: (taskId: string) => number | undefined;
  /** This machine's name, as the receiver's wrapper shows it. */
  readonly machine: string;
  readonly audit: MessageAudit;
  readonly now?: () => number;
  /** Whether this host can name a peer at all; `peerPidSupported` unless a test stands in for another host. */
  readonly hostNamesPeers?: () => boolean;
  readonly graceMs?: number;
  readonly mintId?: () => string;
  /**
   * Hands a message for a task not deliverable here to the scheduler leader (in process when this daemon leads); false
   * when it could not be sent. Absent, this daemon never routes and answers `unsupported` to a `send`.
   */
  readonly route?: (message: SessionMessage) => Promise<boolean>;
}

/** What became of a custodian nudge (`deliverAsCustodian`). */
export type CustodianDelivery =
  | { readonly ok: true; readonly taskId: string; readonly outcome: "delivered" | "sent" }
  | {
      readonly ok: false;
      /** `no_listener`: no inbox listener now and none within the grace; `unsupported`: no messaging here at all. */
      readonly code: "gone" | "untasked" | "unsupported" | "no_listener" | "too_long" | "stopping";
    };

/** The pane process and task the caller's counts were written under: a delivery to anything else is `gone`. */
export interface CustodianTarget {
  readonly pid: number;
  readonly taskId: string;
}

export interface Messages {
  /** Writes the ack or a refusal itself; a refusal closes the sink. */
  readonly listen: (raw: unknown, peer: number | null, sink: ListenerSink) => Promise<void>;
  readonly send: (raw: unknown, peer: number | null) => Promise<MessageReply>;
  /**
   * A custodian round's nudge (docs/custodian.md C26): one `request` to the task session in `pane`, the daemon as its
   * sender, by the same listener write or hold a `message` frame takes. No peer binding (the `custodian` frame was
   * bound to the round's pane already) and no rate-limit bucket (the verb's own counts bound it). `no_listener` is a
   * pane with no listener past the grace: its exclave lacks the `inbox` mod, or its listener dropped and did not come
   * back in time. `expect` is the pid and task the verb counted under: a pane carrying other ones now is `gone`.
   */
  readonly deliverAsCustodian: (pane: string, text: string, expect: CustodianTarget) => Promise<CustodianDelivery>;
  /**
   * Whether `deliverAsCustodian` would not answer `no_listener` for this pane now: a listener bound for this pid and
   * task, or the grace. Reads and places nothing, so the seat's due check can ask without a nudge.
   */
  readonly canDeliver: (pane: string, expect: CustodianTarget) => Promise<boolean>;
  /**
   * The leader's forward of a message routed here (`deliver-message`): to the live pane carrying the resolved task, by
   * the same listener write or hold a local message takes. De-duplicated by message id for `REPLAY_RETAIN_MS`, since a
   * second leader could be sent the same envelope inside the relay's replay window.
   */
  readonly deliverRouted: (request: DeliverMessageRequest) => Promise<DeliverMessageResponse>;
  /**
   * The leader's receipt for a message this machine's task sent (`message-receipt`): one fixed-text note into the sending
   * task's pane, never message text. `dropped`: no live pane carries the task, or it can no longer take one.
   */
  readonly receipt: (request: MessageReceiptRequest) => Promise<MessageReceiptResponse>;
  /** Session events saw `ended` for this pane's task. */
  readonly onEnded: (pane: string, taskId: string) => void;
  readonly stop: () => void;
}

interface Listener {
  readonly taskId: string | null;
  readonly panePid: number;
  readonly sink: ListenerSink;
}

interface Held {
  readonly id: string;
  readonly messageKind: MessageKind;
  readonly push: string;
  readonly body?: string;
  /** The sender's task, null when untasked, or the custodian: for the audit line only. */
  readonly from: string | null | CustodianSender;
  readonly bytes: number;
  /** A leader's receipt note: it has no outcome of its own to audit, the `receipt` line is its record. */
  readonly receipt?: true;
  /** Its own grace, from the moment it was held: one timer per inbox would age a later message by an earlier one's clock. */
  timer: ReturnType<typeof setTimeout> | null;
}

interface Inbox {
  readonly taskId: string;
  items: Held[];
  bytes: number;
  dropped: number;
}

export function createMessages(deps: MessagesDeps): Messages {
  const now = deps.now ?? Date.now;
  const graceMs = deps.graceMs ?? LISTENER_GRACE_MS;
  const hostNamesPeers = deps.hostNamesPeers ?? peerPidSupported;
  const mintId = deps.mintId ?? ((): string => crypto.randomUUID());
  const startedAt = now();
  let stopped = false;

  const listeners = new Map<string, Listener>();
  /** A listener that dropped: its pane may reconnect within the grace without its messages being refused. */
  const disconnects = new Map<string, { readonly taskId: string | null; readonly at: number }>();
  const inboxes = new Map<string, Inbox>();
  /** Send timestamps per rate key, pruned to the hour. */
  const sends = new Map<string, number[]>();

  const audit = (line: Parameters<MessageAudit>[0]): void => {
    void deps.audit(line).catch((err: unknown) => log.warn(`messages: audit write failed: ${String(err)}`));
  };
  const auditHeld = (to: string, item: Held, outcome: "delivered" | "ended" | "nolistener" | "dropped"): void => {
    if (item.receipt === true) return;
    audit({ dir: "in", from: item.from, to, kind: item.messageKind, bytes: item.bytes, outcome });
  };

  const bind = async (peer: number | null, panes: readonly BoundPane[]): Promise<BoundPane | null> => {
    if (peer === null || !hostNamesPeers()) return null;
    const live = panes.filter((pane) => !pane.dead);
    return ancestorIn(peer, new Map(live.map((pane) => [pane.pid, pane])));
  };

  /**
   * A listener whose pane is gone, dead, re-tagged or respawned (its pid changed) is closed: its binding was
   * made for a pane and task that no longer stand. Run at every send and bind, with a pane list already in hand.
   */
  const sweep = (panes: readonly BoundPane[]): void => {
    for (const [paneId, listener] of listeners) {
      const pane = panes.find((p) => p.id === paneId);
      if (pane !== undefined && !pane.dead && pane.taskId === listener.taskId && pane.pid === listener.panePid) {
        continue;
      }
      listeners.delete(paneId);
      listener.sink.close();
    }
  };

  const release = (item: Held): void => {
    if (item.timer === null) return;
    clearTimeout(item.timer);
    item.timer = null;
  };

  const dropInbox = (paneId: string, outcome: "ended" | "nolistener"): void => {
    const inbox = inboxes.get(paneId);
    if (inbox === undefined) return;
    inboxes.delete(paneId);
    for (const item of inbox.items) {
      release(item);
      auditHeld(inbox.taskId, item, outcome);
    }
  };

  const lineOf = (item: Held, dropped: number): string => {
    const prefix = dropped > 0 ? `${droppedNotice(dropped)}\n\n` : "";
    const line: InboxLine = {
      v: 1,
      id: item.id,
      messageKind: item.messageKind,
      push: prefix + item.push,
      ...(item.body === undefined ? {} : { body: prefix + item.body }),
    };
    return JSON.stringify(line);
  };

  /**
   * Writes what the sink takes, oldest first. A write that fails (the connection closed, or its unread output passed
   * the cap) leaves the rest held, each with its own grace: the pane's next listener, typically a second away,
   * would still be served.
   */
  const flush = (paneId: string, inbox: Inbox, sink: ListenerSink): void => {
    let written = 0;
    for (const item of inbox.items) {
      if (!sink.write(lineOf(item, inbox.dropped))) break;
      // The notice rode the first line out: a retry after a failed write must not repeat it.
      inbox.dropped = 0;
      release(item);
      auditHeld(inbox.taskId, item, "delivered");
      written += 1;
    }
    for (const item of inbox.items.splice(0, written)) inbox.bytes -= item.bytes;
    if (inbox.items.length === 0) inboxes.delete(paneId);
  };

  const hold = (paneId: string, to: string, item: Held): void => {
    let inbox = inboxes.get(paneId);
    if (inbox !== undefined && inbox.taskId !== to) {
      dropInbox(paneId, "ended");
      inbox = undefined;
    }
    const box: Inbox = inbox ?? { taskId: to, items: [], bytes: 0, dropped: 0 };
    inboxes.set(paneId, box);
    item.timer = setTimeout(() => {
      item.timer = null;
      const at = box.items.indexOf(item);
      if (at === -1) return;
      box.items.splice(at, 1);
      box.bytes -= item.bytes;
      auditHeld(to, item, "nolistener");
      if (box.items.length === 0 && inboxes.get(paneId) === box) inboxes.delete(paneId);
    }, graceMs);
    box.items.push(item);
    box.bytes += item.bytes;
    while (box.items.length > INBOX_MAX_MESSAGES || box.bytes > INBOX_MAX_BYTES) {
      const oldest = box.items.shift();
      if (oldest === undefined) break;
      release(oldest);
      box.bytes -= oldest.bytes;
      box.dropped += 1;
      auditHeld(to, oldest, "dropped");
    }
  };

  /** Records a send against its rate key; false when it would pass either limit. */
  const admit = (key: string): boolean => {
    const t = now();
    for (const [k, stamps] of sends) {
      if (stamps.every((s) => t - s >= HOUR_MS)) sends.delete(k);
    }
    const stamps = (sends.get(key) ?? []).filter((s) => t - s < HOUR_MS);
    const lastMinute = stamps.filter((s) => t - s < MINUTE_MS).length;
    if (lastMinute >= MESSAGE_RATE.perMinute || stamps.length >= MESSAGE_RATE.perHour) {
      sends.set(key, stamps);
      return false;
    }
    stamps.push(t);
    sends.set(key, stamps);
    return true;
  };

  /**
   * Writes the message to the target pane's listener, or holds it for one within the grace: from the launch, from the
   * listener's disconnect, or from this daemon's own start. `nolistener` past all three, with nothing kept. The caller
   * writes the audit lines.
   */
  const place = (target: BoundPane, to: string, launched: number, item: Held): "delivered" | "sent" | "nolistener" => {
    // The listener was bound for a task and a pane process: a pane re-tagged or respawned since is closed, not served.
    const listener = listeners.get(target.id);
    if (listener !== undefined) {
      if (listener.taskId === to && listener.panePid === target.pid && listener.sink.write(lineOf(item, 0))) {
        return "delivered";
      }
      if (listeners.get(target.id) === listener) {
        listeners.delete(target.id);
        listener.sink.close();
      }
    }
    const t = now();
    const reconnecting = disconnects.get(target.id);
    const holds =
      t - launched <= graceMs ||
      (reconnecting !== undefined && reconnecting.taskId === to && t - reconnecting.at <= graceMs) ||
      // A restart closed every listener and forgot every disconnect: each live pane is treated as just dropped.
      t - startedAt <= graceMs;
    if (!holds) return "nolistener";
    hold(target.id, to, item);
    return "sent";
  };

  /** What `place` would find, with nothing written: a listener for this task and pid, or one of the grace's three holds. */
  const wouldPlace = (target: BoundPane, to: string, launched: number): boolean => {
    const listener = listeners.get(target.id);
    if (listener !== undefined && listener.taskId === to && listener.panePid === target.pid) return true;
    const t = now();
    const reconnecting = disconnects.get(target.id);
    return (
      t - launched <= graceMs ||
      (reconnecting !== undefined && reconnecting.taskId === to && t - reconnecting.at <= graceMs) ||
      t - startedAt <= graceMs
    );
  };

  /** The wrapper and what is pushed: the text itself when it fits `MESSAGE_PUSH_MAX`, else a stub the model pulls. */
  const itemOf = (m: {
    readonly id: string;
    readonly kind: MessageKind;
    readonly text: string;
    readonly bytes: number;
    readonly from: MessageSender;
    readonly inReplyTo: string | undefined;
  }): Held => {
    const full = renderMessage({
      kind: m.kind,
      id: m.id,
      from: m.from,
      text: m.text,
      ...(m.inReplyTo === undefined ? {} : { inReplyTo: m.inReplyTo }),
    });
    const pushed = m.bytes <= MESSAGE_PUSH_MAX;
    return {
      id: m.id,
      messageKind: m.kind,
      push: pushed ? full : messageStub({ kind: m.kind, id: m.id, from: m.from, bytes: m.bytes }),
      ...(pushed ? {} : { body: full }),
      from: m.from.task,
      bytes: m.bytes,
      timer: null,
    };
  };

  const listen: Messages["listen"] = async (raw, peer, sink) => {
    const refuse = (code: Extract<InboxAck, { ok: false }>["code"]): void => {
      sink.write(JSON.stringify({ ok: false, code } satisfies InboxAck));
      sink.close();
    };
    if (!parseInboxFrame(raw)) return refuse("invalid");
    if (stopped) return refuse("stopping");
    // Nothing on this host can ever bind: a refusal the mod waits out, where `unbound` would read as transient.
    if (!hostNamesPeers()) return refuse("unsupported");
    const panes = await deps.panes();
    const pane = await bind(peer, panes);
    if (pane === null) {
      // Info: a claude run outside tmux, in another tmux server, or a background session is ordinary.
      log.info(`local socket: inbox listener from pid=${peer ?? "unknown"} matched no live pane — refused`);
      return refuse("unbound");
    }
    if (stopped) return refuse("stopping");
    // The peer may have gone while the pane list was read: nothing to serve, and no binding to keep.
    if (sink.gone.aborted) return;
    sweep(panes);
    // Nothing is ever addressed to a pane without a task this machine launched, so its listener would only idle.
    // Silent: a hand-started session is ordinary, and the mod asks again every few minutes.
    if (pane.taskId === null || deps.launchedAt(pane.taskId) === undefined) return refuse("untasked");

    const previous = listeners.get(pane.id);
    if (previous !== undefined) {
      listeners.delete(pane.id);
      previous.sink.close();
    }
    const listener: Listener = { taskId: pane.taskId, panePid: pane.pid, sink };
    listeners.set(pane.id, listener);
    disconnects.delete(pane.id);
    sink.gone.addEventListener(
      "abort",
      () => {
        // A replaced or swept listener is no longer the pane's: only the current one dropping starts a grace.
        if (listeners.get(pane.id) !== listener) return;
        listeners.delete(pane.id);
        disconnects.set(pane.id, { taskId: listener.taskId, at: now() });
      },
      { once: true },
    );
    const ack: InboxAck = {
      ok: true,
      keep: { messages: INBOX_MAX_MESSAGES, bytes: INBOX_MAX_BYTES },
    };
    sink.write(JSON.stringify(ack));

    const inbox = inboxes.get(pane.id);
    if (inbox === undefined) return;
    if (inbox.taskId === pane.taskId) flush(pane.id, inbox, sink);
    // Held for another task: the pane was re-tagged since, and none of it is for this session.
    else dropInbox(pane.id, "ended");
  };

  const send: Messages["send"] = async (raw, peer) => {
    const frame = parseMessageFrame(raw);
    if (frame === null) return { ok: false, code: "invalid" };
    if (stopped) return { ok: false, code: "stopping" };
    const { to, messageKind: kind, text } = frame;
    const bytes = Buffer.byteLength(text, "utf8");
    const panes = await deps.panes();
    const sender = await bind(peer, panes);
    if (sender === null) {
      audit({ dir: "out", from: undefined, to, kind, bytes, outcome: "unbound" });
      return { ok: false, code: "unbound" };
    }
    sweep(panes);
    // Tasked only when this machine launched the sender's task: a pane that tags itself with another task's id
    // can neither borrow its name in a wrapper nor rotate ids to dodge the rate limit.
    const from = sender.taskId !== null && deps.launchedAt(sender.taskId) !== undefined ? sender.taskId : null;
    const out = (outcome: Parameters<MessageAudit>[0]["outcome"]): void =>
      audit({ dir: "out", from, to, kind, bytes, outcome });

    if (bytes > MESSAGE_MAX || (kind === "request" && bytes > MESSAGE_PUSH_MAX)) {
      out("too_long");
      return { ok: false, code: "too_long" };
    }
    // Local when this machine launched the task and a live pane carries it, or the launch is still inside the grace
    // (a held answer). Anything else is not deliverable here: a caller that can check the leader is told to (`remote`)
    // before the rate limit counts the frame, so one routed message is one count, not two.
    const launched = deps.launchedAt(to);
    const candidates = panes.filter((pane) => !pane.dead && pane.taskId === to);
    const local = launched !== undefined && (candidates.length > 0 || now() - launched <= graceMs);
    if (!local && frame.route === "ask") return { ok: false, code: "remote" };

    if (!admit(from === null ? `pane:${sender.id}` : `task:${from}`)) {
      out("rate_limited");
      return { ok: false, code: "rate_limited" };
    }

    if (!local) {
      if (frame.route !== "send") {
        // PR 1's answers, for a caller that never asked to route.
        if (launched === undefined) {
          out("unknown");
          return { ok: false, code: "unknown" };
        }
        out("ended");
        return { ok: false, code: "ended" };
      }
      if (routeBytes(text) > MESSAGE_ROUTE_MAX) {
        out("too_long");
        return { ok: false, code: "too_long", reason: "route" };
      }
      if (deps.route === undefined) {
        out("unsupported");
        return { ok: false, code: "unsupported" };
      }
      const title = from === null ? null : displayTitle((await deps.windowName(sender.id)) ?? "");
      const id = mintId();
      const routed = await deps.route({
        id,
        to,
        kind,
        text,
        ...(from === null ? {} : { fromTask: from }),
        ...(title === null ? {} : { fromTitle: title }),
        ...(frame.inReplyTo === undefined ? {} : { inReplyTo: frame.inReplyTo }),
      });
      if (!routed) {
        out("no_leader");
        return { ok: false, code: "no_leader" };
      }
      out("routed");
      return { ok: true, id, outcome: "routed", ...(from === null ? { receipt: false as const } : {}) };
    }

    const target = candidates.find((pane) => listeners.has(pane.id)) ?? candidates[0];
    if (target === undefined) {
      out("held");
      return { ok: false, code: "held" };
    }

    const title = from === null ? null : displayTitle((await deps.windowName(sender.id)) ?? "");
    const id = mintId();
    const item = itemOf({
      id,
      kind,
      text,
      bytes,
      from: { task: from, title, machine: deps.machine },
      inReplyTo: frame.inReplyTo,
    });

    const placed = place(target, to, launched, item);
    out(placed);
    if (placed === "delivered") {
      auditHeld(to, item, "delivered");
      return { ok: true, id, outcome: "delivered" };
    }
    if (placed === "nolistener") {
      auditHeld(to, item, "nolistener");
      return { ok: false, code: "ended", reason: "nolistener" };
    }
    return { ok: true, id, outcome: "sent" };
  };

  const deliverAsCustodian: Messages["deliverAsCustodian"] = async (paneId, text, expect) => {
    if (stopped) return { ok: false, code: "stopping" };
    const bytes = Buffer.byteLength(text, "utf8");
    // Always pushed, never pulled: a nudge is a request.
    if (bytes > MESSAGE_PUSH_MAX) return { ok: false, code: "too_long" };
    const panes = await deps.panes();
    sweep(panes);
    const target = panes.find((pane) => pane.id === paneId && !pane.dead);
    if (target === undefined) return { ok: false, code: "gone" };
    // Addressed only as messaging addresses: a pane carrying a task this machine's launch ledger holds.
    const to = target.taskId;
    const launched = to === null ? undefined : deps.launchedAt(to);
    if (to === null || launched === undefined) return { ok: false, code: "untasked" };
    // Counted under another process or task than the one here now: the count is not this session's.
    if (target.pid !== expect.pid || to !== expect.taskId) return { ok: false, code: "gone" };
    const id = mintId();
    const item: Held = {
      id,
      messageKind: "request",
      push: custodianRequest({ id, machine: deps.machine, text }),
      from: CUSTODIAN_SENDER,
      bytes,
      timer: null,
    };
    const placed = place(target, to, launched, item);
    if (placed === "nolistener") {
      auditHeld(to, item, "nolistener");
      return { ok: false, code: "no_listener" };
    }
    if (placed === "delivered") auditHeld(to, item, "delivered");
    return { ok: true, taskId: to, outcome: placed };
  };

  const canDeliver: Messages["canDeliver"] = async (paneId, expect) => {
    if (stopped) return false;
    const target = (await deps.panes()).find((pane) => pane.id === paneId && !pane.dead);
    if (target === undefined || target.taskId === null) return false;
    const launched = deps.launchedAt(target.taskId);
    if (launched === undefined) return false;
    if (target.pid !== expect.pid || target.taskId !== expect.taskId) return false;
    return wouldPlace(target, target.taskId, launched);
  };

  /** Replies to forwards by message id, held as promises so a replay racing the first is answered by it. */
  const forwards = new Map<string, { readonly reply: Promise<DeliverMessageResponse>; readonly at: number }>();

  const placeRouted = async (request: DeliverMessageRequest): Promise<DeliverMessageResponse> => {
    const { taskId: to, kind, id } = request;
    const bytes = Buffer.byteLength(request.text, "utf8");
    const from = request.fromTask ?? null;
    const inLine = (outcome: Parameters<MessageAudit>[0]["outcome"]): void =>
      audit({ dir: "in", from, to, kind, bytes, outcome });

    const launched = deps.launchedAt(to);
    if (launched === undefined) {
      inLine("unknown");
      return { ok: true, outcome: "unknown" };
    }
    const panes = await deps.panes();
    sweep(panes);
    const candidates = panes.filter((pane) => !pane.dead && pane.taskId === to);
    const target = candidates.find((pane) => listeners.has(pane.id)) ?? candidates[0];
    if (target === undefined) {
      // `settled`: the leader's record is finished, so a session that never showed a pane is not still starting.
      if (request.settled !== true && now() - launched <= graceMs) {
        inLine("held");
        return { ok: true, outcome: "held" };
      }
      inLine("ended");
      return { ok: true, outcome: "ended" };
    }
    const item = itemOf({
      id,
      kind,
      text: request.text,
      bytes,
      from: {
        task: from,
        title: request.fromTitle === undefined ? null : displayTitle(request.fromTitle),
        machine: request.fromMachine,
      },
      inReplyTo: request.inReplyTo,
    });
    const placed = place(target, to, launched, item);
    // `sent` is audited when its hold resolves, as a local message's is.
    if (placed === "delivered") auditHeld(to, item, "delivered");
    if (placed === "nolistener") {
      auditHeld(to, item, "nolistener");
      return { ok: true, outcome: "ended", reason: "nolistener" };
    }
    return { ok: true, outcome: placed };
  };

  const deliverRouted: Messages["deliverRouted"] = (request) => {
    if (stopped) return Promise.resolve({ ok: false, code: "unsupported", message: "stopping" });
    const t = now();
    for (const [id, entry] of forwards) {
      if (t - entry.at >= REPLAY_RETAIN_MS) forwards.delete(id);
    }
    const known = forwards.get(request.id);
    if (known !== undefined) return known.reply;
    const reply = placeRouted(request);
    forwards.set(request.id, { reply, at: t });
    return reply;
  };

  const receipt: Messages["receipt"] = async (request) => {
    if (stopped) return { ok: false, code: "unsupported", message: "stopping" };
    const to = request.fromTask;
    // A receipt for an untasked sender: nothing here can address it yet.
    if (to === undefined) return { ok: true, outcome: "dropped" };
    const launched = deps.launchedAt(to);
    if (launched === undefined) return { ok: true, outcome: "dropped" };
    const panes = await deps.panes();
    sweep(panes);
    const candidates = panes.filter((pane) => !pane.dead && pane.taskId === to);
    const target = candidates.find((pane) => listeners.has(pane.id)) ?? candidates[0];
    if (target === undefined) return { ok: true, outcome: "dropped" };
    const push = receiptNote(request);
    const item: Held = {
      id: mintId(),
      messageKind: "note",
      push,
      from: null,
      bytes: Buffer.byteLength(push, "utf8"),
      receipt: true,
      timer: null,
    };
    const placed = place(target, to, launched, item);
    if (placed === "nolistener") return { ok: true, outcome: "dropped" };
    audit({ dir: "receipt", from: to, to: request.to, kind: request.kind, outcome: request.outcome });
    return { ok: true, outcome: placed };
  };

  return {
    listen,
    send,
    deliverAsCustodian,
    canDeliver,
    deliverRouted,
    receipt,
    onEnded: (pane, taskId) => {
      if (inboxes.get(pane)?.taskId === taskId) dropInbox(pane, "ended");
      disconnects.delete(pane);
      const listener = listeners.get(pane);
      if (listener?.taskId === taskId) {
        listeners.delete(pane);
        listener.sink.close();
      }
    },
    stop: () => {
      stopped = true;
      // A restart clears the inboxes by design (nothing is at rest), so no audit: the lines would claim an outcome.
      for (const inbox of inboxes.values()) inbox.items.forEach(release);
      inboxes.clear();
      for (const listener of listeners.values()) listener.sink.close();
      listeners.clear();
    },
  };
}
