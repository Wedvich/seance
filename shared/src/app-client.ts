import {
  APP_ID,
  CAPABILITIES,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PONG_TIMEOUT_MS,
  CLOSE_BAD_REQUEST,
  CLOSE_UNAUTHORIZED,
  OP_TIMEOUT_MS,
  QUOTA_KEY,
  SCHEDULER_ID,
  STORE_CREATE_MAX_CT_LENGTH,
  STORE_MAX_CT_LENGTH,
  STORE_PREFIXES,
  STORE_LIST_TIMEOUT_MS,
  STORE_TIMEOUT_MS,
  TOKEN_PARAM,
  type AccountRecord,
  type AppStoreRequestFrame,
  type AppFrame,
  type DiscardReply,
  type DiscardRequest,
  type Envelope,
  type ErrorResponse,
  type ExclaveInfo,
  type FleetQuotaEntry,
  type MachineInfo,
  type MachineStatus,
  type MetricsReply,
  type MetricsRequest,
  type Plain,
  type PauseReply,
  type PauseRequest,
  type QueueChanged,
  type QueueReply,
  type QueueRequest,
  type RegistryView,
  type RepoEntry,
  type RequestOp,
  type RescanResponse,
  type ResumeRequest,
  type RoutePreviewReply,
  type SchedulerLeader,
  type SchedulerOp,
  type SourceInfo,
  type StoreChangedFrame,
  type StoreReplyFrame,
  type Task,
  type TaskRecord,
  type TaskRef,
  type TaskReply,
  type TaskRequest,
  type UndeliverableCode,
  type UpdateReport,
} from "./types.ts";
import {
  bindTaskRecord,
  isRecord,
  isStoreKey,
  isTerm,
  parseDiscardReply,
  parseEnvelope,
  parseLeadProof,
  parseMachineInfo,
  parseMachineStatus,
  parseMetricsReply,
  parsePauseReply,
  parseQueueChanged,
  parseQueueReply,
  parseRescanResponse,
  parseRoutePreviewReply,
  parseStoreChanged,
  parseStoreReply,
  parseTaskReply,
} from "./parse.ts";
import { open as openEnvelope, OpMismatchError, openAtRest, ReplayGuard, seal } from "./crypto.ts";
import { sanitizeStatus } from "./status-reader.ts";
import { quote } from "./fmt.ts";
import { openFleetQuotaRecord } from "./fleet-quota.ts";
import { openTaskListing, openTaskRecord, sealTaskRecord, taskKey, type UnreadableRecord } from "./task-record.ts";
import {
  accountRecord,
  accountStoreKey,
  openAccountListing,
  openAccountRecord,
  sealAccountRecord,
  type AccountEntry,
} from "./account-record.ts";

export type RelayStatus = "connecting" | "open" | "retrying" | "rejected";

/**
 * What the scheduler leader's leg hands an envelope `to: SCHEDULER_ID` that
 * answers nothing — a daemon's `session-event` — once opened and replay-checked,
 * with the sealing machine's AAD-bound id.
 */
export type SchedulerEventHandler = (plain: Plain, from: string) => void;

/**
 * Why a request will never get an answer. "refused" is an `undeliverable` whose
 * code this build does not know: what it means is unknown, but that the relay
 * declined delivery is not — the request certainly did not land. "unsupported"
 * never left the app: the machine's register blob doesn't advertise the op.
 * "disconnected" never left either — there was no socket to send it on — where
 * "dropped" was sent and the socket closed before an answer came, so like
 * "timeout" it may have landed.
 */
export type FailureReason =
  | UndeliverableCode
  | "refused"
  | "unsupported"
  | "timeout"
  | "disconnected"
  | "dropped"
  | "no_leader"
  | "leader_unverified";

/**
 * The refusal a scheduler request gets, unsent, while no verified leader is
 * nominated; null when one is. Shared with surfaces that gate without sending.
 */
export function schedulerRefusal(scheduler: SchedulerAvailability): RequestFailure | null {
  if (scheduler.kind === "none") return new RequestFailure("no_leader", "no scheduler is leading");
  if (scheduler.kind === "unverified") {
    return new RequestFailure("leader_unverified", `the scheduler nominee ${quote(scheduler.deviceId)} is unverified`);
  }
  return null;
}

/**
 * What did not answer: a store frame's timeout blames the relay, not a machine.
 * `daemon` is a keyless peer's own daemon (the fleet broker) failing, before
 * or after it sent anything on — never a relay's or a machine's doing.
 */
export type RequestFailureTarget = "machine" | "relay" | "daemon";

export class RequestFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
    readonly target: RequestFailureTarget = "machine",
  ) {
    super(message);
    this.name = "RequestFailure";
  }
}

/**
 * The one line per failure reason every surface shows, shared so `seanced mcp`,
 * the Raycast extension and any later app-role client explain a reason the same
 * way. Callers add their own op/title framing around it.
 */
export function failureReasonText(failure: RequestFailure): string {
  switch (failure.reason) {
    case "offline":
      return "that machine is not connected to the relay";
    case "unknown":
      return "the relay has never seen that machine";
    case "not_leader":
      return "sent as the scheduler under a term that is no longer the leader's";
    case "disconnected":
      return "lost the relay connection before the request went out";
    case "dropped":
      // The daemon's own words: its failure was not the relay connection, and naming that would misdirect the reader.
      return failure.target === "daemon"
        ? `${failure.message} — the request may have landed anyway`
        : "lost the relay connection after the request went out — it may have landed anyway";
    case "no_leader":
      return "no scheduler is leading — no connected daemon can take auto right now";
    case "leader_unverified":
      return "the nominated scheduler's registry entry does not open with this key, so nothing is sent to it";
    // The message already names the code the relay sent, or the op the daemon
    // predates; no fixed line could.
    case "refused":
    case "unsupported":
      return failure.message;
    // The one outcome that is genuinely unknown: the request went out and no
    // answer came back, so it may have landed anyway. Saying "failed" flatly
    // would be a lie — and an invitation to fire a duplicate.
    case "timeout":
      return failure.target === "relay"
        ? `${failure.message} — the relay did not answer; the request may have landed anyway`
        : `${failure.message} — the machine may be asleep, or the request may have landed anyway`;
  }
}

/**
 * A store op that did not happen: the relay's `StoreErrorCode`, raw so a code
 * minted later still settles, or `too_large` / `invalid_request` decided here
 * before anything was sent.
 */
export interface StoreRefusal {
  readonly ok: false;
  readonly code: string;
}

export interface TaskListing {
  readonly ok: true;
  readonly tasks: readonly TaskRecord[];
  readonly unreadable: readonly UnreadableRecord[];
}

export interface TaskLookup {
  readonly ok: true;
  /** Null: the store holds no such task (or only its tombstone). */
  readonly task: TaskRecord | UnreadableRecord | null;
}

/**
 * The task is queued. `landedEarlier`: the put answered `version_conflict` —
 * the id is the app's own, so that is an earlier put of this same create
 * (a retry after a lost reply), never another task.
 */
export interface TaskCreated {
  readonly ok: true;
  readonly landedEarlier: boolean;
}

export interface AccountListing {
  readonly ok: true;
  readonly accounts: readonly AccountEntry[];
  readonly unreadable: readonly UnreadableRecord[];
}

export interface AccountLookup {
  readonly ok: true;
  readonly key: string;
  /** The relay's version of the key, unreadable record included, so a rename can overwrite it; 0 when absent. */
  readonly version: number;
  /** Null: the store holds no record at the key. */
  readonly entry: AccountRecord | UnreadableRecord | null;
}

export interface AccountWritten {
  readonly ok: true;
  readonly key: string;
  /** The record as sealed: version `expect + 1`. */
  readonly record: AccountRecord;
}

/** A registry entry whose `info` decrypted. Entries that don't are counted, not shown. */
export interface Machine {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly repos: readonly RepoEntry[];
  readonly scannedAt: number;
  readonly lastSeen: number;
  readonly connected: boolean;
  /**
   * The daemon's latest snapshot, when the relay holds one and it indexes the
   * register blob this build decrypted (`scan` agrees with that blob's
   * `scannedAt`). Live while `connected`; otherwise the one the relay kept when
   * the socket went, which still counts for its accounts' quota but says
   * nothing about pressure — read pressure through `liveStatus`.
   */
  readonly status?: MachineStatus;
  /** The register blob's `capabilities`, kept by identity; absent from a daemon that predates them. */
  readonly capabilities?: readonly string[];
  /** The register blob's `exclaves`, which `status` indexes; absent from a daemon that predates them. */
  readonly exclaves?: readonly ExclaveInfo[];
  /** The build the daemon is running (read once per process, not the checkout on disk); absent from an old daemon or one outside git. */
  readonly source?: SourceInfo;
  /** Its last self-update attempt that did something other than find itself current. */
  readonly lastUpdate?: UpdateReport;
}

/**
 * Who would answer `auto` (DESIGN.md, Scheduler, "Leadership"). `unverified`
 * is a leader the relay nominated that has not shown it holds this key: its
 * registry entry did not become a `Machine`, or the push carries no
 * `lead-proof` sealed `from` it for the current term. The second is what a
 * token holder using a listed machine's seed looks like, even when it registers
 * that machine's own `info` blob. Treated as no leader: nothing is sent to it.
 */
export type SchedulerAvailability =
  | { readonly kind: "none" }
  | { readonly kind: "unverified"; readonly deviceId: string; readonly term: number }
  | { readonly kind: "ready"; readonly deviceId: string; readonly term: number };

