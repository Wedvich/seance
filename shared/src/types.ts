export const PROTOCOL_VERSION = 1;

/** Routing id the app uses on the wire; daemons address responses to it. */
export const APP_ID = "app";

/**
 * Broadcast address: the relay fans an envelope addressed here to every
 * registered daemon socket except the sender. One seal reaches all machines —
 * the AAD binds `to`, so a group needs one shared address. Fire-and-forget:
 * no `undeliverable`, nothing correlates a broadcast; receivers allowlist
 * which ops may arrive group-addressed.
 */
export const MACHINES_ID = "machines";

/**
 * The scheduler's wire address. The relay routes an envelope addressed here to
 * whichever daemon it nominated leader (DESIGN.md, Scheduler, "Leadership"), and
 * the leader's app-role leg sends as it, fenced by its term. Reserved like
 * `APP_ID` and `MACHINES_ID`: no daemon may register under it.
 */
export const SCHEDULER_ID = "scheduler";

/**
 * A routing id's bounds: a `deviceId`, a task id, a store key's id part, a
 * store frame's `id`. Each reaches storage keys and logs, so it stays short and
 * boring. The one copy — the relay's frame bounds, `TASK_ID_PATTERN` and
 * `STORE_KEY_PATTERN` derive from it, so a task id is always a valid key part.
 */
export const ROUTING_ID_MAX_LENGTH = 64;

/** A routing id's characters, as a regex character-class body. */
export const ROUTING_ID_CHARS = "A-Za-z0-9._-";

export const ROUTING_ID_PATTERN = new RegExp(`^[${ROUTING_ID_CHARS}]{1,${ROUTING_ID_MAX_LENGTH}}$`, "u");

/**
 * Plaintext `register.roles` values — the one capability the relay itself
 * reads. `scheduler`: the daemon may be nominated leader. Only a v2 register
 * (signature over the roles) carries them; the relay acts on no other value,
 * and accepts an unknown one only so the signature covering it still verifies.
 */
export const DAEMON_ROLES = { scheduler: "scheduler" } as const;

export type DaemonRole = (typeof DAEMON_ROLES)[keyof typeof DAEMON_ROLES];

/** `register.roles` entries at most — a bound for the relay, far above the one role there is. */
export const MAX_REGISTER_ROLES = 8;

/** WS upgrade paths. Role is fixed by path, so the app sends no register frame. */
export const DAEMON_PATH = "/daemon";
export const APP_PATH = "/app";
/** Browsers cannot set WS headers, so the app passes the bearer token as `?t=`. */
export const TOKEN_PARAM = "t";

/**
 * App-side close codes (4000–4999 is the app-defined range). A browser cannot
 * read the HTTP status of a failed WS handshake, so `/app` accepts the upgrade
 * and then closes with one of these; both are permanent, so the app must stop
 * reconnecting rather than back off. Daemons read the real 401 from `fetch`,
 * so `/daemon` keeps refusing pre-upgrade.
 */
export const CLOSE_BAD_REQUEST = 4400;
export const CLOSE_UNAUTHORIZED = 4401;

export const DEFAULT_MODEL = "opus";
export const DEFAULT_EFFORT = "medium";

/**
 * Encrypted envelope — all the relay sees besides routing. The 12-byte GCM
 * IV doubles as the replay nonce; `v|to|from` are bound as AAD so the relay
 * cannot re-address a captured blob.
 */
export interface Envelope {
  readonly v: number;
  readonly to: string;
  readonly from: string;
  /** base64, 12 bytes */
  readonly iv: string;
  /** base64, ciphertext + 16-byte GCM tag */
  readonly ct: string;
}

/**
 * Layer 1: plaintext daemon→relay frames. Heartbeats are the literal strings
 * "ping"/"pong" (not JSON) so DO auto-response can answer without waking.
 */
export type DaemonFrame =
  | {
      readonly t: "register";
      readonly deviceId: string;
      readonly info: Envelope;
      /** base64 raw ML-DSA-65 public key; `deviceId` is its SHA-256 (`shared/src/identity.ts`). */
      readonly key: string;
      /** Signing time, ms — the relay refuses one outside `REGISTER_FRESHNESS_MS`. */
      readonly ts: number;
      /**
       * base64 signature made with `key`: over `deviceId`, `ts` and `roles` when
       * `roles` is present (v2), over `deviceId` and `ts` alone when it is not
       * (v1, which registers a daemon with no roles).
       */
      readonly sig: string;
      /**
       * What the relay may nominate this daemon for (`DaemonRole`). Plaintext
       * because the relay must read it, signed because it acts on it. Raw
       * strings on the wire: a role minted after the relay was built still has
       * to verify, and is then ignored.
       */
      readonly roles?: readonly string[];
    }
  | { readonly t: "msg"; readonly env: Envelope }
  /**
   * The daemon's current telemetry snapshot (`op: "status"`, sealed to APP_ID
   * like the register blob), every STATUS_INTERVAL_MS. The relay keeps only the
   * latest, on the socket's attachment, and when the socket goes keeps that one
   * in the registry entry until the next register — quota for the machine's
   * accounts, never its pressure. DESIGN.md, Presence & identity.
   */
  | { readonly t: "status"; readonly env: Envelope }
  /**
   * The nominee's answer to `lead`: `env` is a `LeadProof` for `term` (op
   * `lead-proof`, sealed to APP_ID). The relay cannot read it; it keeps the
   * first one the leader's own socket sends under the current term and carries
   * it in the registry push (`SchedulerLeader.proof`), where apps check it.
   * DESIGN.md, Scheduler, "Leadership".
   */
  | { readonly t: "lead-proof"; readonly term: number; readonly env: Envelope }
  /** The leader's store client (M3); writes to a term-fenced prefix carry its term. */
  | StoreRequestFrame;

/**
 * Layer 1: relay→daemon frames. `lead` tells a daemon the relay nominated it
 * scheduler leader under `term`; `follow` that it no longer is. Plaintext relay
 * assertions: the relay is the only party that decides leadership, and what a
 * leader does with the role is sealed and term-fenced (DESIGN.md, Scheduler,
 * "Leadership"). The store frames are M3's: no relay sends them yet.
 */
export type RelayToDaemonFrame =
  | { readonly t: "msg"; readonly env: Envelope }
  | { readonly t: "lead"; readonly term: number }
  | { readonly t: "follow" }
  | StoreReplyFrame
  | StoreChangedFrame;

/**
 * Layer 1: app→relay frames. `forget` deletes one registry entry — the only
 * frame the app sends that the relay acts on itself rather than routes. It is
 * not an `OpName`: ops are sealed end to end and answered by a daemon, and the
 * machine being forgotten is by definition not there to answer.
 */
export type AppFrame =
  | {
      readonly t: "msg";
      readonly env: Envelope;
      /**
       * The scheduler term an envelope sent `from: SCHEDULER_ID` claims — required
       * there, ignored for `from: APP_ID`. A fence against a stale leader, not
       * authentication: every registry push carries the current term.
       */
      readonly term?: number;
    }
  | { readonly t: "forget"; readonly deviceId: string }
  /** Store ops (M3). Never a `term`: on this leg it would authorize nothing (`StorePutFrame.term`). */
  | AppStoreRequestFrame;

/**
 * Why the relay did not hand an envelope on. `offline`/`unknown`: the target
 * daemon has no open socket, and the registry does or does not hold its entry.
 * `to: SCHEDULER_ID` is only ever `offline` — no leader holds a socket now, but
 * the address is real and one will be back. `not_leader`: the envelope was sent
 * as the scheduler under a term that is not the current leader's.
 */
export type UndeliverableCode = "offline" | "unknown" | "not_leader";

/**
 * The nominated scheduler leader, as the registry push carries it — null when
 * no connected daemon is both capable (signed `roles`) and on the relay's
 * `SCHEDULER_LEADERS` allowlist; unset, that list nominates nobody. `term` is
 * the relay's monotonic counter, bumped on every change of leader or of the
 * leader's socket.
 */
export interface SchedulerLeader {
  readonly deviceId: string;
  readonly term: number;
  /**
   * The leader's `lead-proof` for this term, once its socket has sent one.
   * What an app believes the nominee by: a token holder with a listed
   * machine's seed can register that machine's own `info` blob, but cannot
   * seal a proof for a term the relay minted after taking the socket from it.
   */
  readonly proof?: Envelope;
}

/**
 * The payload of a `lead-proof` envelope: the term the relay told this daemon
 * it leads. Sealed `from` the daemon's own id, so it binds machine and term.
 */
export interface LeadProof {
  readonly term: number;
}

/**
 * Why the relay would not delete an entry. Only one reason, and it is one a
 * blind relay can check without the PSK: the machine is connected, so the
 * entry is live state rather than a leftover. An id the registry doesn't hold
 * is no refusal — deleting it is what the caller asked for.
 */
export const FORGET_REFUSAL_CODES = ["connected"] as const;

export type ForgetRefusalCode = (typeof FORGET_REFUSAL_CODES)[number];

/**
 * Layer 1: relay→app frames. `registry` arrives on connect and on every
 * change. `undeliverable` correlates by `iv` — the request `id` lives inside
 * the ciphertext, so a blind relay has nothing else to echo. App-bound
 * envelopes go to every open app socket; clients drop unmatched `re`. A
 * `forget` that lands needs no ack: the registry push it causes is the ack,
 * and it reaches every open app rather than just the one that asked.
 */
