import {
  ADAPTER_RATE,
  adapterOfAddress,
  adapterStub,
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
  renderAdapterMessage,
  renderMessage,
  REPLAY_RETAIN_MS,
  routeBytes,
  type AdapterDeliveryOutcome,
  type AdapterResultCode,
  type AdapterResultOutcome,
  type DeliverFrame,
  type DeliverMessageRequest,
  type DeliverMessageResponse,
  type MessageKind,
  type MessageReceiptRequest,
  type MessageReceiptResponse,
  type MessageSender,
  type ReplyHandle,
  type SessionMessage,
} from "@seance/shared";
import { CUSTODIAN_SENDER, type AdapterMessageOutcome, type CustodianSender, type MessageAudit } from "./audit.ts";
import { log } from "./log.ts";
import {
  LISTENER_GRACE_MS,
  parseInboxFrame,
  parseMessageFrame,
  type InboxAck,
  type InboxLine,
  type MessageFrameRoute,
  type MessageReply,
} from "./message-frame.ts";
import { nestedClaude, sessionAlive, sessionProcessOf, type ClaudeProcess, type SessionKey } from "./claude-process.ts";
import { ancestorBelow, peerPidSupported } from "./peer.ts";
import type { Conversations } from "./conversations.ts";
import type { BoundPane } from "./session-events.ts";

/**
 * Session messages on this machine (DESIGN.md, "Session messages"): the daemon side of the `message` and
 * `inbox` local-socket frames. A session's `send_message` is a `message` frame, bound to its pane by the
 * kernel-reported peer pid; the `inbox` mod's `seance inbox` child is a long-lived `inbox` connection bound
 * the same way. Neither binds by a field, and neither falls back to a claimed pane on a host that names no
 * peer: unlike a session event, which only claims a state, an `inbox` frame hands text out.
 *
 * Memory only. A message is written once to the listener of the pane carrying the target task (which this
 * machine's launch ledger must hold a launch of), or held for a listener that has not connected yet, and is
 * never at rest on disk. No log line here carries message text, a title or a message id.
 *
 * A session with no task is addressed only as a reply, by the id of a message it sent (its handle). Two tables,
 * both memory only, 1 h and 256 entries each, bind a handle to who it reached: `sent` (the ids this daemon minted
 * for a session, so an answer finds its asker) and `received` (the ids placed in a session's pane, so only that
 * session can answer them). Every entry is bound to the `claude` process (`session`: its pid and start time), not the
 * pane and its pid alone: a hand-started session's pane process is the shell, which outlives a `claude` restart, and no
 * `ended` ever fires for an untasked pane. A peer with no `claude` above it has no session: it may still send to a task
 * and, in a pane whose task this machine launched, listen, but it holds no handle.
 */

/** Unread output a listener's connection may hold before the daemon drops it: a mod that stopped reading. */
export const LISTENER_OUTBOUND_MAX = 2 * 1_048_576;

export { LISTENER_GRACE_MS };

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** How long a reply handle stays good, and how many a daemon keeps (past it the busiest pane's oldest note goes first). */
export const REPLY_HANDLE_TTL_MS = HOUR_MS;
export const REPLY_HANDLE_MAX = 256;

/** What a reply's audit lines and held items name as the recipient: a constant, never the message id (a bearer handle). */
const REPLY_LABEL = "reply";

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
  /**
   * This machine's device id. A `received` entry whose origin is this machine is answered locally, through the `sent`
   * table, never through the leader; absent, every routed origin is taken as another machine.
   */
  readonly deviceId?: string;
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
  /** Session identity: what subscribes a sender to an adapter, and what a `toSession` delivery resolves through. */
  readonly conversations?: Pick<Conversations, "verifiedFor" | "atAct">;
  /** Every exclave's config dir, where a `claude` process's `sessions/<pid>.json` says it is a session (`nestedClaude`). */
  readonly configDirs?: () => readonly string[];
}

/** A session's message to an adapter, as messages hands it to the adapter host (`adapter-host.ts`). */
export interface AdapterOutletMessage {
  readonly id: string;
  readonly kind: MessageKind;
  readonly text: string;
  readonly bytes: number;
  /** The sending `claude` process (`Bound.session`). */
  readonly key: SessionKey;
  /** The sender's task, only one this machine launched. */
  readonly task: string | null;
  readonly title: string | null;
  /** Only when it names a delivery from this adapter that this very session received. */
  readonly inReplyTo?: string;
  /** The sender's verified conversation, re-read at the act; null when it has none. */
  readonly conversation: string | null;
  readonly leave: boolean;
  /** A message to `adapter:<name>` subscribes; a reply by handle to the adapter's delivery does not (DESIGN.md, "Adapters", "The subscription"). */
  readonly subscribe: boolean;
}

export type AdapterOutletAnswer =
  | { readonly ok: true; readonly subscribed: boolean; readonly session?: string }
  | { readonly ok: false; readonly code: "unknown" | "ended" | "refused" | "too_long" };

/** Refusals messages answers before the host sees the message; the host audits them under its own origin. */
export type AdapterEarlyRefusal = Extract<AdapterMessageOutcome, "unbound" | "too_long" | "rate_limited" | "stopping">;

/** The adapter host as messages reaches it: bound late, since the host starts after messages exists. */
export interface AdapterOutlet {
  readonly message: (name: string, message: AdapterOutletMessage) => Promise<AdapterOutletAnswer>;
  readonly refused: (
    name: string,
    line: {
      readonly from: string | null | undefined;
      readonly kind: MessageKind;
      readonly bytes: number;
      readonly outcome: AdapterEarlyRefusal;
    },
  ) => void;
}

/** What the host decides for one adapter's `deliver`: its config's scope and subscriptions, and where a later outcome goes. */
export interface AdapterDeliveryContext {
  /** The adapter's `repos` cover the target: its task, else the session `key` names. */
  readonly inScope: (target: { readonly task: string | null; readonly key: SessionKey | null }) => boolean;
  readonly subscribed: (conversation: string) => boolean;
  /** The fate of a delivery first answered `sent`. */
  readonly settle: (id: string, outcome: AdapterDeliveryOutcome) => void;
}