const NO_SCHEDULER: SchedulerAvailability = { kind: "none" };

/** Where one machine stands with the scheduler, for display: only a `ready` nominee is ever shown as leading. */
export type SchedulerRole = "leader" | "unverified";

/** Null for every machine but the relay's nominee. */
export function schedulerRole(deviceId: string, scheduler: SchedulerAvailability): SchedulerRole | null {
  if (scheduler.kind === "none" || scheduler.deviceId !== deviceId) return null;
  return scheduler.kind === "ready" ? "leader" : "unverified";
}

export interface RelayState {
  readonly status: RelayStatus;
  /** Set only for a permanent close; the client stops reconnecting. */
  readonly rejection: "unauthorized" | "bad-request" | null;
  /** Entries whose `info` decrypted; the list the app shows. */
  readonly machines: readonly Machine[];
  /** Total entries the relay holds, including any that did not decrypt. */
  readonly registrySize: number;
  /** Entries whose info blob did not decrypt with this key — a stale PSK somewhere. */
  readonly ignored: number;
  /**
   * Entries whose blob is sealed from a different deviceId than the one it is
   * filed under — a pairing only a bearer-token holder could have made, since a
   * daemon always seals from its own id. Counted apart from `ignored` because no
   * key rotation clears it; the fix is rotating the relay's bearer token.
   */
  readonly unbound: number;
  /**
   * Entries this build cannot read for a reason no key rotation fixes: a blob
   * that opened but was not shaped like a MachineInfo, or a registry entry that
   * did not parse at all — version skew, surfaced apart from `ignored` so the
   * UI never sends anyone to check a correct key.
   */
  readonly skewed: number;
  /**
   * The socket is not open, but too briefly to be worth reporting yet. Set from the
   * moment `open` is left until SETTLE_MS later, and never re-armed by a retry that
   * follows one — once the drop has been shown it stays shown.
   */
  readonly settling: boolean;
  /**
   * True once this socket's registry is authoritative: its first registry frame
   * has landed, or REGISTRY_SETTLE_MS passed after `open` without one. While
   * false under an open socket, an empty `machines` means "no push yet", never
   * "every machine vanished". Reset whenever the socket leaves `open`.
   */
  readonly registrySettled: boolean;
  /** From the last registry push, checked against the entries that opened. */
  readonly scheduler: SchedulerAvailability;
  /**
   * The fleet quota record's entries (DESIGN.md, Scheduler, "Fleet quota
   * record"), for `newestQuotaByAccount` beside the statuses. Read only by a
   * client built with `fleetQuotaRefreshMs`; empty otherwise, and empty while
   * the store holds no record or one this build cannot read.
   */
  readonly fleetQuota: readonly FleetQuotaEntry[];
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 15_000;

/**
 * How long a gap in the socket is allowed to go unreported. A refresh dials from
 * scratch and a resume re-dials unconditionally (the socket dies silently while an
 * installed PWA is suspended), so the app is legitimately not open for a moment on
 * the way in — and rendering that immediately flashed "Relay unreachable" for a
 * frame or two every single time. Anything that recovers inside this window is
 * never shown at all; a real outage lasts far longer than it.
 */
const SETTLE_MS = 1_500;

/**
 * How long after `open` to wait for the registry push before declaring the
 * (possibly empty) machine list authoritative anyway. The relay pushes the
 * registry on every app connect, so the timer is a bound for the abnormal case,
 * not the expected path. Lives here, not in consumers: the client sees every
 * registry frame — including an empty one, which pushes no state change a
 * subscriber could await. Exported for consumers that budget a deadline around
 * a first connect, as the daemon's fleet broker does.
 */
export const REGISTRY_SETTLE_MS = 1_500;

const INITIAL_STATE: RelayState = {
  status: "connecting",
  rejection: null,
  machines: [],
  registrySize: 0,
  ignored: 0,
  unbound: 0,
  skewed: 0,
  settling: true,
  registrySettled: false,
  fleetQuota: [],
  scheduler: NO_SCHEDULER,
};

interface Pending {
  readonly iv: string;
  readonly settle: (result: { ok: true; payload: unknown } | { ok: false; error: RequestFailure }) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface StorePending {
  /** The relay answers a store frame on the socket that sent it, so a reply is this request's only there. */
  readonly socket: WebSocket;
  readonly settle: (result: { ok: true; reply: StoreReplyFrame | null } | { ok: false; error: RequestFailure }) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  /** A fleet quota read: its send and successful answer leave no wire line (failures still do). */
  readonly quiet: boolean;
}

const UNDELIVERABLE_MESSAGES = {
  offline: "that machine is not connected",
  unknown: "unknown machine",
  not_leader: "not the scheduler leader",
} as const satisfies Record<UndeliverableCode, string>;

function isUndeliverableCode(value: unknown): value is UndeliverableCode {
  return typeof value === "string" && Object.hasOwn(UNDELIVERABLE_MESSAGES, value);
}

function parseRegistryView(value: unknown): RegistryView | null {
  if (!isRecord(value)) return null;
  const info = parseEnvelope(value["info"]);
  if (info === null) return null;
  if (typeof value["deviceId"] !== "string" || typeof value["lastSeen"] !== "number") return null;
  if (typeof value["connected"] !== "boolean") return null;
  // Optional and lenient: a malformed status costs the status, never the entry.
  const status = value["status"] === undefined ? null : parseEnvelope(value["status"]);
  return {
    deviceId: value["deviceId"],
    info,
    lastSeen: value["lastSeen"],
    connected: value["connected"],
    ...(status === null ? {} : { status }),
  };
}

/**
 * Lenient like an entry's status: a malformed field costs `auto`, never the
 * push. Absent is a relay that predates leadership; a malformed proof is no
 * proof, which reads as unverified.
 */
function parseLeader(value: unknown): SchedulerLeader | null {
  if (!isRecord(value)) return null;
  const { deviceId, term } = value;
  if (typeof deviceId !== "string" || !isTerm(term)) return null;
  const proof = value["proof"] === undefined ? null : parseEnvelope(value["proof"]);
  return { deviceId, term, ...(proof === null ? {} : { proof }) };
}

/**
 * `RelayToAppFrame`, loosened where forward compatibility needs it: a registry
 * push carries how many entries were skipped instead of failing whole, and
 * `undeliverable.code` stays the raw string so a code minted after this build
 * can still fail its request fast.
 */
type ParsedFrame =
  | {
      readonly t: "registry";
      readonly entries: readonly RegistryView[];
      readonly skipped: number;
      readonly scheduler: SchedulerLeader | null;
    }
  | { readonly t: "msg"; readonly env: Envelope }
  | { readonly t: "status"; readonly deviceId: string; readonly env: Envelope }
  | { readonly t: "undeliverable"; readonly to: string; readonly iv: string; readonly code: string }
  | { readonly t: "forget-refused"; readonly deviceId: string; readonly code: string }
  | StoreReplyFrame
  | StoreChangedFrame
  /** A store reply this build cannot read: it still names its request, so that settles now rather than at its timeout. */
  | { readonly t: "store-unreadable"; readonly re: string };

/**
 * Every field the handlers below touch, checked here — bounds stay the relay's
 * job (`relay/src/wire.ts`), because what this side is defending is the tab.
 * The types are a promise the peer makes, and a peer that breaks it used to
 * wedge the app: a `registry` without `entries` threw mid-assignment and left
 * every later rebuild throwing on the same undefined list, dead until reload.
 * Unhandleable frames are dropped whole, never half-applied.
 */
function parseFrame(text: string): ParsedFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value["t"] === "registry") {
    const raw = value["entries"];
    if (!Array.isArray(raw)) return null;
    const entries: RegistryView[] = [];
    let skipped = 0;
    for (const candidate of raw) {
      const entry = parseRegistryView(candidate);
      // Skipped, not fatal: every push carries the full stored registry, so one
      // persistently unreadable entry would otherwise drop every push for as
      // long as it stays stored — an authoritative "no machines" out of one bad
      // machine. Counted so the skipped entry surfaces as skew, never vanishes.
      if (entry === null) {
        skipped += 1;
        continue;
      }
      entries.push(entry);
    }
    return { t: "registry", entries, skipped, scheduler: parseLeader(value["scheduler"]) };
  }
  if (value["t"] === "msg") {
    const env = parseEnvelope(value["env"]);
    return env === null ? null : { t: "msg", env };
  }
  if (value["t"] === "status") {
    if (typeof value["deviceId"] !== "string") return null;
    const env = parseEnvelope(value["env"]);
    return env === null ? null : { t: "status", deviceId: value["deviceId"], env };
  }
  if (value["t"] === "undeliverable") {
    if (typeof value["to"] !== "string" || typeof value["iv"] !== "string") return null;
    // Carried raw rather than narrowed to the known set: the frame's two facts —
    // this request failed, that machine may be gone — hold whatever the code
    // says, and dropping an unrecognized one left the request riding its full
    // timeout (90s for a spawn) the relay had already answered.
    if (typeof value["code"] !== "string") return null;
    return { t: "undeliverable", to: value["to"], iv: value["iv"], code: value["code"] };
  }
  if (value["t"] === "forget-refused") {
    // Raw code for the same reason as `undeliverable`: a refusal minted after
    // this build still says the entry is still there, which is the whole fact.
    if (typeof value["deviceId"] !== "string" || typeof value["code"] !== "string") return null;
    return { t: "forget-refused", deviceId: value["deviceId"], code: value["code"] };
  }
  // Before the reply branch: a nudge carries no `re`, so that branch would drop it.
  if (value["t"] === "store-changed") return parseStoreChanged(value);
  if (typeof value["t"] === "string" && value["t"].startsWith("store-")) {
    const reply = parseStoreReply(value);
    if (reply !== null) return reply;
    return typeof value["re"] === "string" ? { t: "store-unreadable", re: value["re"] } : null;
  }
  return null;
}

