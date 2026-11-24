import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isAgentSessionId, isRecord } from "@seance/shared";
import { CODEX_PANES, CODEX_RUN_PREFIX } from "../agents/panes.ts";
import { sessionKey, type ClaudeProcess } from "../claude-process.ts";
import { log } from "../log.ts";
import { ancestorBelow, processNames, processStart } from "../peer.ts";
import { listPanePids, type BoundPane, type CodexState } from "../session-events.ts";
import { tmux } from "../tmux.ts";
import {
  connectCodex,
  initializeCodex,
  ownDirectory,
  type CodexAnswer,
  type CodexConnection,
  type CodexNotification,
} from "./client.ts";
import { codexSignals, stateOfStatus, turnIdOf, type CodexSignal } from "./events.ts";

/**
 * The daemon's live Codex sessions (DESIGN.md, Daemon, "Codex session events"; docs/codex.md, build order item 7): per
 * pane, the connection to its own `codex app-server`, the thread this daemon started on it, and what its notifications
 * say. One per daemon process, module-level like the launch's: the launch attaches a session (`track`), despawn's
 * graceful close interrupts one (`interrupt`), and the daemon's wiring hands in where states go (`configure`) and
 * re-joins the sessions a previous daemon process left running (`reconnectAll`).
 *
 * Bound by construction: a session's pane is the one its launch's window holds (or, on a reconnect, the one whose
 * start command names its run dir), its thread the id this daemon's own `thread/start` answered and its launch ledger
 * noted. A notification naming another thread is dropped (`codexSignals`). The daemon never answers a server request
 * (an approval): the connection reads none.
 *
 * A lost connection is no session's end: the pane is. The daemon re-dials a live pane's server a few times, and a pane
 * gone or dead is harvest's, as a Claude pane's is.
 */

/** Where a session's states and its login's readings go: the session-event step and the account. */
export interface CodexSink {
  readonly state: (pane: BoundPane, thread: string, process: ClaudeProcess | null, state: CodexState) => Promise<void>;
  readonly rateLimits: (value: unknown) => void;
}

export interface CodexSessionsConfig {
  readonly sink: CodexSink;
  /** The home's realpath: what a reconnect's `initialize` must answer. */
  readonly home: string;
  /** The thread id the launch ledger noted for a task's launch here: what a reconnect's `thread` must equal. */
  readonly launchSession: (taskId: string) => string | undefined;
}

export interface CodexSessionsOptions {
  readonly panes: () => Promise<readonly BoundPane[]>;
  /** One `account/rateLimits/read` per this long, per session: the trailing one of a burst still goes. */
  readonly rateLimitsEveryMs?: number;
  /** A lost connection's re-dials, each after its delay, while the pane lives. */
  readonly reconnectDelaysMs?: readonly number[];
}

export interface CodexSessions {
  /**
   * For the launch: a listener to dial with, buffering what arrives before the thread is known, and the attach that
   * binds the session once `thread` is written. A launch that fails before attaching leaves nothing held.
   */
  readonly track: (runDir: string) => {
    readonly listener: (notification: CodexNotification) => void;
    readonly attach: (thread: string, connection: CodexConnection, window: string) => Promise<void>;
  };
  /**
   * The graceful close's first step: the session's running turn interrupted (`turn/interrupt`), then its end awaited,
   * all within `graceMs`. Resolves at once for a pane no session here tracks, one whose pid moved, or one idle.
   */
  readonly interrupt: (
    pane: { readonly paneId: string; readonly pid: number | null },
    graceMs: number,
  ) => Promise<void>;
  readonly configure: (config: CodexSessionsConfig) => void;
  /** Re-dials every live Codex pane's server this process does not hold: a daemon restart's resync. */
  readonly reconnectAll: () => Promise<void>;
  /** Whether the pane's session is held here (a test's and the reconnect's read). */
  readonly holds: (paneId: string) => boolean;
  /** Closes every connection; the servers run on in their panes, for the next daemon process to re-join. */
  readonly stop: () => void;
}

