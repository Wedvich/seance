import { writeTags, type AgentKind, type NeedsInputReason, type SessionState, type SessionTag } from "@seance/shared";
import { readAgentSession, sessionFilePids, type AgentSessionRead } from "./agent-session-file.ts";
import { claudeProcessOf, type ClaudeProcess, type SessionKey } from "./claude-process.ts";
import type { ConversationStore } from "./adapter-subscriptions.ts";
import { ancestorBelow, processStart } from "./peer.ts";

/** What of a bound pane the table reads (`BoundPane`, `session-events.ts`, which this module must not load: it logs). */
export interface PaneRef {
  readonly id: string;
  readonly pid: number;
  readonly dead: boolean;
  readonly taskId: string | null;
}

type TrackedState = Exclude<SessionState, "done">;

/**
 * Session identity and the process and conversation levels of a session's tags (docs/tags.md §1, §3.2, §4): daemon
 * memory, never written, logged, audited or sent anywhere but an app's `sessions` reply (`SessionEntry.tags`).
 *
 * - **Process level**, keyed on the bound `claude` process (`<pid>:<start time>`, `Bound.session`), never the pane:
 *   a hand-started pane's process is the shell, which outlives a restarted `claude`, so a pane key would carry one
 *   `claude`'s facts onto the next. Its last state, `reason`, `agent.remote` and its current conversation claim.
 *   Retained for any pane whose peer resolves to a `claude` process, tasked or not, `ours` or not (§3.3); a peer with no
 *   `claude` on its chain retains nothing. Retention, not an act: nothing here runs anything a frame shaped, and no
 *   reply to the frame depends on it.
 * - **Conversation level**, keyed on `agent.session`: a conversation's `agent.kind` and when it was last live, for a
 *   conversation some process claims with verification.
 *
 * An `agent.session` arrives as a claim (`report`) and is **verified** only from the daemon's own sources (§4.1):
 * the process's own `sessions/<pid>.json` (`agent-session-file.ts`), which decides whenever one exists; else the launch
 * ledger's session id for the pane's task, which never moves and so refutes any other id at once. A file that names
 * another id is re-read for `SETTLE_MS` (Claude Code can write it tens of milliseconds after the event the report rides,
 * S1) and only then refutes. A refuted claim is dropped: not kept, shown or counted. A claim with neither source is
 * unverifiable. A claim bound through the frame's `pane` (a host that names no peer) is never verified and never
 * counted, since no process could be checked. Two live processes claiming one id (verified, unverifiable or still
 * settling) are a conflict, which `atAct` answers `ambiguous`. Every act a verified id names re-reads the source first
 * (`atAct`): a file that moved with no report demotes the claim before the act.
 *
 * Nothing here binds a frame to a pane (peer pid does that, `session-events.ts`), and no tag binds, routes or moves
 * anything; the verified id's one use is to name a conversation to the acts docs/tags.md §3.1 and §8 list.
 *
 * The owner's label on an untasked conversation (`label`, the `session-tag` op) is kept at rest against the id
 * (`adapter-subscriptions.ts`) and joins a process's tags as `owner.label` only while that process's claim of the id is
 * verified and no other live process claims it: an unverified claimer of a labelled id shows its own name.
 */

/** How long a report the file does not name yet is re-read before the claim is refuted: ten times the slowest lag seen (S1). */
export const SETTLE_MS = 500;
const RETRY_MS = 25;
/** Conversations remembered in memory; the least recently live goes first. */
export const CONVERSATIONS_MEMORY_MAX = 256;
/** Conversations and tasks one adapter may hold tags on (docs/tags.md §8.4); past it a new one is `full`. */
export const ADAPTER_TAG_TARGETS_MAX = 512;

/** The `agent` claims a report carries, each already through its parser (`parseAgentClaim`). */
export interface AgentClaim {
  readonly kind?: AgentKind;
  readonly session?: string;
  readonly remote?: string;
}