/** No deep walk needed: `repos` comes off the info cache, so it compares by identity. */
function sameMachine(a: Machine, b: Machine): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.name === b.name &&
    a.platform === b.platform &&
    a.repos === b.repos &&
    a.scannedAt === b.scannedAt &&
    a.lastSeen === b.lastSeen &&
    a.connected === b.connected &&
    a.status === b.status &&
    a.capabilities === b.capabilities &&
    a.exclaves === b.exclaves &&
    a.source === b.source &&
    a.lastUpdate === b.lastUpdate
  );
}

/**
 * Cache identity of an `info` blob. The deviceId is part of it because the same
 * blob can arrive under two ids in one push and only one of them can be the id
 * it was sealed from. Length-prefixed rather than separated: both halves are
 * relay-supplied strings, so no separator character is safe on its own.
 */
function infoCacheKey(entry: RegistryView): string {
  return `${entry.info.iv.length}:${entry.info.iv}${entry.deviceId}`;
}

type InfoCacheHit = MachineInfo | "unopenable" | "skewed" | "unbound";

/** The last `lead-proof` opened, by iv: who sealed it and the term it names (null: it did not open or parse). */
interface LeadProofHit {
  readonly iv: string;
  readonly from: string;
  readonly term: number | null;
}

/** The latest `status` envelope per machine, decrypted once per iv; null is one that did not open or parse. */
interface StatusHit {
  readonly iv: string;
  readonly status: MachineStatus | null;
}

/**
 * Transport half of the app: one socket, envelope seal/open, and request
 * correlation. Deliberately knows nothing about the spawn form — that keeps it
 * testable against the real relay with no DOM in sight.
 */
export class RelayClient {
  readonly #url: string;
  readonly #token: string;
  readonly #key: CryptoKey;
  /** Names `account:` keys; absent on an install that never derived it, and on every non-PWA client. */
  readonly #accountKey: CryptoKey | null;
  readonly #listeners = new Set<() => void>();
  readonly #queueListeners = new Set<(change: QueueChanged) => void>();
  readonly #storeListeners = new Set<(key: string, version: number) => void>();
  readonly #pending = new Map<string, Pending>();
  /** Store frames are Layer 1 plaintext the relay answers, correlated on the frame's own `id`, not a sealed one. */
  readonly #storePending = new Map<string, StorePending>();
  /** `undeliverable` can only echo the IV, so responses and failures index differently. */
  readonly #idByIv = new Map<string, string>();
  readonly #guard: ReplayGuard;
  /**
   * Decrypted `info` by deviceId and envelope IV (`infoCacheKey`); blobs are
   * re-sent verbatim on every push. "unopenable" is a blob sealed with a key this
   * app doesn't hold (`ignored`); "skewed" one that opened but was not shaped
   * like a MachineInfo; "unbound" one whose `from` is not the entry's own
   * deviceId. Rebuilt from each push's own keys in `#onRegistry`, so cache ⊆
   * registry holds by construction — every register mints a fresh IV, and an
   * installed PWA left open for weeks would otherwise hold every blob it ever saw.
   */
  #infoCache = new Map<string, InfoCacheHit>();
  /**
   * Entries the last accepted push carried that did not parse. Folded into
   * `registrySize` and `skewed`, so a machine a version ahead reads as skew on
   * screen rather than as a machine that was never installed.
   */
  #skippedEntries = 0;
  /**
   * deviceId -> its latest `status`. Fed by the registry push (one per live
   * socket, and the one kept for each machine whose socket went) and by
   * `status` frames between pushes; rebuilt from each push's own entries, so a
   * register — the relay clears the kept snapshot — drops it here too.
   */
  #statuses = new Map<string, StatusHit>();
  /**
   * deviceId -> the lastSeen we held when delivery failed (an `undeliverable`
   * refusal or a request timeout). `connected` is derived from live sockets and
   * can read true over an abruptly slept machine, so a failed delivery is the
   * better evidence — until the machine registers again, or answers, which any
   * decrypted message from it proves.
   */
  readonly #provenOffline = new Map<string, number>();
  /**
   * deviceId -> the repo list and scan time a `rescan` reply carried. The daemon
   * re-registers only when the set changed, so without this a scan that found
   * nothing new leaves the machine asserting the old `scannedAt` — and the app
   * looks like it did nothing. Spent by the register that overtakes it.
   */
  readonly #scans = new Map<string, RescanResponse>();
  #entries: readonly RegistryView[] = [];
  /** The leader the last push named, before it is checked against the entries that opened. */
  #leader: SchedulerLeader | null = null;
  /** The leader's proof, opened once per iv: every push re-sends it. */
  #leadProof: LeadProofHit | null = null;
  #state: RelayState = INITIAL_STATE;
  #socket: WebSocket | null = null;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #settleTimer: ReturnType<typeof setTimeout> | null = null;
  #registrySettleTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #pongDeadline: ReturnType<typeof setTimeout> | null = null;
  #fleetQuotaTimer: ReturnType<typeof setInterval> | null = null;
  /** The store version `fleetQuota` was read at, so an unchanged record keeps its array (and its subscribers quiet). */
  #fleetQuotaVersion = 0;
  /** The newest store version any answer showed (a record's, readable or not): reads can finish out of order. */
  #fleetQuotaStoreVersion = 0;
  /** When the current socket last delivered anything — pong or frame. Uplink evidence for timeout blame. */
  #lastFrameAt = 0;
  #stopped = false;

  readonly #timeouts: Partial<Record<RequestOp, number>>;
  readonly #storeTimeoutMs: number | undefined;
  readonly #createSocket: (url: string) => WebSocket;
  readonly #settleMs: number;
  readonly #registrySettleMs: number;
  readonly #pingIntervalMs: number;
  readonly #pongTimeoutMs: number;
  readonly #fleetQuotaRefreshMs: number | null;
  readonly #log: (line: string) => void;
  /** Set only on a scheduler leader's leg: requests go `from: SCHEDULER_ID` under this term. */
  readonly #term: number | null;
  /** The leader's leg only: what an envelope `to: SCHEDULER_ID` that answers nothing is handed to. */
  readonly #onEvent: SchedulerEventHandler | null;

  constructor(opts: {
    readonly url: string;
    readonly token: string;
    readonly key: CryptoKey;
    /** HMAC key of `account:` store keys (`deriveAccountKey`). Without it the account methods throw `unsupported`. */
    readonly accountKey?: CryptoKey;
    /** Per-op overrides for OP_TIMEOUT_MS; tests use it to avoid real 10s waits. */
    readonly timeouts?: Partial<Record<RequestOp, number>>;
    /** Override for STORE_TIMEOUT_MS and STORE_LIST_TIMEOUT_MS; tests use it to avoid real waits. */
    readonly storeTimeoutMs?: number;
    /** Socket construction, injected so tests can pass runtime-specific options. */
    readonly createSocket?: (url: string) => WebSocket;
    /** Override for SETTLE_MS; tests use it to avoid a real 1.5s wait. */
    readonly settleMs?: number;
    /** Override for REGISTRY_SETTLE_MS; tests use it to avoid a real 1.5s wait. */
    readonly registrySettleMs?: number;
    /** Overrides for the shared heartbeat cadence; tests use them to avoid real 30s beats. */
    readonly pingIntervalMs?: number;
    readonly pongTimeoutMs?: number;
    /**
     * Read the fleet quota record (`refreshFleetQuota`) on every open and then
     * this often while the socket stays up (`FLEET_QUOTA_INTERVAL_MS` in
     * production). Off by default: a client that folds no quota — MCP, Raycast,
     * one per Claude session — must not spend the store's reads.
     */
    readonly fleetQuotaRefreshMs?: number;
    /** Wire-log sink. Defaults to stdout; a consumer whose stdout is spoken for (the MCP server's JSON-RPC) passes its own. */
    readonly log?: (line: string) => void;
    /**
     * Speak as the scheduler leader (DESIGN.md, Scheduler): every request is
     * sealed `from: SCHEDULER_ID` and its frame carries `term`, which the relay
     * fences on. One client per term — a new term is a new client, so nothing
     * sent under the old one can go out under the new. `onEvent` takes what
     * daemons send the scheduler unasked (`session-event`): opened and
     * replay-checked like a reply, with the sealing machine's id.
     *
     * `guard` is the one replay guard the daemon keeps for scheduler envelopes
     * across terms. The relay decides which term an envelope reaches, so a
     * guard per term would let it hand one app request (a `cancel`, a
     * `resume`) to each new term in turn, inside the replay window.
     */
    readonly scheduler?: {
      readonly term: number;
      readonly onEvent?: SchedulerEventHandler;
      readonly guard?: ReplayGuard;
    };
  }) {
    this.#url = opts.url;
    this.#token = opts.token;
    this.#key = opts.key;
    this.#accountKey = opts.accountKey ?? null;
    this.#timeouts = opts.timeouts ?? {};
    this.#storeTimeoutMs = opts.storeTimeoutMs;
    this.#createSocket = opts.createSocket ?? ((url) => new WebSocket(url));
    this.#settleMs = opts.settleMs ?? SETTLE_MS;
    this.#registrySettleMs = opts.registrySettleMs ?? REGISTRY_SETTLE_MS;
    this.#pingIntervalMs = opts.pingIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.#pongTimeoutMs = opts.pongTimeoutMs ?? HEARTBEAT_PONG_TIMEOUT_MS;
    this.#fleetQuotaRefreshMs = opts.fleetQuotaRefreshMs ?? null;
    this.#log = opts.log ?? ((line) => console.log(line));
    this.#term = opts.scheduler?.term ?? null;
    this.#onEvent = opts.scheduler?.onEvent ?? null;
    this.#guard = opts.scheduler?.guard ?? new ReplayGuard();
  }