export type RelayToAppFrame =
  | {
      readonly t: "registry";
      readonly entries: readonly RegistryView[];
      /** Who `to: SCHEDULER_ID` reaches now. Absent from relays that predate leadership: read it as null. */
      readonly scheduler?: SchedulerLeader | null;
    }
  | { readonly t: "msg"; readonly env: Envelope }
  /** A daemon's latest `status`, forwarded as it arrives — a small frame, not a registry re-push. */
  | { readonly t: "status"; readonly deviceId: string; readonly env: Envelope }
  | {
      readonly t: "undeliverable";
      readonly to: string;
      readonly iv: string;
      readonly code: UndeliverableCode;
    }
  | {
      readonly t: "forget-refused";
      readonly deviceId: string;
      readonly code: ForgetRefusalCode;
    }
  | StoreReplyFrame;

/**
 * Machine registry as persisted by the Durable Object. An entry is overwritten
 * by a later register and removed only by an app's `forget`; nothing else
 * expires it.
 */
export interface RegistryEntry {
  readonly deviceId: string;
  /** Encrypted MachineInfo, AAD-bound to APP_ID. */
  readonly info: Envelope;
  /** Written on register and on close — the only liveness events the DO observes. */
  readonly lastSeen: number;
  /**
   * The last `status` its socket sent, kept by the close or sweep that wrote
   * `lastSeen`, and cleared by the next register: it indexes the blob that
   * register replaces. Sealed `from` this `deviceId` by the verified socket.
   */
  readonly status?: Envelope;
}

/**
 * A registry entry as sent to the app. `connected` is derived from open
 * sockets at read time and never persisted: heartbeats use DO auto-response
 * and never wake the object, so a stored flag would survive as a stale `true`
 * past an eviction.
 */
export type RegistryView = RegistryEntry & {
  readonly connected: boolean;
  /**
   * The live socket's latest `status` while `connected`, else the one the
   * entry kept. A kept one describes the machine's accounts, not its pressure.
   */
  readonly status?: Envelope;
};

/**
 * The relay's store (scheduler M3; docs/scheduler.md, "Store ops"): sealed
 * records at keys, each `{ version, env }`, `version` 1 on create and +1 per
 * put, ruled by `relay/src/store.ts` (item 1); the app sends
 * `store-list`, `store-get` and `store-put` (`RelayClient`, item 2), and nothing
 * sends `store-delete` yet. Plaintext Layer 1 frames, not ops — the
 * relay itself answers them — so a request carries its own `id` (a routing id,
 * `ROUTING_ID_PATTERN`; a UUID fits) and the reply echoes it as `re`. Who may write
 * is a rule per key prefix (`STORE_PREFIXES`); reads are anyone's, since the
 * bearer token already lists ciphertext. Records live in DO storage under a
 * namespace of their own, so no key can alias `device:<id>` or `scheduler:term`.
 *
 * A delete under a prefix apps may create into leaves a tombstone: the key and
 * its last version, no `env`, kept `STORE_TOMBSTONE_MS`. While it stands, a put
 * there is `version_conflict`, a get reads `null` and a list leaves it out; it
 * counts toward neither `MAX_TASKS` nor `MAX_RECORDS`. Without it, a token
 * holder could re-create a deleted task from its own authentic version-1 blob
 * and run it again, which version binding cannot see. Past its expiry the
 * reader's age rule (`TaskRecord`) takes over.
 *
 * Reserved, not accepted yet: `account:<hmac>` (M4's account records, app-
 * writable by `expect`), which adds a prefix here when it lands.
 */
export const STORE_PREFIXES = {
  /**
   * `task:<id>` → a sealed `TaskRecord`. Any app (or the leader) creates at
   * `expect: 0`, so enqueue needs no leader; every overwrite and delete is the
   * leader's.
   */
  task: { prefix: "task:", appCreate: true, appWrite: false, termFenced: true },
  /**
   * `queue:pause` → the sealed `PauseRecord`: what the queue holds, kept here
   * so a pause outlives the leader that took it (leader changes are routine).
   * The leader's alone, created included.
   */
  queue: { prefix: "queue:", appCreate: false, appWrite: false, termFenced: true },
} as const;

export type StorePrefix = (typeof STORE_PREFIXES)[keyof typeof STORE_PREFIXES]["prefix"];

/** A known prefix, then a routing id — so a key stays a short, boring storage key, and a task id is one as it stands. */
export const STORE_KEY_PATTERN = new RegExp(
  `^(?:${Object.values(STORE_PREFIXES)
    .map((rule) => rule.prefix)
    .join("|")})[${ROUTING_ID_CHARS}]{1,${ROUTING_ID_MAX_LENGTH}}$`,
  "u",
);

/** The one key under `queue:`. */
export const PAUSE_KEY = "queue:pause";

/**
 * Ciphertext (base64 chars) one record may hold, under the 64 KiB of
 * `ENVELOPE_MAX_CT_LENGTH`: small enough that a whole prefix is one
 * `store-listed` frame. A put past it is `too_large`, so a sealer checks the
 * sealed length first, as the daemon's transport does a reply.
 *
 * A task record grows as the leader writes it — reservation, assignment,
 * decision, PR, branch, failure — so creates get less
 * (`STORE_CREATE_MAX_CT_LENGTH`): created at the full size, the leader's first
 * write would be `too_large` and the task would sit `queued` for good. All the
 * leader adds is bounded but the decision, so a write that would not fit trims
 * the decision first (`Decision.trimmed`), never the task. 40 KiB, not the
 * 32 first planned: at every bound the leader's fields seal to ~8 KB, which a
 * create holding a full prompt left no room for (measured in parse.test.ts).
 */
export const STORE_MAX_CT_LENGTH = 40 * 1024;

/**
 * Ciphertext a create (`expect: 0`) may hold — the relay refuses a larger one
 * `too_large` on either leg, and the app checks its sealed length before
 * sending. 28 KiB holds a task with every field at its bound and a prompt at
 * `TASK_REQUEST_LIMITS.prompt` where each character costs two UTF-8 bytes;
 * three-byte text (CJK) fits about 5,800 characters, and the sealer's check
 * refuses more. The 12 KiB left holds all the leader adds at every bound plus a
 * decision of ten candidates (both measured in parse.test.ts).
 */
export const STORE_CREATE_MAX_CT_LENGTH = 28 * 1024;

/**
 * Task records at most, in `task:`. M2 held ≤64 unfinished tasks plus the newest
 * 50 finished, which fits. Like `MAX_DEVICES` it bounds a bearer-token holder's
 * junk (the leader skips what does not open), and full means `store_full` on
 * create. The leader prunes finished tasks to keep room; a record it cannot read
 * it reports and never deletes on its own — after a PSK rotation that would be
 * the whole queue — so clearing junk is a person's act. With
 * `STORE_MAX_CT_LENGTH`, a full prefix lists as one frame; a deployed relay sent
 * one intact to a daemon and a Bun app leg, a browser's is unchecked (DESIGN.md,
 * "The store", _Send size_, which holds the arithmetic), and paging is the fix
 * if an app leg refuses it.
 */
export const MAX_TASKS = 128;

/** Records across every prefix: `MAX_TASKS` plus room for the singletons and M4's account records. 10 MiB at most. */
export const MAX_RECORDS = 256;

/**
 * How long a tombstone stands, and the oldest `createdAt` a leader admits from
 * `queued`: one value, so a record can never outlive its key's tombstone and
 * still be taken. Thirty days is far past any queue left waiting for a leader.
 */
export const STORE_TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Creates per socket per window — the create rate floor, the register limit's
 * counterpart. Sixty a minute lets one client queue a block of work at once and
 * keeps a token holder's junk to a trickle the leader can skip. Per socket, so
 * it bounds one connection's spend, not an attacker's total (`MAX_TASKS` does).
 */
export const STORE_CREATE_WINDOW_MS = 60_000;
export const MAX_STORE_CREATES_PER_WINDOW = 60;

/**
 * Client-side deadline for a store reply. The relay answers every store frame it
 * can parse, except on a storage throw or a reply the socket refused: then it
 * sends nothing, and this timeout reads the outcome as indeterminate
 * (DESIGN.md, "The store").
 */
export const STORE_TIMEOUT_MS = 10_000;

/**
 * A full `store-list` is `MAX_TASKS` records of up to `STORE_MAX_CT_LENGTH`
 * each, one frame of about 5.2 MB; `STORE_TIMEOUT_MS` is sized for a single
 * record. Measured at 100-250 ms on a good link, so this is slack for a slow
 * one — a takeover that times out here retries, but never lists faster.
 */
export const STORE_LIST_TIMEOUT_MS = 30_000;

export interface StoreListFrame {
  readonly t: "store-list";
  readonly id: string;
  readonly prefix: StorePrefix;
}

/** One record: what a `version_conflict` refreshes from, so a lost race costs one read, not the queue unsealed. */
export interface StoreGetFrame {
  readonly t: "store-get";
  readonly id: string;
  readonly key: string;
}

