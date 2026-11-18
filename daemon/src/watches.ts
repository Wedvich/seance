import {
  isTerminalKey,
  parseGithubPr,
  parseGithubRun,
  prUrlOf,
  runUrlOf,
  WATCH_SEEN_MAX,
  watchNote,
  watchTargetKey,
  type WatchEvent,
  type WatchEventRequest,
  type WatchEventResponse,
  type WatchNoteBody,
  type WatchRefusal,
  type WatchSet,
  type WatchTarget,
} from "@seance/shared";
import type { WatchAudit, WatchAuditLine, WatchEndReason } from "./audit.ts";
import { log } from "./log.ts";
import { processStart, peerPidSupported } from "./peer.ts";
import { sessionAlive, type SessionKey } from "./claude-process.ts";
import { bindPeer, type Messages } from "./messages.ts";
import type { BoundPane } from "./session-events.ts";
import { parseWatchFrame, type WatchFrame, type WatchReply, type WatchReplyCode } from "./watch-frame.ts";
import type { WatchLeader } from "./watch-leader.ts";
import { readSavedWatches, writeSavedWatches, type SavedWatch } from "./watches-store.ts";

/**
 * The daemon's table of the GitHub watches its sessions asked for (docs/gh-watch.md W1-W9; DESIGN.md, "Watches"). The
 * daemon owns each watch's life: it binds the asker by the kernel's peer pid, keeps the table (and `watches.json`, so a
 * self-update does not end them), states the whole set to the leader (`watch-set`), and turns the leader's facts
 * (`watch-event`) into one fixed note in the asking session's inbox. A watch ends with its session, its task, its 24 h
 * expiry or its target; nothing about a watch is ever logged: not its URL, head, check names or id.
 */

export const WATCH_SESSION_MAX = 8;
/** Equal to the leader's per-device cap (`WATCH_SET_MAX`), so a full table is never refused `invalid` for its size. */
export const WATCH_MACHINE_MAX = 64;
export const WATCH_TTL_MS = 24 * 60 * 60_000;

const TICK_MS = 60_000;
const HEARTBEAT_MS = 5 * 60_000;
const NO_LEADER_MS = 10 * 60_000;
const ADD_ANSWER_MS = 3_000;

export interface WatchesDeps {
  readonly panes: () => Promise<readonly BoundPane[]>;
  readonly messages: Pick<Messages, "canListen" | "deliverWatchNote">;
  readonly leader: WatchLeader;
  /** This daemon's `instance`: a watch-set's generation is `{boot, n}`, so `n` restarts at 1 with every process. */
  readonly boot: string;
  readonly path: string;
  readonly audit: WatchAudit;
  readonly now?: () => number;
  readonly tickMs?: number;
  readonly heartbeatMs?: number;
  readonly noLeaderMs?: number;
  readonly ttlMs?: number;
  readonly addAnswerMs?: number;
  readonly hostNamesPeers?: () => boolean;
  readonly processStart?: (pid: number) => string | null;
  readonly sessionAlive?: (session: SessionKey) => boolean;
  readonly mintId?: () => string;
  readonly warn?: (line: string) => void;
}

export interface Watches {
  /** A `watch` frame from the local socket: `peer` is the kernel-reported pid of its sender, never a field of the frame. */
  readonly handle: (raw: unknown, peer: number | null) => Promise<WatchReply>;
  readonly onEvent: (request: WatchEventRequest) => Promise<WatchEventResponse>;
  /**
   * Whether a watch is waiting on this pane's session (and, given `taskId`, on that task): the custodian then does not
   * close it, since the note that would wake it has yet to arrive (`awaitsWake`).
   */
  readonly holds: (pane: string, taskId?: string | null) => boolean;
  /** Session events saw `ended` for this pane's task. */
  readonly onEnded: (pane: string, taskId: string) => void;
  /** States the whole table to the leader now: a new nominee holds none of it (W9). Nothing for an empty table. */
  readonly resend: () => void;
  /** Reloads the table, states it to the leader and starts the tick. */
  readonly start: () => Promise<void>;
  /** The write chain: awaited where the daemon's own shutdown can, so a restart's reload reads what this process saved. */
  readonly stop: () => Promise<void>;
}