  /**
   * Same shape the daemon and relay emit, so one grep spans all three tiers. The
   * `iv` is what the blind relay can name; the `id`/`re` beside it is what only
   * the two encrypting ends can read. Ships in production builds — a phone-only
   * failure is the one that cannot be reproduced at a desk. Never the payload.
   */
  #wireLog(event: string, detail: string): void {
    this.#log(`wire ${event} ${detail}`);
  }

  #timeoutFor(op: RequestOp): number {
    return this.#timeouts[op] ?? OP_TIMEOUT_MS[op];
  }

  getState = (): RelayState => this.#state;

  /**
   * Deletes a machine's registry entry at the relay, for every app rather than
   * just this one. Fire-and-forget: the registry push the relay sends back is
   * the acknowledgement, and a refusal (the machine turned out to be connected)
   * arrives as its own frame and is logged, not modelled — the entry the caller
   * can see is what says whether it worked. Nothing happens with no socket; the
   * relay is the only place the list lives.
   */
  forget(deviceId: string): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      this.#wireLog("dropped", `forget=${quote(deviceId)} reason=disconnected`);
      return;
    }
    const frame: AppFrame = { t: "forget", deviceId };
    socket.send(JSON.stringify(frame));
    this.#wireLog("forget", `to=${quote(deviceId)}`);
  }

  /**
   * Folds a `rescan` reply into the machine it came from. Sealed with the same
   * key as the `machine-info` blob and strictly fresher than it, so it stands in
   * for that blob's repo list until a register carries the scan itself. Takes
   * the raw reply and validates it here rather than trusting the request's type
   * parameter: the fields land on `machine.repos`/`scannedAt` and render every
   * frame, so an unchecked reply from a daemon a version ahead is the register
   * wedge by another door. Null means the reply was unreadable and nothing was
   * applied — callers report it as a failed rescan.
   */
  applyScan(deviceId: string, reply: unknown): RescanResponse | null {
    const parsed = parseRescanResponse(reply);
    if (parsed === null) {
      this.#wireLog("dropped", `from=${quote(deviceId)} reason=rescan-shape`);
      return null;
    }
    this.#scans.set(deviceId, parsed);
    this.#rebuildMachines();
    return parsed;
  }

  /**
   * History from one machine's metrics store. Validated here rather than
   * trusted from a type parameter, as `applyScan` is: the reply lands on a
   * chart, and a daemon a version ahead must cost the chart, not the app. Null
   * means the reply was unreadable; transport failures throw as any request's do.
   * Refused here for a machine that doesn't advertise the op: its daemon drops
   * it unanswered, and the timeout would mark a live machine offline.
   */
  async metrics(deviceId: string, request: MetricsRequest): Promise<MetricsReply | null> {
    const machine = this.#state.machines.find((m) => m.deviceId === deviceId);
    if (machine !== undefined && machine.capabilities?.includes(CAPABILITIES.metrics) !== true) {
      throw new RequestFailure("unsupported", `${quote(machine.name)} runs a daemon that predates the metrics op`);
    }
    const parsed = parseMetricsReply(await this.request<unknown>(deviceId, "metrics", request));
    if (parsed === null) this.#wireLog("dropped", `from=${quote(deviceId)} reason=metrics-shape`);
    return parsed;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#clearSettle();
    this.#clearRegistrySettle();
    this.#teardownHeartbeat();
    // Leaving the settle window set would strand the screen on "connecting…" for as
    // long as the client stays stopped, which is the one thing it is certainly not.
    this.#patch({ settling: false, registrySettled: false });
    this.#socket?.close();
    this.#socket = null;
    this.#failAllPending(new RequestFailure("dropped", "client stopped"));
  }

  /** Reconnects now, skipping any pending backoff. */
  reconnect(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#attempt = 0;
    this.#teardownHeartbeat();
    // Detached before closing, or a close dispatched synchronously still passes the
    // identity guard and runs the backoff path — arming a second retry chain and
    // reporting the deliberate swap as a drop.
    const previous = this.#socket;
    this.#socket = null;
    // Sealed replies fan out to every app socket and may still arrive on the new one; a store
    // reply goes only to its sender, so these would otherwise ride out STORE_TIMEOUT_MS.
    if (previous !== null) {
      this.#failStoreSentOn(previous, new RequestFailure("dropped", "the relay socket was replaced", "relay"));
    }
    previous?.close();
    this.#stopped = false;
    this.#connect();
  }

  /**
   * One op to one machine. `T` is the op's own reply; any op can instead answer
   * with an `ErrorResponse` (a crashed handler, an oversized reply), so callers
   * check before reading fields. Throws `RequestFailure` when nothing answered.
   */
  async request<T>(deviceId: string, op: RequestOp, payload: unknown): Promise<T | ErrorResponse> {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      throw new RequestFailure("disconnected", "no socket to the relay");
    }
    const id = crypto.randomUUID();
    const plain: Plain = { id, ts: Date.now(), op, payload };
    const term = this.#term;
    const env = await seal(this.#key, { to: deviceId, from: term === null ? APP_ID : SCHEDULER_ID }, plain);
    const frame: AppFrame = { t: "msg", env, ...(term === null ? {} : { term }) };
    // Sealing is async, so the socket can die in the gap. Without this the request
    // would sit in #pending until its own timeout — 90s for a spawn.
    if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
      throw new RequestFailure("disconnected", "the relay socket closed while the request was being sealed");
    }

    return new Promise<T | ErrorResponse>((resolve, reject) => {
      const limit = this.#timeoutFor(op);
      const sentAt = Date.now();
      const timer = setTimeout(() => {
        this.#wireLog("timeout", `iv=${quote(env.iv)} id=${quote(id)} op=${quote(op)} after=${limit}ms`);
        this.#discard(id);
        // Blame the machine only when the uplink demonstrably worked while the
        // request was out: same socket, and at least one frame (a pong counts)
        // received since the send. A silently dead app socket looks exactly like
        // a silent machine from here, and marking on that guess paints every
        // polled machine asleep at once.
        if (this.#socket === socket && this.#lastFrameAt >= sentAt && deviceId !== SCHEDULER_ID) {
          this.#markProvenOffline(deviceId);
        }
        reject(new RequestFailure("timeout", `${op} timed out after ${limit}ms`));
      }, limit);

      this.#pending.set(id, {
        iv: env.iv,
        timer,
        settle: (result) => {
          this.#discard(id);
          if (result.ok) resolve(result.payload as T | ErrorResponse);
          else reject(result.error);
        },
      });
      this.#idByIv.set(env.iv, id);
      socket.send(JSON.stringify(frame));
      // A probe: its pong (answered at the edge) is the uplink evidence the blame
      // check above needs, without waiting for the next 30s heartbeat beat. A
      // healthy socket produces it within an RTT; a dead one produces nothing.
      socket.send("ping");
      this.#wireLog("send", `iv=${quote(env.iv)} id=${quote(id)} op=${quote(op)} to=${quote(deviceId)}`);
    });
  }

  /**
   * An envelope that reached the leader on another socket. A daemon answers a
   * scheduler request to `env.from`, and the relay routes `to: SCHEDULER_ID` to
   * the leader's daemon-role socket, never this app-role one — so the daemon
   * leg hands it here, and it is opened, replay-checked and correlated exactly
   * as one that arrived on this socket. Anything else is not this client's.
   */
  async deliver(env: Envelope): Promise<void> {
    if (this.#term === null || env.to !== SCHEDULER_ID) {
      this.#wireLog("dropped", `iv=${quote(env.iv)} to=${quote(env.to)} reason=not-scheduler`);
      return;
    }
    await this.#onMessage(env);
  }

  #discard(id: string): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    this.#idByIv.delete(pending.iv);
  }

  #failAllPending(error: RequestFailure): void {
    for (const [id, pending] of [...this.#pending]) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      this.#idByIv.delete(pending.iv);
      pending.settle({ ok: false, error });
    }
    for (const [id, pending] of [...this.#storePending]) {
      clearTimeout(pending.timer);
      this.#storePending.delete(id);
      pending.settle({ ok: false, error });
    }
  }

  #failStoreSentOn(socket: WebSocket, error: RequestFailure): void {
    for (const [id, pending] of [...this.#storePending]) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      this.#storePending.delete(id);
      pending.settle({ ok: false, error });
    }
  }

  #connect(): void {
    if (this.#stopped) return;
    const url = new URL(this.#url);
    url.searchParams.set(TOKEN_PARAM, this.#token);
    const socket = this.#createSocket(url.href);
    this.#socket = socket;
    // A relay store reset restarts `quota:` versions; answers from the old socket are already dropped.
    this.#fleetQuotaStoreVersion = 0;
    this.#fleetQuotaVersion = -1;
    this.#patchDown(this.#attempt === 0 ? "connecting" : "retrying");

    socket.addEventListener("open", () => {
      this.#attempt = 0;
      this.#clearSettle();
      this.#startHeartbeat(socket);
      this.#patch({ status: "open", rejection: null, settling: false, registrySettled: false });
      this.#armRegistrySettle(socket);
      this.#startFleetQuota(socket);
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      // Stale sockets don't count: their late frames say nothing about this one.
      if (this.#socket === socket) this.#lastFrameAt = Date.now();
      if (event.data === "pong") {
        if (this.#pongDeadline !== null) clearTimeout(this.#pongDeadline);
        this.#pongDeadline = null;
        return;
      }
      void this.#onFrame(event.data, socket);
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#teardownHeartbeat();
      this.#failAllPending(new RequestFailure("dropped", "the relay socket closed"));
      this.#onClose(event.code);
    });
  }

  #onClose(code: number): void {
    // A rejected token is permanent: retrying forever would only hide the reason.
    if (code === CLOSE_UNAUTHORIZED || code === CLOSE_BAD_REQUEST) {
      this.#stopped = true;
      this.#clearSettle();
      this.#clearRegistrySettle();
      this.#patch({
        status: "rejected",
        rejection: code === CLOSE_UNAUTHORIZED ? "unauthorized" : "bad-request",
        settling: false,
        registrySettled: false,
      });
      return;
    }
    if (this.#stopped) return;
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.#attempt);
    this.#attempt += 1;
    this.#patchDown("retrying");
    this.#retryTimer = setTimeout(() => this.#connect(), delay * (0.5 + Math.random() / 2));
  }

  /**
   * Reports a status other than `open`, holding it back for SETTLE_MS if this is the
   * moment the socket went away. A retry inside a window already declared over is
   * shown at once, so backoff never makes the banner blink.
   */
  #patchDown(status: "connecting" | "retrying"): void {
    this.#clearRegistrySettle();
    const settling = this.#state.settling || this.#state.status === "open";
    this.#patch({ status, settling, registrySettled: false });
    if (!settling || this.#settleTimer !== null) return;
    this.#settleTimer = setTimeout(() => {
      this.#settleTimer = null;
      this.#patch({ settling: false });
    }, this.#settleMs);
  }

  #clearSettle(): void {
    if (this.#settleTimer !== null) clearTimeout(this.#settleTimer);
    this.#settleTimer = null;
  }

  #armRegistrySettle(socket: WebSocket): void {
    this.#clearRegistrySettle();
    this.#registrySettleTimer = setTimeout(() => {
      this.#registrySettleTimer = null;
      if (this.#socket !== socket) return;
      this.#patch({ registrySettled: true });
    }, this.#registrySettleMs);
  }

  #clearRegistrySettle(): void {
    if (this.#registrySettleTimer !== null) clearTimeout(this.#registrySettleTimer);
    this.#registrySettleTimer = null;
  }

  /**
   * The relay pushes presence rather than being polled, so a silently dead app
   * socket freezes the machine list with no other symptom. Pings bound that: a
   * missed pong re-dials, and the fresh socket gets a fresh registry.
   */
  #startHeartbeat(socket: WebSocket): void {
    this.#teardownHeartbeat();
    this.#pingTimer = setInterval(() => {
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send("ping");
      this.#pongDeadline ??= setTimeout(() => {
        this.#pongDeadline = null;
        if (this.#socket !== socket) return;
        this.#wireLog("heartbeat", `no pong within ${this.#pongTimeoutMs}ms`);
        // reconnect() rather than close(): closing a dead peer waits out the
        // closing handshake, and pending requests can still complete over the
        // new socket — replies fan out to every open app socket.
        this.reconnect();
      }, this.#pongTimeoutMs);
    }, this.#pingIntervalMs);
  }

  /** Every timer bound to the current socket: the heartbeat's, and the record poll's. */
  #teardownHeartbeat(): void {
    if (this.#pingTimer !== null) clearInterval(this.#pingTimer);
    if (this.#pongDeadline !== null) clearTimeout(this.#pongDeadline);
    if (this.#fleetQuotaTimer !== null) clearInterval(this.#fleetQuotaTimer);
    this.#pingTimer = null;
    this.#pongDeadline = null;
    this.#fleetQuotaTimer = null;
  }

  /** Polled, not pushed: the relay nudges apps only for `account:`, never `quota:`. */
  #startFleetQuota(socket: WebSocket): void {
    const every = this.#fleetQuotaRefreshMs;
    if (every === null) return;
    if (this.#fleetQuotaTimer !== null) clearInterval(this.#fleetQuotaTimer);
    this.#fleetQuotaTimer = setInterval(() => {
      if (this.#socket === socket) void this.refreshFleetQuota();
    }, every);
    void this.refreshFleetQuota();
  }

  /**
   * Re-reads the fleet quota record through its one open path
   * (`openFleetQuotaRecord`). No record, or one this build cannot read, is an
   * empty record; a read that got no answer keeps the last one. Resolves
   * either way, within the store timeout, so a caller may await it before
   * acting on the result (the leader's takeover). Logs one wire line per
   * unreadable answer, never its `env` or `ct`.
   */
  async refreshFleetQuota(): Promise<void> {
    const socket = this.#socket;
    let next: { readonly version: number; readonly accounts: readonly FleetQuotaEntry[] } | null = null;
    let storeVersion = 0;
    try {
      const reply = await this.#store({ t: "store-get", id: crypto.randomUUID(), key: QUOTA_KEY });
      if (reply?.t === "store-record") {
        const stored = reply.record;
        storeVersion = stored?.version ?? 0;
        const opened = stored === null ? null : await openFleetQuotaRecord(this.#key, stored);
        if (typeof opened === "string") this.#wireLog("skipped", `key=${QUOTA_KEY} reason=${opened}`);
        next = opened === null || typeof opened === "string" ? { version: 0, accounts: [] } : opened;
      } else if (reply?.t !== "store-refused") {
        this.#storeKindMismatch(reply);
      }
    } catch (err) {
      if (!(err instanceof RequestFailure)) throw err;
    }
    if (next === null || this.#socket !== socket) return;
    // Versions only grow on `quota:` and nothing deletes: an older answer is a read that lost the race.
    if (storeVersion < this.#fleetQuotaStoreVersion) return;
    this.#fleetQuotaStoreVersion = storeVersion;
    const unchanged =
      next.version === this.#fleetQuotaVersion && (next.version !== 0 || this.#state.fleetQuota.length === 0);
    this.#fleetQuotaVersion = next.version;
    if (!unchanged) this.#patch({ fleetQuota: next.accounts });
  }

  async #onFrame(text: string, socket: WebSocket): Promise<void> {
    const frame = parseFrame(text);
    if (frame === null) {
      // Observable but contentless: the frame is peer-supplied text, so nothing
      // of it is echoed. One line per rejection is the only evidence a relay or
      // daemon that has moved past this build leaves behind.
      this.#wireLog("dropped", "reason=frame");
      return;
    }
    if (frame.t === "registry") {
      // The count is the only trace the skipped entries leave — parseFrame sees
      // peer-supplied text, so nothing of them is echoed.
      if (frame.skipped > 0) this.#wireLog("dropped", `reason=entry-shape count=${frame.skipped}`);
      await this.#onRegistry(frame.entries, frame.skipped, frame.scheduler);
      return;
    }
    if (frame.t === "status") {
      await this.#decryptStatus(frame.deviceId, frame.env);
      this.#rebuildMachines();
      return;
    }
    if (frame.t === "undeliverable") {
      this.#onUndeliverable(frame.to, frame.iv, frame.code);
      return;
    }
    if (frame.t === "forget-refused") {
      // Only reachable as a race: the app offers removal for an offline machine
      // and this says the relay holds a live socket for it. Left to resolve
      // itself — either the machine really is up and the next push shows it, or
      // its socket is dead and the relay's sweep closes it within three beats.
      this.#wireLog("forget-refused", `to=${quote(frame.deviceId)} code=${quote(frame.code)}`);
      return;
    }
    if (frame.t === "store-changed") {
      // Apps' records only; the term's leader acts on `task:` nudges via its daemon socket.
      if (this.#term === null) for (const listener of this.#storeListeners) listener(frame.key, frame.version);
      return;
    }
    if (frame.t === "store-unreadable") {
      this.#wireLog("dropped", `re=${quote(frame.re)} reason=store-shape`);
      this.#settleStore(socket, frame.re, null);
      return;
    }
    if (
      frame.t === "store-listed" ||
      frame.t === "store-record" ||
      frame.t === "store-written" ||
      frame.t === "store-refused"
    ) {
      this.#settleStore(socket, frame.re, frame);
      return;
    }
    await this.#onMessage(frame.env);
  }

  /** Settles a store request only from the socket it was sent on; anything else is stale. */
  #settleStore(socket: WebSocket, re: string, reply: StoreReplyFrame | null): void {
    const pending = this.#storePending.get(re);
    if (pending !== undefined && pending.socket !== socket) {
      this.#wireLog("dropped", `re=${quote(re)} reason=store-stale`);
      return;
    }
    if (!(pending?.quiet === true && reply?.t === "store-record")) {
      this.#wireLog(
        "recv",
        `re=${quote(re)} t=${reply?.t ?? "unreadable"} pending=${pending === undefined ? "no" : "yes"}`,
      );
    }
    pending?.settle({ ok: true, reply });
  }

  #onUndeliverable(to: string, iv: string, code: string): void {
    // The scheduler address names no machine: there is nothing to mark.
    if (code === "offline" && to !== SCHEDULER_ID) this.#markProvenOffline(to);
    const id = this.#idByIv.get(iv);
    // Quoted like every other wire value: `to`, `iv` and `code` are all relay-supplied text.
    this.#wireLog("undeliverable", `iv=${quote(iv)} id=${quote(id ?? "")} to=${quote(to)} code=${quote(code)}`);
    if (id === undefined) return;
    const error = isUndeliverableCode(code)
      ? new RequestFailure(code, UNDELIVERABLE_MESSAGES[code])
      : new RequestFailure("refused", `the relay refused to deliver the request (code ${quote(code)})`);
    this.#pending.get(id)?.settle({ ok: false, error });
  }

  #markProvenOffline(deviceId: string): void {
    const entry = this.#entries.find((candidate) => candidate.deviceId === deviceId);
    this.#provenOffline.set(deviceId, entry?.lastSeen ?? 0);
    this.#rebuildMachines();
  }

  async #onMessage(env: Envelope): Promise<void> {
    let plain: Plain;
    try {
      plain = await openEnvelope(this.#key, env);
    } catch {
      // Not ours to read: a stale PSK somewhere, or traffic for another key.
      this.#wireLog("dropped", `iv=${quote(env.iv)} reason=unopenable`);
      return;
    }
    // Decryption authenticates the sender — `from` is AAD-bound — so this alone
    // proves the machine is alive: fresher evidence than any mark a timeout left.
    // Deliberately ahead of the replay guard. A phone off NTP rejects every reply
    // below as replay; gating the clear on that check would strand every machine
    // it touches offline instead of merely timing out. A replayed frame can at
    // worst fake presence for a moment, and the next failed delivery re-marks it.
    if (this.#provenOffline.delete(env.from)) this.#rebuildMachines();
    try {
      this.#guard.check(env.iv, plain.ts);
    } catch {
      // A phone more than REPLAY_WINDOW_MS off NTP lands here for every reply
      // while the registry still renders every machine online, so every request
      // ends in `wire timeout`. Without this line that has no other symptom.
      this.#wireLog("dropped", `iv=${quote(env.iv)} re=${quote(plain.re ?? "")} reason=replay`);
      return;
    }
    // Not a reply: on the leader's leg, an event a daemon sent the scheduler.
    if (plain.re === undefined) {
      if (env.to === SCHEDULER_ID) this.#onEvent?.(plain, env.from);
      // The scheduler's push to apps, authenticated by the AAD-bound `from`.
      if (this.#term === null && env.to === APP_ID && env.from === SCHEDULER_ID && plain.op === "queue-changed") {
        const change = parseQueueChanged(plain.payload);
        if (change !== null) for (const listener of this.#queueListeners) listener(change);
      }
      return;
    }
    // Replies fan out to every open app socket, so another tab's are expected here.
    // Logged before the lookup: an unmatched `re` is the late reply to a request
    // that already timed out, and "arrived late" vs "never came" is the whole
    // point of the ids. Another tab's reply lands here too, hence `pending`.
    const pending = this.#pending.get(plain.re);
    this.#wireLog(
      "recv",
      `iv=${quote(env.iv)} re=${quote(plain.re)} op=${quote(plain.op)} pending=${pending === undefined ? "no" : "yes"}`,
    );
    pending?.settle({ ok: true, payload: plain.payload });
  }

  async #onRegistry(entries: readonly RegistryView[], skipped: number, leader: SchedulerLeader | null): Promise<void> {
    this.#clearRegistrySettle();
    this.#entries = entries;
    this.#leader = leader;
    this.#skippedEntries = skipped;
    // Replaced, not pruned: seeding a fresh map from this push's own keys makes
    // cache ⊆ registry hold by construction. A slow decrypt from an older push
    // can still land one dead key in the current map; the next push evicts it.
    const next = new Map<string, InfoCacheHit>();
    for (const entry of entries) {
      const key = infoCacheKey(entry);
      const hit = this.#infoCache.get(key);
      if (hit !== undefined) next.set(key, hit);
    }
    this.#infoCache = next;
    const statuses = new Map<string, StatusHit>();
    for (const entry of entries) {
      const hit = this.#statuses.get(entry.deviceId);
      if (entry.status !== undefined && hit?.iv === entry.status.iv) statuses.set(entry.deviceId, hit);
    }
    this.#statuses = statuses;
    await Promise.all([
      this.#decryptLeadProof(leader),
      ...entries.map((entry) => this.#decryptInfo(entry)),
      ...entries.flatMap((entry) =>
        entry.status === undefined ? [] : [this.#decryptStatus(entry.deviceId, entry.status)],
      ),
    ]);
    // Settled in the same patch as the machines it vouches for, so a subscriber
    // never observes an authoritative flag beside a stale list.
    this.#rebuildMachines({ registrySettled: true });
  }

  /**
   * `machine-info` blobs are data at rest, not live messages: `scannedAt` can be
   * days old and the identical envelope arrives on every push, so the replay
   * guard must not see them.
   *
   * The registry pairs a plaintext `deviceId` with a blob the relay cannot read,
   * and only `from` — AAD-bound, so unforgeable without the PSK — says which
   * machine the blob describes. A mismatch is a swapped pairing: the entry would
   * render one machine's name and repos on an id that routes to another. Refused
   * here rather than in #rebuildMachines so nothing downstream can read an
   * unbound blob; the cache is keyed by id and iv together for the same reason,
   * as one blob can appear under two ids in a single push.
   */
  async #decryptInfo(entry: RegistryView): Promise<void> {
    const env = entry.info;
    const cacheKey = infoCacheKey(entry);
    if (this.#infoCache.has(cacheKey)) return;
    if (env.from !== entry.deviceId) {
      this.#wireLog(
        "dropped",
        `iv=${quote(env.iv)} from=${quote(env.from)} deviceId=${quote(entry.deviceId)} reason=info-from-mismatch`,
      );
      this.#infoCache.set(cacheKey, "unbound");
      return;
    }
    try {
      const plain = await openAtRest(this.#key, env, "machine-info");
      const info = parseMachineInfo(plain.payload);
      // Logged where an unopenable blob is not: an entry sealed with a key this
      // app doesn't hold is an expected steady state — it is what `ignored`
      // counts — while a blob that opened and then failed the shape check is
      // skew worth seeing. Named by sender, not by iv: a `machine-info` iv
      // repeats across every push, so it is no message identity here, and the
      // machine is what an operator can act on. Cached either way, so it is one
      // line per blob rather than one per push.
      if (info === null) this.#wireLog("dropped", `from=${quote(env.from)} reason=info-shape`);
      this.#infoCache.set(cacheKey, info ?? "skewed");
    } catch (err) {
      // Opened under our key but sealed as another op: a blob moved into this
      // slot, not one sealed with a key we don't hold — worth a line, once.
      if (err instanceof OpMismatchError) this.#wireLog("dropped", `from=${quote(env.from)} reason=info-op`);
      this.#infoCache.set(cacheKey, "unopenable");
    }
  }

  /**
   * Opened like `machine-info`: data at rest rather than a live message — the
   * registry re-sends the same envelope on every push — so the replay guard
   * must not see it, and only `from` says which machine it describes. Cached
   * by iv per machine, so a push re-sending the envelope costs no decrypt.
   */
  async #decryptStatus(deviceId: string, env: Envelope): Promise<void> {
    if (this.#statuses.get(deviceId)?.iv === env.iv) return;
    if (env.from !== deviceId) {
      this.#wireLog(
        "dropped",
        `iv=${quote(env.iv)} from=${quote(env.from)} deviceId=${quote(deviceId)} reason=status-from-mismatch`,
      );
      this.#statuses.set(deviceId, { iv: env.iv, status: null });
      return;
    }
    let status: MachineStatus | null = null;
    try {
      const plain = await openAtRest(this.#key, env, "status");
      status = parseMachineStatus(plain.payload);
      if (status === null) this.#wireLog("dropped", `from=${quote(env.from)} reason=status-shape`);
    } catch (err) {
      if (err instanceof OpMismatchError) this.#wireLog("dropped", `from=${quote(env.from)} reason=status-op`);
      // Otherwise not ours to read, like an info blob sealed with another key: steady state, not news.
    }
    // A snapshot that opened is the machine speaking — the same proof of life a
    // reply gives, and fresher than any mark a timeout left. A kept one clears
    // the mark too, harmlessly: it only arrives on an entry the relay already
    // lists as not connected.
    if (status !== null) this.#provenOffline.delete(deviceId);
    this.#statuses.set(deviceId, { iv: env.iv, status });
  }

  /**
   * Opened at rest like `status`: the relay re-sends the same envelope on
   * every push. Whether it binds the nominee and the term is asked in
   * `#schedulerAvailability`, against the leader the push named.
   */
  async #decryptLeadProof(leader: SchedulerLeader | null): Promise<void> {
    const env = leader?.proof;
    if (env === undefined || this.#leadProof?.iv === env.iv) return;
    let term: number | null = null;
    try {
      const plain = await openAtRest(this.#key, env, "lead-proof");
      term = parseLeadProof(plain.payload)?.term ?? null;
      if (term === null) this.#wireLog("dropped", `from=${quote(env.from)} reason=lead-proof-shape`);
    } catch (err) {
      if (err instanceof OpMismatchError) this.#wireLog("dropped", `from=${quote(env.from)} reason=lead-proof-op`);
      // Otherwise not sealed under this key: unverified, which the state says.
    }
    this.#leadProof = { iv: env.iv, from: env.from, term };
  }

  #rebuildMachines(extra: Partial<RelayState> = {}): void {
    const previous = this.#state.machines;
    // Keyed, not positional: the relay lists entries in lexicographic deviceId
    // order, so a machine registering for the first time can land anywhere in
    // the list and shift every one after it.
    const priorById = new Map(previous.map((machine) => [machine.deviceId, machine]));
    const machines: Machine[] = [];
    let reused = 0;
    let skewedHere = 0;
    let unboundHere = 0;
    for (const entry of this.#entries) {
      // Only #decryptInfo writes this cache, and it stores no MachineInfo for an
      // entry whose blob is not bound to its deviceId — so an unverified entry
      // can only ever miss here, never render half-built.
      const info = this.#infoCache.get(infoCacheKey(entry));
      if (info === "skewed") {
        skewedHere += 1;
        continue;
      }
      if (info === "unbound") {
        unboundHere += 1;
        continue;
      }
      if (info === undefined || info === "unopenable") continue;
      const scan = this.#scans.get(entry.deviceId);
      // A register that carries the scan (or a later one) makes the override spent.
      if (scan !== undefined && scan.scannedAt <= info.scannedAt) this.#scans.delete(entry.deviceId);
      const scanned = scan !== undefined && scan.scannedAt > info.scannedAt ? scan : info;
      const markedAt = this.#provenOffline.get(entry.deviceId);
      // Cleared by a later register, which is the one event that moves lastSeen up.
      const stillProvenOffline = markedAt !== undefined && entry.lastSeen <= markedAt;
      if (!stillProvenOffline) this.#provenOffline.delete(entry.deviceId);
      const connected = entry.connected && !stillProvenOffline;
      // Against the register blob's own stamp, never `scanned.scannedAt`: a
      // rescan reply moves that without re-registering, and the status indexes
      // the blob's `exclaves`. A mismatch is a status from before a re-register,
      // held back until the next beat replaces it (DESIGN.md, Presence & identity).
      // Sanitized here rather than at decrypt: the rules need the register
      // blob's exclave count, and the two blobs open in parallel. The same
      // object comes back when nothing is dropped, so `sameMachine` still sees
      // no change. Staleness is the consumer's call (`isStatusStale`), never applied here.
      const opened = this.#statuses.get(entry.deviceId)?.status ?? null;
      const status =
        opened === null || opened.scan !== info.scannedAt
          ? null
          : sanitizeStatus(opened, info.exclaves?.length ?? 0, Date.now());
      const built: Machine = {
        deviceId: entry.deviceId,
        name: info.name,
        platform: info.platform,
        repos: scanned.repos,
        scannedAt: scanned.scannedAt,
        lastSeen: entry.lastSeen,
        connected,
        ...(status === null ? {} : { status }),
        ...(info.capabilities !== undefined ? { capabilities: info.capabilities } : {}),
        ...(info.exclaves !== undefined ? { exclaves: info.exclaves } : {}),
        ...(info.source !== undefined && info.source !== null ? { source: info.source } : {}),
        ...(info.lastUpdate !== undefined && info.lastUpdate !== null ? { lastUpdate: info.lastUpdate } : {}),
      };
      const prior = priorById.get(entry.deviceId);
      if (prior !== undefined && sameMachine(prior, built)) {
        // Counted only where it also lands on its old index, so the array below
        // is reused for an unchanged list and never for a merely reordered one.
        if (prior === previous[machines.length]) reused += 1;
        machines.push(prior);
      } else machines.push(built);
    }
    this.#patch({
      scheduler: this.#schedulerAvailability(machines),
      // Every push re-derives the whole list, and the app connect behind every
      // resume re-sends a registry that is usually identical. Handing back the
      // previous array is what lets #patch — and Preact — skip the render.
      machines: reused === machines.length && reused === previous.length ? previous : machines,
      registrySize: this.#entries.length + this.#skippedEntries,
      // Counted off entries the registry actually holds, so neither skew nor a
      // swapped pairing reads as a key mismatch.
      ignored: this.#entries.length - machines.length - skewedHere - unboundHere,
      unbound: unboundHere,
      skewed: skewedHere + this.#skippedEntries,
      ...extra,
    });
  }

  /**
   * The relay's nominee is believed only when its own entry opened into a
   * `Machine` and it sealed a `lead-proof` for this very term: the relay cannot
   * check that the nominee holds the PSK (DESIGN.md, Scheduler, "Leadership").
   * The entry alone is not enough — its `info` blob is the machine's own, which
   * anyone holding the bearer token can read off a push and register again
   * under a stolen seed — but a term minted after the socket was taken is one
   * the machine was never told, so no proof for it exists. Same object back
   * while nothing moved.
   */
  #schedulerAvailability(machines: readonly Machine[]): SchedulerAvailability {
    const leader = this.#leader;
    const prior = this.#state.scheduler;
    if (leader === null) return NO_SCHEDULER;
    const proof = this.#leadProof;
    const proven =
      leader.proof !== undefined &&
      proof?.iv === leader.proof.iv &&
      proof.from === leader.deviceId &&
      proof.term === leader.term;
    const kind = proven && machines.some((m) => m.deviceId === leader.deviceId) ? "ready" : "unverified";
    if (prior.kind === kind && prior.deviceId === leader.deviceId && prior.term === leader.term) return prior;
    return { kind, deviceId: leader.deviceId, term: leader.term };
  }

  /**
   * One request to the scheduler, refused here — never sent — unless a
   * verified leader is nominated. Sealed `to: SCHEDULER_ID`, so the relay
   * routes it to whoever leads by the time it lands; the reply, validated like
   * any that reaches the render path, comes from that daemon. Null is a reply
   * this build cannot read.
   */
  async #schedule<T>(op: SchedulerOp, payload: unknown, parse: (value: unknown) => T | null): Promise<T | null> {
    const refusal = schedulerRefusal(this.#state.scheduler);
    if (refusal !== null) throw refusal;
    let reply: unknown;
    try {
      reply = await this.request<unknown>(SCHEDULER_ID, op, payload);
    } catch (err) {
      // The relay answers `offline` for this address when no leader holds a socket: no machine was asked.
      if (err instanceof RequestFailure && err.reason === "offline") {
        throw new RequestFailure("no_leader", "the relay has no leader to route to");
      }
      throw err;
    }
    const parsed = parse(reply);
    if (parsed === null) this.#wireLog("dropped", `from=${quote(SCHEDULER_ID)} reason=${op}-shape`);
    return parsed;
  }

  /** What routing would decide for `request` now; reserves nothing. */
  routePreview(request: TaskRequest): Promise<RoutePreviewReply | null> {
    return this.#schedule("route-preview", request, parseRoutePreviewReply);
  }

  /** `request.tasks` narrows the reply to those ids; a leader that predates the filter answers its newest, so the caller filters again. */
  queue(request: QueueRequest = {}): Promise<QueueReply | null> {
    return this.#schedule("queue", request, parseQueueReply);
  }

  /** Ends the task's session if it has one, then marks it `cancelled`; the reply is the task as it now stands. */
  cancel(taskId: string): Promise<TaskReply | null> {
    const ref: TaskRef = { taskId };
    return this.#schedule("cancel", ref, parseTaskReply);
  }

  /**
   * Marks the task `done`, ending its session first when one is live and its
   * machine reachable; the reply is the task as it now stands.
   */
  markDone(taskId: string): Promise<TaskReply | null> {
    const ref: TaskRef = { taskId };
    return this.#schedule("mark-done", ref, parseTaskReply);
  }

  pause(request: PauseRequest): Promise<PauseReply | null> {
    return this.#schedule("pause", request, parsePauseReply);
  }

  resume(request: ResumeRequest = {}): Promise<PauseReply | null> {
    return this.#schedule("resume", request, parsePauseReply);
  }

  /**
   * Deletes one record the leader holds as unreadable, at the version its
   * `queue` reply listed it under; never a task it can read.
   */
  discard(request: DiscardRequest): Promise<DiscardReply | null> {
    return this.#schedule("discard", request, parseDiscardReply);
  }

  /**
   * The leader's nudge to every app: something in the queue changed, re-fetch.
   * Fire-and-forget on the term's leg (`from: SCHEDULER_ID`, fenced by the
   * relay), so a demoted leader's is dropped there. False when there is no
   * term or no open socket: nothing was sent.
   */
  async queueChanged(change: QueueChanged): Promise<boolean> {
    const term = this.#term;
    const socket = this.#socket;
    if (term === null || socket === null || socket.readyState !== WebSocket.OPEN) return false;
    const plain: Plain = { id: crypto.randomUUID(), ts: Date.now(), op: "queue-changed", payload: change };
    const env = await seal(this.#key, { to: APP_ID, from: SCHEDULER_ID }, plain);
    // Sealing is async: the socket can have died or been replaced in the gap.
    if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return false;
    const frame: AppFrame = { t: "msg", env, term };
    socket.send(JSON.stringify(frame));
    return true;
  }

  /**
   * Called when the leader says the queue changed. Only an app's client hears
   * it: a leader's own leg ignores the fan-out of its own nudge.
   */
  onQueueChanged(listener: (change: QueueChanged) => void): () => void {
    this.#queueListeners.add(listener);
    return () => this.#queueListeners.delete(listener);
  }

  /**
   * Called when the relay says another client wrote an app-writable record
   * (`account:`: `getAccountRecord` re-reads it). Only an app's client hears it, as with `onQueueChanged`.
   * Relay plaintext, prefix unchecked: a hint to re-read through the store's own
   * open path, never data — trust neither `key` nor `version` past that.
   */
  onStoreChanged(listener: (key: string, version: number) => void): () => void {
    this.#storeListeners.add(listener);
    return () => this.#storeListeners.delete(listener);
  }

  /**
   * One store frame to the relay, which answers it itself: no envelope, so no
   * leader, machine or replay guard is involved. Null is a reply this build
   * cannot read. Throws `RequestFailure` when nothing answered.
   */
  #store(frame: AppStoreRequestFrame): Promise<StoreReplyFrame | null> {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RequestFailure("disconnected", "no socket to the relay", "relay"));
    }
    // A quota read every interval would leave a local record of when other
    // machines' accounts are active; its failures (timeout, skipped) still log.
    const quiet = frame.t === "store-get" && frame.key === QUOTA_KEY;
    return new Promise<StoreReplyFrame | null>((resolve, reject) => {
      const limit = this.#storeTimeoutMs ?? (frame.t === "store-list" ? STORE_LIST_TIMEOUT_MS : STORE_TIMEOUT_MS);
      const timer = setTimeout(() => {
        this.#wireLog("timeout", `id=${quote(frame.id)} t=${frame.t} after=${limit}ms`);
        this.#storePending.delete(frame.id);
        reject(new RequestFailure("timeout", `${frame.t} timed out after ${limit}ms`, "relay"));
      }, limit);
      this.#storePending.set(frame.id, {
        socket,
        timer,
        quiet,
        settle: (result) => {
          clearTimeout(timer);
          this.#storePending.delete(frame.id);
          if (result.ok) resolve(result.reply);
          else reject(result.error);
        },
      });
      try {
        socket.send(JSON.stringify(frame));
      } catch (err) {
        // A frame never sent gets no reply, so its timer would only report a spurious timeout.
        clearTimeout(timer);
        this.#storePending.delete(frame.id);
        reject(new RequestFailure("disconnected", `${frame.t} could not be sent: ${String(err)}`, "relay"));
        return;
      }
      if (quiet) return;
      this.#wireLog("send", `id=${quote(frame.id)} t=${frame.t}`);
    });
  }

  /** A reply of the wrong kind for its request reads as no reply this build understands. */
  #storeKindMismatch(reply: StoreReplyFrame | null): null {
    if (reply !== null) this.#wireLog("dropped", `re=${quote(reply.re)} t=${reply.t} reason=store-kind`);
    return null;
  }

  /**
   * Every `task:` record, each opened at rest and kept only through
   * `bindTaskRecord`; the rest are reported with their reasons. Unpaged: a
   * page (`next`) is unreadable here, never a short queue.
   */
  async listTasks(): Promise<TaskListing | StoreRefusal | null> {
    const reply = await this.#store({ t: "store-list", id: crypto.randomUUID(), prefix: STORE_PREFIXES.task.prefix });
    if (reply?.t === "store-refused") return { ok: false, code: reply.code };
    if (reply?.t !== "store-listed") return this.#storeKindMismatch(reply);
    const { tasks, unreadable } = await openTaskListing(this.#key, reply.records, Date.now());
    if (unreadable.length > 0) this.#wireLog("skipped", `prefix=task count=${unreadable.length}`);
    return { ok: true, tasks, unreadable };
  }

  async getTask(taskId: string): Promise<TaskLookup | StoreRefusal | null> {
    const key = taskKey(taskId);
    const reply = await this.#store({ t: "store-get", id: crypto.randomUUID(), key });
    if (reply?.t === "store-refused") return { ok: false, code: reply.code };
    if (reply?.t !== "store-record") return this.#storeKindMismatch(reply);
    if (reply.record === null) return { ok: true, task: null };
    // Binding checks the record against the key it came with, so that key must be the one asked for.
    if (reply.record.key !== key) {
      this.#wireLog("dropped", `re=${quote(reply.re)} t=${reply.t} reason=store-key`);
      return null;
    }
    const read = await openTaskRecord(this.#key, reply.record, Date.now());
    return { ok: true, task: typeof read === "string" ? { key, version: reply.record.version, reason: read } : read };
  }

  /**
   * Enqueues `task` (its id minted by the caller) as a create: version 1 at
   * `expect: 0`, sealed from APP_ID — also on a leader's leg, whose writes go
   * through its daemon socket instead. A record every reader would skip, or
   * one past the create cap, is refused here and never sent — a batch index past
   * `TASK_SPEC_LIMITS.batchIndex` among them. A retry after a
   * lost reply re-sends the same task, and its `version_conflict` is queued.
   *
   * Precondition: `task.id` is freshly minted by the app, never reused and
   * never an id whose key may hold a tombstone — `version_conflict` is read as
   * "queued", which for any other key would report a task that never runs.
   */
  async createTask(task: Task): Promise<TaskCreated | StoreRefusal | null> {
    const key = taskKey(task.id);
    // Sealed is the parsed copy, which holds only known fields: what is sealed is what was checked.
    const record = bindTaskRecord({ version: 1, task }, { key, version: 1 }, Date.now());
    if (typeof record === "string") return { ok: false, code: "invalid_request" };
    const env = await sealTaskRecord(this.#key, APP_ID, record);
    if (env.ct.length > STORE_CREATE_MAX_CT_LENGTH) return { ok: false, code: "too_large" };
    const reply = await this.#store({ t: "store-put", id: crypto.randomUUID(), key, expect: 0, env });
    if (reply?.t === "store-written") return { ok: true, landedEarlier: false };
    if (reply?.t !== "store-refused") return this.#storeKindMismatch(reply);
    return reply.code === "version_conflict" ? { ok: true, landedEarlier: true } : { ok: false, code: reply.code };
  }

  /** Whether this client can read and write account records. */
  get accountsNamed(): boolean {
    return this.#accountKey !== null;
  }

  #needAccountKey(): CryptoKey {
    if (this.#accountKey !== null) return this.#accountKey;
    throw new RequestFailure(
      "unsupported",
      "this install has no account key — re-enter the pre-shared key in Settings to name accounts",
      "relay",
    );
  }

  /** The `account:<hmac>` key an account's record lives at. */
  async accountStoreKey(accountId: string): Promise<string> {
    return accountStoreKey(this.#needAccountKey(), accountId);
  }

  /** Every `account:` record, opened and kept as `openAccountRecord` says; the rest are reported with their reasons. */
  async listAccounts(): Promise<AccountListing | StoreRefusal | null> {
    const accountKey = this.#needAccountKey();
    const reply = await this.#store({
      t: "store-list",
      id: crypto.randomUUID(),
      prefix: STORE_PREFIXES.account.prefix,
    });
    if (reply?.t === "store-refused") return { ok: false, code: reply.code };
    if (reply?.t !== "store-listed") return this.#storeKindMismatch(reply);
    const { accounts, unreadable } = await openAccountListing(this.#key, accountKey, reply.records);
    if (unreadable.length > 0) this.#wireLog("skipped", `prefix=account count=${unreadable.length}`);
    return { ok: true, accounts, unreadable };
  }

  /**
   * One account record by its store key. The key may come from a `store-changed`
   * nudge, which is relay plaintext, so anything but an `account:` key is
   * refused here and never sent.
   */
  async getAccountRecord(key: string): Promise<AccountLookup | StoreRefusal | null> {
    const accountKey = this.#needAccountKey();
    if (!key.startsWith(STORE_PREFIXES.account.prefix) || !isStoreKey(key)) return null;
    const reply = await this.#store({ t: "store-get", id: crypto.randomUUID(), key });
    if (reply?.t === "store-refused") return { ok: false, code: reply.code };
    if (reply?.t !== "store-record") return this.#storeKindMismatch(reply);
    if (reply.record === null) return { ok: true, key, version: 0, entry: null };
    // The binding compares the record's account to the key it came with, so that key must be the one asked for.
    if (reply.record.key !== key) {
      this.#wireLog("dropped", `re=${quote(reply.re)} t=${reply.t} reason=store-key`);
      return null;
    }
    const read = await openAccountRecord(this.#key, accountKey, reply.record);
    const entry = typeof read === "string" ? { key, version: reply.record.version, reason: read } : read;
    return { ok: true, key, version: reply.record.version, entry };
  }

  /**
   * Sets an account's alias (null or blank clears it) as a compare-and-set at
   * `expect`, the version the caller last read (0: none). A lost race answers
   * `version_conflict`, never success: the caller re-reads and decides, since a
   * blind overwrite would drop the other client's name.
   */
  async putAccountAlias(
    accountId: string,
    alias: string | null,
    expect: number,
  ): Promise<AccountWritten | StoreRefusal | null> {
    const accountKey = this.#needAccountKey();
    const record = accountRecord(accountId, alias, expect + 1);
    if (record === null) return { ok: false, code: "invalid_request" };
    const key = await accountStoreKey(accountKey, accountId);
    const env = await sealAccountRecord(this.#key, APP_ID, record);
    if (env.ct.length > (expect === 0 ? STORE_CREATE_MAX_CT_LENGTH : STORE_MAX_CT_LENGTH)) {
      return { ok: false, code: "too_large" };
    }
    const reply = await this.#store({ t: "store-put", id: crypto.randomUUID(), key, expect, env });
    if (reply?.t === "store-refused") return { ok: false, code: reply.code };
    if (reply?.t !== "store-written") return this.#storeKindMismatch(reply);
    if (reply.version !== expect + 1) {
      this.#wireLog("dropped", `re=${quote(reply.re)} t=${reply.t} reason=store-version`);
      return null;
    }
    return { ok: true, key, record };
  }

  /** Same object back when nothing moved: `useState` bails out on reference equality. */
  #patch(next: Partial<RelayState>): void {
    const keys = Object.keys(next) as readonly (keyof RelayState)[];
    if (keys.every((key) => Object.is(this.#state[key], next[key]))) return;
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener();
  }
}
