import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { AUTH_EXPIRING_MS, isRecord } from "@seance/shared";
import { DEFAULT_EXCLAVE, type Exclave, type ExclaveScan } from "./exclaves.ts";
import { exec } from "./exec.ts";
import { bunPathFor } from "./link.ts";
import { log } from "./log.ts";
import { baseChildEnv, loginName } from "./usage-refresh.ts";

/**
 * Auth health (DESIGN.md, Daemon, "Auth health"; docs/scheduler.md M4): whether each
 * signed-in exclave's login is still good. `authOk` only says `.claude.json` names an
 * `oauthAccount`; a lapsed or revoked login keeps it, and Claude Code instead rewrites
 * its stored credentials to empty tokens. So the credential store is the signal.
 *
 * **The daemon never holds a token.** The store is read by a short-lived `bun -e` child
 * running one constant script (`AUTH_READ_SCRIPT`), the file handed over as an open file
 * descriptor — the daemon never calls `read` on it — or, on macOS, `security -w` run by
 * the child itself. The child prints two derived values and nothing else, and the daemon
 * takes exactly that shape or reads `unknown`. Its stdout and stderr are never logged, and
 * stderr is never even read. Anything that goes wrong reads `unknown`, never `expired`:
 * `unknown` still routes.
 */

const DAY_MS = 86_400_000;

/**
 * Below this (September 2001, in ms) a `refreshTokenExpiresAt` is not a plausible ms epoch: a Claude Code
 * that wrote seconds, or a duration, would otherwise read every exclave as long expired. Such a value is
 * no expiry at all (the script prints null, the parser refuses it), never a time.
 */
const MIN_EXPIRY_MS = 1_000_000_000_000;

/**
 * The one script every read runs: `bun -e <this> <mode> <security> <service> <account>`.
 * Constant — nothing from a frame, a file or a config reaches it but as an argv word it
 * only passes to `security`. `expiresAt > refreshTokenExpiresAt + 3d` copies Claude Code's
 * own suppression of its "login expires" notice: an access token outliving the refresh
 * token by days means that refresh expiry is not the login's. An expiry under `MIN_EXPIRY_MS`
 * is no expiry. Exits: 2 bad mode, 3 not
 * JSON, 4 not a credential store, 5 `security` failed, 44 `security` found no item
 * (a keychain-less Claude Code uses the file), 6 anything else. `lapsed` needs both tokens
 * empty, which is what Claude Code writes on a lapse; one empty field alone is not proof.
 */
export const AUTH_READ_SCRIPT = `
const DAY = ${DAY_MS};
const MIN_EXPIRY = ${MIN_EXPIRY_MS};
const out = (lapsed, at) => process.stdout.write(JSON.stringify({ lapsed, refreshExpiresAt: at }));
const judge = (text) => {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    process.exit(3);
  }
  const o = doc !== null && typeof doc === "object" ? doc.claudeAiOauth : undefined;
  if (o === null || typeof o !== "object" || typeof o.refreshToken !== "string" || typeof o.accessToken !== "string") {
    process.exit(4);
  }
  const r = o.refreshTokenExpiresAt;
  const e = o.expiresAt;
  let at = typeof r === "number" && Number.isFinite(r) && r >= MIN_EXPIRY ? r : null;
  if (at !== null && typeof e === "number" && e > at + 3 * DAY) at = null;
  out(o.refreshToken === "" && o.accessToken === "", at);
};
try {
  const [mode, bin, service, account] = process.argv.slice(1);
  if (mode === "keychain") {
    const r = Bun.spawnSync([bin, "find-generic-password", "-a", account, "-w", "-s", service], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 4000,
    });
    if (r.exitCode === 44) process.exit(44);
    if (r.exitCode !== 0) process.exit(5);
    judge(r.stdout.toString());
  } else if (mode === "stdin") {
    judge(await Bun.stdin.text());
  } else {
    process.exit(2);
  }
} catch {
  process.exit(6);
}
`;

export type AuthUnknown =
  | "pending"
  | "absent"
  | "too_large"
  | "keychain"
  | "keychain_off"
  | "unreadable"
  | "timeout"
  | "output"
  | "spawn";

