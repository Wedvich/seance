import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CODEX_MODEL, isAgentSessionId, isRecord, type SpawnRequest } from "@seance/shared";
import { SpawnFailure } from "../backend.ts";
import {
  connectCodex,
  initializeCodex,
  ownDirectory,
  socketState,
  SOCKET_NAME,
  type CodexAnswer,
  type CodexConnection,
} from "../codex/client.ts";
import { codexSessions } from "../codex/sessions.ts";
import { codexBin } from "../codex/home.ts";
import type { CodexConfig } from "../config.ts";
import { shq } from "../shq.ts";
import { tmux } from "../tmux.ts";
import type { AgentDriver, AgentLaunch, LaunchSpec } from "./driver.ts";
import { CODEX_PANES, CODEX_RUN_PREFIX } from "./panes.ts";

/**
 * Codex in a tmux pane that hosts its own `codex app-server` (DESIGN.md, Daemon, "Codex sessions"; docs/codex.md,
 * "A pane that hosts its own server"). The pane runs a constant script from a run dir the daemon made: the server in
 * the background on the run dir's socket, then, once the daemon has written `thread`, the TUI joining that thread.
 * The daemon is the server's client: it starts the thread, so the thread id is its own and never a claim, and sends the
 * seed as the first turn's input, never argv. Everything a session runs is a descendant of the pane.
 */

/** What the driver reads of this machine: `config.json`'s `codex` block (D5) and the home (`codex/home.ts`). */
export interface CodexDriverOptions {
  readonly config: CodexConfig;
  readonly home: string;
}

const RUN_SCRIPT = "run.sh";
const THREAD_FILE = "thread";
/** How long `started` waits for the pane's server to listen: a cold Codex start, on a loaded machine. */
const SOCKET_WAIT_MS = 30_000;
const POLL_MS = 100;
/** The script's own bound on `thread`, in its 0.1 s steps: past the daemon's whole `started`, so the daemon decides. */
const SCRIPT_WAIT_STEPS = 1_800;

export function codexDriver(opts: CodexDriverOptions): AgentDriver {
  return { panes: CODEX_PANES, launch: (spec) => launchCodex(spec, opts), close: closeCodex };
}

/**
 * The graceful close (docs/codex.md, "Ending a session"): the running turn interrupted over the daemon's own
 * connection (`codexSessions.interrupt`) and its end awaited within `graceMs`, then false, so the caller kills the
 * pane, whose hangup and escalation take the TUI and its server with it. The TUI has no exit a daemon can ask for, and
 * the thread stays in the home's store either way. Needs no config, so despawn closes a Codex pane on a machine whose
 * `codex` block has since gone; out of the daemon's process (`seance despawn`) no session is held, and the pane is
 * killed at once.
 */
export const closeCodex: AgentDriver["close"] = async (pane, opts) => {
  await codexSessions.interrupt({ paneId: pane.paneId, pid: pane.pid }, opts.graceMs);
  return false;
};

/**
 * What this driver cannot run, from the request alone: thrown by the spawn path before it makes a worktree
 * (`driverFor`), and again here at launch. V1 refuses these before a write (`codexSpecRefusal`), so a spawn that
 * carries one anyway never reaches a worktree or a pane.
 */
export function codexRequestRefusal(request: SpawnRequest): SpawnFailure | null {
  if (request.attachments !== undefined) {
    return new SpawnFailure("launch_error", "a Codex session can't take attachments yet");
  }
  if (request.effort === "max") return new SpawnFailure("launch_error", "a Codex session can't run at effort max");
  // The TUI can join a thread only once it has had a turn (S2), and the seed is that turn. A continuation's thread has
  // had its turns, and its seed is never empty: the preamble says why it was resumed.
  if (request.mode !== "continue" && (request.prompt === undefined || request.prompt === "")) {
    return new SpawnFailure("launch_error", "a Codex session needs a prompt");
  }
  return null;
}