export interface AdapterDeliverResult {
  readonly outcome: AdapterResultOutcome;
  readonly code?: AdapterResultCode;
  readonly id?: string;
  /** The audit line's recipient: a task id, or the constant `session` or `reply` (never a conversation or message id). */
  readonly to: string;
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
  /**
   * Whether a note for this pane's session would not be refused `nolistener` now: its own listener, a reconnect or
   * launch within the grace, or this daemon's own start. Synchronous and places nothing: a watch asks before it exists
   * (docs/gh-watch.md W1), including for an untasked pane, which `canDeliver` answers false for.
   */
  readonly canListen: (
    pane: string,
    expect: { readonly pid: number; readonly task: string | null; readonly session: SessionKey },
  ) => boolean;
  /**
   * A watch's note (`watches.ts`; DESIGN.md, "Watches"): only to the listener of the `claude` process the table names,
   * by the same write or hold a message takes, as a reply by handle reaches its asker, and not repliable by handle. A
   * plain note unless `wake`, which the mod submits. `onFate` is told what became of a note that was held; no
   * `message` audit line is written (the watch's own lines are its record). `gone`: no such live pane, or that session
   * no longer runs. `unreadable`: the pane list came back empty, which is a failed tmux read as often as no panes, so
   * nothing is concluded from it.
   */
  readonly deliverWatchNote: (
    target: {
      readonly pane: string;
      readonly pid: number;
      readonly task: string | null;
      readonly session: SessionKey;
    },
    note: { readonly text: string; readonly wake: boolean },
    onFate: WatchNoteFate,
  ) => Promise<"delivered" | "sent" | "nolistener" | "gone" | "unreadable">;
  /**
   * An adapter's `deliver` (DESIGN.md, "Adapters"): to a task launched here, a conversation subscribed to it, or the
   * session whose message it answers, by the same listener write or hold a local message takes, in the adapter wrapper.
   * Never routed. `kinds` is the host's to check first.
   */
  readonly deliverFromAdapter: (
    name: string,
    frame: DeliverFrame,
    context: AdapterDeliveryContext,
  ) => Promise<AdapterDeliverResult>;
  /** Binds the adapter host, or unbinds it (null): a message to `adapter:<name>` is then `unknown`. */
  readonly setAdapters: (outlet: AdapterOutlet | null) => void;
  /**
   * A Codex session's inbox (`codex/sessions.ts`), the pane's one listener as a mod's child would be: the daemon's own,
   * from the launch or a reconnect, never a frame. `session` is the pane's server, the process a peer in that pane binds
   * to; null holds no handle. Closed (the inbox's `close`) when replaced or the pane is swept.
   */
  readonly attachCodex: (pane: BoundPane, session: SessionKey | null, inbox: SessionInbox) => void;
  /** Session events saw `ended` for this pane's task. */
  readonly onEnded: (pane: string, taskId: string) => void;
  readonly stop: () => void;
}

/**
 * A Codex session's inbox, which the daemon serves itself (`codex/delivery.ts`; DESIGN.md, "Session messages", "A Codex
 * session"): no `inbox` mod and no `seance inbox` child, the line handed over as a value and sent into the session as a
 * turn over the daemon's own connection to its server. `take` is false when that connection is gone.
 */
export interface SessionInbox {
  readonly take: (line: InboxLine) => boolean;
  readonly close: () => void;
  readonly gone: AbortSignal;
}

interface Listener {
  readonly taskId: string | null;
  readonly panePid: number;
  /** The `claude` process this listener belongs to (`Bound.session`), null when none stands above it. */
  readonly session: SessionKey | null;
  /** One line to the session: the mod's child's stdout, or a Codex session's turn. */
  readonly take: (line: InboxLine) => boolean;
  readonly sink: Pick<ListenerSink, "close" | "gone">;
}

/** What became of a held item: the outcomes `auditHeld` records. */
export type WatchNoteFate = (outcome: "delivered" | "ended" | "nolistener" | "dropped") => void;

/**
 * The live pane a peer's pid sits in and the `claude` process above it: replies by handle and watches bind the same
 * way (DESIGN.md, "Replies by handle"; "Watches"), by the kernel-reported pid and never a field. Null when the host
 * names no peer, the pid came back null or it is in no live pane; `session` is null when no `claude` stands on the
 * chain between the peer and the pane process. In a Codex pane (its start mark) the session is the innermost `codex`,
 * the pane's server (`sessionProcessOf`; docs/codex.md, "Tools").
 */
export async function bindPeer(
  peer: number | null,
  panes: readonly BoundPane[],
  hostNamesPeers: () => boolean = peerPidSupported,
): Promise<{
  readonly pane: BoundPane;
  readonly below: readonly number[];
  readonly session: ClaudeProcess | null;
} | null> {
  if (peer === null || !hostNamesPeers()) return null;
  const live = panes.filter((pane) => !pane.dead);
  const found = await ancestorBelow(peer, new Map(live.map((pane) => [pane.pid, pane])));
  if (found === null) return null;
  return {
    pane: found.hit,
    below: found.below,
    session: await sessionProcessOf([...found.below, found.hit.pid], found.hit.agent),
  };
}

/** A peer bound to its pane, and to the session process inside it. */
interface Bound {
  readonly pane: BoundPane;
  /**
   * What a reply handle is bound to: the `claude` process (`sessionOf`), never a shell it runs under, which a
   * restarted `claude` shares with its predecessor. Null when no `claude` stands on the peer's chain: such a peer
   * holds no handle, and nothing that needs one is done for it.
   */
  readonly session: SessionKey | null;
  /** The peer's ancestry, peer first, the pane process last. */
  readonly chain: readonly number[];
}

/** A message this daemon minted for a session: its id is the handle an answer carries. */
interface SentHandle {
  readonly pane: string;
  readonly pid: number;
  readonly session: SessionKey;
  readonly task: string | null;
  readonly kind: MessageKind;
  readonly at: number;
  /** Sent to this adapter: only its `deliver` may answer it. */
  readonly adapter?: string;
}

/** A message placed in a session's pane: only that session may answer it by handle. `origin` is null for a local sender. */
interface ReceivedHandle {
  readonly pane: string;
  readonly pid: number;
  readonly session: SessionKey;
  readonly task: string | null;
  readonly origin: string | null;
  readonly at: number;
  /** Delivered by this adapter: a reply to it goes back to the adapter. */
  readonly adapter?: string;
}

interface Held {
  readonly id: string;
  /** What its audit lines name as the recipient: a task id, or `reply`. */
  readonly to: string;
  readonly messageKind: MessageKind;
  readonly push: string;
  readonly body?: string;
  /** Where a reply to it goes: null for a local sender, a device id, undefined when it cannot be replied to by handle. */
  readonly origin?: string | null;
  /** Only this session may be written it: the reply's addressee, never the next `claude` in the same pane. */
  readonly only?: SessionKey;
  /** The line carries `wake` only on a listener of this session: the one that asked. */
  readonly wakeSession?: SessionKey;
  /** The sender's task, null when untasked, or the custodian: for the audit line only. */
  readonly from: string | null | CustodianSender;
  readonly bytes: number;
  /** A leader's receipt note: it has no outcome of its own to audit, the `receipt` line is its record. */
  readonly receipt?: true;
  /** A watch's note: told its fate instead of a `message` audit line, and it may be held through the restart grace. */
  readonly onFate?: WatchNoteFate;
  /** Delivered by this adapter: a reply by handle goes back to it. */
  readonly adapter?: string;
  /** The adapter asked for a turn (`wake: true`): submitted even as a note, on any listener it meets. */
  readonly wake?: true;
  /** An adapter's delivery: its later outcome goes to the adapter (a `delivery` frame), not the message audit. */
  readonly settle?: (outcome: AdapterDeliveryOutcome) => void;
  /** Its own grace, from the moment it was held: one timer per inbox would age a later message by an earlier one's clock. */
  timer: ReturnType<typeof setTimeout> | null;
}

interface Inbox {
  readonly taskId: string | null;
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
  let adapters: AdapterOutlet | null = null;