export interface ConversationReport {
  /** Absent on an `agent`-only report. */
  readonly state?: TrackedState;
  readonly turnEnded?: boolean;
  readonly reason?: NeedsInputReason;
  readonly agent?: AgentClaim;
}

type Verdict = "verified" | "unverifiable" | "settling";

interface Claim {
  readonly session: string;
  readonly at: number;
  verdict: Verdict;
}

interface ProcessEntry {
  readonly key: SessionKey;
  readonly pid: number;
  readonly start: string;
  readonly pane: string;
  /** Bound through the frame's `pane`, on a host that names no peer: never verified, never counted. */
  readonly fallback: boolean;
  taskId: string | null;
  readonly seenAt: number;
  reportedAt: number;
  state: TrackedState | null;
  stateAt: number | null;
  turnEnded: boolean;
  reason: NeedsInputReason | null;
  kind: { readonly value: AgentKind; readonly at: number } | null;
  remote: { readonly value: string; readonly at: number } | null;
  claim: Claim | null;
}

/** One bound process's facts as a reader sees them. */
export interface ProcessView {
  readonly pane: string;
  readonly pid: number;
  /** The process, `<pid>:<start time>` (`Bound.session`). */
  readonly key: SessionKey;
  readonly taskId: string | null;
  readonly state: TrackedState | null;
  /** Beside `idle`: the idle a turn's own end raised. */
  readonly turnEnded: boolean;
  /** When the state began, else when this table first held the process. */
  readonly since: number;
  readonly reason: NeedsInputReason | null;
  readonly remote: string | null;
  readonly kind: AgentKind | null;
  /** The claim's conversation; `verified` only from the daemon's own source, `conflict` while another process claims it too. */
  readonly session: { readonly id: string; readonly verified: boolean; readonly conflict: boolean } | null;
}

/** The owner's `session-tag` act: the label was written, or why not (the op's codes, `SESSION_TAG_ERROR_CODES`). */
export type LabelOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "unsupported" | "ended" | "tasked" | "moved" | "unverified" | "ambiguous" };

export type ActCheck =
  | { readonly ok: true; readonly pane: string; readonly pid: number; readonly key: SessionKey }
  | { readonly ok: false; readonly code: "ended" | "unverified" | "ambiguous" };

export interface ConversationsDeps {
  /** Every config dir the exclave scan knows, the default one included. */
  readonly configDirs: () => readonly string[];
  /** The conversation id the launch ledger noted for a task's launch here (`--session-id`, or the one it resumed). */
  readonly launchSession: (taskId: string) => string | undefined;
  /** Every pane, for the daemon's own read and pruning (`sweep`). */
  readonly panes: () => Promise<readonly PaneRef[]>;
  readonly read?: (pid: number, start: string, configDirs: readonly string[]) => Promise<AgentSessionRead>;
  /** What tells a process from a later one under its pid; `processStart` unless a test stands in. */
  readonly processStart?: (pid: number) => string | null;
  readonly now?: () => number;
  readonly settleMs?: number;
  readonly retryMs?: number;
  /** The owner's labels at rest (`conversations.json`); absent, `label` answers `unsupported` and no tag carries one. */
  readonly store?: Pick<ConversationStore, "label" | "setLabel" | "live">;
}

/** What an adapter's `tag` frame names: a subscribed conversation, or a task launched here (docs/tags.md §8.4). */
export type AdapterTagTarget = { readonly conversation: string } | { readonly task: string };