export type AuthView =
  | { readonly state: "ok" }
  | { readonly state: "expiring"; readonly expiresAt: number }
  | { readonly state: "expired" }
  | { readonly state: "unknown"; readonly why: AuthUnknown };

/** Past this a credentials file is not one: Claude Code's are a few hundred bytes. */
const MAX_CREDENTIALS_BYTES = 65_536;

/** The child prints two short fields; more is not its output. */
const MAX_OUTPUT_BYTES = 256;

/** Never read one exclave twice inside this, however it is poked. */
export const MIN_REREAD_MS = 60_000;
export const CHECK_INTERVAL_MS = 60_000;
export const READ_TIMEOUT_MS = 5_000;
const KILL_AFTER_MS = 1_000;
const HARD_DEADLINE_SLACK_MS = 1_000;

/** A file's stamp is watched on Linux; the macOS keychain has none, so it is polled more often. */
const REREAD_LINUX_MS = 60 * 60_000;
const REREAD_DARWIN_MS = 10 * 60_000;

/** A read that failed for a reason that may pass (not a missing file) is retried at most this late. */
const RETRY_UNKNOWN_MS = 10 * 60_000;

/** Reasons a retry cannot change by itself: a missing file (its stamp is watched), an oversize one, a switched-off read. */
const STRUCTURAL: ReadonlySet<AuthUnknown> = new Set(["absent", "too_large", "keychain_off"]);

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_ACCOUNT_FALLBACK = "claude-code-user";
const KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/u;
const KEYCHAIN_NOT_FOUND = 44;
const KEYCHAIN_FAILED = 5;

export interface AuthHealthDeps {
  /** The last scan: which exclaves exist, where their credentials are, and whether each is signed in. */
  readonly scan: () => Pick<ExclaveScan, "exclaves" | "info">;
  /** The daemon's home: `HOME` for the child, never a cwd. */
  readonly home: string;
  readonly platform?: NodeJS.Platform;
  /** Judges the refresh token's expiry, which Claude Code stamps with the wall clock. */
  readonly now?: () => number;
  /** Default: `bun` resolved through the child's PATH at each spawn, never a recorded path. */
  readonly bunBin?: string;
  /** Default `/usr/bin/security`. */
  readonly securityBin?: string;
  /**
   * Read the macOS keychain. Off by default: the item naming and a no-prompt read are verified
   * on no Mac yet, so until the owner turns it on (config `authHealth.keychain`) a macOS
   * exclave reads `unknown/keychain_off` and nothing is read: Claude Code keeps a Mac's login in
   * the keychain and uses its plaintext file only when there is no item, so a file found beside
   * a keychain login can be a stale leftover and would read as a false `expired`.
   */
  readonly keychain?: boolean;
  readonly checkIntervalMs?: number;
  readonly minRereadMs?: number;
  readonly rereadMs?: number;
  readonly timeoutMs?: number;
  /**
   * Some exclave's state changed (a first read counts) and the reader has gone quiet: the daemon
   * sends a status now rather than at its next beat, so a restart's window of `au` (which still
   * routes) is one walk plus the status floor, not up to a whole beat.
   */
  readonly onChange?: () => void;
  /** Fixed-text lines only; default `log.info`. */
  readonly log?: (line: string) => void;
}

export interface AuthHealth {
  /** Reads every signed-in exclave now, then checks every `checkIntervalMs`. */
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  /** Something may have changed this exclave's login (a `/usage` run, a rescan): re-read it when the 60 s floor allows. */
  readonly poke: (exclaveId: string) => void;
  /**
   * By exclave id, an entry for every signed-in exclave: one not read yet is `unknown/pending`,
   * never `ok`, so a fresh daemon (restart, reload) cannot read as a clean bill of health.
   */
  readonly view: () => ReadonlyMap<string, AuthView>;
  readonly expired: (exclaveId: string) => boolean;
  /** Resolves once nothing is queued or running; for tests and shutdown. */
  readonly idle: () => Promise<void>;
}

type Reading =
  | { readonly kind: "read"; readonly lapsed: boolean; readonly refreshExpiresAt: number | null }
  | { readonly kind: "unknown"; readonly why: AuthUnknown };

interface Entry {
  reading: Reading | null;
  /** The credentials file's stamp before the last read; null on macOS, which has none. */
  marker: string | null;
  readAt: number | null;
  poked: boolean;
  logged: string | null;
}