  const listeners = new Map<string, Listener>();
  /** A listener that dropped: its pane may reconnect within the grace without its messages being refused. */
  const disconnects = new Map<
    string,
    { readonly taskId: string | null; readonly session: SessionKey | null; readonly at: number }
  >();
  const inboxes = new Map<string, Inbox>();
  /** Send timestamps per rate key, pruned to the hour. */
  const sends = new Map<string, number[]>();
  /** Oldest first: ids are minted in time order, and the clock only moves forward. */
  const sent = new Map<string, SentHandle>();
  const received = new Map<string, ReceivedHandle>();

  /**
   * Past the cap the oldest entry of the pane holding the most goes, not the oldest overall: one busy sender (an
   * orchestrator's notes) must not push a quiet session's open question out of the table. Within that pane `spare`
   * says which entries to keep as long as another can go instead: a note's entry serves an optional receipt, an open
   * question's carries the reply and its wake.
   */
  const remember = <T extends { readonly at: number; readonly pane: string }>(
    table: Map<string, T>,
    id: string,
    entry: T,
    spare: (held: T) => boolean = () => false,
  ): void => {
    const t = now();
    for (const [key, held] of table) {
      if (t - held.at < REPLY_HANDLE_TTL_MS) break;
      table.delete(key);
    }
    table.set(id, entry);
    while (table.size > REPLY_HANDLE_MAX) {
      // Insertion order is age order, so the first pane to reach the top count is the one holding the oldest entry.
      const counts = new Map<string, number>();
      for (const held of table.values()) counts.set(held.pane, (counts.get(held.pane) ?? 0) + 1);
      let heaviest: string | undefined;
      let most = 0;
      for (const [pane, count] of counts) {
        if (count <= most) continue;
        heaviest = pane;
        most = count;
      }
      const inPane = [...table].filter(([, held]) => held.pane === heaviest);
      const victim = inPane.find(([, held]) => !spare(held)) ?? inPane[0];
      if (victim === undefined) break;
      table.delete(victim[0]);
    }
  };

  const recall = <T extends { readonly at: number }>(table: Map<string, T>, id: string): T | undefined => {
    const entry = table.get(id);
    if (entry === undefined) return undefined;
    if (now() - entry.at < REPLY_HANDLE_TTL_MS) return entry;
    table.delete(id);
    return undefined;
  };

  /** The live pane an entry was made for: same id, same process, same task (null still null). */
  const paneOf = (
    panes: readonly BoundPane[],
    entry: { readonly pane: string; readonly pid: number; readonly task: string | null },
  ): BoundPane | undefined =>
    panes.find((p) => p.id === entry.pane && !p.dead && p.pid === entry.pid && p.taskId === entry.task);

  /**
   * The pane a `sent` entry's session still asks from: the same live pane, process and task, and a `claude` that still
   * runs (the same process, by start time as well as pid). A hand-started session's pane outlives it (the shell stays),
   * and no `ended` fires for an untasked pane, so the process itself is the only sign it is gone.
   */
  const askerPane = (panes: readonly BoundPane[], entry: SentHandle): BoundPane | undefined =>
    sessionAlive(entry.session) ? paneOf(panes, entry) : undefined;

  /**
   * Drops a pane's handles, bar `keep`'s: those made for that pane process and task and for the listener's own session,
   * or for another `claude` that still runs there (a nested one's listener must not end the outer session's handles;
   * each handle is bound to its own session, so keeping it gives nobody else access).
   */
  const dropHandles = (
    paneId: string,
    keep?: { readonly pid: number; readonly task: string | null; readonly session: SessionKey | null },
  ): void => {
    for (const table of [sent, received]) {
      for (const [id, entry] of table) {
        if (entry.pane !== paneId) continue;
        if (
          keep !== undefined &&
          entry.pid === keep.pid &&
          entry.task === keep.task &&
          (entry.session === keep.session || sessionAlive(entry.session))
        ) {
          continue;
        }
        table.delete(id);
      }
    }
  };

  const audit = (line: Parameters<MessageAudit>[0]): void => {
    void deps.audit(line).catch((err: unknown) => log.warn(`messages: audit write failed: ${String(err)}`));
  };
  const auditHeld = (item: Held, outcome: "delivered" | "ended" | "nolistener" | "dropped"): void => {
    if (item.receipt === true) return;
    if (item.onFate !== undefined) {
      item.onFate(outcome);
      return;
    }
    if (item.settle !== undefined) {
      item.settle(outcome);
      return;
    }
    audit({ dir: "in", from: item.from, to: item.to, kind: item.messageKind, bytes: item.bytes, outcome });
  };

  const bind = async (peer: number | null, panes: readonly BoundPane[]): Promise<Bound | null> => {
    const bound = await bindPeer(peer, panes, hostNamesPeers);
    return bound === null
      ? null
      : { pane: bound.pane, session: bound.session?.key ?? null, chain: [...bound.below, bound.pane.pid] };
  };

  /** A message written to a listener can be answered by handle, from the session that read it. */
  const noteReceived = (item: Held, paneId: string, listener: Listener): void => {
    if (item.origin === undefined || listener.session === null) return;
    remember(received, item.id, {
      pane: paneId,
      pid: listener.panePid,
      session: listener.session,
      task: listener.taskId,
      origin: item.origin,
      at: now(),
      ...(item.adapter === undefined ? {} : { adapter: item.adapter }),
    });
  };

  /**
   * The session that asked, when `inReplyTo` is a question or request this very pane's session sent, from the same
   * process and task: the daemon's own table makes the wake binding, never a field of a frame.
   */
  const wakeFor = (inReplyTo: string | undefined, target: BoundPane): SessionKey | undefined => {
    if (inReplyTo === undefined) return undefined;
    const entry = recall(sent, inReplyTo);
    if (entry === undefined || entry.kind === "note") return undefined;
    return entry.pane === target.id && entry.pid === target.pid && entry.task === target.taskId
      ? entry.session
      : undefined;
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
    // A disconnect past the grace can no longer hold anything, and an untasked pane has no `ended` to clear it.
    for (const [paneId, dropped] of disconnects) {
      if (now() - dropped.at > graceMs) disconnects.delete(paneId);
    }
    // A handle whose pane is gone, re-tagged or respawned names nobody now. An empty list is a failed tmux read, which
    // must not cost an hour of handles.
    if (panes.length === 0) return;
    for (const table of [sent, received]) {
      for (const [id, entry] of table) {
        if (paneOf(panes, entry) === undefined) table.delete(id);
      }
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
      auditHeld(item, outcome);
    }
  };

  const lineOf = (item: Held, dropped: number, listener: Listener): InboxLine => {
    const prefix = dropped > 0 ? `${droppedNotice(dropped)}\n\n` : "";
    const line: InboxLine = {
      v: 1,
      id: item.id,
      messageKind: item.messageKind,
      push: prefix + item.push,
      ...(item.body === undefined ? {} : { body: prefix + item.body }),
      ...(item.wake === true || (item.wakeSession !== undefined && item.wakeSession === listener.session)
        ? { wake: true as const }
        : {}),
    };
    return line;
  };

