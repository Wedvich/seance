import { versionAtLeast, type AgentLogin, type QuotaReading } from "@seance/shared";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { codexBin, codexEnv, ownerCodexAuth, prepareCodexHome } from "./home.ts";
import {
  creditView,
  parseRateLimits,
  probeCodex,
  quotaReadingOf,
  type ProbeFailure,
  type ProbeResult,
} from "./probe.ts";
import { log } from "../log.ts";
import { inRefreshLane } from "../refresh-lane.ts";
import { readRemote, remotePath } from "./remote.ts";
import { CHECK_INTERVAL_MS, DEBOUNCE_MS, STALE_AFTER_MS } from "../usage-refresh.ts";

/**
 * The machine's Codex login as the daemon knows it (docs/codex.md, "The account"; DESIGN.md, Daemon, "Codex login"):
 * the probe's last answers, the `AgentLogin` the register blob carries and the health the status carries. One login
 * per machine in V1, so one instance per daemon, built only when `config.json` has a `codex` block.
 */

/** `ok` read a quota; `signed_out` and `expired` are the backend's word; `unknown` is anything else, or no probe yet. */
export type LoginHealth = "ok" | "signed_out" | "expired" | "unknown";

/** What a `status` tick reads: `lq`, and which of `lx`, `lu`, `lb` the login is in. */
export interface LoginView {
  readonly health: LoginHealth;
  /** The last reading, kept through `unknown` (its `at` says how old it is) and dropped by any other health. */
  readonly quota: QuotaReading | null;
  /** `ordinaryUsageAllowed: false` at the last `ok` reading. */
  readonly blocked: boolean;
}

export interface CodexAccountOpts {
  /** Floored at `DEBOUNCE_MS`, as the usage refresh's: config refuses less, but callers pass ms directly. */
  readonly staleAfterMs?: number;
  readonly checkIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly killAfterMs?: number;
  /** Defaults to `codexBin()`: `SEANCE_CODEX_BIN`, else the bare name through `PATH`. */
  readonly bin?: string;
  /** Wall clock: a reading's `at` is compared with readers' clocks. */
  readonly now?: () => number;
}

export interface CodexAccountDeps extends CodexAccountOpts {
  /** The Codex home (`codexHome()`), already prepared. */
  readonly home: string;
  /** The daemon's home: the children's `HOME`. */
  readonly userHome: string;
  /** The register blob's view changed (identity, `authOk`, credits, version): re-register. */
  readonly onInfoChange: () => void;
  /** The status's view changed (health, a new reading): send a status now. */
  readonly onStatusChange: () => void;
  /** `remote.json`, the owner's pairing note (`remote.ts`). */
  readonly remotePath: string;
  /** The home's pairing changed: the remote-control slot is offered or taken back. */
  readonly onPairedChange?: () => void;
}

export interface CodexAccount {
  /** The prepared home (`codexHome()`): what a session's server must answer it runs on. */
  readonly home: string;
  /** The register blob's entry. */
  readonly login: () => AgentLogin;
  readonly view: () => LoginView;
  /** Whether `remote.json` says the home is paired, as last read: display (`AgentLogin.paired`) and the slot's offer. */
  readonly paired: () => boolean;
  /**
   * A running session's own `account/rateLimits/read` answer (`codex/sessions.ts`), over its pane's server on this
   * home: taken as a probe's reading while the login reads `ok` and the answer names the same account, and the next
   * probe waits its full stale interval from now. Anything else is dropped: never a health, never an identity.
   */
  readonly observe: (value: unknown) => void;
  /** Probes now, then whenever due on the timer. */
  readonly start: () => void;
  /** Stops the timer and kills a probe in flight by group. */
  readonly stop: () => void;
  /** Resolves once no probe is queued or running; for tests and shutdown. */
  readonly idle: () => Promise<void>;
}

/**
 * A signature of the credential file's metadata (inode, size, mtime), or `none`: what tells a sign-in or a sign-out
 * apart from nothing at all, so a signed-out or expired login is probed again only when its file changed. `lstat` reads
 * the directory entry, never the file: the daemon opens no Codex credential, not even to look.
 */