export interface StorePutFrame {
  readonly t: "store-put";
  readonly id: string;
  readonly key: string;
  /** The version the caller last read; 0 creates. Anything else is `version_conflict`. */
  readonly expect: number;
  /**
   * The sealed record, `ct` under `STORE_MAX_CT_LENGTH` (`STORE_CREATE_MAX_CT_LENGTH`
   * for a create); its sealed body names the version this put produces.
   */
  readonly env: Envelope;
  /**
   * Daemon leg only: the leader's term, required on a `termFenced` prefix and
   * checked as `msg`'s is — and only from the socket the term was issued to.
   * The app leg has no such field: every registry push carries the term, so
   * there it is public, and an app frame with one would authorize nothing.
   */
  readonly term?: number;
}

export interface StoreDeleteFrame {
  readonly t: "store-delete";
  readonly id: string;
  readonly key: string;
  readonly expect: number;
  /** As on `StorePutFrame`. */
  readonly term?: number;
}

export type StoreRequestFrame = StoreListFrame | StoreGetFrame | StorePutFrame | StoreDeleteFrame;

export type AppStoreRequestFrame =
  | StoreListFrame
  | StoreGetFrame
  | Omit<StorePutFrame, "term">
  | Omit<StoreDeleteFrame, "term">;

export interface StoreRecord {
  readonly key: string;
  readonly version: number;
  readonly env: Envelope;
}

/**
 * `version_conflict`: `expect` is not the stored version (0 for none) — the
 * expected answer to a lost race, and to an enqueue retried after its put landed.
 * `not_leader`: a write to a term-fenced prefix without the current term, or
 * not from the leader's socket. `forbidden`: the prefix's rule refuses this leg
 * the act (an app overwriting a task). `invalid_request`: a key outside
 * `STORE_KEY_PATTERN`, an unknown prefix, a malformed field. `too_large`: `ct`
 * past `STORE_MAX_CT_LENGTH`, or a create's past `STORE_CREATE_MAX_CT_LENGTH`.
 * `rate_limited`: past the create floor. `store_full`: a create past
 * `MAX_TASKS` or `MAX_RECORDS`.
 */
export const STORE_ERROR_CODES = [
  "version_conflict",
  "not_leader",
  "forbidden",
  "invalid_request",
  "too_large",
  "rate_limited",
  "store_full",
] as const;

export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number];

/** Relay → app or daemon, correlated on `re`, the request's `id`. */
export type StoreReplyFrame =
  | {
      readonly t: "store-listed";
      readonly re: string;
      /**
       * Every record under the prefix, ascending by key — one frame, unpaged
       * (`MAX_TASKS`). Paging stays open: it would be `after` on the request,
       * which a relay without it ignores and answers whole, and `next` on the
       * reply, which `parseStoreReply` refuses — so a client that predates
       * paging fails loudly on a page rather than reading it as the whole queue.
       */
      readonly records: readonly StoreRecord[];
    }
  | { readonly t: "store-record"; readonly re: string; readonly record: StoreRecord | null }
  /** A put's new version, or the version a delete removed. */
  | { readonly t: "store-written"; readonly re: string; readonly version: number }
  /**
   * A `StoreErrorCode` from this relay. Raw on the wire, as `undeliverable`'s
   * code is read: a code minted after a client was built must still settle its
   * request rather than ride the timeout.
   */
  | { readonly t: "store-refused"; readonly re: string; readonly code: string };

/**
 * Relay → the leader's daemon socket, after a write the leader did not make
 * itself (an app's enqueue): the nudge that makes the loop read the key, so the
 * leader never polls the store. `version` 0: the key was deleted. The relay
 * already knows every write it makes, so this tells the leader nothing new
 * about the relay — and nothing about the record.
 */
export interface StoreChangedFrame {
  readonly t: "store-changed";
  readonly key: string;
  readonly version: number;
}

/**
 * Ops sealed as data at rest rather than sent: the register blob, the `status`
 * beat, the leader's `lead-proof` and the store's records. Opened through `openAtRest`, never the replay
 * guard, and never accepted on a live routing path — one op per kind, so a
 * stored record can stand in neither for a request nor for another kind of
 * record. `task` and `pause-state` are sealed to SCHEDULER_ID: `task` by
 * `sealTaskRecord` (shared/src/task-record.ts), `pause-state` by the leader's
 * queue-store adapter (`daemon/src/queue-store.ts`, `putPause`), which the
 * library writes the pause through (`QueueStore.putPause`).
 */
export const AT_REST_OPS = {
  machineInfo: "machine-info",
  status: "status",
  leadProof: "lead-proof",
  task: "task",
  pauseState: "pause-state",
} as const;

export type AtRestOp = (typeof AT_REST_OPS)[keyof typeof AT_REST_OPS];

/**
 * Fire-and-forget ops — nothing correlates a reply: `update-available` a
 * broadcast, `session-event` and `branch-state` reports to the scheduler, and
 * `queue-changed` the scheduler's nudge to every app.
 */
export type EventOp = "update-available" | "session-event" | "branch-state" | "queue-changed";

export type OpName = "sessions" | "spawn" | "despawn" | "rescan" | "metrics" | AtRestOp | EventOp | SchedulerOp;

/** Ops that expect a response. */
export type RequestOp = Exclude<OpName, AtRestOp | EventOp>;

/**
 * Request ops an app sends `to: SCHEDULER_ID`, answered by the leader rather
 * than by a daemon's handlers (DESIGN.md, Scheduler, "The leader"). Only from
 * `APP_ID`: anything else sent the scheduler is an event, never a request.
 * The leader answers all five. Enqueue is not among them — an app
 * `store-put`s the task itself.
 */
export const SCHEDULER_OPS = ["queue", "route-preview", "cancel", "mark-done", "pause", "resume"] as const;

export type SchedulerOp = (typeof SCHEDULER_OPS)[number];

/**
 * App-side response deadlines. A backstop rather than the primary error path —
 * the daemon returns a structured error on its own — so spawn's ceiling clears
 * exec.ts's 60s command timeout plus spawn.ts's 3s pane-death check, and
 * despawn's clears its ~5s graceful exit plus the kill and its escalation.
 * `cancel` may despawn on the task's machine first, so it clears `despawn`'s.
 */
export const OP_TIMEOUT_MS = {
  sessions: 10_000,
  rescan: 15_000,
  spawn: 90_000,
  despawn: 20_000,
  metrics: 15_000,
  queue: 10_000,
  "route-preview": 10_000,
  cancel: 25_000,
  "mark-done": 10_000,
  pause: 10_000,
  resume: 10_000,
} as const satisfies Record<RequestOp, number>;

/**
 * Status cadence. The relay floors it per socket at STATUS_MIN_INTERVAL_MS, as
 * it rate-limits `register`; a sender below the floor is dropped, not closed.
 */
export const STATUS_INTERVAL_MS = 30_000;
export const STATUS_MIN_INTERVAL_MS = 10_000;

/**
 * Ciphertext bound (base64 chars) on a `status` envelope. The relay keeps the
 * latest on the daemon socket's attachment — 2 KiB, shared with the socket's
 * identity — so the relay refuses a larger one and the daemon trims its blob
 * to fit (`daemon/src/status.ts`) rather than send one that will be dropped.
 */
export const STATUS_MAX_CT_LENGTH = 1024;

/**
 * Ciphertext bound (base64 chars) on every other envelope the relay forwards.
 * A DO value caps at 128 KiB; a register blob for ~60 repos is nearer 12 KiB.
 * Shared because a sender whose reply scales with data (`metrics`) must refuse
 * to build one the relay would drop, which the app sees only as a timeout.
 */
export const ENVELOPE_MAX_CT_LENGTH = 64 * 1024;

/**
 * Heartbeat cadence, shared by both socket legs (daemon↔relay and app↔relay):
 * a bare "ping" every interval, "pong" expected within the deadline, a miss
 * closes/redials. The relay sweeps a daemon socket silent for
 * HEARTBEAT_MISSES_TO_SWEEP beats — derived from the interval there, so
 * slowing the beat can never silently outpace the sweep.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_PONG_TIMEOUT_MS = 10_000;
export const HEARTBEAT_MISSES_TO_SWEEP = 3;

/**
 * Decrypted message body. `ts` feeds the ±60s replay window; `re` correlates
 * a response to its request `id`. `machine-info` and `status` blobs are data
 * at rest (the registry, a socket attachment) — receivers skip the replay
 * check for them.
 */
export interface Plain {
  readonly id: string;
  readonly ts: number;
  readonly op: OpName;
  readonly re?: string;
  readonly payload: unknown;
}

export interface RepoEntry {
  readonly name: string;
  readonly path: string;
  /** From local refs only (origin/HEAD on disk); null when unset. */
  readonly defaultBranch: string | null;
  /** Which exclave's tree this clone sits in (`ExclaveInfo.id`). Absent from older daemons. */
  readonly exclave?: string;
  /**
   * The cross-machine repo key: the origin URL normalised to `host/path` (no
   * scheme, user or `.git`), or the basename when there is no remote. `name` is
   * machine-local and collision-disambiguated, so it cannot say "the same repo"
   * across machines. Absent from older daemons.
   */
  readonly origin?: string;
}

/**
 * One exclave as the daemon reports it: a tree at `~/<id>` whose Claude Code
 * config dir is `~/.claude-<id>` (`default` is `~` with `~/.claude`). The
 * `~/.exclaves` contract is in DESIGN.md, "Exclaves" (under _Daemon_).
 */