export interface Conversations {
  /**
   * A bound report: retained against `process` (the peer's innermost `claude`), or against the pane's own process
   * when `fallback` (no peer named), else nothing. Resolves once a new claim's first read is done; a claim the file
   * does not name yet keeps settling after.
   */
  readonly report: (
    pane: PaneRef,
    process: ClaudeProcess | null,
    fallback: boolean,
    report: ConversationReport,
  ) => Promise<void>;
  /** Prunes processes gone or out of their pane, then reads `sessions/<pid>.json` for live panes with no report since start. */
  readonly sweep: () => Promise<void>;
  /** The session tags of the pane's newest reporting process (`SessionEntry.tags`); undefined when none. */
  readonly tagsFor: (pane: string) => Readonly<Record<string, SessionTag>> | undefined;
  readonly process: (pane: string) => ProcessView | null;
  /** The conversation level: `agent.kind` and when it was last live, for a conversation a process claimed verified. */
  readonly conversation: (id: string) => { readonly kind: AgentKind | null; readonly lastLive: number } | null;
  /**
   * Before an act that names `id`: the one live process claiming it, its source re-read now. `unverified` when its claim
   * is not verified or the source no longer agrees (demoted, to settle or be refuted), `ambiguous` when two claim it,
   * `ended` when none is live.
   */
  readonly atAct: (id: string) => Promise<ActCheck>;
  /**
   * The verified conversation of the bound `claude` process `key` (`Bound.session`), re-read now as `atAct` does: null
   * unless that process alone claims it, verified. What subscribes a sender to an adapter (docs/tags.md §8.2).
   */
  readonly verifiedFor: (key: SessionKey) => Promise<string | null>;
  /**
   * One adapter's bare-suffix tag, in memory only, under its own namespace and no other: on a conversation, shown on
   * the process whose verified claim it is, or on a task, shown on that task's session. `""` clears it.
   */
  readonly setAdapterTag: (
    adapter: string,
    target: AdapterTagTarget,
    key: string,
    value: string,
  ) => "ok" | "full" | "invalid";
  /** Clears one adapter's tags: at its handshake (it replays them after the snapshot), or on one conversation's `leave`. */
  readonly clearAdapterTags: (adapter: string, conversation?: string) => void;
  /** The adapter tags on a task's session, for a pane no process of which has reported (`adapter-feed.ts`). */
  readonly taskTags: (taskId: string) => Readonly<Record<string, SessionTag>> | undefined;
  /**
   * `listener` hears that a process's facts may have moved (a report taken, a claim verified or refuted): a nudge with
   * nothing in it, for a reader that re-reads (`adapter-feed.ts`). Returns its unsubscribe.
   */
  readonly listen: (listener: () => void) => () => void;
  /**
   * The owner's label on the untasked conversation `id` in `pane` (`""` clears it), checked now: the pane listing read
   * afresh, its newest live process carrying no task (`tasked`) and claiming `id` (`moved`), then `atAct`, whose one
   * live claimant must be that same process. Throws when the pane listing or the file write fails.
   */
  readonly label: (pane: string, id: string, value: string) => Promise<LabelOutcome>;
  /** Whether the process reported `ended` here lately: it is leaving, so no reader should list it as a session again. */
  readonly ended: (key: SessionKey) => boolean;
  readonly stop: () => void;
}