/** Which child to run and what it needs; the scan only names an exclave. */
type Mode =
  | { readonly kind: "stdin" }
  | { readonly kind: "keychain"; readonly service: string; readonly account: string };

/** The child's whole environment. */
export function authEnv(home: string): Readonly<Record<string, string>> {
  return baseChildEnv(home);
}

/**
 * One child at a time in the whole process, not per instance: a config reload starts a
 * second daemon in process while the first one's read may still be going.
 */
let lane: Promise<unknown> = Promise.resolve();

function inLane<T>(run: () => Promise<T>): Promise<T> {
  const next = lane.then(run);
  lane = next.catch(() => undefined);
  return next;
}

/** Claude Code's keychain item name for an exclave (read from the 2.1.322 binary; verified on no Mac yet). */
export function keychainService(exclave: Exclave): string {
  if (exclave.id === DEFAULT_EXCLAVE) return KEYCHAIN_SERVICE;
  return `${KEYCHAIN_SERVICE}-${createHash("sha256").update(exclave.configDir).digest("hex").slice(0, 8)}`;
}

function keychainAccount(): string {
  const user = loginName();
  return user !== null && KEYCHAIN_ACCOUNT_PATTERN.test(user) ? user : KEYCHAIN_ACCOUNT_FALLBACK;
}

/** The child's stdout, exactly `{lapsed: boolean, refreshExpiresAt: a plausible ms epoch | null}` or nothing. */
function parseChildOutput(stdout: string): Extract<Reading, { kind: "read" }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes("lapsed") || !keys.includes("refreshExpiresAt")) return null;
  const { lapsed, refreshExpiresAt } = parsed;
  if (typeof lapsed !== "boolean") return null;
  if (refreshExpiresAt === null) return { kind: "read", lapsed, refreshExpiresAt: null };
  if (typeof refreshExpiresAt !== "number" || !Number.isFinite(refreshExpiresAt) || refreshExpiresAt < MIN_EXPIRY_MS) {
    return null;
  }
  return { kind: "read", lapsed, refreshExpiresAt };
}

function describeView(view: AuthView): string {
  return view.state === "unknown" ? `unknown why=${view.why}` : view.state;
}