const RATE_LIMITS_EVERY_MS = 60_000;
const RECONNECT_DELAYS_MS = [1_000, 5_000, 30_000] as const;
/** Notifications held before the thread is known: the first turn's few state changes, never its deltas. */
const EARLY_MAX = 32;
const EARLY_METHODS: ReadonlySet<string> = new Set([
  "thread/status/changed",
  "turn/started",
  "turn/completed",
  "thread/closed",
  "account/rateLimits/updated",
]);
const THREAD_FILE = "thread";
/** `run.sh` writes the server's pid here: the session's process, which `seance mcp` from it binds to (`sessionOf`). */
const SERVER_FILE = "server";
const RUN_DIR_PATTERN = /\/tmp\/seance-cx-[A-Za-z0-9]{1,32}\/run\.sh/u;

interface Session {
  readonly thread: string;
  readonly runDir: string;
  readonly pane: BoundPane;
  process: ClaudeProcess | null;
  connection: CodexConnection | null;
  turn: string | null;
  /** Ingest's order is the notifications': each state waits for the one before it. */
  chain: Promise<void>;
  readonly turnEnds: Set<() => void>;
  lastRead: number;
  readTimer: ReturnType<typeof setTimeout> | null;
  reading: boolean;
}

export function createCodexSessions(opts: CodexSessionsOptions): CodexSessions {
  const everyMs = opts.rateLimitsEveryMs ?? RATE_LIMITS_EVERY_MS;
  const delays = opts.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  const sessions = new Map<string, Session>();
  let config: CodexSessionsConfig | null = null;
  let stopped = false;

  const endTurn = (session: Session): void => {
    session.turn = null;
    for (const resolve of session.turnEnds) resolve();
    session.turnEnds.clear();
  };

  const readRateLimits = async (session: Session): Promise<void> => {
    const connection = session.connection;
    if (connection === null || session.reading) return;
    session.reading = true;
    session.lastRead = Date.now();
    try {
      const answer = await connection.request("account/rateLimits/read", {});
      if (!stopped && answer.kind === "result") config?.sink.rateLimits(answer.value);
    } finally {
      session.reading = false;
    }
  };

  const onRateLimits = (session: Session): void => {
    if (session.readTimer !== null) return;
    const wait = session.lastRead + everyMs - Date.now();
    if (wait <= 0) {
      void readRateLimits(session);
      return;
    }
    session.readTimer = setTimeout(() => {
      session.readTimer = null;
      if (!stopped && sessions.get(session.pane.id) === session) void readRateLimits(session);
    }, wait);
    session.readTimer.unref?.();
  };

  const signal = (session: Session, s: CodexSignal): void => {
    if (s.kind === "rateLimits") {
      onRateLimits(session);
      return;
    }
    if (s.kind === "turn") {
      if (s.turn === null) endTurn(session);
      else session.turn = s.turn;
      return;
    }
    const sink = config?.sink;
    if (sink === undefined) return;
    const state: CodexState = {
      state: s.state,
      ...(s.turnEnded === undefined ? {} : { turnEnded: s.turnEnded }),
      ...(s.reason === undefined ? {} : { reason: s.reason }),
    };
    session.chain = session.chain
      .then(() => sink.state(session.pane, session.thread, session.process, state))
      .catch((err: unknown) => log.warn(`codex: a session's state was not taken (${String(err)})`));
  };

  const hear = (session: Session, notification: CodexNotification): void => {
    if (stopped || sessions.get(session.pane.id) !== session) return;
    for (const s of codexSignals(notification, session.thread)) signal(session, s);
  };

  /** The pane as the listing has it now, only under the session's own pid. */
  const livePane = async (session: Session): Promise<boolean> => {
    const now = (await opts.panes().catch(() => null))?.find((p) => p.id === session.pane.id);
    return now !== undefined && !now.dead && now.pid === session.pane.pid && now.taskId === session.pane.taskId;
  };

  const onClosed = async (session: Session, connection: CodexConnection): Promise<void> => {
    if (session.connection !== connection) return;
    session.connection = null;
    // Nothing more will say the turn ended on this connection: a close waiting on it stops waiting.
    endTurn(session);
    for (const delay of delays) {
      // oxlint-disable-next-line no-await-in-loop -- each re-dial waits its own delay
      await Bun.sleep(delay);
      if (stopped || sessions.get(session.pane.id) !== session) return;
      // oxlint-disable-next-line no-await-in-loop -- as above
      if (!(await livePane(session))) {
        sessions.delete(session.pane.id);
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- as above
      if (await rejoin(session)) return;
    }
    if (sessions.get(session.pane.id) === session) {
      sessions.delete(session.pane.id);
      log.warn("codex: lost a session's server connection — its state is no longer read until the daemon restarts");
    }
  };

  const hold = (session: Session, connection: CodexConnection): void => {
    session.connection = connection;
    void connection.closed.then(() => onClosed(session, connection));
  };

  /**
   * Dials the session's server again, resumes its thread (a connection that only reads a thread hears none of its
   * turns: the item 7 spike) and re-reads its status and running turn. True once held.
   */
  const rejoin = async (session: Session): Promise<boolean> => {
    const home = config?.home;
    if (home === undefined) return false;
    const connection = await connectCodex(session.runDir, (n) => hear(session, n));
    if (connection === null) return false;
    const ok = await resync(session, connection, home).catch(() => false);
    if (!ok || stopped || sessions.get(session.pane.id) !== session) {
      connection.close();
      return false;
    }
    hold(session, connection);
    return true;
  };

  const resync = async (session: Session, connection: CodexConnection, home: string): Promise<boolean> => {
    if (!(await initializeCodex(connection, home)).ok) return false;
    const resumed = await connection.request("thread/resume", { threadId: session.thread, excludeTurns: true });
    const thread = field(resultOf(resumed), "thread");
    if (field(thread, "id") !== session.thread) return false;
    const state = stateOfStatus(field(thread, "status"));
    if (state?.state === "busy" || state?.state === "needs-input") {
      // The running turn's id, for a close's interrupt: the newest turn, only when still in progress.
      const listed = await connection.request("thread/turns/list", {
        threadId: session.thread,
        limit: 1,
        itemsView: "notLoaded",
      });
      const data = field(resultOf(listed), "data");
      const newest: unknown = Array.isArray(data) ? data[0] : undefined;
      if (field(newest, "status") === "inProgress") session.turn = turnIdOf(newest);
    }
    if (state !== null) signal(session, state);
    return true;
  };

  /** The pane's session process: the server `run.sh` noted, only while it is `codex` under that pane. */
  const serverOf = async (runDir: string, pane: BoundPane): Promise<ClaudeProcess | null> => {
    const text = await readFile(join(runDir, SERVER_FILE), "utf8").catch(() => "");
    const pid = Number(text.trim());
    if (!Number.isSafeInteger(pid) || pid <= 1) return null;
    if (!(await processNames(pid)).some((name) => CODEX_PANES.process.test(name))) return null;
    if ((await ancestorBelow(pid, new Map([[pane.pid, true]]))) === null) return null;
    const start = processStart(pid);
    return start === null ? null : { pid, start, key: sessionKey(pid, start) };
  };

  const fresh = (thread: string, runDir: string, pane: BoundPane): Session => ({
    thread,
    runDir,
    pane,
    process: null,
    connection: null,
    turn: null,
    chain: Promise.resolve(),
    turnEnds: new Set(),
    lastRead: -Infinity,
    readTimer: null,
    reading: false,
  });

  const drop = (session: Session): void => {
    if (session.readTimer !== null) clearTimeout(session.readTimer);
    session.connection?.close();
    endTurn(session);
  };

  return {
    track: (runDir) => {
      const early: CodexNotification[] = [];
      let session: Session | null = null;
      return {
        listener: (notification): void => {
          if (session !== null) {
            hear(session, notification);
            return;
          }
          if (EARLY_METHODS.has(notification.method) && early.length < EARLY_MAX) early.push(notification);
        },
        attach: async (thread, connection, window): Promise<void> => {
          if (stopped) return;
          const listed = await tmux(["display-message", "-p", "-t", window, "#{pane_id}"]);
          const paneId = listed.exitCode === 0 ? listed.stdout.trim() : "";
          const pane = (await opts.panes()).find((p) => p.id === paneId && !p.dead);
          if (pane === undefined || stopped) return;
          const held = sessions.get(pane.id);
          if (held !== undefined) drop(held);
          const attached = fresh(thread, runDir, pane);
          attached.process = await serverOf(runDir, pane);
          sessions.set(pane.id, attached);
          session = attached;
          hold(attached, connection);
          for (const notification of early.splice(0)) hear(attached, notification);
        },
      };
    },
    interrupt: async (pane, graceMs): Promise<void> => {
      const session = sessions.get(pane.paneId);
      if (session === undefined || session.pane.pid !== pane.pid) return;
      const { connection, turn } = session;
      if (connection === null || turn === null) return;
      const deadline = Date.now() + graceMs;
      const ended = new Promise<void>((resolve) => {
        session.turnEnds.add(resolve);
      });
      const answer = await connection.request("turn/interrupt", { threadId: session.thread, turnId: turn }, graceMs);
      if (answer.kind !== "result") return;
      const left = deadline - Date.now();
      if (left <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        ended,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left);
        }),
      ]);
      clearTimeout(timer);
    },
    // A config reload stops one daemon instance and starts the next in this process: the registry runs again.
    configure: (next): void => {
      stopped = false;
      config = next;
    },
    reconnectAll: async (): Promise<void> => {
      const home = config?.home;
      if (home === undefined || stopped) return;
      const panes = (await opts.panes()).filter((p) => p.agent === "codex" && p.ours && !p.dead);
      if (panes.length === 0) return;
      const commands = await startCommands();
      await Promise.all(
        panes
          .filter((pane) => !sessions.has(pane.id))
          .map(async (pane) => {
            const runDir = runDirOf(commands.get(pane.id));
            if (runDir === null || (await ownDirectory(runDir)) === null) return;
            const thread = (await readFile(join(runDir, THREAD_FILE), "utf8").catch(() => "")).trim();
            if (!isAgentSessionId(thread)) return;
            // A tasked pane's thread is the one its launch noted: the run dir's file alone could be any thread.
            if (pane.taskId !== null && config?.launchSession(pane.taskId) !== thread) return;
            if (stopped || sessions.has(pane.id)) return;
            const session = fresh(thread, runDir, pane);
            session.process = await serverOf(runDir, pane);
            sessions.set(pane.id, session);
            if (!(await rejoin(session)) && sessions.get(pane.id) === session) sessions.delete(pane.id);
          }),
      );
    },
    holds: (paneId) => sessions.has(paneId),
    stop: (): void => {
      stopped = true;
      for (const session of sessions.values()) drop(session);
      sessions.clear();
    },
  };
}

/** Each pane's start command, by pane id: where a Codex pane's run dir is named. */
async function startCommands(): Promise<ReadonlyMap<string, string>> {
  const listed = await tmux(["list-panes", "-a", "-F", "#{pane_id}|#{pane_start_command}"]);
  const commands = new Map<string, string>();
  if (listed.exitCode !== 0) return commands;
  for (const line of listed.stdout.split("\n")) {
    const at = line.indexOf("|");
    if (at > 0) commands.set(line.slice(0, at), line.slice(at + 1));
  }
  return commands;
}

/** The run dir a Codex pane's start command names (`paneCommand`), else null. */
export function runDirOf(command: string | undefined): string | null {
  const match = command === undefined ? null : RUN_DIR_PATTERN.exec(command);
  if (match === null) return null;
  const dir = match[0].slice(0, -"/run.sh".length);
  return dir.startsWith(CODEX_RUN_PREFIX) ? dir : null;
}

function resultOf(answer: CodexAnswer): unknown {
  return answer.kind === "result" ? answer.value : undefined;
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** The daemon process's one registry: the launch, despawn's close and the daemon's wiring all reach this one. */
export const codexSessions: CodexSessions = createCodexSessions({ panes: listPanePids });