export function createConversations(deps: ConversationsDeps): Conversations {
  const now = deps.now ?? Date.now;
  const startOf = deps.processStart ?? processStart;
  const read = deps.read ?? readAgentSession;
  const settleMs = deps.settleMs ?? SETTLE_MS;
  const retryMs = deps.retryMs ?? RETRY_MS;
  const processes = new Map<SessionKey, ProcessEntry>();
  const conversations = new Map<string, { kind: AgentKind | null; lastLive: number }>();
  const listeners = new Set<() => void>();
  /** Processes that reported `ended`, newest last; bounded like the table. */
  const endedKeys = new Set<SessionKey>();
  /** Adapter tags: per adapter, per `c:<conversation>` or `t:<task>`, bare suffix to tag. */
  const adapterTags = new Map<string, Map<string, Map<string, { value: string; at: number }>>>();
  let stopped = false;

  const changed = (): void => {
    if (stopped) return;
    for (const listener of listeners) listener();
  };

  const alive = (entry: ProcessEntry): boolean => startOf(entry.pid) === entry.start;

  const touchConversation = (entry: ProcessEntry): void => {
    if (entry.claim?.verdict !== "verified") return;
    const id = entry.claim.session;
    const held = conversations.get(id);
    conversations.delete(id); // re-insert: insertion order is liveness order
    conversations.set(id, { kind: entry.kind?.value ?? held?.kind ?? null, lastLive: now() });
    for (const old of conversations.keys()) {
      if (conversations.size <= CONVERSATIONS_MEMORY_MAX) break;
      conversations.delete(old);
    }
    deps.store?.live(id);
  };

  type Check = "verified" | "refuted" | "mismatch" | "unverifiable";

  /** The daemon's own sources for the entry's claim, read now. */
  const check = async (entry: ProcessEntry, session: string): Promise<Check> => {
    if (entry.fallback) return "unverifiable";
    const file = await read(entry.pid, entry.start, deps.configDirs());
    if (file.kind === "found") return file.sessionId === session ? "verified" : "mismatch";
    // Files exist but more than one matches: the file must agree, and cannot say.
    if (file.kind === "ambiguous") return "unverifiable";
    const launched = entry.taskId === null ? undefined : deps.launchSession(entry.taskId);
    if (launched === undefined) return "unverifiable";
    // No file: the ledger, which never moves, corroborates only the launch's own conversation and refutes any other.
    return launched === session ? "verified" : "refuted";
  };

  const current = (entry: ProcessEntry, claim: Claim): boolean =>
    !stopped && processes.get(entry.key) === entry && entry.claim === claim;

  const apply = (entry: ProcessEntry, claim: Claim, result: Exclude<Check, "mismatch">): void => {
    if (result === "refuted") {
      entry.claim = null;
      return;
    }
    claim.verdict = result;
    touchConversation(entry);
  };

  /** A file naming another id: re-read until it agrees or the window closes, then refute. Never awaited by ingest. */
  const settle = async (entry: ProcessEntry, claim: Claim): Promise<void> => {
    const deadline = now() + settleMs;
    while (now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- re-reads spaced out over the settle window
      await Bun.sleep(retryMs);
      if (!current(entry, claim)) return;
      // oxlint-disable-next-line no-await-in-loop -- as above
      const result = await check(entry, claim.session);
      if (!current(entry, claim)) return;
      if (result !== "mismatch") {
        apply(entry, claim, result);
        changed();
        return;
      }
    }
    if (current(entry, claim)) {
      entry.claim = null;
      changed();
    }
  };

  const verify = async (entry: ProcessEntry, claim: Claim): Promise<void> => {
    const result = await check(entry, claim.session);
    if (!current(entry, claim)) return;
    if (result !== "mismatch") {
      apply(entry, claim, result);
      return;
    }
    claim.verdict = "settling";
    void settle(entry, claim);
  };

  /** Live, counted claims of `id`: never a fallback's, never a refuted one (gone), never a dead process's. */
  const claimants = (id: string): readonly ProcessEntry[] =>
    [...processes.values()].filter((e) => !e.fallback && e.claim?.session === id && alive(e));

  const newest = (pane: string): ProcessEntry | null => {
    let best: ProcessEntry | null = null;
    for (const entry of processes.values()) {
      if (entry.pane !== pane || !alive(entry)) continue;
      if (best === null || entry.reportedAt > best.reportedAt) best = entry;
    }
    return best;
  };

  const viewOf = (entry: ProcessEntry): ProcessView => ({
    pane: entry.pane,
    pid: entry.pid,
    key: entry.key,
    taskId: entry.taskId,
    state: entry.state,
    turnEnded: entry.state === "idle" && entry.turnEnded,
    since: entry.stateAt ?? entry.seenAt,
    reason: entry.reason,
    remote: entry.remote?.value ?? null,
    kind: entry.kind?.value ?? null,
    session:
      entry.claim === null
        ? null
        : {
            id: entry.claim.session,
            verified: entry.claim.verdict === "verified",
            conflict: !entry.fallback && claimants(entry.claim.session).length > 1,
          },
  });

  const entryFor = (pane: PaneRef, pid: number, start: string, fallback: boolean): ProcessEntry => {
    const key = `${pid}:${start}`;
    const held = processes.get(key);
    // A process in another pane than it reported from (tmux reused the id, or a `join-pane`), or now under another
    // task: its process facts were the old place's.
    if (held !== undefined && held.pane === pane.id && held.taskId === pane.taskId && held.fallback === fallback) {
      return held;
    }
    const fresh: ProcessEntry = {
      key,
      pid,
      start,
      pane: pane.id,
      fallback,
      taskId: pane.taskId,
      seenAt: now(),
      reportedAt: now(),
      state: null,
      stateAt: null,
      turnEnded: false,
      reason: null,
      kind: null,
      remote: null,
      claim: null,
    };
    processes.set(key, fresh);
    return fresh;
  };

  const take: Conversations["report"] = async (pane, process, fallback, body) => {
    if (stopped) return;
    let bound: { readonly pid: number; readonly start: string } | null = process;
    if (bound === null) {
      if (!fallback) return; // no `claude` on the peer's chain: nothing is retained
      const start = startOf(pane.pid);
      if (start === null) return;
      bound = { pid: pane.pid, start };
    }
    // A `claude` gone from this pane (restarted under the same shell) leaves nothing behind for its successor.
    for (const [key, entry] of processes) if (entry.pane === pane.id && !alive(entry)) processes.delete(key);
    const entry = entryFor(pane, bound.pid, bound.start, fallback);
    const at = now();
    entry.reportedAt = at;
    if (body.state === "ended") {
      // The process is leaving: its tags go with it, and its conversation was last live now.
      touchConversation(entry);
      processes.delete(entry.key);
      endedKeys.delete(entry.key);
      endedKeys.add(entry.key);
      for (const old of endedKeys) {
        if (endedKeys.size <= CONVERSATIONS_MEMORY_MAX) break;
        endedKeys.delete(old);
      }
      return;
    }
    if (body.state !== undefined) {
      if (entry.state !== body.state) entry.stateAt = at;
      entry.state = body.state;
      entry.turnEnded = body.turnEnded === true;
      entry.reason = body.state === "needs-input" ? (body.reason ?? null) : null;
    }
    const agent = body.agent;
    if (agent?.remote !== undefined && entry.remote?.value !== agent.remote) entry.remote = { value: agent.remote, at };
    if (agent?.kind !== undefined && entry.kind?.value !== agent.kind) entry.kind = { value: agent.kind, at };
    if (agent?.session === undefined) {
      touchConversation(entry);
      return;
    }
    const held = entry.claim;
    // The same id again: one still unverifiable is tried again (a file may have appeared); a settling one runs on.
    if (held?.session === agent.session && held.verdict !== "unverifiable") {
      touchConversation(entry);
      return;
    }
    const claim: Claim = {
      session: agent.session,
      at: held?.session === agent.session ? held.at : at,
      verdict: "settling",
    };
    entry.claim = claim;
    await verify(entry, claim);
  };

  const report: Conversations["report"] = async (pane, process, fallback, body) => {
    try {
      await take(pane, process, fallback, body);
    } finally {
      changed();
    }
  };

  /**
   * The daemon's own read, for a pane with no report since this process began: each config dir's `sessions/<pid>.json`
   * whose pid is a `claude`-named process under exactly one live pane, the one such file for that pane, read and
   * matched as a report's claim is (`readAgentSession`) and linked verified.
   */
  const adopt = async (live: readonly PaneRef[]): Promise<void> => {
    const reported = new Set([...processes.values()].map((e) => e.pane));
    const open = live.filter((pane) => !reported.has(pane.id));
    if (open.length === 0) return;
    const byPid = new Map(open.map((pane) => [pane.pid, pane]));
    const dirs = deps.configDirs();
    const pids = new Set((await Promise.all(dirs.map(sessionFilePids))).flat());
    const found = new Map<string, { pid: number; start: string; pane: PaneRef }[]>();
    for (const pid of pids) {
      const start = startOf(pid);
      if (start === null) continue;
      // oxlint-disable-next-line no-await-in-loop -- a handful of files, one parent walk each
      const under = await ancestorBelow(pid, byPid);
      if (under === null) continue;
      // The file's own process must be the `claude` nearest it on its chain: a wrapper's file is no session's.
      // oxlint-disable-next-line no-await-in-loop -- as above
      if ((await claudeProcessOf([pid]))?.pid !== pid) continue;
      const list = found.get(under.hit.id) ?? [];
      list.push({ pid, start, pane: under.hit });
      found.set(under.hit.id, list);
    }
    for (const [, list] of found) {
      const [only] = list;
      // Two `claude`s under one pane (one started another in a tool): wait for a report to say which one speaks.
      if (only === undefined || list.length !== 1) continue;
      // oxlint-disable-next-line no-await-in-loop -- one read per adopted pane
      const file = await read(only.pid, only.start, dirs);
      if (stopped || file.kind !== "found" || processes.has(`${only.pid}:${only.start}`)) continue;
      const entry = entryFor(only.pane, only.pid, only.start, false);
      const at = now();
      entry.kind = { value: "claude", at };
      if (file.bridge !== undefined) entry.remote = { value: file.bridge, at };
      entry.claim = { session: file.sessionId, at, verdict: "verified" };
      touchConversation(entry);
    }
  };

  const sweep = async (): Promise<void> => {
    if (stopped) return;
    const live = (await deps.panes()).filter((pane) => !pane.dead);
    const panes = new Map(live.map((pane) => [pane.id, pane]));
    for (const [key, entry] of processes) {
      const pane = panes.get(entry.pane);
      if (pane === undefined || pane.taskId !== entry.taskId || !alive(entry)) processes.delete(key);
    }
    await adopt(live);
  };

  const atAct = async (id: string): Promise<ActCheck> => {
    const live = claimants(id);
    const [only] = live;
    if (only === undefined) return { ok: false, code: "ended" };
    if (live.length > 1) return { ok: false, code: "ambiguous" };
    const claim = only.claim;
    if (claim?.verdict !== "verified") return { ok: false, code: "unverified" };
    const result = await check(only, id);
    if (!current(only, claim)) return { ok: false, code: "unverified" };
    if (result === "verified") return { ok: true, pane: only.pane, pid: only.pid, key: only.key };
    // Demoted before the act: a file that moved with no report settles or refutes like a report's.
    if (result === "mismatch") {
      claim.verdict = "settling";
      void settle(only, claim);
    } else apply(only, claim, result);
    return { ok: false, code: "unverified" };
  };

  const adapterTagsOf = (bucket: string): Record<string, SessionTag> => {
    const out: Record<string, SessionTag> = {};
    for (const [adapter, mine] of adapterTags) {
      for (const [suffix, tag] of mine.get(bucket) ?? []) {
        out[`adapter.${adapter}.${suffix}`] = { ...tag, scope: "conversation" };
      }
    }
    return out;
  };

  /**
   * The owner's label for the entry's conversation, only while its claim is verified and no other live process claims
   * it, and never on a tasked process: its name is its task's (docs/tags.md §3.1; the act refuses `tasked` the same).
   */
  const ownerLabel = (entry: ProcessEntry): SessionTag | null => {
    const claim = entry.claim;
    if (
      entry.taskId !== null ||
      claim?.verdict !== "verified" ||
      entry.fallback ||
      claimants(claim.session).length !== 1
    )
      return null;
    const label = deps.store?.label(claim.session);
    return label === undefined ? null : { ...label, scope: "conversation" };
  };

  return {
    report,
    sweep,
    tagsFor: (pane): Readonly<Record<string, SessionTag>> | undefined => {
      const entry = newest(pane);
      if (entry === null) return undefined;
      const tags: Record<string, SessionTag> = {};
      if (entry.taskId !== null) Object.assign(tags, adapterTagsOf(`t:${entry.taskId}`));
      // Only a verified, unconflicted claim carries what is kept against its id (docs/tags.md §3.2).
      if (!entry.fallback && entry.claim?.verdict === "verified" && claimants(entry.claim.session).length === 1) {
        Object.assign(tags, adapterTagsOf(`c:${entry.claim.session}`));
      }
      if (entry.remote !== null) tags["agent.remote"] = { ...entry.remote, scope: "process" };
      if (entry.kind !== null) tags["agent.kind"] = { ...entry.kind, scope: "conversation" };
      if (entry.claim !== null) {
        tags["agent.session"] = {
          value: entry.claim.session,
          at: entry.claim.at,
          scope: "conversation",
          ...(entry.claim.verdict === "verified" ? { verified: true as const } : {}),
        };
      }
      const label = ownerLabel(entry);
      if (label !== null) tags["owner.label"] = label;
      return Object.keys(tags).length === 0 ? undefined : tags;
    },
    process: (pane) => {
      const entry = newest(pane);
      return entry === null ? null : viewOf(entry);
    },
    conversation: (id) => conversations.get(id) ?? null,
    atAct,
    label: async (pane, id, value): Promise<LabelOutcome> => {
      const store = deps.store;
      if (store === undefined || stopped) return { ok: false, code: "unsupported" };
      // Afresh: a pane now under a task, or a process gone from it, must not be labelled on an older read.
      await sweep();
      const entry = newest(pane);
      if (entry === null) return { ok: false, code: "ended" };
      if (entry.taskId !== null) return { ok: false, code: "tasked" };
      if (entry.claim?.session !== id) return { ok: false, code: "moved" };
      const at = await atAct(id);
      if (!at.ok) return at;
      if (at.pane !== pane || at.pid !== entry.pid) return { ok: false, code: "moved" };
      await store.setLabel(id, value);
      changed();
      return { ok: true };
    },
    verifiedFor: async (key): Promise<string | null> => {
      const entry = processes.get(key);
      if (entry === undefined || entry.fallback || entry.claim?.verdict !== "verified") return null;
      const id = entry.claim.session;
      const act = await atAct(id);
      return act.ok && act.key === key ? id : null;
    },
    setAdapterTag: (adapter, target, key, value) => {
      const bucket = "conversation" in target ? `c:${target.conversation}` : `t:${target.task}`;
      const mine = adapterTags.get(adapter) ?? new Map<string, Map<string, { value: string; at: number }>>();
      const held = mine.get(bucket) ?? new Map<string, { value: string; at: number }>();
      const values = Object.fromEntries([...held].map(([suffix, tag]) => [suffix, tag.value]));
      const written = writeTags(`adapter.${adapter}`, { [key]: value }, "conversation", values);
      if (!written.ok) return written.code === "full" ? "full" : "invalid";
      if (!mine.has(bucket) && Object.keys(written.tags).length > 0 && mine.size >= ADAPTER_TAG_TARGETS_MAX) {
        return "full";
      }
      const at = now();
      const next = new Map<string, { value: string; at: number }>();
      for (const [suffix, tagValue] of Object.entries(written.tags)) {
        const before = held.get(suffix);
        next.set(suffix, before?.value === tagValue ? before : { value: tagValue, at });
      }
      if (next.size === 0) mine.delete(bucket);
      else mine.set(bucket, next);
      if (mine.size === 0) adapterTags.delete(adapter);
      else adapterTags.set(adapter, mine);
      changed();
      return "ok";
    },
    clearAdapterTags: (adapter, conversation): void => {
      const mine = adapterTags.get(adapter);
      if (mine === undefined) return;
      if (conversation === undefined) adapterTags.delete(adapter);
      else if (mine.delete(`c:${conversation}`) && mine.size === 0) adapterTags.delete(adapter);
      changed();
    },
    taskTags: (taskId) => {
      const tags = adapterTagsOf(`t:${taskId}`);
      return Object.keys(tags).length === 0 ? undefined : tags;
    },
    listen: (listener): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ended: (key): boolean => endedKeys.has(key),
    stop: (): void => {
      stopped = true;
      processes.clear();
      listeners.clear();
    },
  };
}

/** What an app's `sessions` reply reads: the table swept, then each pane's tags. */
export type SessionTagsSource = Pick<Conversations, "sweep" | "tagsFor">;