export interface ExclaveInfo {
  readonly id: string;
  /** `organizationUuid:accountUuid` from the exclave's `.claude.json` (`~/.claude.json` for `default`); null when not signed in. Never the email. */
  readonly accountId: string | null;
  /**
   * `oauthAccount.emailAddress`, for display only: what the PWA names the
   * account by when no alias is set. Never a key — `accountId` is. Absent from
   * older daemons and from accounts whose file doesn't carry one.
   */
  readonly email?: string;
  /** Whether the account may spill into credits; null when its `.claude.json` doesn't say. */
  readonly extraUsageEnabled: boolean | null;
  /**
   * `oauthAccount.seatTier` (`team_tier_1`, `team_standard`): what the scheduler
   * reads a seat's size and included models from (`SchedulerConfig.seats`).
   * Absent from older daemons and from accounts whose file doesn't carry one.
   */
  readonly seatTier?: string;
  /** The config dir holds a signed-in account. */
  readonly authOk: boolean;
  /**
   * User-level skill names: entries under `<configDir>/skills/` holding a
   * `SKILL.md` (symlinks followed). Read with the scan, served from the blob.
   */
  readonly skills: readonly string[];
}

export interface SessionEntry {
  /**
   * The backend's handle on the session — a tmux pane id (`%12`) — and what
   * `despawn` targets. Optional: a daemon a version behind omits it.
   */
  readonly id?: string;
  readonly window: string;
  /** Repo name mapped by path prefix — a linked worktree's through its main clone; null when outside every known repo. */
  readonly repo: string | null;
  readonly path: string;
  /**
   * The `SpawnRequest.taskId` the session was spawned with, read back from the
   * pane rather than remembered, so it survives a daemon restart. Absent for a
   * session spawned without one, and from daemons without the capability.
   */
  readonly taskId?: string;
}

/** Git identity of a daemon's own checkout. `commitTs` is ms, like every other wire timestamp. */
export interface SourceInfo {
  readonly sha: string;
  readonly commitTs: number;
  /** Null on detached HEAD. */
  readonly branch: string | null;
}

/**
 * Self-update outcomes. The skips are deliberate refusals — a checkout that is
 * dirty, off its default branch, or diverged is someone's work in progress, and
 * an update must never force it.
 */
export const UPDATE_OUTCOMES = [
  "ok",
  "current",
  "skipped_dirty",
  "skipped_branch",
  "skipped_diverged",
  "fetch_failed",
  "install_failed",
  /** Updated on disk, but the restart that would run the new code failed — stranded, visibly. */
  "restart_failed",
] as const;

export type UpdateOutcome = (typeof UPDATE_OUTCOMES)[number];

/** Last self-update attempt, carried in the register blob so skips aren't silent. */
export interface UpdateReport {
  readonly at: number;
  readonly outcome: UpdateOutcome;
  readonly detail?: string;
}

/**
 * Broadcast payload (`op: "update-available"`, sealed to `"machines"`): the
 * announcer's new HEAD. Advisory only — receivers verify against their own
 * origin with ff-only, so a forged sha buys at most one extra fetch.
 */
export interface UpdateAvailable {
  readonly sha: string;
  readonly commitTs: number;
}

/**
 * Payload of the encrypted register blob (`op: "machine-info"`). `source` and
 * `lastUpdate` are optional on the wire — blobs from older daemons lack them.
 * The app and `list_machines` render both (which build each machine runs is
 * what tells a stale leader apart), beside doctor/status on the box itself.
 */
export interface MachineInfo {
  readonly name: string;
  readonly platform: string;
  readonly repos: readonly RepoEntry[];
  readonly scannedAt: number;
  readonly source?: SourceInfo | null;
  readonly lastUpdate?: UpdateReport | null;
  /**
   * In the order `MachineStatus` indexes them. Absent from older daemons, which
   * the scheduler then treats as ineligible for `auto` — it can't know which
   * account a spawn would bill.
   */
  readonly exclaves?: readonly ExclaveInfo[];
  /**
   * What this daemon's handlers support beyond the base ops (`"metrics"`,
   * `"taskId"`, later `"baseBranch"`), so no reader relies on a field an old
   * daemon would drop. Sealed, unlike the relay-read `roles` of M2.
   */
  readonly capabilities?: readonly string[];
}

/**
 * `MachineInfo.capabilities` entries. `metrics`: the op — a daemon without it
 * ignores the op, which an app sees only as a timeout. `taskId`: the spawn
 * field — a daemon without it spawns a duplicate rather than refusing one.
 */
export const CAPABILITIES = { metrics: "metrics", taskId: "taskId" } as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export const QUOTA_SOURCES = ["session", "oauth", "cache"] as const;

/**
 * Where a quota number came from, newest wins per account: `session` is a
 * running session's statusline report, `oauth` the usage endpoint poll (M4),
 * `cache` the `cachedUsageUtilization` Claude Code itself leaves in the
 * exclave's `.claude.json` — M1's only source, and the floor for an idle exclave.
 */
export type QuotaSource = (typeof QUOTA_SOURCES)[number];

/**
 * One account's newest quota observation on this daemon. Keys are short and
 * every number an integer: the whole `status` must fit a DO socket attachment
 * (2 KiB, shared with the socket's identity), and the inputs are already
 * smoothed or stepped, so a float would claim precision nobody has.
 */
export interface ScopedWindow {
  /** Model display name as Claude Code reports it (`"Fable"`); the id is not cached. */
  readonly m: string;
  /** Used, whole percent. */
  readonly p: number;
  /** Resets at, unix seconds. */
  readonly r?: number;
}

export interface QuotaObservation {
  /** Index into the register blob's `exclaves`; the account id lives there, not here. */
  readonly x: number;
  /** Five-hour window used, whole percent. */
  readonly h?: number;
  /** Seven-day window used, whole percent. */
  readonly d?: number;
  /** Five-hour window resets at, unix seconds. */
  readonly hr?: number;
  /** Seven-day window resets at, unix seconds. */
  readonly dr?: number;
  /**
   * Weekly windows scoped to one model (Claude Code's `weekly_scoped` limits —
   * the "Current week (Fable)" bar), beside the all-models `d`. A list keyed by
   * the model's display name rather than a field per model: the next model
   * with its own cap must not be a schema change. Readers take the max over
   * `d` and these.
   */
  readonly w?: readonly ScopedWindow[];
  readonly s: QuotaSource;
  /** Observed at, unix seconds. */
  readonly at: number;
}

/**
 * Payload of the sealed `status` blob (`op: "status"`). Pressure fractions are
 * whole percent, smoothed over ~2 min daemon-side so no reader needs a window
 * of its own. Absent fields are unknown — never null — so the blob stays small.
 * On the wire it also carries `_`, spaces that pad every status to one sealed
 * length (`daemon/src/status.ts`); readers ignore it, so it is not declared here.
 *
 * Indexed fields (`sess`, `quota[].x`) refer to the register blob's `exclaves`,
 * and `scan` names which blob: a status whose `scan` disagrees with the
 * `MachineInfo.scannedAt` a reader holds is dropped for that tick, the same
 * rule the app applies between `rescan` and `machine-info`.
 *
 * "The register blob's" is load-bearing on both ends. Three scan stamps exist:
 * the daemon's `state.scannedAt` advances on every hourly rescan but a
 * re-register happens only when the repo set changed (`daemon/src/run.ts`), and
 * a `rescan` reply stamps a third `Date.now()` that the app merges into
 * `Machine.scannedAt`. The sender stamps the blob it last *registered*; the
 * reader compares against that blob's decrypted `scannedAt`, never against
 * `Machine.scannedAt` — either slip drops every status until the next
 * repo-set change.
 */
export interface MachineStatus {
  /** Sampled at, unix seconds. */
  readonly at: number;
  /** `MachineInfo.scannedAt` of the register blob whose `exclaves` this indexes — ms, as that field is. */
  readonly scan: number;
  readonly cpu?: number;
  readonly mem?: number;
  readonly disk?: number;
  /** Disk free, MiB. */
  readonly free?: number;
  /** Disk read / write rate, KiB/s. */
  readonly rd?: number;
  readonly wr?: number;
  /** Running sessions per exclave, by index. */
  readonly sess?: readonly number[];
  readonly quota?: readonly QuotaObservation[];
  /**
   * Present only when the daemon trimmed this status to fit the relay's
   * bound: how many quota entries it dropped, from the last exclave down — 0
   * when only per-model windows or reset stamps went. In a trimmed status an
   * exclave without an observation is unknown, not unobserved.
   */
  readonly tr?: number;
}

/** Resolutions the daemon's metrics store keeps, seconds — raw, 5-min and hourly tiers. */
export const METRICS_STEPS = [30, 300, 3600] as const;

export type MetricsStep = (typeof METRICS_STEPS)[number];

/**
 * Points per series one `metrics` request may span, `(to - from) / step + 1`:
 * a month hourly, or two days at 5 min. Bounds the store's work; what bounds
 * the reply is `ENVELOPE_MAX_CT_LENGTH`, checked on the sealed reply.
 */
export const METRICS_MAX_POINTS = 720;

