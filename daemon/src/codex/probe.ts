import { AGENT_LOGIN_TEXT_MAX, isRecord, TASK_SPEC_LIMITS, type QuotaReading, type ScopedWindow } from "@seance/shared";
import { childEnv, exec } from "../exec.ts";

/**
 * The Codex probe (docs/codex.md, "Quota", "Login health"; DESIGN.md, Daemon, "Codex login"): `codex --version`, then a
 * `codex app-server` child on stdio that answers `account/read` and `account/rateLimits/read` from the machine's home.
 * Identity, quota, credits and login health all come from those two answers, never from the home's files. The answers
 * may carry account data, so nothing either child writes reaches a log, and no error message is kept past the one
 * fixed test that tells an expired login from any other failure.
 */

/** The version the spikes ran (S1–S9): 0.166.0's `account/read` has no `userId`. */
export const CODEX_MIN_VERSION = "0.170.0";

export const PROBE_TIMEOUT_MS = 30_000;
export const PROBE_KILL_AFTER_MS = 5_000;
const VERSION_TIMEOUT_MS = 10_000;
/** The whole conversation's stdout; a probe past it is a failure, never a partial read. */
export const PROBE_OUTPUT_CAP_BYTES = 64 * 1024;
/** Scoped weekly windows kept from `rateLimitsByLimitId`; one per model the backend caps on its own. */
const SCOPED_WINDOWS_MAX = 8;
/** A model slug, as `w[].m`: what `windowAppliesTo` matches a task's model against. */
const MODEL_SLUG_MAX = 64;

/** `clientInfo.version`: Codex records the client, and the daemon has no version of its own but its sha. */
const CLIENT_VERSION = "1";

const FIVE_HOURS_MINS = 300;
const SEVEN_DAYS_MINS = 10_080;

/** JSON-RPC's "invalid request": Codex answers it, with no network call, for a home that holds no usable login (S4). */
const SIGNED_OUT_CODE = -32_600;
/** JSON-RPC's "internal error": among others, the backend refusing the login, which Codex quotes as below (S4). */
const INTERNAL_ERROR_CODE = -32_603;
const UNAUTHORIZED_TEXT = "401 Unauthorized";

/** The backend's own reasons the account cannot spend credits now (`RateLimitReachedType`). */
const CREDITS_BLOCKED = new Set([
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

const VERSION_PATTERN = /\b(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.-]{1,32})?\b/u;

/** `codex --version`'s `codex-cli 0.170.0` → `0.170.0`; null for anything without a version in it. */
export function parseCodexVersion(stdout: string): string | null {
  const match = VERSION_PATTERN.exec(stdout);
  return match === null ? null : match[0];
}

/** Semver order on the numeric triple; a prerelease of the floor itself is below it. */
export function versionAtLeast(version: string, floor: string = CODEX_MIN_VERSION): boolean {
  const a = VERSION_PATTERN.exec(version);
  const b = VERSION_PATTERN.exec(floor);
  if (a === null || b === null) return false;
  for (const i of [1, 2, 3]) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) return diff > 0;
  }
  return a[4] === undefined || b[4] !== undefined;
}

/** One JSON-RPC answer, an error reduced to its code and the one fact the health test needs. */
export type RpcAnswer =
  | { readonly kind: "result"; readonly value: unknown }
  | { readonly kind: "error"; readonly code: number | null; readonly unauthorized: boolean };

export type AppServerOutcome =
  | { readonly kind: "answered"; readonly account: RpcAnswer; readonly rateLimits: RpcAnswer }
  | { readonly kind: "failed"; readonly reason: "spawn" | "timeout" | "exited" | "oversized" };

export interface AppServerOpts {
  readonly bin: string;
  /** The child's whole environment (`codexEnv`): it is built bare. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly killAfterMs?: number;
  /** The child's pid, as soon as it exists, so `stop` can kill its group. */
  readonly onSpawn?: (pid: number) => void;
  /** Called once the child is reaped: its pid is no longer the caller's to signal. */
  readonly onExit?: () => void;
}