async function authSignature(home: string): Promise<string> {
  const stat = await lstat(join(home, "auth.json")).catch(() => null);
  return stat === null ? "none" : `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

const FAILURE_TEXT: Readonly<Record<ProbeFailure, string>> = {
  missing: "codex is not on PATH",
  unreadable_version: "codex --version printed no version",
  outdated: "codex is older than the floor",
  spawn: "codex app-server could not start",
  timeout: "codex app-server timed out",
  exited: "codex app-server exited before answering",
  oversized: "codex app-server answered past the output cap",
  malformed: "codex app-server's answer had an unexpected shape",
  refused: "codex app-server refused the rate-limit read",
};

export function createCodexAccount(deps: CodexAccountDeps): CodexAccount {
  const now = deps.now ?? Date.now;
  const staleAfterMs = Math.max(deps.staleAfterMs ?? STALE_AFTER_MS, DEBOUNCE_MS);
  const bin = deps.bin ?? codexBin();
  const env = codexEnv(deps.home, deps.userHome);

  let health: LoginHealth = "unknown";
  let quota: QuotaReading | null = null;
  let blocked = false;
  let version: string | null = null;
  let identity: Pick<AgentLogin, "accountId" | "email" | "plan" | "workspace"> = { accountId: null };
  let authOk = false;
  let credits = false;
  let attemptedAt: number | null = null;
  let signature: string | null = null;
  let failure: ProbeFailure | null = null;
  let paired = false;
  /** `AgentLogin.ownerHome`: looked up only while signed out, false in any other health. */
  let ownerHome = false;
  let pairing: Promise<void> | null = null;

  let running: number | null = null;
  let probing: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const login = (): AgentLogin => ({
    agent: "codex",
    accountId: identity.accountId,
    ...(identity.email === undefined ? {} : { email: identity.email }),
    ...(identity.plan === undefined ? {} : { plan: identity.plan }),
    ...(identity.workspace === undefined ? {} : { workspace: identity.workspace }),
    authOk,
    ...(credits ? { credits: true } : {}),
    ...(paired ? { paired: true } : {}),
    ...(ownerHome ? { ownerHome: true } : {}),
    ...(version === null ? {} : { version }),
  });
  const view = (): LoginView => ({ health, quota, blocked });

  /** `owner`: `ownerCodexAuth`'s answer, asked only for a signed-out result. */
  const apply = (result: ProbeResult, owner: boolean): void => {
    const infoBefore = JSON.stringify(login());
    const viewBefore = JSON.stringify(view());
    const healthBefore = health;
    if (result.version !== null) version = result.version;
    health = result.health;
    // `unknown` keeps it with everything else it knew.
    if (result.health !== "unknown") ownerHome = result.health === "signed_out" && owner;
    if (result.health === "ok") {
      identity = { accountId: result.accountId, ...result.display };
      authOk = true;
      credits = result.credits;
      quota = result.quota;
      blocked = result.blocked;
    } else if (result.health === "signed_out") {
      identity = { accountId: null };
      authOk = false;
      credits = false;
      quota = null;
      blocked = false;
    } else if (result.health === "expired") {
      // Still signed in by its file, refused by the backend: the identity stays, as a Claude exclave's does in `ax`.
      authOk = true;
      quota = null;
      blocked = false;
    }
    // `unknown` keeps everything it last knew: one failed read is not a sign-out.

    if (result.health === "unknown") {
      if (failure !== result.failure) log.warn(`codex login: probe failed (${FAILURE_TEXT[result.failure]})`);
      failure = result.failure;
    } else {
      if (failure !== null) log.info("codex login: probe answered again");
      failure = null;
      if (healthBefore !== result.health) log.info(`codex login: ${result.health.replace("_", " ")}`);
    }
    if (JSON.stringify(login()) !== infoBefore) deps.onInfoChange();
    if (JSON.stringify(view()) !== viewBefore) deps.onStatusChange();
  };

  const attempt = async (): Promise<void> => {
    if (stopped) return;
    const startedAt = now();
    attemptedAt = startedAt;
    signature = await authSignature(deps.home);
    if (stopped) return;
    const result = await probeCodex({
      bin,
      env,
      home: deps.home,
      now,
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      ...(deps.killAfterMs === undefined ? {} : { killAfterMs: deps.killAfterMs }),
      onSpawn: (pid) => {
        // A child spawned after `stop` would be no one's to kill: refusing it here kills it at once.
        if (stopped) throw new Error("stopped");
        running = pid;
      },
      onExit: () => {
        running = null;
      },
    });
    running = null;
    if (stopped) return;
    const owner = result.health === "signed_out" && (await ownerCodexAuth(deps.userHome));
    if (stopped) return;
    apply(result, owner);
  };

  const due = async (): Promise<boolean> => {
    if (attemptedAt === null) return true;
    // A sign-in, a sign-out or Codex's own refresh rewrote the file: whatever the health, read it now.
    if ((await authSignature(deps.home)) !== signature) return true;
    if (health === "signed_out") {
      // A plain `codex login` or logout in the owner's home changes the hint, never Séance's login: no probe.
      const owner = await ownerCodexAuth(deps.userHome);
      if (!stopped && health === "signed_out" && owner !== ownerHome) {
        ownerHome = owner;
        deps.onInfoChange();
      }
      return false;
    }
    if (health === "expired") return false;
    return now() - attemptedAt >= staleAfterMs;
  };

  /** A file read, never a probe: outside the refresh lane, at each tick. */
  const readPaired = (): void => {
    if (stopped || pairing !== null) return;
    pairing = (async (): Promise<void> => {
      try {
        const found = (await readRemote(deps.remotePath)) !== null;
        if (stopped || found === paired) return;
        paired = found;
        log.info(`codex login: ${paired ? "paired with a phone" : "not paired"}`);
        deps.onInfoChange();
        deps.onPairedChange?.();
      } finally {
        pairing = null;
      }
    })();
  };

  const check = (): void => {
    readPaired();
    if (stopped || probing !== null) return;
    probing = (async (): Promise<void> => {
      try {
        if (await due()) await inRefreshLane(attempt);
      } catch (err) {
        if (!stopped) log.warn(`codex login: ${String(err)}`);
      } finally {
        probing = null;
      }
    })();
  };

  const observe = (value: unknown): void => {
    if (stopped || health !== "ok" || identity.accountId === null) return;
    const read = parseRateLimits(value);
    // The account half only: the answer names no user, and the identity's user half came from `account/read`.
    if (read === null || read.accountId === null) return;
    if (!identity.accountId.startsWith(`codex:${read.accountId}:`)) return;
    const infoBefore = JSON.stringify(login());
    const viewBefore = JSON.stringify(view());
    attemptedAt = now();
    quota = quotaReadingOf(read, Math.floor(now() / 1000));
    credits = creditView(read).credits;
    blocked = read.ordinaryUsageAllowed === false;
    if (JSON.stringify(login()) !== infoBefore) deps.onInfoChange();
    if (JSON.stringify(view()) !== viewBefore) deps.onStatusChange();
  };

  return {
    home: deps.home,
    login,
    view,
    paired: () => paired,
    observe,
    start: (): void => {
      if (stopped || timer !== null) return;
      timer = setInterval(check, deps.checkIntervalMs ?? CHECK_INTERVAL_MS);
      check();
    },
    stop: (): void => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      const pid = running;
      if (pid === null) return;
      const signal = (sig: "SIGTERM" | "SIGKILL"): void => {
        try {
          process.kill(-pid, sig);
        } catch {
          // group already gone
        }
      };
      signal("SIGTERM");
      setTimeout(() => {
        if (running === pid) signal("SIGKILL");
      }, deps.killAfterMs ?? 5_000).unref();
    },
    idle: async (): Promise<void> => {
      // oxlint-disable-next-line no-await-in-loop -- a probe begun while waiting is waited for too
      for (let pending = probing ?? pairing; pending !== null; pending = probing ?? pairing) await pending;
    },
  };
}

/**
 * Whether this machine may take Codex tasks (`CAPABILITIES.codex`; docs/codex.md, "Phase 2"): its login signed in,
 * identified (the account the scheduler routes by) and at or above the floor. From the register blob's entry alone, so
 * the capability moves with the entry it is read beside, and a change re-registers both.
 */
export function codexRunnable(login: AgentLogin): boolean {
  return login.authOk && login.accountId !== null && login.version !== undefined && versionAtLeast(login.version);
}

/**
 * The daemon's start of the login: nothing without a `codex` block or without `opts` (main.ts passes `{}`; tests
 * must not run a developer's `codex`). The home's `config.toml` is regenerated here, at every daemon start; a home
 * that cannot be written leaves the machine with no Codex login, warned, rather than a probe against a config it
 * does not know. Not started: the caller starts it once what its callbacks reach exists.
 */
export async function startCodex(
  config: { readonly codex?: unknown },
  opts: (CodexAccountOpts & { readonly stateDir?: string }) | undefined,
  userHome: string,
  callbacks: Pick<CodexAccountDeps, "onInfoChange" | "onStatusChange" | "onPairedChange">,
): Promise<CodexAccount | null> {
  if (config.codex === undefined || opts === undefined) return null;
  const { stateDir: stateDirectory, ...accountOpts } = opts;
  const prepared = await prepareCodexHome(stateDirectory).catch((err: unknown) => {
    log.warn(`codex login: could not write the Codex home (${String(err)}) — no Codex on this machine this run`);
    return null;
  });
  if (prepared === null) return null;
  if (!prepared.mcp) log.warn("codex login: bun is not on PATH — config.toml written without the seance MCP server");
  return createCodexAccount({
    ...accountOpts,
    ...callbacks,
    home: prepared.home,
    userHome,
    remotePath: remotePath(stateDirectory),
  });
}