  /**
   * Writes what the sink takes, oldest first. A write that fails (the connection closed, or its unread output passed
   * the cap) leaves the rest held, each with its own grace: the pane's next listener, typically a second away,
   * would still be served.
   */
  const flush = (paneId: string, inbox: Inbox, listener: Listener): void => {
    let consumed = 0;
    for (const item of inbox.items) {
      if (item.only !== undefined && item.only !== listener.session) {
        // Held for a session that is gone: this listener is another `claude` in the same pane.
        release(item);
        auditHeld(item, "ended");
        consumed += 1;
        continue;
      }
      if (!listener.take(lineOf(item, inbox.dropped, listener))) break;
      // The notice rode the first line out: a retry after a failed write must not repeat it.
      inbox.dropped = 0;
      release(item);
      auditHeld(item, "delivered");
      noteReceived(item, paneId, listener);
      consumed += 1;
    }
    for (const item of inbox.items.splice(0, consumed)) inbox.bytes -= item.bytes;
    if (inbox.items.length === 0) inboxes.delete(paneId);
  };

  const hold = (paneId: string, to: string | null, item: Held): void => {
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
      auditHeld(item, "nolistener");
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
      auditHeld(oldest, "dropped");
    }
  };

  /** Records a send against its rate key; false when it would pass either limit. */
  const admit = (
    key: string,
    rate: { readonly perMinute: number; readonly perHour: number } = MESSAGE_RATE,
  ): boolean => {
    const t = now();
    for (const [k, stamps] of sends) {
      if (stamps.every((s) => t - s >= HOUR_MS)) sends.delete(k);
    }
    const stamps = (sends.get(key) ?? []).filter((s) => t - s < HOUR_MS);
    const lastMinute = stamps.filter((s) => t - s < MINUTE_MS).length;
    if (lastMinute >= rate.perMinute || stamps.length >= rate.perHour) {
      sends.set(key, stamps);
      return false;
    }
    stamps.push(t);
    sends.set(key, stamps);
    return true;
  };

  /**
   * Writes the message to the target pane's listener, or holds it for one within the grace: from the launch (a task
   * the ledger holds), from the listener's disconnect, or from this daemon's own start. `nolistener` past all of them,
   * with nothing kept. A message that is `only` for one session (a reply) meets only that session's listener or
   * reconnect: the next `claude` in the same pane is not its addressee, and the launch and restart graces, which a
   * stranger's listener could meet, do not apply, with one exception: a watch's note (`onFate`) also holds through the
   * restart grace, because after a restart a reloaded watch's first event can land before the session's `inbox` child
   * has listened again, and `flush` still drops the note for any other session, so no stranger can read it. The caller
   * writes the audit lines.
   */
  const place = (
    target: BoundPane,
    to: string | null,
    launched: number | undefined,
    item: Held,
  ): "delivered" | "sent" | "nolistener" => {
    // The listener was bound for a task and a pane process: a pane re-tagged or respawned since is closed, not served.
    const listener = listeners.get(target.id);
    if (listener !== undefined) {
      const current = listener.taskId === to && listener.panePid === target.pid;
      // Another session's listener is a live, valid one: not closed, but not this message's either.
      if (current && item.only !== undefined && item.only !== listener.session) return "nolistener";
      if (current && listener.take(lineOf(item, 0, listener))) {
        noteReceived(item, target.id, listener);
        return "delivered";
      }
      if (listeners.get(target.id) === listener) {
        listeners.delete(target.id);
        listener.sink.close();
      }
    }
    const t = now();
    const reconnecting = disconnects.get(target.id);
    const reconnected =
      reconnecting !== undefined &&
      reconnecting.taskId === to &&
      t - reconnecting.at <= graceMs &&
      (item.only === undefined || item.only === reconnecting.session);
    const holds =
      reconnected ||
      (item.only === undefined &&
        ((launched !== undefined && t - launched <= graceMs) ||
          // A restart closed every listener and forgot every disconnect: each live pane is treated as just dropped.
          t - startedAt <= graceMs)) ||
      (item.onFate !== undefined && t - startedAt <= graceMs);
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
    readonly to: string;
    readonly kind: MessageKind;
    readonly text: string;
    readonly bytes: number;
    readonly from: MessageSender;
    readonly inReplyTo: string | undefined;
    readonly origin: string | null | undefined;
    readonly only?: SessionKey;
    readonly wakeSession: SessionKey | undefined;
  }): Held => {
    const full = renderMessage({
      kind: m.kind,
      id: m.id,
      from: m.from,
      text: m.text,
      // A routed message with no origin comes from a leader that predates replies: no `received` entry is made for it,
      // so a handle reply to it could only answer `unknown`.
      byHandle: m.origin !== undefined,
      ...(m.inReplyTo === undefined ? {} : { inReplyTo: m.inReplyTo }),
    });
    const pushed = m.bytes <= MESSAGE_PUSH_MAX;
    return {
      id: m.id,
      to: m.to,
      messageKind: m.kind,
      push: pushed ? full : messageStub({ kind: m.kind, id: m.id, from: m.from, bytes: m.bytes }),
      ...(pushed ? {} : { body: full }),
      ...(m.origin === undefined ? {} : { origin: m.origin }),
      ...(m.only === undefined ? {} : { only: m.only }),
      ...(m.wakeSession === undefined ? {} : { wakeSession: m.wakeSession }),
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
    const bound = await bind(peer, panes);
    if (bound === null) {
      // Info: a claude run outside tmux, in another tmux server, or a background session is ordinary.
      log.info(`local socket: inbox listener from pid=${peer ?? "unknown"} matched no live pane — refused`);
      return refuse("unbound");
    }
    const { pane, session } = bound;
    // A Codex pane's inbox is the daemon's own (`attachCodex`): a process inside it that listens would take the pane's
    // one listener from its session, which then misses what arrives, and read what was meant for the session.
    if (pane.agent === "codex") {
      log.info(`local socket: inbox listener from pid=${peer ?? "unknown"} is in a Codex pane — refused`);
      return refuse("unbound");
    }
    // A `claude -p` a tool ran loads the pane's mods too, and its listener would take the pane's one listener from the
    // pane's own session, which then misses what arrives. Refused as unbindable, which the mod waits out.
    if (deps.configDirs !== undefined && (await nestedClaude(bound.chain, deps.configDirs()))) {
      log.info(
        `local socket: inbox listener from pid=${peer ?? "unknown"} was started by another claude in its pane — refused`,
      );
      return refuse("unbound");
    }
    // No `claude` above the peer: no handle can be bound, so it listens only where a task id reaches it, as in Part A.
    if (session === null && (pane.taskId === null || deps.launchedAt(pane.taskId) === undefined)) {
      log.info(
        `local socket: inbox listener from pid=${peer ?? "unknown"} has no claude process above it and no task — refused`,
      );
      return refuse("unbound");
    }
    if (stopped) return refuse("stopping");
    // The peer may have gone while the pane list was read: nothing to serve, and no binding to keep.
    if (sink.gone.aborted) return;
    sweep(panes);
    // An untasked pane is acked too: no task id reaches it, but a reply by handle can (docs/messaging.md, D3).
    const ack: InboxAck = {
      ok: true,
      keep: { messages: INBOX_MAX_MESSAGES, bytes: INBOX_MAX_BYTES },
    };
    register(pane, session, {
      take: (line) => sink.write(JSON.stringify(line)),
      sink,
      ack: () => sink.write(JSON.stringify(ack)),
    });
  };

  /**
   * Makes a bound listener the pane's one: the previous one closed, the pane's other sessions' handles dropped, a grace
   * started when it drops, and what the pane holds for its task flushed to it.
   */
  const register = (
    pane: BoundPane,
    session: SessionKey | null,
    to: Pick<Listener, "take" | "sink"> & { readonly ack?: () => void },
  ): void => {
    const { sink } = to;
    // Handles made for another process, task or session in this pane are not this listener's.
    dropHandles(pane.id, { pid: pane.pid, task: pane.taskId, session });

    const previous = listeners.get(pane.id);
    if (previous !== undefined) {
      listeners.delete(pane.id);
      previous.sink.close();
    }
    const listener: Listener = { taskId: pane.taskId, panePid: pane.pid, session, take: to.take, sink };
    listeners.set(pane.id, listener);
    disconnects.delete(pane.id);
    sink.gone.addEventListener(
      "abort",
      () => {
        // A replaced or swept listener is no longer the pane's: only the current one dropping starts a grace.
        if (listeners.get(pane.id) !== listener) return;
        listeners.delete(pane.id);
        disconnects.set(pane.id, { taskId: listener.taskId, session, at: now() });
      },
      { once: true },
    );
    to.ack?.();

    const inbox = inboxes.get(pane.id);
    if (inbox === undefined) return;
    if (inbox.taskId === pane.taskId) flush(pane.id, inbox, listener);
    // Held for another task: the pane was re-tagged since, and none of it is for this session.
    else dropInbox(pane.id, "ended");
  };

  /**
   * A Codex session's inbox, bound by construction (DESIGN.md, "Session messages", "A Codex session"): the daemon
   * launched the pane and holds the connection to its server, so the pane, its pid and task, and the session process
   * (`run.sh`'s noted server, which `sessionOf` names for a peer in that pane) are the launch's facts, never a frame's.
   */
  const attachCodex: Messages["attachCodex"] = (pane, session, inbox) => {
    if (stopped || inbox.gone.aborted || pane.agent !== "codex" || pane.dead) {
      inbox.close();
      return;
    }
    register(pane, session, { take: inbox.take, sink: inbox });
  };

  /** What one `send` knows once its sender is bound: both the task-addressed and the reply path run on it. */
  interface Outgoing {
    readonly sender: Bound;
    /** The sender's task as a wrapper may name it: only one this machine launched. */
    readonly from: string | null;
    readonly kind: MessageKind;
    readonly text: string;
    readonly bytes: number;
    readonly inReplyTo: string | undefined;
    readonly out: (outcome: Parameters<MessageAudit>[0]["outcome"]) => void;
  }

  /** A sender with no session gets no handle: its message still goes, and an answer to it by id finds nobody. */
  const rememberSent = (id: string, o: Pick<Outgoing, "sender" | "kind">, adapter?: string): void => {
    const { session } = o.sender;
    if (session === null) return;
    remember(
      sent,
      id,
      {
        pane: o.sender.pane.id,
        pid: o.sender.pane.pid,
        session,
        task: o.sender.pane.taskId,
        kind: o.kind,
        at: now(),
        ...(adapter === undefined ? {} : { adapter }),
      },
      (held) => held.kind !== "note",
    );
  };

  /** The sender's wrapper title, or null when it has no task. */
  const titleOf = async (o: Outgoing): Promise<string | null> =>
    o.from === null ? null : displayTitle((await deps.windowName(o.sender.pane.id)) ?? "");

  /** Hands a message to the leader: to a task it resolves, or to the machine a reply's handle names. */
  const routeOut = async (
    o: Outgoing,
    target: { readonly to: string } | { readonly replyTo: ReplyHandle },
  ): Promise<MessageReply> => {
    if (routeBytes(o.text) > MESSAGE_ROUTE_MAX) {
      o.out("too_long");
      return { ok: false, code: "too_long", reason: "route" };
    }
    if (deps.route === undefined) {
      o.out("unsupported");
      return { ok: false, code: "unsupported" };
    }
    const title = await titleOf(o);
    const id = mintId();
    const common = {
      id,
      kind: o.kind,
      text: o.text,
      ...(o.from === null ? {} : { fromTask: o.from }),
      ...(title === null ? {} : { fromTitle: title }),
      ...(o.inReplyTo === undefined ? {} : { inReplyTo: o.inReplyTo }),
    };
    // Before the hand-off: a leader in this process can have the receipt back before `route` returns.
    rememberSent(id, o);
    const routed = await deps.route(
      "to" in target ? { ...common, to: target.to } : { ...common, replyTo: target.replyTo },
    );
    if (!routed) {
      sent.delete(id);
      o.out("no_leader");
      return { ok: false, code: "no_leader" };
    }
    o.out("routed");
    return { ok: true, id, outcome: "routed" };
  };

  /**
   * A reply by handle: `replyTo` is the id of a message this very session received. The `received` table says whether
   * it did and where the message came from, the `sent` table (here, or at the origin's daemon) where the asker is.
   */
  const sendReply = async (
    o: Outgoing,
    replyTo: string,
    route: MessageFrameRoute | undefined,
    panes: readonly BoundPane[],
    bucket: string,
    viaTo: boolean,
  ): Promise<MessageReply> => {
    const limited = (): MessageReply => {
      o.out("rate_limited");
      return { ok: false, code: "rate_limited" };
    };
    const pane = o.sender.pane;
    const got = recall(received, replyTo);
    // Only the session the message reached may answer it: another pane, process, task or `claude` holds no handle.
    if (
      got === undefined ||
      got.pane !== pane.id ||
      got.pid !== pane.pid ||
      got.task !== pane.taskId ||
      got.session !== o.sender.session
    ) {
      if (!admit(bucket)) return limited();
      o.out("unknown");
      return { ok: false, code: "unknown" };
    }

    if (got.adapter !== undefined) return replyToAdapter(o, got.adapter, replyTo, bucket);

    if (got.origin !== null && got.origin !== deps.deviceId) {
      // A frame that carries the id as `to` comes from a caller that predates replies (a current one leaves `to` out),
      // which gated only on routing: the leader it checked may drop a reply it cannot read, so none is sent.
      if (viaTo) {
        if (!admit(bucket)) return limited();
        o.out("unknown");
        return { ok: false, code: "unknown" };
      }
      if (route === "ask") {
        if (!admit(`ask:${bucket}`)) return limited();
        return { ok: false, code: "remote" };
      }
      if (!admit(bucket)) return limited();
      if (route !== "send") {
        // A caller that never asked to route is answered as an unreachable local handle.
        o.out("unknown");
        return { ok: false, code: "unknown" };
      }
      return routeOut(o, { replyTo: { id: replyTo, deviceId: got.origin } });
    }

    if (!admit(bucket)) return limited();
    const asker = recall(sent, replyTo);
    const target = asker === undefined ? undefined : askerPane(panes, asker);
    if (asker === undefined || target === undefined) {
      o.out("ended");
      return { ok: false, code: "ended" };
    }
    const title = await titleOf(o);
    const id = mintId();
    const item = itemOf({
      id,
      to: REPLY_LABEL,
      kind: o.kind,
      text: o.text,
      bytes: o.bytes,
      from: { task: o.from, title, machine: deps.machine },
      inReplyTo: replyTo,
      origin: null,
      only: asker.session,
      wakeSession: wakeFor(replyTo, target),
    });
    const launched = target.taskId === null ? undefined : deps.launchedAt(target.taskId);
    const placed = place(target, target.taskId, launched, item);
    o.out(placed);
    if (placed === "nolistener") {
      auditHeld(item, "nolistener");
      return { ok: false, code: "ended", reason: "nolistener" };
    }
    rememberSent(id, o);
    if (placed === "delivered") auditHeld(item, "delivered");
    return { ok: true, id, outcome: placed };
  };

  /**
   * Hands a session's message to an adapter on this machine: the host checks the name, `repos`, subscribes or leaves,
   * and audits under origin `adapter`. A sender with no `claude` process has no key the adapter could know it by.
   */
  const toAdapter = async (
    name: string,
    o: Pick<Outgoing, "sender" | "from" | "kind" | "text" | "bytes">,
    opts: { readonly inReplyTo?: string; readonly leave: boolean; readonly subscribe: boolean },
  ): Promise<MessageReply> => {
    const outlet = adapters;
    const key = o.sender.session;
    if (outlet === null) return { ok: false, code: "unknown" };
    if (key === null) {
      outlet.refused(name, { from: o.from, kind: o.kind, bytes: o.bytes, outcome: "unbound" });
      return { ok: false, code: "unbound" };
    }
    const conversation = (await deps.conversations?.verifiedFor(key)) ?? null;
    const title = o.from === null ? null : displayTitle((await deps.windowName(o.sender.pane.id)) ?? "");
    const id = mintId();
    const answer = await outlet.message(name, {
      id,
      kind: o.kind,
      text: o.text,
      bytes: o.bytes,
      key,
      task: o.from,
      title,
      ...(opts.inReplyTo === undefined ? {} : { inReplyTo: opts.inReplyTo }),
      conversation,
      leave: opts.leave,
      subscribe: opts.subscribe,
    });
    if (!answer.ok) return { ok: false, code: answer.code };
    // The adapter answers by this id (`deliver.inReplyTo`), and only that adapter.
    rememberSent(id, o, name);
    return {
      ok: true,
      id,
      outcome: "delivered",
      subscribed: answer.subscribed,
      ...(answer.subscribed && answer.session !== undefined ? { session: answer.session } : {}),
      adapter: name,
    };
  };

  /** A session's reply by handle to an adapter's delivery: back to that adapter, which subscribes nothing. */
  const replyToAdapter = async (o: Outgoing, name: string, replyTo: string, bucket: string): Promise<MessageReply> => {
    if (!admit(bucket)) {
      adapters?.refused(name, { from: o.from, kind: o.kind, bytes: o.bytes, outcome: "rate_limited" });
      return { ok: false, code: "rate_limited" };
    }
    return toAdapter(name, o, { inReplyTo: replyTo, leave: false, subscribe: false });
  };

  /** `to: "adapter:<name>"`: local only, never routed, refused before the host sees it only as a task message is. */
  const sendToAdapter = async (
    name: string,
    frame: NonNullable<ReturnType<typeof parseMessageFrame>>,
    peer: number | null,
  ): Promise<MessageReply> => {
    const { messageKind: kind, text } = frame;
    const bytes = Buffer.byteLength(text, "utf8");
    const outlet = adapters;
    if (outlet === null) return { ok: false, code: "unknown" };
    const panes = await deps.panes();
    const sender = await bind(peer, panes);
    if (sender === null) {
      outlet.refused(name, { from: undefined, kind, bytes, outcome: "unbound" });
      return { ok: false, code: "unbound" };
    }
    sweep(panes);
    const taskId = sender.pane.taskId;
    const from = taskId !== null && deps.launchedAt(taskId) !== undefined ? taskId : null;
    // An adapter takes no stub: the push limit is a pane's, and the whole text goes on one line.
    if (bytes > MESSAGE_MAX) {
      outlet.refused(name, { from, kind, bytes, outcome: "too_long" });
      return { ok: false, code: "too_long" };
    }
    const bucket = from === null ? `pane:${sender.pane.id}` : `task:${from}`;
    if (!admit(bucket)) {
      outlet.refused(name, { from, kind, bytes, outcome: "rate_limited" });
      return { ok: false, code: "rate_limited" };
    }
    // An `inReplyTo` the adapter never sent this session is dropped, not passed on: the adapter takes the id as its own.
    const got = frame.inReplyTo === undefined ? undefined : recall(received, frame.inReplyTo);
    const answers =
      got !== undefined &&
      got.adapter === name &&
      got.pane === sender.pane.id &&
      got.pid === sender.pane.pid &&
      got.session === sender.session;
    return toAdapter(
      name,
      { sender, from, kind, text, bytes },
      {
        ...(answers && frame.inReplyTo !== undefined ? { inReplyTo: frame.inReplyTo } : {}),
        leave: frame.leave === true,
        subscribe: true,
      },
    );
  };

  const send: Messages["send"] = async (raw, peer) => {
    const frame = parseMessageFrame(raw);
    if (frame === null) return { ok: false, code: "invalid" };
    if (stopped) return { ok: false, code: "stopping" };
    const adapter = frame.to === undefined ? null : adapterOfAddress(frame.to);
    if (adapter !== null) return sendToAdapter(adapter, frame, peer);
    const { messageKind: kind, text } = frame;
    // `to` left out, or the message id given as it (a model that fills the field): the id is the address.
    const replyTo =
      frame.inReplyTo !== undefined && (frame.to === undefined || frame.to === frame.inReplyTo)
        ? frame.inReplyTo
        : null;
    const to = replyTo === null ? frame.to : REPLY_LABEL;
    if (to === undefined) return { ok: false, code: "invalid" };
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
    const taskId = sender.pane.taskId;
    const from = taskId !== null && deps.launchedAt(taskId) !== undefined ? taskId : null;
    const out = (outcome: Parameters<MessageAudit>[0]["outcome"]): void =>
      audit({ dir: "out", from, to, kind, bytes, outcome });
    const outgoing: Outgoing = { sender, from, kind, text, bytes, inReplyTo: frame.inReplyTo, out };

    if (bytes > MESSAGE_MAX || (kind === "request" && bytes > MESSAGE_PUSH_MAX)) {
      out("too_long");
      return { ok: false, code: "too_long" };
    }
    const bucket = from === null ? `pane:${sender.pane.id}` : `task:${from}`;
    if (replyTo !== null) return sendReply(outgoing, replyTo, frame.route, panes, bucket, frame.to !== undefined);

    // Local when this machine launched the task and a live pane carries it, or the launch is still inside the grace
    // (a held answer). Anything else is not deliverable here: a caller that can check the leader is told to (`remote`)
    // before the send bucket counts the frame, so one routed message is one count there, not two. The ask has a bucket
    // of its own (same limits), since each costs a pane listing and a peer walk and a gate that refuses ends there.
    const launched = deps.launchedAt(to);
    const candidates = panes.filter((pane) => !pane.dead && pane.taskId === to);
    const local = launched !== undefined && (candidates.length > 0 || now() - launched <= graceMs);
    if (!local && frame.route === "ask") {
      if (!admit(`ask:${bucket}`)) {
        out("rate_limited");
        return { ok: false, code: "rate_limited" };
      }
      return { ok: false, code: "remote" };
    }

    if (!admit(bucket)) {
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
      return routeOut(outgoing, { to });
    }

    const target = candidates.find((pane) => listeners.has(pane.id)) ?? candidates[0];
    if (target === undefined) {
      out("held");
      return { ok: false, code: "held" };
    }

    const title = await titleOf(outgoing);
    const id = mintId();
    const item = itemOf({
      id,
      to,
      kind,
      text,
      bytes,
      from: { task: from, title, machine: deps.machine },
      inReplyTo: frame.inReplyTo,
      // No origin, so no handle clause and no `received` entry, for a sender nothing could answer by handle.
      origin: sender.session === null ? undefined : null,
      wakeSession: wakeFor(frame.inReplyTo, target),
    });

    const placed = place(target, to, launched, item);
    out(placed);
    if (placed === "delivered") {
      auditHeld(item, "delivered");
      rememberSent(id, outgoing);
      return { ok: true, id, outcome: "delivered" };
    }
    if (placed === "nolistener") {
      auditHeld(item, "nolistener");
      return { ok: false, code: "ended", reason: "nolistener" };
    }
    rememberSent(id, outgoing);
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
      to,
      messageKind: "request",
      push: custodianRequest({ id, machine: deps.machine, text }),
      from: CUSTODIAN_SENDER,
      bytes,
      timer: null,
    };
    const placed = place(target, to, launched, item);
    if (placed === "nolistener") {
      auditHeld(item, "nolistener");
      return { ok: false, code: "no_listener" };
    }
    if (placed === "delivered") auditHeld(item, "delivered");
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

  const canListen: Messages["canListen"] = (paneId, expect) => {
    if (stopped) return false;
    const listener = listeners.get(paneId);
    if (
      listener !== undefined &&
      listener.panePid === expect.pid &&
      listener.taskId === expect.task &&
      listener.session === expect.session
    ) {
      return true;
    }
    const t = now();
    const dropped = disconnects.get(paneId);
    if (
      dropped !== undefined &&
      dropped.taskId === expect.task &&
      dropped.session === expect.session &&
      t - dropped.at <= graceMs
    ) {
      return true;
    }
    if (t - startedAt <= graceMs) return true;
    const launched = expect.task === null ? undefined : deps.launchedAt(expect.task);
    return launched !== undefined && t - launched <= graceMs;
  };

  const deliverWatchNote: Messages["deliverWatchNote"] = async (target, note, onFate) => {
    if (stopped) return "gone";
    const panes = await deps.panes();
    // A failed tmux read and no tmux server look alike: concluding "gone" from either would end every watch on a hiccup.
    if (panes.length === 0) return "unreadable";
    sweep(panes);
    const pane = paneOf(panes, { pane: target.pane, pid: target.pid, task: target.task });
    if (pane === undefined || !sessionAlive(target.session)) return "gone";
    const item: Held = {
      id: mintId(),
      to: target.task ?? "watch",
      messageKind: "note",
      push: note.text,
      only: target.session,
      ...(note.wake ? { wakeSession: target.session } : {}),
      from: null,
      bytes: Buffer.byteLength(note.text, "utf8"),
      timer: null,
      onFate,
    };
    const placed = place(pane, target.task, target.task === null ? undefined : deps.launchedAt(target.task), item);
    if (placed === "delivered") onFate("delivered");
    return placed;
  };

  /** Replies to forwards by message id, held as promises so a replay racing the first is answered by it. */
  const forwards = new Map<string, { readonly reply: Promise<DeliverMessageResponse>; readonly at: number }>();
  /** Receipts placed, by message id and outcome: a second leader sent the same message answers it again. */
  const receipts = new Map<string, { readonly reply: Promise<MessageReceiptResponse>; readonly at: number }>();

  /** A forward that answers a message this daemon's `sent` table holds: to the pane and session that asked. */
  const placeReply = async (
    request: Extract<DeliverMessageRequest, { readonly replyTo: string }>,
  ): Promise<DeliverMessageResponse> => {
    const { kind, id, replyTo } = request;
    const bytes = Buffer.byteLength(request.text, "utf8");
    const from = request.fromTask ?? null;
    const inLine = (outcome: Parameters<MessageAudit>[0]["outcome"]): void =>
      audit({ dir: "in", from, to: REPLY_LABEL, kind, bytes, outcome });

    const panes = await deps.panes();
    sweep(panes);
    const asker = recall(sent, replyTo);
    const target = asker === undefined ? undefined : askerPane(panes, asker);
    if (asker === undefined || target === undefined) {
      inLine("ended");
      return { ok: true, outcome: "ended" };
    }
    const item = itemOf({
      id,
      to: REPLY_LABEL,
      kind,
      text: request.text,
      bytes,
      from: {
        task: from,
        title: request.fromTitle === undefined ? null : displayTitle(request.fromTitle),
        machine: request.fromMachine,
      },
      inReplyTo: replyTo,
      origin: request.origin,
      only: asker.session,
      wakeSession: wakeFor(replyTo, target),
    });
    const launched = target.taskId === null ? undefined : deps.launchedAt(target.taskId);
    const placed = place(target, target.taskId, launched, item);
    if (placed === "delivered") auditHeld(item, "delivered");
    if (placed === "nolistener") {
      auditHeld(item, "nolistener");
      return { ok: true, outcome: "ended", reason: "nolistener" };
    }
    return { ok: true, outcome: placed };
  };

  const placeRouted = async (request: DeliverMessageRequest): Promise<DeliverMessageResponse> => {
    if (request.replyTo !== undefined) return placeReply({ ...request, replyTo: request.replyTo });
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
      to,
      kind,
      text: request.text,
      bytes,
      from: {
        task: from,
        title: request.fromTitle === undefined ? null : displayTitle(request.fromTitle),
        machine: request.fromMachine,
      },
      inReplyTo: request.inReplyTo,
      origin: request.origin,
      wakeSession: wakeFor(request.inReplyTo, target),
    });
    const placed = place(target, to, launched, item);
    // `sent` is audited when its hold resolves, as a local message's is.
    if (placed === "delivered") auditHeld(item, "delivered");
    if (placed === "nolistener") {
      auditHeld(item, "nolistener");
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

  /**
   * Where a receipt goes: the pane and session the `sent` table says sent the message, when it still stands there (an
   * untasked sender's only way), else the pane carrying `fromTask`, as a daemon that predates replies finds it.
   */
  const placeReceipt = async (request: MessageReceiptRequest): Promise<MessageReceiptResponse> => {
    const panes = await deps.panes();
    sweep(panes);
    const asker = recall(sent, request.id);
    const byHandle = asker === undefined ? undefined : askerPane(panes, asker);
    let target: BoundPane | undefined;
    let launched: number | undefined;
    let only: SessionKey | undefined;
    if (asker !== undefined && byHandle !== undefined) {
      target = byHandle;
      launched = byHandle.taskId === null ? undefined : deps.launchedAt(byHandle.taskId);
      // An asker whose task this machine launched keeps the launch and restart graces a task-addressed receipt always
      // had: its `claude` is the pane's own process, so no later session is taken for it. Any other (untasked, or
      // tagged with a task the ledger does not hold, where a shell's later `claude` could be) is pinned to its session.
      if (launched === undefined) only = asker.session;
    } else if (request.fromTask !== undefined) {
      const task = request.fromTask;
      launched = deps.launchedAt(task);
      if (launched === undefined) return { ok: true, outcome: "dropped" };
      const candidates = panes.filter((pane) => !pane.dead && pane.taskId === task);
      target = candidates.find((pane) => listeners.has(pane.id)) ?? candidates[0];
    }
    if (target === undefined) return { ok: true, outcome: "dropped" };
    const push = receiptNote(request);
    const item: Held = {
      id: mintId(),
      to: request.to ?? REPLY_LABEL,
      messageKind: "note",
      push,
      from: null,
      bytes: Buffer.byteLength(push, "utf8"),
      receipt: true,
      ...(only === undefined ? {} : { only }),
      timer: null,
    };
    const placed = place(target, target.taskId, launched, item);
    if (placed === "nolistener") return { ok: true, outcome: "dropped" };
    audit({
      dir: "receipt",
      from: target.taskId !== null && launched !== undefined ? target.taskId : null,
      to: request.to ?? REPLY_LABEL,
      kind: request.kind,
      outcome: request.outcome,
    });
    return { ok: true, outcome: placed };
  };

  const receipt: Messages["receipt"] = (request) => {
    if (stopped) return Promise.resolve({ ok: false, code: "unsupported", message: "stopping" });
    const t = now();
    for (const [key, entry] of receipts) {
      if (t - entry.at >= REPLAY_RETAIN_MS) receipts.delete(key);
    }
    const key = `${request.id}:${request.outcome}`;
    const known = receipts.get(key);
    if (known !== undefined) return known.reply;
    const reply = placeReceipt(request);
    receipts.set(key, { reply, at: t });
    return reply;
  };

  const deliverFromAdapter: Messages["deliverFromAdapter"] = async (name, frame, context) => {
    const label = "to" in frame ? frame.to : "toSession" in frame ? "session" : REPLY_LABEL;
    const answer = (
      outcome: AdapterResultOutcome,
      extra: { readonly code?: AdapterResultCode; readonly id?: string } = {},
    ): AdapterDeliverResult => ({ outcome, to: label, ...extra });
    if (stopped) return answer("unsupported");
    const { messageKind: kind, text } = frame;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MESSAGE_MAX || (kind === "request" && bytes > MESSAGE_PUSH_MAX)) return answer("too_long");
    // One bucket for all of an adapter's deliveries, then each target's own below.
    if (!admit(`adapter:${name}`, ADAPTER_RATE)) return answer("rate_limited");
    const panes = await deps.panes();
    sweep(panes);

    let target: BoundPane | undefined;
    let only: SessionKey | undefined;
    let wakeSession: SessionKey | undefined;
    let inReplyTo: string | undefined;
    let targetKey: string;
    if ("to" in frame) {
      const launched = deps.launchedAt(frame.to);
      if (launched === undefined) return answer("unknown");
      const candidates = panes.filter((pane) => !pane.dead && pane.taskId === frame.to);
      target = candidates.find((pane) => listeners.has(pane.id)) ?? candidates[0];
      if (target === undefined) return answer(now() - launched <= graceMs ? "held" : "ended");
      if (!context.inScope({ task: frame.to, key: null })) return answer("refused", { code: "repo" });
      targetKey = `task:${frame.to}`;
    } else if ("toSession" in frame) {
      if (!context.subscribed(frame.toSession) || deps.conversations === undefined) return answer("unknown");
      const act = await deps.conversations.atAct(frame.toSession);
      if (!act.ok) return answer(act.code);
      // `atAct`'s pid is the `claude` process's, not the pane's: `only` binds the delivery to that process.
      target = panes.find((pane) => pane.id === act.pane && !pane.dead);
      if (target === undefined) return answer("ended");
      only = act.key;
      targetKey = `session:${act.key}`;
    } else {
      const asker = recall(sent, frame.inReplyTo);
      // Only the adapter the session messaged may answer it.
      if (asker === undefined || asker.adapter !== name) return answer("unknown");
      target = askerPane(panes, asker);
      if (target === undefined) return answer("ended");
      only = asker.session;
      wakeSession = wakeFor(frame.inReplyTo, target);
      inReplyTo = frame.inReplyTo;
      targetKey = `session:${asker.session}`;
    }
    const task = target.taskId !== null && deps.launchedAt(target.taskId) !== undefined ? target.taskId : null;
    if (!("to" in frame) && !context.inScope({ task, key: only ?? null })) {
      return answer("refused", { code: "repo" });
    }
    if (!admit(`adapter:${name}:${targetKey}`)) return answer("rate_limited");

    const id = mintId();
    const from = { adapter: name, machine: deps.machine, label: displayTitle(frame.from ?? "") };
    const full = renderAdapterMessage({ kind, id, from, text, ...(inReplyTo === undefined ? {} : { inReplyTo }) });
    const pushed = bytes <= MESSAGE_PUSH_MAX;
    const item: Held = {
      id,
      to: label,
      messageKind: kind,
      push: pushed ? full : adapterStub({ kind, id, from, bytes }),
      ...(pushed ? {} : { body: full }),
      // Answerable by handle: `received` holds it with the adapter, which a reply goes back to.
      origin: null,
      adapter: name,
      ...(only === undefined ? {} : { only }),
      ...(wakeSession === undefined ? {} : { wakeSession }),
      ...(frame.wake === true ? { wake: true as const } : {}),
      from: null,
      bytes,
      settle: (outcome) => context.settle(id, outcome),
      timer: null,
    };
    const launched = target.taskId === null ? undefined : deps.launchedAt(target.taskId);
    const placed = place(target, target.taskId, launched, item);
    if (placed === "nolistener") return answer("ended", { code: "nolistener" });
    return answer(placed, { id });
  };

  return {
    listen,
    send,
    deliverAsCustodian,
    canDeliver,
    canListen,
    deliverWatchNote,
    deliverRouted,
    receipt,
    deliverFromAdapter,
    attachCodex,
    setAdapters: (outlet) => {
      adapters = outlet;
    },
    onEnded: (pane, taskId) => {
      if (inboxes.get(pane)?.taskId === taskId) dropInbox(pane, "ended");
      disconnects.delete(pane);
      const listener = listeners.get(pane);
      if (listener?.taskId === taskId) {
        listeners.delete(pane);
        listener.sink.close();
      }
      dropHandles(pane);
    },
    stop: () => {
      stopped = true;
      // A restart clears the inboxes by design (nothing is at rest), so no audit: the lines would claim an outcome.
      for (const inbox of inboxes.values()) inbox.items.forEach(release);
      inboxes.clear();
      for (const listener of listeners.values()) listener.sink.close();
      listeners.clear();
      sent.clear();
      received.clear();
    },
  };
}