function answerOf(message: Record<string, unknown>): RpcAnswer {
  const error = message["error"];
  if (isRecord(error)) {
    const code = typeof error["code"] === "number" ? error["code"] : null;
    const text = typeof error["message"] === "string" ? error["message"] : "";
    return { kind: "error", code, unauthorized: text.includes(UNAUTHORIZED_TEXT) };
  }
  return { kind: "result", value: message["result"] };
}

/**
 * The conversation, driven line by line: Codex's app-server exits at EOF on stdin without answering what it has not
 * answered yet, so the requests cannot go up front with stdin closed behind them (`exec`'s shape). `initialize`, then
 * `initialized` and both reads, then stdin closed. Its own process group, killed at the timeout (TERM, then KILL),
 * and swept by group once the leader is reaped, so a helper Codex forked cannot outlive it.
 */
export async function converseAppServer(opts: AppServerOpts): Promise<AppServerOutcome> {
  let proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
  try {
    proc = Bun.spawn([opts.bin, "app-server"], {
      cwd: opts.cwd,
      env: childEnv(opts.env, true),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
    });
  } catch {
    return { kind: "failed", reason: "spawn" };
  }
  const pid = proc.pid;
  const signal = (sig: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      // group already gone
    }
  };
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
    signal("SIGKILL");
    opts.onExit?.();
  });
  try {
    opts.onSpawn?.(pid);
  } catch (err) {
    signal("SIGKILL");
    throw err;
  }

  const send = (message: Record<string, unknown>): void => {
    try {
      void proc.stdin.write(`${JSON.stringify(message)}\n`);
      void proc.stdin.flush();
    } catch {
      // the child is gone; its exit ends the read below
    }
  };
  const close = (): void => {
    try {
      void proc.stdin.end();
    } catch {
      // already closed
    }
  };

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    close();
    signal("SIGTERM");
    killTimer = setTimeout(() => {
      if (!exited) signal("SIGKILL");
    }, opts.killAfterMs ?? PROBE_KILL_AFTER_MS);
  }, opts.timeoutMs ?? PROBE_TIMEOUT_MS);

  const answers = new Map<number, RpcAnswer>();
  let oversized = false;
  send({
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "seance", title: null, version: CLIENT_VERSION }, capabilities: null },
  });
  try {
    const decoder = new TextDecoder();
    let pending = "";
    let read = 0;
    for await (const chunk of proc.stdout) {
      read += chunk.length;
      if (read > PROBE_OUTPUT_CAP_BYTES) {
        oversized = true;
        close();
        signal("SIGTERM");
        break;
      }
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        // Notifications (`remoteControl/status/changed`, …) carry no id and are not ours to read.
        if (!isRecord(message) || typeof message["id"] !== "number" || answers.has(message["id"])) continue;
        const id = message["id"];
        answers.set(id, answerOf(message));
        if (id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/read", params: { refreshToken: false } });
          send({ id: 3, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
        }
      }
      if (answers.has(2) && answers.has(3)) {
        close();
        break;
      }
    }
  } catch {
    // a read error is the child gone: what was answered decides below
  }
  const account = answers.get(2);
  const rateLimits = answers.get(3);
  // Waited for, not raced: once stdin is closed the child exits at once, and the timer above bounds a child that does not.
  await proc.exited;
  clearTimeout(timer);
  clearTimeout(killTimer);
  if (oversized) return { kind: "failed", reason: "oversized" };
  if (account !== undefined && rateLimits !== undefined) return { kind: "answered", account, rateLimits };
  return { kind: "failed", reason: timedOut ? "timeout" : "exited" };
}