/** `op: "metrics"` — history from the daemon's local store; the PWA asks when a chart opens. */
export interface MetricsRequest {
  /** Unix seconds, inclusive. */
  readonly from: number;
  readonly to: number;
  readonly step: MetricsStep;
  /**
   * `METRIC_NAMES` values to return; absent means every series. A chart asks
   * for its panel's names so the reply fits one envelope — every series of a
   * multi-exclave machine at a day's 5-min points does not. A name this daemon
   * doesn't keep matches nothing, so a newer app gets fewer series, not an error.
   */
  readonly names?: readonly string[];
  /**
   * Prometheus-style equality matchers, all of which a series must meet; a
   * label the series lacks reads as `""`. An account chart sends `{ account }`
   * so a multi-exclave machine's other accounts stay off the wire. A daemon that
   * predates the key ignores it and returns every series, so a caller filters
   * the reply again.
   */
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * Bounds on `MetricsRequest.names` (entries, each name) and `.labels`
 * (matchers, each name and value): every entry costs a comparison per series read.
 */
export const METRICS_MAX_FILTERS = 8;
export const METRICS_MAX_FILTER_LENGTH = 128;

/** Prometheus's data model and nothing else, so an external metrics stack is a consumer, not a redesign. */
export interface MetricsSeries {
  readonly metric: string;
  /** `machine`, `exclave`, `account` as applicable. */
  readonly labels: Readonly<Record<string, string>>;
  /** `[unix seconds, value]`, ascending. */
  readonly points: readonly (readonly [number, number])[];
}

export interface MetricsResponse {
  readonly series: readonly MetricsSeries[];
}

/**
 * Codes the transport can answer any op with, whatever its handler would have
 * said (`ErrorResponse`): `internal_error` from a crashed handler, `too_large`
 * from a reply that would seal past `ENVELOPE_MAX_CT_LENGTH`.
 */
export const TRANSPORT_ERROR_CODES = ["internal_error", "too_large"] as const;

export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

/** `too_large`: the reply would not fit one envelope — ask fewer `names` or a coarser step. */
export const METRICS_ERROR_CODES = ["invalid_request", ...TRANSPORT_ERROR_CODES] as const;

export type MetricsErrorCode = (typeof METRICS_ERROR_CODES)[number];

export interface MetricsError {
  readonly ok: false;
  readonly code: MetricsErrorCode;
  readonly message: string;
}

export type MetricsReply = MetricsResponse | MetricsError;

/**
 * The series the daemon's store keeps, one per `MachineStatus` field plus the
 * two quota windows — the same whole-percent / MiB / KiB/s units, so a chart
 * and a status tile read alike. Labels: `machine` on all; `exclave` on
 * `sessions` and quota; `account` on quota when the exclave's config dir says, `model` on `w`.
 * A daemon ahead may add names; a reader charts the ones it knows.
 */
export const METRIC_NAMES = {
  cpu: "cpu_pct",
  mem: "mem_pct",
  disk: "disk_pct",
  free: "disk_free_mib",
  rd: "disk_read_kibs",
  wr: "disk_write_kibs",
  sess: "sessions",
  h: "quota_5h_pct",
  d: "quota_7d_pct",
  /** Label `model` carries the display name. */
  w: "quota_7d_model_pct",
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

export type SpawnMode = "worktree" | "here";

/**
 * Client names our own senders stamp into `SpawnRequest.client` — compile-time
 * discipline on the sending side only. The wire field stays free-text `string`:
 * a daemon must never reject a spawn over a client name minted after it was
 * built, so receivers never validate against this list.
 */
export const SPAWN_CLIENTS = ["pwa", "mcp", "raycast"] as const;

export type SpawnClient = (typeof SPAWN_CLIENTS)[number];

export interface SpawnRequest {
  readonly repo: string;
  readonly mode: SpawnMode;
  readonly prompt?: string;
  readonly title?: string;
  readonly model?: string;
  readonly effort?: string;
  /**
   * Start the session in plan mode (`--permission-mode plan`). Absent or false leaves the
   * flag off entirely, so the session inherits the machine's own settings.json default —
   * the standing behaviour for every other caller. Boolean, not free text: the flag's value
   * is a literal, so unlike `title`/`model`/`effort` nothing wire-supplied reaches the
   * command line. Optional: older clients don't send it, older daemons ignore it.
   */
  readonly plan?: boolean;
  /**
   * Which app-role client formed the request — audit trail only, so
   * `origin=relay` stays separable into "my phone" vs "an agent on my
   * laptop". Our senders stamp a `SpawnClient`; the wire keeps `string` so a
   * daemon never rejects a name minted after it was built. Optional: older
   * clients don't send it, older daemons ignore it.
   */
  readonly client?: string;
  /**
   * Dispatch idempotency (docs/scheduler.md): a daemon refuses a second spawn for a
   * task id one of its sessions already carries, with `task_running`. Bounded by
   * `TASK_ID_PATTERN`; a request outside it is malformed. Old daemons ignore it —
   * `CAPABILITIES.taskId` says which don't.
   */
  readonly taskId?: string;
}

/**
 * What `SpawnRequest.taskId` may hold: a routing id, so a UUID fits and a shell
 * metacharacter, a separator or a `:` doesn't — and the id is a `task:` key's
 * id part as it stands.
 */
export const TASK_ID_PATTERN = ROUTING_ID_PATTERN;

export const SPAWN_ERROR_CODES = [
  "repo_not_found",
  /** A session already carries the request's `taskId`; the reply's `id` names it. */
  "task_running",
  "fetch_failed",
  "no_default_branch",
  "launch_error",
  "claude_died",
  "timeout",
  ...TRANSPORT_ERROR_CODES,
] as const;

export type SpawnErrorCode = (typeof SPAWN_ERROR_CODES)[number];

export type SpawnResponse =
  | {
      readonly ok: true;
      readonly window: string;
      readonly path: string;
      /**
       * Non-fatal detail about a spawn that worked. The daemon emits one when the
       * session started but never registered — it is likely sitting on a startup
       * dialog, and the note carries that screen. A backend may emit others
       * (`SessionBackend` in the daemon's `backend.ts`); clients render whatever
       * arrives.
       */
      readonly note?: string;
      /**
       * The session started but had not registered by the time the ack went out —
       * near-certainly blocked on a startup dialog no remote can answer, with the
       * screen in `note`. Absent means it registered; a daemon a version behind
       * omits it, which reads as the same thing and is the pre-existing behaviour.
       */
      readonly pending?: true;
      readonly sessions: readonly SessionEntry[];
    }
  | {
      readonly ok: false;
      readonly code: SpawnErrorCode;
      readonly message: string;
      /** With `task_running` only: the `SessionEntry.id` of the session already running the task. */
      readonly id?: string;
    };

/**
 * Ends one session: claude is asked to exit, and its pane is killed if it
 * hasn't within a few seconds. The window only — a worktree and its branch are
 * left for `seanced reap`.
 */
export interface DespawnRequest {
  /** `SessionEntry.id` from a session list — the daemon accepts nothing else as a target. */
  readonly id: string;
  /** Skip the graceful exit and kill the pane outright. */
  readonly force?: boolean;
  /** Which app-role client formed the request, as on `SpawnRequest` — audit trail only. */
  readonly client?: string;
}

export const DESPAWN_ERROR_CODES = ["invalid_target", "session_not_found", ...TRANSPORT_ERROR_CODES] as const;

export type DespawnErrorCode = (typeof DESPAWN_ERROR_CODES)[number];

/** `exited`: claude left on its own once asked. `killed`: it didn't, or `force` said not to wait. */
export type DespawnOutcome = "exited" | "killed";

export type DespawnResponse =
  | {
      readonly ok: true;
      readonly window: string;
      readonly outcome: DespawnOutcome;
      readonly sessions: readonly SessionEntry[];
    }
  | { readonly ok: false; readonly code: DespawnErrorCode; readonly message: string };

export interface SessionsResponse {
  readonly sessions: readonly SessionEntry[];
  readonly at: number;
  /**
   * Task ids this daemon launched, or saw end, that no live pane carries now:
   * what tells a scheduler whose spawn reply and `ended` event were both lost
   * that the task ran, rather than that it never started. Sent only to the
   * scheduler (DESIGN.md, "Session events"); absent from older daemons, and
   * when there are none; a reader that predates it ignores it.
   */
  readonly ended?: readonly string[];
  /**
   * Ms epoch, this daemon's clock: from here on `ended` is complete — every
   * task launched here at or after it that no live pane carries is listed. The
   * launches are recorded write-ahead in a file that survives restarts, so a
   * reservation made after it and found in neither list is proof its spawn
   * never landed. The ledger's creation time on a fresh install; it moves
   * forward as old launches are evicted. Sent only to the scheduler, whose
   * request the reply waits on every launch in flight for; absent from older
   * daemons, which can prove nothing (DESIGN.md, "Session events").
   */
  readonly ledgerSince?: number;
  /**
   * What this daemon last knew of each task's PR and branch, live or ended —
   * the sum of the `session-event`s and `branch-state`s it sent, which are
   * fire-and-forget and lost while no leader listens. A leader reads it on
   * takeover and when a machine holding a task it waits on comes back, so a gap
   * cannot settle a task that ended with an open PR as `done`, or hold an
   * `after: "merged"` dependent past a merge it missed. At most
   * `SESSIONS_MAX_PROGRESS`; absent from older daemons and when there is none.
   */
  readonly progress?: readonly TaskProgress[];
  /**
   * Present only when the daemon dropped entries from `progress` to fit the
   * reply in one envelope, oldest first: how many. In a trimmed reply a task
   * with no entry is unknown, not progress-free: a reader settles it by the PR
   * its record holds, and with none waits for a later read.
   */
  readonly progressTrimmed?: number;
}

/** `SessionsResponse.progress` entries at most: the launch ledger's own bound. */
export const SESSIONS_MAX_PROGRESS = 128;

/**
 * One task's PR and branch as its daemon last saw them. Every field is the
 * daemon's own, as on `SessionEvent` and `BranchState`; each is `true` or
 * absent, since none of them goes back.
 */
export interface TaskProgress {
  readonly taskId: string;
  /** The newest `https:` PR URL its session reported. */
  readonly prUrl?: string;
  /** Absent for a `here` session, which has no task branch of its own. */
  readonly branch?: string;
  /**
   * origin's ref for the branch (`refs/remotes/origin/<branch>`) held its tip at
   * least once — never an upstream: `claude --worktree` branches `--no-track`.
   */
  readonly pushed?: true;
  /** `BranchState.merged`'s verdict. */
  readonly merged?: true;
  /** When any of these last changed, ms (an unchanged state is not re-stamped). */
  readonly at: number;
}

/** What a session is doing, as `session-event` reports it (docs/scheduler.md). */
export const SESSION_STATES = ["busy", "idle", "needs-input", "ended"] as const;

export type SessionState = (typeof SESSION_STATES)[number];

/**
 * `op: "session-event"`, daemon → scheduler, sealed to `SCHEDULER_ID`,
 * fire-and-forget. Every field is the daemon's own, never what the session
 * claimed: `session` and `taskId` from its pane map, `exclave` from the pane's
 * path, `prUrl` only once it parsed as `https:` (DESIGN.md, "Session events").
 * Sent only for sessions that carry a task id.
 */
export interface SessionEvent {
  /** `SessionEntry.id` — the pane. */
  readonly session: string;
  readonly taskId: string;
  readonly exclave: string;
  readonly state: SessionState;
  /** The newest pull request URL the session reported, `https:` only. */
  readonly prUrl?: string;
  /** Observed at by the daemon, ms. */
  readonly at: number;
}

/** A git ref name's length at most, as `branch-state` and a task record carry one. */
export const BRANCH_MAX_LENGTH = 255;

/**
 * `op: "branch-state"`, daemon → scheduler, sealed to `SCHEDULER_ID`,
 * fire-and-forget, on change, for task branches only (M3; docs/scheduler.md,
 * "Done detection"). Like `SessionEvent`, every field is the daemon's own: the
 * task id from its pane map or launch ledger, never from a session. `merged` is
 * reap's verdict (`Merged` in `daemon/src/reap-git.ts`: ancestor, squash or
 * gone) against the default branch; `pushed`, that `refs/remotes/origin/<branch>`
 * holds its work tip (live; exactly, where the repo has no `origin/HEAD`).
 * `pushed` and `merged` are reported only once the branch was seen holding
 * work of its own (a tip not reachable from the default branch whose tree
 * differs from the one it forked at: an empty commit or a revert of its only
 * change is none), and both are about that work tip, not whatever the branch
 * points at now: a branch reset to the default after a push is not merged. The
 * one exception: with no `origin/HEAD` nothing can be judged work, so `pushed`
 * is the exact match alone, and never makes a `merged`, which needs a recorded
 * work tip. `merged` also needs pushed evidence (seen pushed, or a recorded PR
 * URL), since a fresh branch reads as merged. Only a
 * daemon sends one; the leader drops an app's. A leader that missed one reads the
 * same state back from `SessionsResponse.progress`.
 */
export interface BranchState {
  readonly taskId: string;
  /** The repo key, `RepoEntry.origin`. */
  readonly repo: string;
  readonly branch: string;
  readonly pushed: boolean;
  readonly merged: boolean;
  /** Observed at by the daemon, ms. */
  readonly at: number;
}

export interface RescanResponse {
  readonly repos: readonly RepoEntry[];
  readonly scannedAt: number;
}

/**
 * Reply payload when an op handler crashes, or (`too_large`) when its reply
 * would seal past `ENVELOPE_MAX_CT_LENGTH` and the daemon's transport sends
 * this instead; `re` still correlates it to the request. Any op's reply can be
 * one, which is why the app-role `request<T>` resolves to `T | ErrorResponse`
 * and every op's own code list includes these.
 */
export interface ErrorResponse {
  readonly ok: false;
  readonly code: TransportErrorCode;
  readonly message: string;
}

/**
 * The scheduler's task states (docs/scheduler.md, "Task states").
 * `scheduler/src/task.ts` holds the one transition table over them. `lost` is
 * a task whose machine stopped answering for it — a running one absent past
 * `lostAfterMs`, or a reservation whose spawn was never confirmed and whose
 * machine was gone at its TTL: held, never dispatched again without proof,
 * until that machine's own `sessions` says what became of it, or `lostExpiryMs`
 * fails it `lost_expired`.
 *
 * M3 adds three. `queued`: stored, not yet admitted by a leader — the only
 * state an app creates a task in. `blocked`: admitted, waiting on its `deps`.
 * `awaiting-merge`: its session ended with a PR open; it frees its slot but
 * keeps `after: "merged"` dependents blocked until the merge is seen, or
 * `mergeExpiryMs` fails it `merge_expired` and them with it.
 */
export const TASK_STATES = [
  "queued",
  "blocked",
  "ready",
  "reserved",
  "running",
  "needs-input",
  "awaiting-merge",
  "lost",
  "done",
  "failed",
  "cancelled",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/**
 * What an app asks the scheduler to run: a `SpawnRequest`'s fields minus where
 * it lands, with `repo` naming the repo (`RepoEntry.origin`), never a
 * machine's clone of it. Bounded by `TASK_REQUEST_LIMITS`.
 */
export interface TaskRequest extends Pick<SpawnRequest, "mode" | "prompt" | "title" | "model" | "effort" | "plan"> {
  readonly repo: string;
}

/**
 * Lengths a `TaskRequest` field may reach, in UTF-16 units. A task is held on
 * the leader and echoed in `queue` replies, so its fields are bounded here,
 * not by the envelope alone as a direct spawn's are. `prompt` is sized so a task
 * fits one create (`STORE_CREATE_MAX_CT_LENGTH`, M3): a task names its work and
 * the session gathers the rest with tools (the owner, 2026-10-17). A direct
 * spawn is not bound by it.
 */
export const TASK_REQUEST_LIMITS = { repo: 512, prompt: 8_192, title: 200, model: 64, effort: 64 } as const;

/** Where a session runs or ran: what pins, lineage and dependency distance are measured against. */
export interface Placement {
  readonly deviceId: string;
  readonly exclave: string;
}

/**
 * How a batch's members share the fleet. `sequential`: one at a time, in
 * `index` order. `parallel`: at most `max` at once. `auto`: no batch-level
 * bound — deps and the global and per-account caps decide.
 */
export type BatchStrategy =
  | { readonly mode: "sequential" }
  | { readonly mode: "parallel"; readonly max: number }
  | { readonly mode: "auto" };

/**
 * A task's place in a batch. Every member carries the strategy, since there is
 * no batch record — one client creates a batch's members together, so they
 * agree; where they do not, the earliest-created member's wins.
 */
export interface BatchMembership {
  /** `TASK_ID_PATTERN`, minted by the client like a task id. */
  readonly id: string;
  readonly index: number;
  readonly strategy: BatchStrategy;
}

/**
 * When a dependency edge releases. `opened`: the predecessor has a PR and its
 * branch is pushed (stacked work, the default a client offers), in whatever
 * state it is — `running` included. `merged`: its branch merged. A `done`
 * predecessor releases both, whatever settled it, since `mark-done` always
 * wins. A `here` predecessor has no task branch, so `opened` releases on its PR
 * alone and `merged` only at `done`.
 */
export const DEP_AFTER = ["opened", "merged"] as const;

export type DepAfter = (typeof DEP_AFTER)[number];

/**
 * How long a dependent may name a task the store does not hold before it fails
 * `dependency_missing`, from its own `createdAt`: a client puts a batch one
 * record at a time, so a predecessor can land after its dependent.
 */
export const DEP_MISSING_GRACE_MS = 5 * 60_000;

/**
 * One hand-declared edge: this task waits for `task` (another task's id).
 * Linear-derived edges are M4's. An edge that can never release fails the
 * dependent with a `TaskFailureCode`, never holds it `blocked` for good:
 * - `dependency_failed`: the predecessor ended `failed` or `cancelled`. It
 *   cascades, so nothing runs on work that is not there. A `lost` predecessor
 *   is waited on, since it may still finish, until it expires (`lost_expired`),
 *   which fails its dependents.
 * - `dependency_missing`: no task by that id past `DEP_MISSING_GRACE_MS` — a
 *   typo, junk, or a task pruned before it was named. Pruning never deletes a
 *   task an unfinished one names.
 * - `dependency_cycle`: the edges loop, a self-edge included; every member
 *   fails, at admission.
 */
export interface TaskDep {
  readonly task: string;
  readonly after: DepAfter;
}

/** An optional Linear issue the task is for. Informational in M3; M4 reads relations and Done from it. */
export interface LinearLink {
  /** The issue identifier, `ENG-123`. */
  readonly issue: string;
  /** `https:` only, as a PR URL. */
  readonly url?: string;
}

/**
 * Bounds on `TaskSpec`'s M3 fields, beside `TASK_REQUEST_LIMITS`. `batchIndex`
 * is `MAX_TASKS`, inclusive: the store holds no more task records, so no batch
 * held at once has more members, and inclusive admits 1-based numbering.
 */
export const TASK_SPEC_LIMITS = {
  deps: 16,
  parallel: 16,
  linearIssue: 64,
  placement: ROUTING_ID_MAX_LENGTH,
  batchIndex: MAX_TASKS,
} as const;

/** What was asked for, plus what the scheduler itself may add. Everything the spawn carries except where it lands. */
export interface TaskSpec extends TaskRequest {
  /** Restrict to a machine, an exclave name, or both; absent fields are free. */
  readonly pin?: { readonly deviceId?: string; readonly exclave?: string };
  /** The session this one continues — its owner gets the sticky bonus. */
  readonly lineage?: Placement;
  /** Where the work this task builds on lives (M4's stacking fills it; unset today); drives `dependency_distance`. */
  readonly base?: Placement;
  readonly batch?: BatchMembership;
  /** At most `TASK_SPEC_LIMITS.deps`; the leader holds the task `blocked` until every edge releases. */
  readonly deps?: readonly TaskDep[];
  readonly linear?: LinearLink;
}

/**
 * Lengths, in UTF-16 units, of the names a leader writes into a task: a clone
 * (a repo name), a machine's display name, a tmux window (a task's title, or
 * its worktree's slug). With a `Placement`'s routing-id bounds they keep all a
 * leader adds to a record bounded but the decision (`STORE_MAX_CT_LENGTH`). A
 * reader refuses past them, so a writer cuts first.
 */
export const TARGET_LIMITS = { clone: TASK_REQUEST_LIMITS.repo, machine: 256, window: 256 } as const;

/** A placement plus the machine-local clone name `spawn` takes. */
export interface Target extends Placement {
  readonly clone: string;
}

export interface Reservation extends Target {
  readonly expiresAt: number;
}

export interface Assignment extends Target {
  /** Absent when the daemon answered `task_running`, which names the pane only. */
  readonly window?: string;
  /** The session's pane id, when the daemon reported one. */
  readonly pane?: string;
}

/**
 * Why a candidate was filtered (docs/scheduler.md, "Routing"): structured
 * codes, every one that applies, so the record explains each loser.
 */
export type Reason =
  | { readonly code: "offline" }
  /** Connected, but no status, or one `isStatusStale` calls stale: pressure is unknown. */
  | { readonly code: "status_stale" }
  | { readonly code: "task_id_unsupported" }
  /** A daemon predating exclaves: which account a spawn would bill is unknown. */
  | { readonly code: "exclaves_unknown" }
  | { readonly code: "disk_low"; readonly freeMib: number }
  | { readonly code: "pressure_unknown" }
  | { readonly code: "pin_mismatch"; readonly field: "deviceId" | "exclave" }
  | { readonly code: "repo_absent" }
  | { readonly code: "auth_missing" }
  | { readonly code: "quota_unknown"; readonly why: "unobserved" | "trimmed" }
  | { readonly code: "quota_over_line"; readonly window: string; readonly projectedPct: number }
  /**
   * The task's model is one its seat bills to credits (`model`, the gated
   * family as `SchedulerConfig.gatedModels` names it). Never spilled past, as
   * `quota_over_line` may be.
   */
  | { readonly code: "model_not_included"; readonly model: string }
  /**
   * `scope` absent is `global`, as M2's leaders sent it. M3's: `account`, the
   * per-account cap; `batch`, the task's batch at its strategy's bound
   * (`sequential` is a bound of 1).
   */
  | {
      readonly code: "cap_reached";
      readonly inFlight: number;
      readonly max: number;
      readonly scope?: "global" | "account" | "batch";
    }
  /**
   * A `sequential` batch member held for order: the member at `index`, the
   * nearest lower one the scheduler holds, has not ended yet — running, or
   * still `blocked` or unroutable itself.
   */
  | { readonly code: "batch_order"; readonly index: number }
  /**
   * A pause holds dispatch (`PauseHold`): the whole queue, or the candidate's
   * account. Set by the leader since M3 item 5.
   */
  | { readonly code: "paused"; readonly until: PauseUntil; readonly scope: "queue" | "account" };

export type ReasonCode = Reason["code"];

export interface ScoreComponents {
  readonly accountPressure: number;
  readonly machinePressure: number;
  readonly dependencyDistance: number;
  readonly queuePressure: number;
}

export interface Score {
  /** Raw, before weights — what the record shows. */
  readonly components: ScoreComponents;
  /** The bonus subtracted for the lineage owner; 0 elsewhere. */
  readonly sticky: number;
  readonly total: number;
}

/** The reading a candidate's account was judged on, so the record shows its age. */
export interface QuotaBasis {
  /** Unix seconds, as `QuotaObservation.at`. */
  readonly observedAt: number;
  readonly observer: string;
  readonly source: QuotaSource;
}

export interface Candidate {
  readonly deviceId: string;
  readonly machine: string;
  /** Null for a daemon that reports no exclaves. */
  readonly exclave: string | null;
  readonly clone?: string;
  readonly rejected: readonly Reason[];
  readonly score?: Score;
  readonly quota?: QuotaBasis;
  /** Over the line but allowed to spend credits — dispatching here spills. The leader logs it once per account per window after a confirmed spawn; M4 adds the push. */
  readonly spill?: { readonly window: string; readonly projectedPct: number };
}

/**
 * Candidates one decision lists at most, and reasons one candidate carries: a
 * reader refuses more. The candidate bound is a fleet at the relay's 32
 * machines with two exclaves each; a larger one has the leader trim.
 */
export const DECISION_MAX_CANDIDATES = 64;
export const CANDIDATE_MAX_REASONS = 32;

/** One routing outcome: what `route-preview` returns and a task's record carries. */
export interface Decision {
  readonly at: number;
  readonly chosen: Target | null;
  /** Scored candidates first, lowest total first; then the rejected, in fleet order. */
  readonly candidates: readonly Candidate[];
  /**
   * Present only when the leader cut candidates — past
   * `DECISION_MAX_CANDIDATES`, or to fit the record (`STORE_MAX_CT_LENGTH`) —
   * from the end, rejected ones first: how many. The list is then partial, and
   * a reader says so rather than read it as every loser.
   */
  readonly trimmed?: number;
}

export interface Task {
  readonly id: string;
  /** What was asked for. Its `prompt` is dropped on the write that finishes the task (`forgetPrompt`). */
  readonly spec: TaskSpec;
  readonly state: TaskState;
  readonly createdAt: number;
  readonly reservation?: Reservation;
  readonly assignment?: Assignment;
  /** The routing decision that placed it — written with the reservation, never per tick. */
  readonly decision?: Decision;
  /**
   * A daemon's `SpawnErrorCode`, or a `TaskFailureCode`; a string, so a code
   * minted later still parses. Bounded by `TASK_FAILURE_LIMITS`: the message is
   * often a daemon's, and it is stored.
   */
  readonly failure?: { readonly code: string; readonly message: string };
  /** With `lost`: when the scheduler first saw the task's machine absent, ms. */
  readonly absentSince?: number;
  /**
   * When its reservation was made, ms, the leader's clock. Kept past `reserved`
   * only into `lost`, where its presence marks a spawn never confirmed — the one
   * `lost` that may return to `ready`, and only on its machine's ledger proof
   * (`SessionsResponse.ledgerSince`).
   */
  readonly reservedAt?: number;
  /**
   * With `cancelled`: its machine was unreachable at the cancel, so nothing was
   * despawned there — whatever session it had may still be running.
   */
  readonly leftRunning?: true;
  /** The newest `https:` PR URL its session reported — what `after: "opened"` and `awaiting-merge` read. */
  readonly prUrl?: string;
  /** Its branch, from its machine's `branch-state`. */
  readonly branch?: string;
  /**
   * Its branch's upstream held its tip. Per branch: a report naming another
   * branch clears it, and within one it never goes back. A `merged` verdict is
   * believed only of a branch seen pushed (`scheduler/src/done.ts`).
   */
  readonly pushed?: true;
  /** With `done`: which signal settled it (docs/scheduler.md, "Done detection"). */
  readonly doneBy?: DoneSignal;
  /** When it last entered `needs-input`, ms: the escalation clock, here so a new leader does not restart it. */
  readonly needsInputSince?: number;
  /** The needs-input escalation fired for this stay — once, never a kill. */
  readonly escalated?: true;
  /**
   * When it entered `awaiting-merge`, ms, the leader's clock — what merge expiry
   * (`SchedulerConfig.mergeExpiryMs`) ages from. Kept once it leaves. Absent on a
   * record an older leader moved there, which ages from `createdAt` instead.
   */
  readonly endedAt?: number;
}

/**
 * `merged`: its branch merged (`branch-state`). `session`: its session ended
 * with no PR to wait on. `manual`: `mark-done`, which always wins. Linear's
 * Done joins in M4.
 */
export const DONE_SIGNALS = ["merged", "session", "manual"] as const;

export type DoneSignal = (typeof DONE_SIGNALS)[number];

/**
 * A sealed body that names the version its own put produces (docs/scheduler.md,
 * "Version binding"): a reader rejects a record whose `version` is not the
 * relay's, so an authentic old blob put back by a token holder fails like a
 * forged one.
 */
export interface VersionBound {
  readonly version: number;
}

/**
 * Payload of a `task:<id>` record (`op: "task"`, sealed to SCHEDULER_ID, from
 * its sealer). A reader opens it with `openAtRest`, then keeps it only through
 * `bindTaskRecord`, which holds every rule but the crypto (each a
 * `RecordUnreadable` reason):
 * - its version is the relay's, and `task.id` the key's own id — without the
 *   second, a token holder could create a fresh key holding another task's
 *   version-1 blob and have it run twice;
 * - a version-1 record is `queued`, since a create is an app's enqueue and
 *   only the leader moves a task on — so no client can create one running;
 * - its `createdAt` is at most `REPLAY_WINDOW_MS` ahead of the reader's clock,
 *   or a far-future stamp would let a blob outlive the admit rule below.
 *
 * A leader also admits no `queued` task whose `createdAt` is more than
 * `STORE_TOMBSTONE_MS` old: past that its key's tombstone may be gone, and only
 * the age still refuses the blob put back. That one is the admission's, not the
 * reader's — the record still reads, to be failed `queue_expired` and pruned.
 */
export interface TaskRecord extends VersionBound {
  readonly task: Task;
}

/**
 * Why a stored record was not read: `unopenable`, it did not decrypt, its
 * `op` was not the slot's (`openAtRest`) or it was not sealed to SCHEDULER_ID
 * (`openTaskRecord`); `malformed`, its body failed the parser; `key_mismatch`
 * also covers a listing key outside `task:` or listed twice
 * (`openTaskListing`); the rest are `bindTaskRecord`'s rules. A reader skips
 * and reports such a record and never deletes it on its own: after a PSK rotation every
 * record is `unopenable`, and deleting them would wipe the queue.
 */
export const RECORD_UNREADABLE_REASONS = [
  "unopenable",
  "malformed",
  "version_mismatch",
  "key_mismatch",
  "created_unqueued",
  "created_ahead",
] as const;

export type RecordUnreadable = (typeof RECORD_UNREADABLE_REASONS)[number];

/** `PauseRequest.until`: until a `resume`, or until the account's quota next resets. */
export const PAUSE_UNTIL = ["resume", "reset"] as const;

export type PauseUntil = (typeof PAUSE_UNTIL)[number];

/** One hold on dispatch. Running sessions are never touched; only new dispatch waits. */
export interface PauseHold {
  /** `ExclaveInfo.accountId`; absent holds the whole queue. */
  readonly account?: string;
  readonly until: PauseUntil;
  /** Paused at, ms. */
  readonly at: number;
  /** With `until: "reset"`: when the hold lifts, ms — the account's next reset, resolved by the leader when it paused. */
  readonly resumeAt?: number;
}

/** Holds at most: one for the queue plus one per account. */
export const MAX_PAUSE_HOLDS = 32;

/** Payload of the `queue:pause` record (`op: "pause-state"`, sealed to SCHEDULER_ID by the leader; sealed and opened by `daemon/src/queue-store.ts`). */
export interface PauseRecord extends VersionBound {
  readonly holds: readonly PauseHold[];
}

/**
 * `Task.failure` codes the scheduler sets itself, beside a daemon's refusal.
 * `dispatch_unconfirmed`: its spawn's reply was lost and its machine, asked
 * later, could neither show the session nor prove it never started (an older
 * daemon, or a ledger pruned past the reservation). Terminal: re-dispatching
 * could start a twin. `dependency_failed`, `dependency_missing` and
 * `dependency_cycle`: an edge that can never release (`TaskDep`), set at
 * admission. `queue_expired`: `queued` past `STORE_TOMBSTONE_MS`, so it may be
 * a pruned task's blob put back (`TaskRecord`); failed rather than held, so
 * its dependents fail too and it can be pruned. `lost_expired`: `lost` past
 * `SchedulerConfig.lostExpiryMs` since its machine went away, while that machine
 * is disconnected. Failed so it
 * stops holding a slot and can be pruned. Its session may
 * still be running there. `merge_expired`: `awaiting-merge` past `mergeExpiryMs`
 * with no merge. Its `after: "merged"` dependents fail with it.
 */
export const TASK_FAILURE_CODES = [
  "dispatch_unconfirmed",
  "dependency_failed",
  "dependency_missing",
  "dependency_cycle",
  "queue_expired",
  "lost_expired",
  "merge_expired",
] as const;

export type TaskFailureCode = (typeof TASK_FAILURE_CODES)[number];

/**
 * `Task.failure` bounds, in UTF-16 units. A code is an identifier; a message a
 * line for a person, cut by the writer — a daemon's can carry a whole stderr —
 * and by a reader too, so an older leader's long one costs its tail, not the task.
 */
export const TASK_FAILURE_LIMITS = { code: 64, message: 512 } as const;

/**
 * How long a machine's launch ledger keeps a task: a week covers a laptop shut
 * for one, and past it the machine can no longer prove a spawn never landed or
 * report the task's merge. Shared because the scheduler's `mergeExpiryMs` is
 * derived from it — past it nothing waits on a signal that can still arrive.
 */
export const LAUNCH_LEDGER_MAX_AGE_MS = 7 * 24 * 3_600_000;

/**
 * `not_leader`: the daemon the relay routed the request to runs no term — it
 * was demoted in between, or the relay's record outlived its role.
 * `not_ready`: it leads, but its takeover has not finished; ask again shortly.
 */
export const SCHEDULER_ERROR_CODES = [
  "not_leader",
  "not_ready",
  "invalid_request",
  /** `cancel`, `mark-done`: the leader holds no task by that id. */
  "task_not_found",
  /** `cancel`: the task is `reserved`, its spawn in flight — refused rather than raced; ask again. */
  "dispatching",
  /** `cancel`, `mark-done`: the task is already `done`, `failed` or `cancelled`. */
  "finished",
  /** `cancel`, `mark-done` of a running task: its machine answered the despawn with a refusal; the task is unchanged. */
  "despawn_failed",
  /** `cancel`, `mark-done`, `pause`, `resume`: the record changed under the request (a lost store race); ask again. */
  "conflict",
  /** `pause` with `until: "reset"`: no quota reading says when that account resets. */
  "reset_unknown",
  ...TRANSPORT_ERROR_CODES,
] as const;

export type SchedulerErrorCode = (typeof SCHEDULER_ERROR_CODES)[number];

export interface SchedulerError {
  readonly ok: false;
  /**
   * A `SchedulerErrorCode` from a leader of this build; raw as read, as
   * `store-refused`'s is, so a code minted after a client was built still
   * reads as a refusal (`schedulerErrorText` words one it does not know).
   */
  readonly code: string;
  readonly message: string;
}

/** `queue` replies with at most this many tasks, unfinished first (a task waiting on a person leads), newest first within each: each carries a decision, which grows with the fleet. */
export const QUEUE_MAX_TASKS = 20;

/** A `queue` reply's prompts are cut to this many UTF-16 units — enough to name a task, not to re-read it. */
export const QUEUE_PROMPT_PREVIEW = 120;

/**
 * `op: "queue"` → the leader's most relevant tasks (unfinished first), each with its latest decision.
 * `tasks` asks for those ids only (at most `QUEUE_MAX_TASKS`) — what a
 * `queue-changed` named, or the one task a verdict follows. Older leaders
 * ignore the payload and answer their own listing, so a reader filters the reply again.
 */
export interface QueueRequest {
  readonly tasks?: readonly string[];
}

export interface QueueResponse {
  /** `spec.prompt` is cut to `QUEUE_PROMPT_PREVIEW`; absent on a finished task from a leader on this build once its sweep has run (an older leader still returns the preview); a ready task's `decision` is its latest, placed or not. */
  readonly tasks: readonly Task[];
  readonly at: number;
  /** What holds dispatch now (M3). Absent from M2's leaders, which have no pause. */
  readonly holds?: readonly PauseHold[];
}

/** `op: "cancel"` and `op: "mark-done"`: the task, by id. */
export interface TaskRef {
  readonly taskId: string;
}

/** `cancel` and `mark-done` → the task as it now stands. */
export interface TaskResponse {
  readonly task: Task;
}

/**
 * `op: "pause"`. `reset` needs an `account` — it is that account's reset; with
 * no `account` the hold is on the whole queue, and lasts until `resume`.
 */
export interface PauseRequest {
  readonly until: PauseUntil;
  readonly account?: string;
}

/** `op: "resume"`: lifts the hold on `account`, or the whole-queue hold when absent. */
export interface ResumeRequest {
  readonly account?: string;
}

/** `pause` and `resume` → every hold after the change. */
export interface PauseResponse {
  readonly holds: readonly PauseHold[];
}

/**
 * `op: "queue-changed"`, the scheduler → `APP_ID`, fire-and-forget, on every
 * change an app would show: apps re-fetch `queue` instead of polling. Sent on
 * the term's leg as `from: SCHEDULER_ID`, so a demoted leader's is fenced.
 */
export interface QueueChanged {
  readonly at: number;
  /**
   * The tasks that changed, at most `QUEUE_MAX_TASKS`, so an app re-fetches
   * those (`QueueRequest.tasks`) rather than the queue. Absent: more changed,
   * or a holds change — re-fetch it whole.
   */
  readonly tasks?: readonly string[];
}

/** `op: "route-preview"` (a `TaskRequest`) → what routing would decide now, reserving nothing. */
export interface RoutePreviewResponse {
  readonly decision: Decision;
}

export type QueueReply = QueueResponse | SchedulerError;
export type RoutePreviewReply = RoutePreviewResponse | SchedulerError;
export type TaskReply = TaskResponse | SchedulerError;
export type PauseReply = PauseResponse | SchedulerError;