export function createAuthHealth(deps: AuthHealthDeps): AuthHealth {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const securityBin = deps.securityBin ?? "/usr/bin/security";
  const keychain = deps.keychain === true;
  const keychainOff = platform === "darwin" && !keychain;
  const minRereadMs = deps.minRereadMs ?? MIN_REREAD_MS;
  const rereadMs = deps.rereadMs ?? (platform === "darwin" ? REREAD_DARWIN_MS : REREAD_LINUX_MS);
  const timeoutMs = deps.timeoutMs ?? READ_TIMEOUT_MS;
  const say = deps.log ?? ((line: string): void => log.info(line));
  const entries = new Map<string, Entry>();
  const queued: string[] = [];
  let draining: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let checking = false;
  /** The exclave whose read is running: no longer in `queued`, and not yet in `entries` on a first read. */
  let inFlight: string | null = null;
  let stopped = false;
  let running: number | null = null;
  let changed = false;

  const signedIn = (): readonly Exclave[] => {
    const scan = deps.scan();
    return scan.exclaves.filter((_, x) => scan.info[x]?.authOk === true);
  };

  const credentialsPath = (exclave: Exclave): string => join(exclave.configDir, ".credentials.json");

  const viewOf = (entry: Entry | undefined): AuthView => {
    const reading = entry?.reading ?? null;
    if (reading === null) return { state: "unknown", why: "pending" };
    if (reading.kind === "unknown") return { state: "unknown", why: reading.why };
    const at = reading.refreshExpiresAt;
    if (reading.lapsed || (at !== null && at <= now())) return { state: "expired" };
    if (at !== null && at - now() <= AUTH_EXPIRING_MS) return { state: "expiring", expiresAt: at };
    return { state: "ok" };
  };

  /** One line per state change, fixed text only: never what the child printed, never a path. */
  const noteChange = (id: string, entry: Entry): void => {
    const line = `auth: exclave=${id} state=${describeView(viewOf(entry))}`;
    if (entry.reading === null || entry.logged === line) return;
    entry.logged = line;
    changed = true;
    say(line);
  };

  /** Once the reader is quiet, not per exclave: a first walk over several is one nudge. */
  const settle = (): void => {
    if (!changed || stopped || draining !== null) return;
    changed = false;
    deps.onChange?.();
  };

  const markerOf = async (exclave: Exclave): Promise<string | null> => {
    if (platform === "darwin") return null;
    try {
      const s = await stat(credentialsPath(exclave));
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return "absent";
    }
  };

  const runChild = async (exclave: Exclave, mode: Mode, stdinFd?: number): Promise<Reading | "not_found"> => {
    const env = authEnv(deps.home);
    const bunBin = deps.bunBin ?? bunPathFor(Bun.which("bun", { PATH: env["PATH"] ?? "" }));
    const keychainMode = mode.kind === "keychain";
    // `exec` waits for stdout's EOF, which a setsid'd descendant can hold long after the kill; the lane
    // is process-wide, so one such child would leave every exclave `pending` for good. Past the kill
    // grace plus a second, the read is lost as a timeout and the lane moves on.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const abandoned = new Promise<"abandoned">((resolve) => {
      deadline = setTimeout(() => resolve("abandoned"), timeoutMs + KILL_AFTER_MS + HARD_DEADLINE_SLACK_MS);
    });
    const ran = exec(
      [
        bunBin,
        "--no-env-file",
        "--no-install",
        "-e",
        AUTH_READ_SCRIPT,
        mode.kind,
        keychainMode ? securityBin : "",
        keychainMode ? mode.service : "",
        keychainMode ? mode.account : "",
      ],
      {
        cwd: "/",
        env,
        bareEnv: true,
        killGroup: true,
        killAfterMs: KILL_AFTER_MS,
        timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        discardStderr: true,
        ...(stdinFd === undefined ? {} : { stdinFd }),
        onSpawn: (pid) => {
          running = pid;
        },
        onExit: () => {
          running = null;
        },
      },
    ).catch(() => "spawn" as const);
    const result = await Promise.race([ran, abandoned]).finally(() => {
      clearTimeout(deadline);
      running = null;
    });
    if (result === "spawn") return { kind: "unknown", why: "spawn" };
    if (result === "abandoned" || result.timedOut) return { kind: "unknown", why: "timeout" };
    if (keychainMode && result.exitCode === KEYCHAIN_NOT_FOUND) return "not_found";
    if (result.exitCode !== 0)
      return { kind: "unknown", why: keychainMode && result.exitCode === KEYCHAIN_FAILED ? "keychain" : "output" };
    return parseChildOutput(result.stdout) ?? { kind: "unknown", why: "output" };
  };

  /** The file, by descriptor: the daemon opens it and never reads a byte. */
  const readFile = async (exclave: Exclave): Promise<Reading> => {
    // Opened first and judged by descriptor, so what is checked is what the child is handed: a path
    // swapped between a stat and an open could otherwise bring a larger file, or a FIFO whose open blocks
    // (O_NONBLOCK: it returns at once, and is refused as not a regular file).
    let handle;
    try {
      handle = await open(credentialsPath(exclave), constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (err) {
      const code = isRecord(err) ? err["code"] : undefined;
      return { kind: "unknown", why: code === "ENOENT" ? "absent" : "unreadable" };
    }
    try {
      const s = await handle.stat().catch(() => null);
      if (s === null || !s.isFile()) return { kind: "unknown", why: "unreadable" };
      if (s.size > MAX_CREDENTIALS_BYTES) return { kind: "unknown", why: "too_large" };
      const reading = await runChild(exclave, { kind: "stdin" }, handle.fd);
      return reading === "not_found" ? { kind: "unknown", why: "output" } : reading;
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  const readOnce = async (exclave: Exclave): Promise<Reading> => {
    if (keychainOff) return { kind: "unknown", why: "keychain_off" };
    if (platform !== "darwin") return readFile(exclave);
    const reading = await runChild(exclave, {
      kind: "keychain",
      service: keychainService(exclave),
      account: keychainAccount(),
    });
    // No keychain item: Claude Code falls back to its plaintext file there.
    return reading === "not_found" ? readFile(exclave) : reading;
  };

  const attempt = async (id: string): Promise<void> => {
    if (stopped) return;
    const exclave = signedIn().find((x) => x.id === id);
    if (exclave === undefined) return;
    const entry = entries.get(id);
    // Floored, not skipped: a poke inside the floor stays set and the next check re-queues it.
    if (entry?.readAt !== undefined && entry.readAt !== null && now() - entry.readAt < minRereadMs) return;
    inFlight = id;
    try {
      const marker = await markerOf(exclave);
      const reading = await readOnce(exclave);
      if (stopped) return;
      const next: Entry = entry ?? { reading: null, marker: null, readAt: null, poked: false, logged: null };
      next.reading = reading;
      next.marker = marker;
      next.readAt = now();
      next.poked = false;
      entries.set(id, next);
      noteChange(id, next);
    } finally {
      inFlight = null;
    }
  };

  const drain = (): void => {
    if (draining !== null) return;
    draining = (async (): Promise<void> => {
      try {
        for (;;) {
          const id = queued.shift();
          if (id === undefined || stopped) return;
          // oxlint-disable-next-line no-await-in-loop -- one child at a time is the point
          await inLane(() => attempt(id)).catch(() => undefined);
        }
      } finally {
        draining = null;
        settle();
      }
    })();
  };

  const enqueue = (id: string): void => {
    if (stopped || queued.includes(id)) return;
    queued.push(id);
    drain();
  };

  const isDue = async (exclave: Exclave, entry: Entry | undefined): Promise<boolean> => {
    if (entry === undefined || entry.reading === null || entry.readAt === null) return true;
    if (entry.poked) return true;
    const age = now() - entry.readAt;
    if (age >= rereadMs) return true;
    const { reading } = entry;
    if (reading.kind === "unknown" && !STRUCTURAL.has(reading.why) && age >= Math.min(rereadMs, RETRY_UNKNOWN_MS)) {
      return true;
    }
    return entry.marker !== null && (await markerOf(exclave)) !== entry.marker;
  };

  const check = async (): Promise<void> => {
    if (checking || stopped) return;
    checking = true;
    try {
      const present = signedIn();
      const ids = new Set(present.map((x) => x.id));
      for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
      for (const exclave of present) {
        const entry = entries.get(exclave.id);
        if (entry !== undefined) noteChange(exclave.id, entry);
        const readAt = entry?.readAt;
        // oxlint-disable-next-line no-await-in-loop -- a stat each
        const due = await isDue(exclave, entry);
        // Judged after the stat, which a read may overtake: a check landing mid-read, or on one that landed
        // meanwhile, would find no entry (or the old one) and read the exclave twice over.
        const overtaken = inFlight === exclave.id || entries.get(exclave.id)?.readAt !== readAt;
        if (due && !overtaken) enqueue(exclave.id);
      }
    } finally {
      checking = false;
      // A state the clock flipped (an expiry passing) with no read behind it.
      settle();
    }
  };

  return {
    start: (): void => {
      if (stopped || timer !== null) return;
      timer = setInterval(() => void check(), deps.checkIntervalMs ?? CHECK_INTERVAL_MS);
      void check();
    },
    stop: async (): Promise<void> => {
      stopped = true;
      queued.length = 0;
      if (timer !== null) clearInterval(timer);
      timer = null;
      const pid = running;
      if (pid !== null) {
        try {
          // A read-only child with nothing to corrupt: no TERM grace needed.
          process.kill(-pid, "SIGKILL");
        } catch {
          // group already gone
        }
      }
      // oxlint-disable-next-line no-await-in-loop -- a drain begun while waiting is waited for too
      for (let pending = draining; pending !== null; pending = draining) await pending;
    },
    poke: (id: string): void => {
      if (stopped) return;
      const entry = entries.get(id);
      if (entry !== undefined) entry.poked = true;
      enqueue(id);
    },
    view: (): ReadonlyMap<string, AuthView> => {
      const view = new Map<string, AuthView>();
      for (const exclave of signedIn()) view.set(exclave.id, viewOf(entries.get(exclave.id)));
      return view;
    },
    expired: (id: string): boolean => viewOf(entries.get(id)).state === "expired",
    idle: async (): Promise<void> => {
      // oxlint-disable-next-line no-await-in-loop -- a drain begun while waiting is waited for too
      for (let pending = draining; pending !== null; pending = draining) await pending;
    },
  };
}