interface Entry {
  readonly id: string;
  readonly kind: "pr" | "run";
  readonly url: string;
  readonly head?: string;
  readonly target: WatchTarget;
  seen: readonly string[];
  /**
   * Keys of notes held for a listener (`sent`, not yet written): in `seen` so a repeat is skipped, and left out of what
   * is saved until the note lands, so a restart that loses the held note has the leader send them again.
   */
  pending: readonly string[];
  readonly pane: string;
  readonly panePid: number;
  readonly paneStart: string;
  readonly session: SessionKey;
  readonly task: string | null;
  readonly madeAt: number;
  readonly expiresAt: number;
  noLeaderTold: boolean;
  fleetFullTold: boolean;
}

interface Waiter {
  /** The `gen.n` of the send that carried this add: an answer of that `n` or later is its answer. */
  readonly n: number;
  readonly resolve: (result: "ok" | WatchRefusal) => void;
}

/**
 * Writes to `watches.json`, in order, once per path per process (like `endedTasksByLedger` and `floorsByPath` in
 * `run.ts`): a second table over the same path in this process (a restart of the capability, a test's next instance)
 * queues behind the first one's pending writes instead of racing them, and reads only after they land.
 */
const writeChains = new Map<string, Promise<void>>();

function targetOf(kind: "pr" | "run", url: string): WatchTarget | null {
  if (kind === "pr") {
    const pr = parseGithubPr(url);
    return pr === null ? null : { kind, pr };
  }
  const run = parseGithubRun(url);
  return run === null ? null : { kind, run };
}

const urlOf = (target: WatchTarget): string => (target.kind === "pr" ? prUrlOf(target.pr) : runUrlOf(target.run));

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type NoteOutcome = "delivered" | "sent" | "nolistener" | "gone" | "unreadable";

