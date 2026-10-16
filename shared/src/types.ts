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
      /** base64 signature over `deviceId` and `ts`, made with `key`. */
      readonly sig: string;
    }
  | { readonly t: "msg"; readonly env: Envelope }
  /**
   * The daemon's current telemetry snapshot (`op: "status"`, sealed to APP_ID
   * like the register blob), every STATUS_INTERVAL_MS. The relay keeps only the
   * latest, on the socket's attachment — never in storage — so it vanishes with
   * the socket, which is right: a disconnected machine's snapshot is stale by
   * definition. DESIGN.md, Presence & identity.
   */
  | { readonly t: "status"; readonly env: Envelope };

/** Layer 1: relay→daemon frames. */
export type RelayToDaemonFrame = { readonly t: "msg"; readonly env: Envelope };

/**
 * Layer 1: app→relay frames. `forget` deletes one registry entry — the only
 * frame the app sends that the relay acts on itself rather than routes. It is
 * not an `OpName`: ops are sealed end to end and answered by a daemon, and the
 * machine being forgotten is by definition not there to answer.
 */
export type AppFrame =
  | { readonly t: "msg"; readonly env: Envelope }
  | { readonly t: "forget"; readonly deviceId: string };

/** Why the relay could not hand an envelope to its target daemon. */
export type UndeliverableCode = "offline" | "unknown";

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
  | { readonly t: "registry"; readonly entries: readonly RegistryView[] }
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
    };

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
}

/**
 * A registry entry as sent to the app. `connected` is derived from open
 * sockets at read time and never persisted: heartbeats use DO auto-response
 * and never wake the object, so a stored flag would survive as a stale `true`
 * past an eviction.
 */
export type RegistryView = RegistryEntry & {
  readonly connected: boolean;
  /** The daemon's latest `status` envelope, present only while its socket is open. */
  readonly status?: Envelope;
};

export type OpName =
  | "sessions"
  | "spawn"
  | "despawn"
  | "rescan"
  | "machine-info"
  | "update-available"
  | "status"
  | "metrics";

/**
 * Ops that expect a response; `machine-info` and `status` are stored blobs and
 * `update-available` a fire-and-forget broadcast — none correlates a reply.
 */
export type RequestOp = Exclude<OpName, "machine-info" | "update-available" | "status">;

/**
 * App-side response deadlines. A backstop rather than the primary error path —
 * the daemon returns a structured error on its own — so spawn's ceiling clears
 * exec.ts's 60s command timeout plus spawn.ts's 3s pane-death check, and
 * despawn's clears its ~5s graceful exit plus the kill and its escalation.
 */
export const OP_TIMEOUT_MS = {
  sessions: 10_000,
  rescan: 15_000,
  spawn: 90_000,
  despawn: 20_000,
  metrics: 15_000,
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
  /** Whether the account may spill into credits; null when its `.claude.json` doesn't say. */
  readonly extraUsageEnabled: boolean | null;
  /** The config dir holds a signed-in account. */
  readonly authOk: boolean;
  /** User-level skill names under the config dir — informational until M4's skill filter. */
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
 * `lastUpdate` are optional on the wire — blobs from older daemons lack them,
 * and the app renders neither in v1 (doctor/status are the visibility surface).
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
   * later `"taskId"`, `"baseBranch"`), so no reader relies on a field an old
   * daemon would drop. Sealed, unlike the relay-read `roles` of M2.
   */
  readonly capabilities?: readonly string[];
}

/** The `capabilities` entry for the `metrics` op: a daemon without it ignores the op, which an app sees only as a timeout. */
export const METRICS_CAPABILITY = "metrics";

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

/** `too_large`: the reply would not fit one envelope — ask fewer `names` or a coarser step. */
export const METRICS_ERROR_CODES = ["invalid_request", "too_large", "internal_error"] as const;

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
}

export const SPAWN_ERROR_CODES = [
  "repo_not_found",
  "fetch_failed",
  "no_default_branch",
  "launch_error",
  "claude_died",
  "timeout",
  "internal_error",
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
  | { readonly ok: false; readonly code: SpawnErrorCode; readonly message: string };

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

export const DESPAWN_ERROR_CODES = ["invalid_target", "session_not_found", "internal_error"] as const;

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
}

export interface RescanResponse {
  readonly repos: readonly RepoEntry[];
  readonly scannedAt: number;
}

/**
 * Reply payload when an op handler crashes, or (`too_large`) when its reply
 * would seal past `ENVELOPE_MAX_CT_LENGTH` and the daemon's transport sends
 * this instead; `re` still correlates it to the request.
 */
export interface ErrorResponse {
  readonly ok: false;
  readonly code: "internal_error" | "too_large";
  readonly message: string;
}