async function launchCodex(spec: LaunchSpec, opts: CodexDriverOptions): Promise<AgentLaunch> {
  const refused = codexRequestRefusal(spec.request);
  if (refused !== null) throw refused;
  // The ledger's own note, held to the shape `thread/start` answered at launch: it reaches the TUI's argv through
  // `thread`, as a variable's value after `--`.
  if (spec.resume !== undefined && !isAgentSessionId(spec.resume)) {
    throw new SpawnFailure("not_continuable", "its launch record holds no Codex thread id to resume");
  }
  if (spec.readDirs.length > 0) throw new SpawnFailure("launch_error", "a Codex session can't take attachments yet");
  const seed = spec.seed;
  if (seed === undefined) throw new SpawnFailure("launch_error", "a Codex session needs a prompt");
  const home = await ownDirectory(opts.home);
  if (home === null) {
    throw new SpawnFailure("launch_error", "this machine's Codex home is not ready: restart the daemon");
  }
  const runDir = await makeRunDir();
  try {
    await writeFile(join(runDir, RUN_SCRIPT), runScript({ runDir, home: opts.home, bin: codexBin() }), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (err) {
    await rm(runDir, { recursive: true, force: true });
    throw new SpawnFailure("launch_error", `could not write the Codex launch script: ${String(err)}`);
  }
  let thread: string | undefined;
  return {
    dir: spec.cwd,
    command: paneCommand(runDir),
    env: [],
    started: async (window) => {
      thread = await startThread({ runDir, home, window, spec, seed, config: opts.config });
      return thread;
    },
    // A session that started keeps its run dir for its life: the TUI's `--remote` and a reconnect name its socket.
    dispose: async () => {
      if (thread === undefined) await rm(runDir, { recursive: true, force: true });
    },
  };
}

/** The `mkdtemp` under the literal `/tmp/seance-cx-`, held to a real 0700 directory of this uid by `lstat`. */
async function makeRunDir(): Promise<string> {
  let runDir: string;
  try {
    runDir = await mkdtemp(CODEX_RUN_PREFIX);
    await chmod(runDir, 0o700);
  } catch (err) {
    throw new SpawnFailure("launch_error", `could not make the Codex run dir: ${String(err)}`);
  }
  if ((await ownDirectory(runDir)) === null) {
    await rm(runDir, { recursive: true, force: true });
    throw new SpawnFailure("launch_error", "the Codex run dir is not the daemon's own");
  }
  return runDir;
}

/**
 * The pane's one shell string, as the custodian's: `exec /bin/sh '<run>/run.sh'`, so the owner's tmux `default-shell`
 * parses no quoting but one path's. It is also the pane's mark (`CODEX_PANES.startMark`).
 */
export function paneCommand(runDir: string): string {
  const caffeinate = process.platform === "darwin" ? "caffeinate -is " : "";
  return `exec ${caffeinate}/bin/sh ${shq(`${runDir}/${RUN_SCRIPT}`)}`;
}

/**
 * The launch script: constant text, daemon paths through `shq` and nothing else interpolated. The server and the TUI
 * are the shell's children, so the pane's processes are the session's. The TUI is waited on, never `exec`ed: an
 * `exec`ed TUI's exit would orphan the server to init, running on with no pane. Nor run in the foreground: Codex's TUI
 * outlives a hangup, and the shell defers its `HUP` trap until a foreground child exits, so a window closed by hand or
 * a tmux server's end left both running (seen live on 0.170.0). Started in the background on the pane's terminal (an
 * explicit `<&3`, since a background job's stdin is otherwise `/dev/null`) and `wait`ed on, which a trapped signal
 * interrupts at once, so the shell's exit, on the TUI's end, a hangup or a `TERM`, ends the TUI and the server and
 * removes the run dir, and passes the TUI's status on for harvest. The server's output goes nowhere (it would draw over the TUI); the daemon reads it over the
 * socket. `thread` is the daemon's, written once the first turn is accepted, and only ever a thread id
 * `isAgentSessionId` passed; it reaches the TUI's argv as a variable's value, after `--`, never as shell text. A server
 * that dies, or a daemon that never writes `thread`, ends the pane: the daemon's own wait is the shorter, and it kills
 * the window first.
 */
export function runScript(o: { readonly runDir: string; readonly home: string; readonly bin: string }): string {
  return [
    "#!/bin/sh",
    '# seanced\'s launch of one Codex session (DESIGN.md, Daemon, "Codex sessions").',
    `run=${shq(o.runDir)}`,
    `codex=${shq(o.bin)}`,
    `CODEX_HOME=${shq(o.home)}`,
    "export CODEX_HOME",
    // The home's login is the account the probe reads (under a bare env) and the scheduler routes by: a key the
    // tmux server's environment happens to carry must not bill another.
    "unset OPENAI_API_KEY CODEX_API_KEY",
    `"$codex" app-server --listen "unix://$run/${SOCKET_NAME}" </dev/null >/dev/null 2>&1 &`,
    "server=$!",
    // The session's process, which the daemon keys the session's facts on as `seance mcp`'s binding does (`sessionOf`).
    `echo "$server" > "$run/server"`,
    "tui=",
    `trap 'kill $tui "$server" 2>/dev/null; rm -rf "$run"' EXIT`,
    "trap 'exit 129' HUP",
    "trap 'exit 143' TERM",
    "i=0",
    `while [ ! -s "$run/${THREAD_FILE}" ]; do`,
    "  i=$((i + 1))",
    // `jobs` reaps a server that exited, which dash does only there: else `kill -0` finds its zombie alive.
    "  jobs >/dev/null 2>&1",
    `  if [ "$i" -gt ${SCRIPT_WAIT_STEPS} ] || ! kill -0 "$server" 2>/dev/null; then`,
    "    echo 'seance: the Codex session did not start' >&2",
    "    exit 1",
    "  fi",
    "  sleep 0.1",
    "done",
    `IFS= read -r thread < "$run/${THREAD_FILE}"`,
    "exec 3<&0",
    `"$codex" resume --remote "unix://$run/${SOCKET_NAME}" -- "$thread" <&3 3<&- &`,
    "tui=$!",
    "exec 3<&-",
    'wait "$tui"',
    "exit $?",
    "",
  ].join("\n");
}

interface StartArgs {
  readonly runDir: string;
  /** The home's realpath: what the server's `initialize` must answer. */
  readonly home: string;
  readonly window: string;
  readonly spec: LaunchSpec;
  readonly seed: string;
  readonly config: CodexConfig;
}

/**
 * `started`: dials the pane's server, starts the thread and its first turn, then lets the TUI join. Any failure throws,
 * and the spawn path kills the window, which takes the server with it.
 */
async function startThread(args: StartArgs): Promise<string> {
  await awaitSocket(args.runDir, args.window);
  const tracked = codexSessions.track(args.runDir);
  const connection = await connectCodex(args.runDir, tracked.listener);
  if (connection === null) throw new SpawnFailure("launch_error", "could not connect to the session's Codex server");
  try {
    const thread = await converse(connection, args);
    // Written whole, then renamed: the script reads it the moment it is non-empty.
    const staged = join(args.runDir, `${THREAD_FILE}.tmp`);
    await writeFile(staged, `${thread}\n`, { mode: 0o600, flag: "wx" });
    await rename(staged, join(args.runDir, THREAD_FILE));
    // Held for the pane's life, so the thread always has a subscriber, the TUI's join included.
    await tracked.attach(thread, connection, args.window);
    return thread;
  } catch (err) {
    connection.close();
    throw err;
  }
}

/** Until the socket passes `socketState`; a refused one, a closed window or the deadline throws. */
async function awaitSocket(runDir: string, window: string): Promise<void> {
  const deadline = Date.now() + SOCKET_WAIT_MS;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling: each check gates the next
    const state = await socketState(runDir);
    if (state === "ready") return;
    if (state === "refused") {
      throw new SpawnFailure("launch_error", "the session's Codex socket is not the daemon's own: nothing dialled");
    }
    // The window is not yet kept on exit (`awaitRegistration` sets that later): a pane that died closed it.
    // oxlint-disable-next-line no-await-in-loop
    const listed = await tmux(["list-panes", "-t", window, "-F", "#{pane_dead}"]);
    if (listed.exitCode !== 0 || listed.stdout.trim() === "1") {
      throw new SpawnFailure("claude_died", "codex exited before the session started");
    }
    if (Date.now() >= deadline) {
      throw new SpawnFailure("launch_error", "the session's Codex server did not start listening in time");
    }
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(POLL_MS);
  }
}

/**
 * The conversation (threat model, "What the daemon sends a pane's server"): constant methods; `cwd` the daemon's own
 * path; approval, sandbox and reviewer from `config.json` alone; model and effort from the parsed spec; the seed as one
 * text input; for a continuation, the thread id its launch ledger noted (`spec.resume`), never a frame's. What it
 * keeps: the answer's home and the thread id, each checked, nothing else.
 */
async function converse(connection: CodexConnection, args: StartArgs): Promise<string> {
  const { request, resume } = args.spec;
  const init = await initializeCodex(connection, args.home);
  if (!init.ok && init.answer === "home") {
    throw new SpawnFailure("launch_error", "the session's Codex server runs on another home");
  }
  if (!init.ok && init.answer !== "home") resultOf(init.answer, "initialize");
  // The same settings either way: a resumed thread takes them as overrides, so it runs under this machine's
  // `config.json` as it stands now, never under whatever it was started with.
  const settings: ThreadSettings = {
    cwd: args.spec.cwd,
    model: request.model ?? DEFAULT_CODEX_MODEL,
    approvalPolicy: args.config.approvalPolicy,
    sandbox: args.config.sandbox,
    approvalsReviewer: args.config.approvalsReviewer,
  };
  const thread =
    resume === undefined ? await newThread(connection, settings) : await resumedThread(connection, resume, settings);
  const turn = await connection.request("turn/start", {
    threadId: thread,
    input: [{ type: "text", text: args.seed, text_elements: [] }],
    // Absent, the model's own default: Séance's default effort is Claude's.
    ...(request.effort === undefined ? {} : { effort: request.effort }),
  });
  resultOf(turn, "turn/start");
  return thread;
}

interface ThreadSettings {
  readonly cwd: string;
  readonly model: string;
  readonly approvalPolicy: CodexConfig["approvalPolicy"];
  readonly sandbox: CodexConfig["sandbox"];
  readonly approvalsReviewer: CodexConfig["approvalsReviewer"];
}

async function newThread(connection: CodexConnection, settings: ThreadSettings): Promise<string> {
  const started = await connection.request("thread/start", { ...settings });
  const thread = field(field(resultOf(started, "thread/start"), "thread"), "id");
  if (!isAgentSessionId(thread))
    throw new SpawnFailure("launch_error", "Codex answered thread/start with no thread id");
  return thread;
}

/**
 * `thread/resume` of the noted thread from the home's store, its turns left out (the TUI shows them; the daemon keeps
 * none). An error answer (a store that lost the thread) is `not_continuable`, which settles the continuation, since no
 * retry on the same thread gets past it. The answer must name the thread asked for.
 */
async function resumedThread(connection: CodexConnection, thread: string, settings: ThreadSettings): Promise<string> {
  const resumed = await connection.request("thread/resume", { threadId: thread, ...settings, excludeTurns: true });
  if (resumed.kind === "error") {
    throw new SpawnFailure(
      "not_continuable",
      `Codex could not resume its thread (error ${resumed.code ?? "without a code"}): its session store may have lost it`,
    );
  }
  if (field(field(resultOf(resumed, "thread/resume"), "thread"), "id") !== thread) {
    throw new SpawnFailure("launch_error", "Codex answered thread/resume for another thread");
  }
  return thread;
}

/** A result's value, else a throw naming the method and the code: never the error's message. */
function resultOf(answer: CodexAnswer, method: string): unknown {
  if (answer.kind === "result") return answer.value;
  const why =
    answer.kind === "error"
      ? `error ${answer.code ?? "without a code"}`
      : answer.kind === "timeout"
        ? "no answer"
        : "closed";
  throw new SpawnFailure("launch_error", `Codex's ${method} failed (${why})`);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