export type VersionReading =
  | { readonly kind: "version"; readonly version: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" };

/** `codex --version`, with the probe's environment and group rules; `missing` when the binary could not be run. */
export async function readCodexVersion(
  bin: string,
  env: Readonly<Record<string, string>>,
  cwd: string,
  onSpawn?: (pid: number) => void,
  onExit?: () => void,
): Promise<VersionReading> {
  const result = await exec([bin, "--version"], {
    cwd,
    env,
    bareEnv: true,
    killGroup: true,
    killAfterMs: PROBE_KILL_AFTER_MS,
    sweepGroup: true,
    timeoutMs: VERSION_TIMEOUT_MS,
    discardStderr: true,
    maxOutputBytes: 4096,
    ...(onSpawn === undefined ? {} : { onSpawn }),
    ...(onExit === undefined ? {} : { onExit }),
  }).catch(() => null);
  if (result === null) return { kind: "missing" };
  const version = result.exitCode === 0 ? parseCodexVersion(result.stdout) : null;
  return version === null ? { kind: "unreadable" } : { kind: "version", version };
}

/** What `account/read` says, kept: the user half of the id and the display fields. */
export interface AccountRead {
  readonly userId: string | null;
  readonly email?: string;
  readonly plan?: string;
  readonly workspace?: string;
}

/** A display string, or nothing: bounded, non-empty, and no control or format character (it reaches a screen). */
function displayText(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "" || value.length > AGENT_LOGIN_TEXT_MAX) return undefined;
  return /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(value) ? undefined : value;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Null when the answer lacks a field it must carry; any field this does not keep is ignored. */
export function parseAccountRead(value: unknown): AccountRead | null {
  if (!isRecord(value) || !isNullableString(value["userId"])) return null;
  const account = value["account"];
  if (account !== null && !isRecord(account)) return null;
  const userId = value["userId"];
  if (account === null || account["type"] !== "chatgpt") return { userId };
  const email = displayText(account["email"]);
  const plan = displayText(account["planType"]);
  const workspace = displayText(account["workspaceName"]);
  return {
    userId,
    ...(email === undefined ? {} : { email }),
    ...(plan === undefined ? {} : { plan }),
    ...(workspace === undefined ? {} : { workspace }),
  };
}

interface Window {
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
  readonly resetsAt: number | null;
}

interface Snapshot {
  readonly normalModelSlug: string | null;
  readonly windows: readonly Window[];
  readonly credits: { readonly hasCredits: boolean; readonly unlimited: boolean } | null;
  readonly memberRemainingPercent: number | null;
  readonly spendControlReached: boolean;
  readonly reachedType: string | null;
}

/** What `account/rateLimits/read` says, kept. */
export interface RateLimitsRead {
  readonly accountId: string | null;
  /** The backend's word that included usage is blocked; `null` (not said) is not `false`. */
  readonly ordinaryUsageAllowed: boolean | null;
  readonly main: Snapshot;
  readonly buckets: readonly Snapshot[];
}

function isFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseWindow(value: unknown): Window | null | undefined {
  if (value === null) return undefined;
  if (!isRecord(value) || !isFinite(value["usedPercent"])) return null;
  const { windowDurationMins, resetsAt } = value;
  if (windowDurationMins !== null && !isFinite(windowDurationMins)) return null;
  if (resetsAt !== null && !isFinite(resetsAt)) return null;
  return { usedPercent: value["usedPercent"], windowDurationMins, resetsAt };
}

function parseSnapshot(value: unknown): Snapshot | null {
  if (!isRecord(value)) return null;
  const { normalModelSlug, credits, individualLimit, spendControlReached, rateLimitReachedType } = value;
  if (!isNullableString(normalModelSlug) || !isNullableString(rateLimitReachedType)) return null;
  if (spendControlReached !== null && typeof spendControlReached !== "boolean") return null;
  const windows: Window[] = [];
  for (const key of ["primary", "secondary"]) {
    const window = parseWindow(value[key]);
    if (window === null) return null;
    if (window !== undefined) windows.push(window);
  }
  let parsedCredits: Snapshot["credits"] = null;
  if (credits !== null) {
    if (!isRecord(credits) || typeof credits["hasCredits"] !== "boolean" || typeof credits["unlimited"] !== "boolean") {
      return null;
    }
    parsedCredits = { hasCredits: credits["hasCredits"], unlimited: credits["unlimited"] };
  }
  let memberRemainingPercent: number | null = null;
  if (individualLimit !== null) {
    if (!isRecord(individualLimit) || !isFinite(individualLimit["remainingPercent"])) return null;
    memberRemainingPercent = individualLimit["remainingPercent"];
  }
  return {
    normalModelSlug,
    windows,
    credits: parsedCredits,
    memberRemainingPercent,
    spendControlReached: spendControlReached === true,
    reachedType: rateLimitReachedType,
  };
}

export function parseRateLimits(value: unknown): RateLimitsRead | null {
  if (!isRecord(value)) return null;
  const { accountId, ordinaryUsageAllowed, rateLimitsByLimitId } = value;
  if (!isNullableString(accountId)) return null;
  if (ordinaryUsageAllowed !== null && typeof ordinaryUsageAllowed !== "boolean") return null;
  const main = parseSnapshot(value["rateLimits"]);
  if (main === null) return null;
  const buckets: Snapshot[] = [];
  if (rateLimitsByLimitId !== null && rateLimitsByLimitId !== undefined) {
    if (!isRecord(rateLimitsByLimitId)) return null;
    for (const bucket of Object.values(rateLimitsByLimitId)) {
      const snapshot = parseSnapshot(bucket);
      if (snapshot === null) return null;
      buckets.push(snapshot);
    }
  }
  return { accountId, ordinaryUsageAllowed, main, buckets };
}

/** `codex:<account>:<user>`, or null when either half is missing or the whole would not pass `isAccountId`. */
export function codexAccountId(accountId: string | null, userId: string | null): string | null {
  if (accountId === null || userId === null || accountId === "" || userId === "") return null;
  const id = `codex:${accountId}:${userId}`;
  return id.length > TASK_SPEC_LIMITS.account ? null : id;
}

const percent = (used: number): number => Math.max(0, Math.round(used));
const unixSeconds = (at: number | null): number | undefined => (at === null || at < 0 ? undefined : Math.floor(at));

/** The credits the account has, and whether it can spend them now ("Credits and spill"). */
export interface CreditView {
  /** `AgentLogin.credits`: the account has credits or unlimited use, whether or not a limit stops it now. */
  readonly credits: boolean;
  /** `c`, only beside `credits`: the member limit's spent percent, else 0 while it can spend and 100 once it cannot. */
  readonly c?: number;
}

export function creditView(read: RateLimitsRead): CreditView {
  const { credits, memberRemainingPercent, spendControlReached, reachedType } = read.main;
  if (credits === null || !(credits.hasCredits || credits.unlimited)) return { credits: false };
  if (memberRemainingPercent !== null) return { credits: true, c: percent(100 - memberRemainingPercent) };
  const blocked = spendControlReached || (reachedType !== null && CREDITS_BLOCKED.has(reachedType));
  return { credits: true, c: blocked ? 100 : 0 };
}

/** The quota reading, mapped by window length, never position; any other length is dropped. */
export function quotaReadingOf(read: RateLimitsRead, at: number): QuotaReading {
  let h: number | undefined;
  let d: number | undefined;
  let hr: number | undefined;
  let dr: number | undefined;
  for (const window of read.main.windows) {
    if (window.windowDurationMins === FIVE_HOURS_MINS) {
      h = percent(window.usedPercent);
      hr = unixSeconds(window.resetsAt);
    } else if (window.windowDurationMins === SEVEN_DAYS_MINS) {
      d = percent(window.usedPercent);
      dr = unixSeconds(window.resetsAt);
    }
  }
  const w: ScopedWindow[] = [];
  for (const bucket of read.buckets) {
    const slug = bucket.normalModelSlug;
    if (slug === null || slug === "" || slug.length > MODEL_SLUG_MAX || w.length >= SCOPED_WINDOWS_MAX) continue;
    const weekly = bucket.windows.find((window) => window.windowDurationMins === SEVEN_DAYS_MINS);
    if (weekly === undefined) continue;
    const r = unixSeconds(weekly.resetsAt);
    w.push({ m: slug, p: percent(weekly.usedPercent), ...(r === undefined ? {} : { r }) });
  }
  const { c } = creditView(read);
  return {
    s: "cache",
    at,
    ...(h === undefined ? {} : { h }),
    ...(d === undefined ? {} : { d }),
    ...(hr === undefined ? {} : { hr }),
    ...(dr === undefined ? {} : { dr }),
    ...(w.length === 0 ? {} : { w }),
    ...(c === undefined ? {} : { c }),
  };
}

/** Why a probe read nothing; categories only, since the child's words may carry account data. */
export type ProbeFailure =
  | "missing"
  | "unreadable_version"
  | "outdated"
  | "spawn"
  | "timeout"
  | "exited"
  | "oversized"
  | "malformed"
  | "refused";

export type ProbeResult =
  | {
      readonly health: "ok";
      readonly version: string;
      readonly accountId: string | null;
      readonly display: Omit<AccountRead, "userId">;
      readonly quota: QuotaReading;
      readonly credits: boolean;
      readonly blocked: boolean;
    }
  | { readonly health: "signed_out"; readonly version: string }
  | { readonly health: "expired"; readonly version: string }
  | { readonly health: "unknown"; readonly version: string | null; readonly failure: ProbeFailure };

/** The two answers, read into a health and what each health keeps. */
export function probeResultOf(
  version: string,
  account: RpcAnswer,
  rateLimits: RpcAnswer,
  atSeconds: number,
): ProbeResult {
  if (rateLimits.kind === "error") {
    if (rateLimits.code === SIGNED_OUT_CODE) return { health: "signed_out", version };
    if (rateLimits.code === INTERNAL_ERROR_CODE && rateLimits.unauthorized) return { health: "expired", version };
    return { health: "unknown", version, failure: "refused" };
  }
  const limits = parseRateLimits(rateLimits.value);
  if (limits === null) return { health: "unknown", version, failure: "malformed" };
  // The login works; a failed or odd `account/read` leaves it unidentified, never unknown ("Identity").
  const read = account.kind === "result" ? parseAccountRead(account.value) : null;
  const { userId, ...display } = read ?? { userId: null };
  return {
    health: "ok",
    version,
    accountId: codexAccountId(limits.accountId, userId),
    display,
    quota: quotaReadingOf(limits, atSeconds),
    credits: creditView(limits).credits,
    blocked: limits.ordinaryUsageAllowed === false,
  };
}

export interface ProbeOpts {
  readonly bin: string;
  readonly env: Readonly<Record<string, string>>;
  readonly home: string;
  readonly now: () => number;
  readonly timeoutMs?: number;
  readonly killAfterMs?: number;
  readonly onSpawn?: (pid: number) => void;
  readonly onExit?: () => void;
}

/** One probe: the version, held to the floor, then the conversation. A binary below the floor is never run further. */
export async function probeCodex(opts: ProbeOpts): Promise<ProbeResult> {
  const reading = await readCodexVersion(opts.bin, opts.env, opts.home, opts.onSpawn, opts.onExit);
  if (reading.kind === "missing") return { health: "unknown", version: null, failure: "missing" };
  if (reading.kind === "unreadable") return { health: "unknown", version: null, failure: "unreadable_version" };
  const { version } = reading;
  if (!versionAtLeast(version)) return { health: "unknown", version, failure: "outdated" };
  const outcome = await converseAppServer({
    bin: opts.bin,
    env: opts.env,
    cwd: opts.home,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.killAfterMs === undefined ? {} : { killAfterMs: opts.killAfterMs }),
    ...(opts.onSpawn === undefined ? {} : { onSpawn: opts.onSpawn }),
    ...(opts.onExit === undefined ? {} : { onExit: opts.onExit }),
  });
  if (outcome.kind === "failed") return { health: "unknown", version, failure: outcome.reason };
  return probeResultOf(version, outcome.account, outcome.rateLimits, Math.floor(opts.now() / 1000));
}