export function createWatches(deps: WatchesDeps): Watches {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? TICK_MS;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const noLeaderMs = deps.noLeaderMs ?? NO_LEADER_MS;
  const ttlMs = deps.ttlMs ?? WATCH_TTL_MS;
  const addAnswerMs = deps.addAnswerMs ?? ADD_ANSWER_MS;
  const hostNamesPeers = deps.hostNamesPeers ?? peerPidSupported;
  const startOf = deps.processStart ?? processStart;
  const alive = deps.sessionAlive ?? sessionAlive;
  const mintId = deps.mintId ?? ((): string => crypto.randomUUID());
  const warn = deps.warn ?? ((line: string): void => log.warn(line));
  const { leader, messages } = deps;
  const bootAt = now();

  const entries = new Map<string, Entry>();
  const waiters = new Map<string, Waiter>();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  /** `gen.n` of the latest send, the highest an answer of this boot named, and when the leader last answered at all. */
  let n = 0;
  let answeredGen = 0;
  let lastAnsweredAt: number | null = null;
  let lastSentAt = 0;
  let lastSendOk = true;

  /** Sends wanted while a frame or a tick is still working are made once, at its end. */
  let batch = 0;
  let sendWanted = false;

  const say = async (line: WatchAuditLine): Promise<void> => {
    try {
      await deps.audit(line);
    } catch (err) {
      warn(`watches: audit write failed: ${errorText(err)}`);
    }
  };

  const toSaved = (entry: Entry): SavedWatch => ({
    id: entry.id,
    kind: entry.kind,
    url: entry.url,
    ...(entry.head === undefined ? {} : { head: entry.head }),
    seen: entry.pending.length === 0 ? entry.seen : entry.seen.filter((key) => !entry.pending.includes(key)),
    pane: entry.pane,
    panePid: entry.panePid,
    paneStart: entry.paneStart,
    session: entry.session,
    task: entry.task,
    madeAt: entry.madeAt,
    expiresAt: entry.expiresAt,
    noLeaderTold: entry.noLeaderTold,
    fleetFullTold: entry.fleetFullTold,
  });

  /** Nothing is written once stopped: a restart's table may already have read the file, and a late write would undo it. */
  const persist = (): void => {
    if (stopped) return;
    const snapshot = [...entries.values()].map(toSaved);
    const previous = writeChains.get(deps.path) ?? Promise.resolve();
    writeChains.set(
      deps.path,
      previous
        .then(() => writeSavedWatches(deps.path, snapshot))
        .catch((err: unknown) => {
          warn(`watches: could not save the table: ${errorText(err)}`);
        }),
    );
  };

  const watchOf = (entry: Entry): WatchSet["watches"][number] =>
    entry.head === undefined
      ? { id: entry.id, kind: entry.kind, url: entry.url, seen: [...entry.seen] }
      : { id: entry.id, kind: entry.kind, url: entry.url, head: entry.head, seen: [...entry.seen] };

  /** Sends the whole table. Resolves false when the set was not handed on (no leader, a leg that is down). */
  const sendSet = async (): Promise<boolean> => {
    if (stopped) return false;
    n += 1;
    const sent = n;
    const set: WatchSet = {
      gen: { boot: deps.boot, n: sent },
      watches: [...entries.values()].map(watchOf),
    };
    lastSentAt = now();
    // The leader's hold follows the table: an empty set is sent once and the leg is let go.
    if (entries.size === 0) leader.release();
    else leader.hold();
    let ok = false;
    try {
      ok = await leader.send(set);
    } catch (err) {
      warn(`watches: could not send the set: ${errorText(err)}`);
    }
    if (sent === n) lastSendOk = ok;
    return ok;
  };

  const flush = (): void => {
    if (!sendWanted || batch > 0) return;
    sendWanted = false;
    sendSet().catch((err: unknown) => {
      warn(`watches: could not send the set: ${errorText(err)}`);
    });
  };

  const scheduleSend = (): void => {
    sendWanted = true;
    flush();
  };

  const inBatch = async <T>(work: () => Promise<T>): Promise<T> => {
    batch += 1;
    try {
      return await work();
    } finally {
      batch -= 1;
      flush();
    }
  };

  const settle = (id: string, result: "ok" | WatchRefusal): void => {
    const waiter = waiters.get(id);
    if (waiter === undefined) return;
    waiters.delete(id);
    waiter.resolve(result);
  };

  /**
   * Takes an entry out of the table with its audit line, leaving persisting and the set to the caller. A stopped table
   * ends nothing: work that was past its `stopped` check when `stop` ran (a note's grace timer too) must neither audit an
   * end the next instance does not share nor leave the watch out of a file it reloads.
   */
  const drop = async (entry: Entry, reason: WatchEndReason): Promise<boolean> => {
    if (stopped || entries.get(entry.id) !== entry) return false;
    entries.delete(entry.id);
    settle(entry.id, "ok");
    await say({ op: "end", kind: entry.kind, reason });
    return true;
  };

  const end = async (entry: Entry, reason: WatchEndReason): Promise<void> => {
    if (!(await drop(entry, reason))) return;
    persist();
    scheduleSend();
  };

  const sessionOf = (entry: Entry): Parameters<Messages["deliverWatchNote"]>[0] => ({
    pane: entry.pane,
    pid: entry.panePid,
    task: entry.task,
    session: entry.session,
  });

  /** A held note that was never written: its watch is over, since the session will not hear of it. */
  const onFate = (
    entry: Entry,
    fate: "delivered" | "ended" | "nolistener" | "dropped",
    keys: readonly string[],
  ): void => {
    if (fate === "delivered") {
      // The held note landed: its keys are told, so they may be saved now.
      if (entry.pending.length === 0) return;
      entry.pending = entry.pending.filter((key) => !keys.includes(key));
      if (entries.get(entry.id) === entry) persist();
      return;
    }
    end(entry, fate).catch((err: unknown) => {
      warn(`watches: could not end a watch: ${errorText(err)}`);
    });
  };

  const note = (entry: Entry, bodies: readonly WatchNoteBody[], keys: readonly string[] = []): Promise<NoteOutcome> =>
    messages.deliverWatchNote(
      sessionOf(entry),
      watchNote({ id: entry.id, target: entry.target, events: bodies }),
      (fate) => onFate(entry, fate, keys),
    );

  /**
   * What a note that did not land means for its watch. `unreadable` concludes nothing: the next try decides. `gone` is a
   * pane that is not there or a session that died, or a pane that now carries another task: the audit line says which.
   */
  const failed = async (entry: Entry, outcome: NoteOutcome): Promise<void> => {
    if (outcome === "nolistener") {
      await end(entry, "nolistener");
      return;
    }
    if (outcome !== "gone") return;
    let reason: WatchEndReason = "session";
    try {
      const pane = (await deps.panes()).find((each) => each.id === entry.pane);
      if (pane !== undefined && !pane.dead && pane.pid === entry.panePid && pane.taskId !== entry.task) reason = "task";
    } catch {
      // The pane list is only for the audit line's reason.
    }
    await end(entry, reason);
  };

  const placed = (outcome: NoteOutcome): outcome is "delivered" | "sent" =>
    outcome === "delivered" || outcome === "sent";

  /** One of the daemon's own notes (`no_leader`, `fleet_full`, `invalid`, `expired`): true when it was placed. */
  const tell = async (entry: Entry, body: WatchNoteBody): Promise<NoteOutcome> => {
    const outcome = await note(entry, [body]);
    if (placed(outcome)) await say({ op: "event", kind: entry.kind, event: body.kind, outcome });
    return outcome;
  };

  /** Binds a peer to the pane it sits in and the `claude` process above it, as a message does. */
  const bind = async (
    peer: number | null,
  ): Promise<
    | {
        readonly pane: BoundPane;
        readonly paneStart: string;
        readonly session: SessionKey;
      }
    | WatchReplyCode
  > => {
    if (peer === null || !hostNamesPeers()) return "unbound";
    const bound = await bindPeer(peer, await deps.panes(), hostNamesPeers);
    if (bound === null) return "unbound";
    if (bound.session === null) return "nosession";
    const paneStart = startOf(bound.pane.pid);
    if (paneStart === null) return "unbound";
    return { pane: bound.pane, paneStart, session: bound.session.key };
  };

  const sameSession = (entry: Entry, bound: { readonly pane: BoundPane; readonly session: SessionKey }): boolean =>
    entry.session === bound.session &&
    entry.pane === bound.pane.id &&
    entry.panePid === bound.pane.pid &&
    entry.task === bound.pane.taskId;

  const refuse = async (op: "add" | "remove", code: WatchReplyCode): Promise<WatchReply> => {
    await say({ op, outcome: code });
    return { ok: false, code };
  };

  const capsFull = (bound: { readonly session: SessionKey }, replaced: Entry | undefined): boolean => {
    let mine = 0;
    for (const entry of entries.values()) if (entry.session === bound.session && entry !== replaced) mine += 1;
    return mine >= WATCH_SESSION_MAX || entries.size - (replaced === undefined ? 0 : 1) >= WATCH_MACHINE_MAX;
  };

  /** One add at a time per session, so a replacement is made over a finished add and never over one still waiting. */
  const adding = new Map<SessionKey, Promise<void>>();
  const serialised = <T>(session: SessionKey, work: () => Promise<T>): Promise<T> => {
    const run = (adding.get(session) ?? Promise.resolve()).then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    adding.set(session, tail);
    void tail.then(() => {
      if (adding.get(session) === tail) adding.delete(session);
    });
    return run;
  };

  const addBound = async (
    frame: Extract<WatchFrame, { readonly op: "add" }>,
    bound: { readonly pane: BoundPane; readonly paneStart: string; readonly session: SessionKey },
  ): Promise<WatchReply> => {
    if (stopped) return refuse("add", "stopping");
    const { pane, paneStart, session } = bound;
    if (!messages.canListen(pane.id, { pid: pane.pid, task: pane.taskId, session })) return refuse("add", "nolistener");
    const key = watchTargetKey(frame.target);
    const replacing = (): Entry | undefined =>
      [...entries.values()].find((entry) => entry.session === session && watchTargetKey(entry.target) === key);
    if (capsFull(bound, replacing())) return refuse("add", "too_many");

    const verdict = await leader.check();
    if (verdict === "none") return refuse("add", "no_leader");
    if (verdict === "unsupported") return refuse("add", "unsupported");
    // Adds of other sessions can race through the check: the table is read again where it is written.
    if (stopped) return refuse("add", "stopping");
    const replaced = replacing();
    if (capsFull(bound, replaced)) return refuse("add", "too_many");

    const target = frame.target;
    const entry: Entry = {
      id: mintId(),
      kind: target.kind,
      url: urlOf(target),
      ...(frame.head === undefined ? {} : { head: frame.head }),
      target,
      seen: [],
      pending: [],
      pane: pane.id,
      panePid: pane.pid,
      paneStart,
      session,
      task: pane.taskId,
      madeAt: now(),
      expiresAt: now() + ttlMs,
      noLeaderTold: false,
      fleetFullTold: false,
    };
    // The old watch leaves the table for the new one's set, and comes back if the add fails: a refused add costs the
    // session nothing. Its end is audited once the add has succeeded.
    if (replaced !== undefined) entries.delete(replaced.id);
    entries.set(entry.id, entry);
    persist();
    const undo = (): void => {
      if (entries.get(entry.id) !== entry) return;
      entries.delete(entry.id);
      if (replaced !== undefined && !stopped) entries.set(replaced.id, replaced);
      persist();
      scheduleSend();
    };

    // Registered before the send: in process, the leader's answer can arrive before `send` returns.
    const answer = new Promise<"ok" | WatchRefusal>((resolve) => {
      const timeout = setTimeout(() => {
        waiters.delete(entry.id);
        resolve("ok");
      }, addAnswerMs);
      waiters.set(entry.id, {
        n: n + 1,
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
      });
    });
    const sent = await sendSet();
    if (!sent) {
      // Not handed on and no answer to wait for: the session is told rather than left with a watch nothing reads.
      settle(entry.id, "ok");
      undo();
      return refuse("add", "no_leader");
    }
    const result = await answer;
    if (result !== "ok") {
      undo();
      return refuse("add", result);
    }
    if (replaced !== undefined) await say({ op: "end", kind: replaced.kind, reason: "replaced" });
    await say({ op: "add", kind: entry.kind, outcome: "ok" });
    return { ok: true, id: entry.id, kind: entry.kind };
  };

  const add = async (frame: Extract<WatchFrame, { readonly op: "add" }>, peer: number | null): Promise<WatchReply> => {
    if (stopped) return refuse("add", "stopping");
    const bound = await bind(peer);
    if (typeof bound === "string") return refuse("add", bound);
    return serialised(bound.session, () => addBound(frame, bound));
  };

  const remove = async (id: string, peer: number | null): Promise<WatchReply> => {
    if (stopped) return refuse("remove", "stopping");
    const bound = await bind(peer);
    if (typeof bound === "string") return refuse("remove", bound);
    if (stopped) return refuse("remove", "stopping");
    const entry = entries.get(id);
    // The same answer for a wrong id and another session's: an id is no oracle.
    if (entry === undefined || !sameSession(entry, bound)) return refuse("remove", "unknown");
    entries.delete(id);
    settle(id, "ok");
    persist();
    scheduleSend();
    await say({ op: "remove", kind: entry.kind, outcome: "ok" });
    return { ok: true };
  };

  const handle: Watches["handle"] = async (raw, peer) => {
    const frame = parseWatchFrame(raw);
    if (frame === null) return { ok: false, code: "invalid" };
    return frame.op === "add" ? add(frame, peer) : remove(frame.id, peer);
  };

  /** The leader's answer to a set: refusals for the latest one only, since an older one's were superseded by it. */
  const onSetAnswer = async (set: NonNullable<WatchEventRequest["set"]>): Promise<void> => {
    lastAnsweredAt = now();
    answeredGen = Math.max(answeredGen, set.gen.n);
    const waited = new Set<string>();
    for (const [id, waiter] of [...waiters]) {
      if (set.gen.n < waiter.n) continue;
      waited.add(id);
      settle(id, set.refused.find((refusal) => refusal.id === id)?.code ?? "ok");
    }
    if (set.gen.n !== n) return;
    for (const refusal of set.refused) {
      const entry = entries.get(refusal.id);
      if (entry === undefined || waited.has(refusal.id)) continue;
      if (refusal.code === "invalid") {
        // oxlint-disable-next-line no-await-in-loop -- one note per watch, in the leader's order
        const outcome = await tell(entry, { kind: "invalid" });
        // oxlint-disable-next-line no-await-in-loop -- as above
        if (placed(outcome)) await end(entry, "invalid");
        // oxlint-disable-next-line no-await-in-loop -- as above
        else await failed(entry, outcome);
        continue;
      }
      if (entry.fleetFullTold) continue;
      // oxlint-disable-next-line no-await-in-loop -- one note per watch, in the leader's order
      const outcome = await tell(entry, { kind: "fleet_full" });
      if (placed(outcome)) {
        entry.fleetFullTold = true;
        persist();
      } else {
        // oxlint-disable-next-line no-await-in-loop -- as above
        await failed(entry, outcome);
      }
    }
  };

  /** One note for every fresh event of a watch in a frame. True when it was placed (or had been before). */
  const place = async (entry: Entry, events: readonly WatchEvent[]): Promise<boolean> => {
    const known = new Set(entry.seen);
    const fresh: WatchEvent[] = [];
    for (const event of events) {
      if (known.has(event.key)) continue;
      known.add(event.key);
      fresh.push(event);
    }
    // The leader re-sent after a lost answer: it is told the events landed, and the session is not told twice.
    if (fresh.length === 0) return true;
    const keys = fresh.map((each) => each.key);
    const outcome = await note(
      entry,
      fresh.map((each) => each.event),
      keys,
    );
    if (!placed(outcome)) {
      await failed(entry, outcome);
      return false;
    }
    // Before any await: a held note's fate can arrive as soon as this turn yields, and clears what is added here.
    if (outcome === "sent") entry.pending = [...entry.pending, ...keys];
    await Promise.all(fresh.map((each) => say({ op: "event", kind: entry.kind, event: each.event.kind, outcome })));
    if (entries.get(entry.id) !== entry) return true;
    entry.seen = [...entry.seen, ...fresh.map((each) => each.key)].slice(-WATCH_SEEN_MAX);
    persist();
    if (fresh.some((each) => isTerminalKey(each.key))) {
      await end(entry, fresh.some((each) => each.key === "unreadable") ? "unreadable" : "terminal");
    }
    return true;
  };

  const onEvent: Watches["onEvent"] = (request) =>
    inBatch(async () => {
      if (stopped) return { ok: true, delivered: [] };
      if (request.set !== undefined && request.set.gen.boot === deps.boot) await onSetAnswer(request.set);
      const byId = new Map<string, WatchEvent[]>();
      for (const event of request.events) byId.set(event.id, [...(byId.get(event.id) ?? []), event]);
      const delivered: string[] = [];
      let stale = false;
      for (const [id, events] of byId) {
        const entry = entries.get(id);
        if (entry === undefined) {
          // The leader's view is older than ours: restating the set corrects it.
          stale = true;
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- one note per watch, in frame order
        if (await place(entry, events)) delivered.push(id);
      }
      if (stale) scheduleSend();
      return { ok: true, delivered };
    });

  const resend: Watches["resend"] = () => {
    if (!stopped && entries.size > 0) scheduleSend();
  };

  const holds: Watches["holds"] = (pane, taskId) => {
    for (const entry of entries.values()) {
      if (entry.pane !== pane) continue;
      if (taskId === undefined || entry.task === taskId) return true;
    }
    return false;
  };

  const onEnded: Watches["onEnded"] = (pane, taskId) => {
    inBatch(async () => {
      for (const entry of [...entries.values()]) {
        // oxlint-disable-next-line no-await-in-loop -- the audit line orders the writes
        if (entry.pane === pane && entry.task === taskId) await end(entry, "ended");
      }
    }).catch((err: unknown) => {
      warn(`watches: could not end a pane's watches: ${errorText(err)}`);
    });
  };

  /**
   * Ends the watches whose session is gone or moved on. An empty pane list is a failed tmux read as often as no panes
   * (`messages.ts` `sweep` skips it for the same reason), so it ends nothing by pane; the process table is read
   * separately and still ends a watch whose `claude` died.
   */
  const sweep = async (panes: readonly BoundPane[]): Promise<void> => {
    for (const entry of [...entries.values()]) {
      if (panes.length > 0) {
        const pane = panes.find((each) => each.id === entry.pane);
        if (pane === undefined || pane.dead || pane.pid !== entry.panePid) {
          // oxlint-disable-next-line no-await-in-loop -- the audit line orders the writes
          await end(entry, "session");
          continue;
        }
        if (pane.taskId !== entry.task) {
          // oxlint-disable-next-line no-await-in-loop -- as above
          await end(entry, "task");
          continue;
        }
      }
      // oxlint-disable-next-line no-await-in-loop -- as above
      if (!alive(entry.session)) await end(entry, "session");
    }
  };

  const tick = (): Promise<void> => {
    if (stopped || ticking) return Promise.resolve();
    ticking = true;
    return inBatch(async () => {
      await sweep(await deps.panes());
      const t = now();
      for (const entry of [...entries.values()]) {
        if (t >= entry.expiresAt) {
          // Best effort: the watch ends whatever became of the note.
          // oxlint-disable-next-line no-await-in-loop -- one note per watch
          await tell(entry, { kind: "expired" });
          // oxlint-disable-next-line no-await-in-loop -- as above
          await end(entry, "expired");
          continue;
        }
        // "Once" for the watch's life, and answers of any watch count: a leader that answers is a leader.
        const since = Math.max(lastAnsweredAt ?? 0, entry.madeAt, bootAt);
        if (entry.noLeaderTold || t - since < noLeaderMs) continue;
        // oxlint-disable-next-line no-await-in-loop -- one note per watch
        const outcome = await tell(entry, { kind: "no_leader" });
        if (placed(outcome)) {
          entry.noLeaderTold = true;
          persist();
        } else {
          // oxlint-disable-next-line no-await-in-loop -- as above
          await failed(entry, outcome);
        }
      }
      if (entries.size === 0) return;
      leader.hold();
      // A set the leader never answered is restated: a relay-leg set is fire and forget, and the leader drops one while
      // it has no running term yet. `n` still rises, which is what the registry orders by.
      if (answeredGen < n || !lastSendOk || t - lastSentAt >= heartbeatMs) scheduleSend();
    }).finally(() => {
      ticking = false;
    });
  };

  const start: Watches["start"] = async () => {
    if (stopped) return;
    // A previous table's writes in this process land first, so the file read is what it left.
    await (writeChains.get(deps.path) ?? Promise.resolve());
    const saved = await readSavedWatches(deps.path, warn);
    const t = now();
    let dropped = 0;
    for (const each of saved) {
      const target = targetOf(each.kind, each.url);
      const keep =
        target !== null &&
        entries.size < WATCH_MACHINE_MAX &&
        each.expiresAt > t &&
        alive(each.session) &&
        startOf(each.panePid) === each.paneStart;
      if (!keep) {
        dropped += 1;
        // oxlint-disable-next-line no-await-in-loop -- the audit line orders the writes
        await say({ op: "end", kind: each.kind, reason: "restart" });
        continue;
      }
      entries.set(each.id, {
        id: each.id,
        kind: each.kind,
        url: each.url,
        ...(each.head === undefined ? {} : { head: each.head }),
        target,
        seen: each.seen,
        pending: [],
        pane: each.pane,
        panePid: each.panePid,
        paneStart: each.paneStart,
        session: each.session,
        task: each.task,
        madeAt: each.madeAt,
        expiresAt: each.expiresAt,
        noLeaderTold: each.noLeaderTold,
        fleetFullTold: each.fleetFullTold,
      });
    }
    if (dropped > 0) persist();
    const panes = await deps.panes();
    await inBatch(() => sweep(panes));
    if (entries.size > 0) await sendSet();
    if (stopped) return;
    timer = setInterval(() => {
      tick().catch((err: unknown) => {
        warn(`watches: tick failed: ${errorText(err)}`);
      });
    }, tickMs);
    timer.unref();
  };

  const stop: Watches["stop"] = () => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
    for (const id of [...waiters.keys()]) settle(id, "ok");
    // Never an empty set: the restart's reload restates the table, and the leader's TTL covers a daemon that never returns.
    leader.stop();
    return writeChains.get(deps.path) ?? Promise.resolve();
  };

  return { handle, onEvent, holds, onEnded, resend, start, stop };
}
