import { chmod, mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  ADAPTER_LINE_MAX,
  ADAPTER_PROTOCOLS,
  adapterWants,
  encodeDaemonFrame,
  parseAdapterLine,
  type AdapterFrame,
  type AdapterWant,
  type AdapterDaemonFrame,
  type DaemonHello,
  type DeliverFrame,
  type TagFrame,
} from "@seance/shared";
import type { AdapterAudit, AdapterReason } from "./audit.ts";
import type { AdapterConfig } from "./config.ts";
import { childEnv } from "./exec.ts";

/**
 * One adapter as a supervised child (DESIGN.md, "Adapters"). It speaks NDJSON on
 * the child's stdin and stdout, nothing else: no socket, no argv beyond the configured one, stderr discarded. Nothing the
 * adapter writes reaches a log or an audit line, and this module loads neither `log.ts` nor any module that does
 * (`daemon/test/adapter-layering.test.ts`): the audit lines carry the name, an exit code and a reason.
 */

const BACKOFF_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** A run this long resets the backoff: the adapter came up and stayed. */
const STABLE_MS = 60_000;
const FAIL_WINDOW_MS = 10 * 60_000;
const FAIL_EXITS = 5;
const HELLO_TIMEOUT_MS = 10_000;
const KILL_AFTER_MS = 5_000;
/** Bytes written to the adapter's stdin that it has not drained: past this it has stopped reading. */
export const ADAPTER_UNREAD_MAX = 2 * 1024 * 1024;
const INVALID_WINDOW_MS = 60_000;
const INVALID_MAX = 10;

export type SupervisorState = "starting" | "running" | "backoff" | "failed" | "refused" | "stopped" | "held";

export interface SupervisorTiming {
  readonly backoffMs?: number;
  readonly backoffMaxMs?: number;
  readonly stableMs?: number;
  readonly failWindowMs?: number;
  readonly failExits?: number;
  readonly helloTimeoutMs?: number;
  readonly killAfterMs?: number;
  readonly unreadMax?: number;
}

export interface SupervisorDeps extends SupervisorTiming {
  /** The `config.json` key: what the adapter's `hello` must name. */
  readonly name: string;
  readonly config: AdapterConfig;
  /** `SEANCE_ADAPTER_DIR`, made 0700 before each start; the child's cwd. */
  readonly dir: string;
  readonly hello: DaemonHello;
  readonly audit: AdapterAudit;
  /** Once both hellos are through, and on each `resync`: the snapshot to send now, read synchronously from the feed. */
  readonly snapshot: () => AdapterDaemonFrame;
  /** Both hellos are through, before the snapshot: a fresh start, so what the last run set (its tags) is cleared. */
  readonly onReady?: () => void;
  /** Its state, pid or last exit changed: what `info` says moved (the host republishes the status view). */
  readonly onChange?: () => void;
  /** A `deliver` or `tag` past the handshake; answered by the host with a `result` through `send`. */
  readonly onFrame?: (frame: DeliverFrame | TagFrame) => void;
  /** Whether a start must wait: the daemon is draining for a restart. Asked before each start. */
  readonly held?: () => boolean;
  readonly now?: () => number;
}

export interface AdapterSupervisor {
  readonly start: () => void;
  /**
   * Sends `frame` when the adapter is past its handshake and `wants` it; dropped otherwise (a restart snapshots
   * afresh). False when nothing was written: not running, not past the handshake, not wanted, or ending.
   */
  readonly send: (frame: AdapterDaemonFrame) => boolean;
  /** What the running adapter's hello asked for; null while none is past its handshake. */
  readonly wants: () => readonly AdapterWant[] | null;
  readonly state: () => SupervisorState;
  /** What `seance adapter status` shows of it: the daemon's facts, and the running adapter's hello's protocol and version. */
  readonly info: () => SupervisorInfo;
  /**
   * The owner's `seance adapter restart`: ends a running process (`reason=restarted`) and starts it again at once, or
   * starts one that is backing off, `failed` or `refused`, with the backoff and the exit window reset. A no-op once
   * stopping; while the daemon drains for a restart it starts when the hold lifts, as any start does.
   */
  readonly restart: () => void;
  /** Stdin closed, SIGTERM to the group, SIGKILL after `killAfterMs`; resolves once the child is gone. */
  readonly stop: () => Promise<void>;
}

export interface SupervisorInfo {
  readonly state: SupervisorState;
  /** The current process, from its spawn to its exit. */
  readonly pid?: number;
  readonly startedAt?: number;
  /** From the running adapter's `hello`: adapter-written, so a reader prints the version only through a scrub. */
  readonly protocol?: number;
  readonly version?: string;
  /** Exits since the daemon started, a failed spawn included; the exit an owner's restart asked for is not one. */
  readonly exits: number;
  readonly lastExit?: { readonly at: number; readonly code: number | string | null; readonly reason: AdapterReason };
}

interface Run {
  readonly proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
  readonly startedAt: number;
  ready: boolean;
  wants: readonly AdapterWant[];
  protocol: number | null;
  version: string | null;
  /** Why the daemon is ending this run, when it is; a run that ends with none set exited on its own. */
  ending: AdapterReason | null;
  /** Bytes handed to the writer and not yet flushed into the pipe. */
  unread: number;
  readonly queue: string[];
  writing: boolean;
  readonly invalid: number[];
  helloTimer: ReturnType<typeof setTimeout> | null;
  readonly exited: Promise<void>;
}

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/** Signals the whole group the child leads (`detached`), quietly: a group already gone is the outcome wanted. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // gone
  }
}

/**
 * The env a session gets (`childEnv`: never `CREDENTIALS_DIRECTORY`), less every `TMUX*` variable, which would point
 * the adapter at a tmux server it must not drive, plus its name and directory.
 */
export function adapterEnv(name: string, dir: string): NodeJS.ProcessEnv {
  const env = childEnv({ SEANCE_ADAPTER_NAME: name, SEANCE_ADAPTER_DIR: dir });
  for (const key of Object.keys(env)) if (key.startsWith("TMUX")) delete env[key];
  return env;
}

export function createAdapterSupervisor(deps: SupervisorDeps): AdapterSupervisor {
  const now = deps.now ?? Date.now;
  const backoffMs = deps.backoffMs ?? BACKOFF_MS;
  const backoffMaxMs = deps.backoffMaxMs ?? BACKOFF_MAX_MS;
  const stableMs = deps.stableMs ?? STABLE_MS;
  const failWindowMs = deps.failWindowMs ?? FAIL_WINDOW_MS;
  const failExits = deps.failExits ?? FAIL_EXITS;
  const helloTimeoutMs = deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const killAfterMs = deps.killAfterMs ?? KILL_AFTER_MS;
  const unreadMax = deps.unreadMax ?? ADAPTER_UNREAD_MAX;
  const { name } = deps;

  let state: SupervisorState = "stopped";
  let run: Run | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;
  let delay = backoffMs;
  const exits: number[] = [];
  let exitCount = 0;
  let lastExit: SupervisorInfo["lastExit"];
  /** An owner's restart is waiting for the current process to go, to start it again at once. */
  let relaunch = false;
  const changed = (): void => deps.onChange?.();

  // An audit write that fails must not take the supervisor down; the sink reports its own failures.
  const audited = (write: Promise<void>): void => void write.catch(() => {});

  const end = (current: Run, reason: AdapterReason): void => {
    if (current.ending !== null) return;
    current.ending = reason;
    terminate(current);
  };

  const terminate = (current: Run): void => {
    try {
      void current.proc.stdin.end();
    } catch {
      // already closed
    }
    signalGroup(current.proc.pid, "SIGTERM");
    const kill = setTimeout(() => signalGroup(current.proc.pid, "SIGKILL"), killAfterMs);
    void current.exited.then(() => clearTimeout(kill));
  };

  const pump = async (current: Run): Promise<void> => {
    if (current.writing) return;
    current.writing = true;
    try {
      for (let chunk = current.queue.shift(); chunk !== undefined; chunk = current.queue.shift()) {
        // Bun's sink buffers until the pipe is full, then `flush` stays pending: the count falls only once a chunk is in.
        // oxlint-disable-next-line no-await-in-loop -- in order, one chunk at a time
        await current.proc.stdin.write(chunk);
        // oxlint-disable-next-line no-await-in-loop -- as above
        await current.proc.stdin.flush();
        current.unread -= bytesOf(chunk);
      }
    } catch {
      // The pipe closed: the child is going, and its exit is what is acted on.
    } finally {
      current.writing = false;
    }
  };

  const write = (current: Run, frame: AdapterDaemonFrame): boolean => {
    if (current.ending !== null) return false;
    const line = encodeDaemonFrame(frame);
    current.unread += bytesOf(line);
    if (current.unread > unreadMax) {
      end(current, "unread");
      return false;
    }
    current.queue.push(line);
    void pump(current);
    return true;
  };

  const refuse = (current: Run, reason: AdapterReason): void => {
    if (current.ending !== null) return;
    state = "refused";
    current.ending = reason;
    audited(deps.audit.refused(name, reason));
    changed();
    terminate(current);
  };

  const invalid = (current: Run): void => {
    write(current, { kind: "error", code: "invalid" });
    const at = now();
    current.invalid.push(at);
    while ((current.invalid[0] ?? at) <= at - INVALID_WINDOW_MS) current.invalid.shift();
    if (current.invalid.length >= INVALID_MAX) end(current, "invalid");
  };

  const onFrame = (current: Run, frame: AdapterFrame): void => {
    if (frame.kind === "hello") {
      if (current.ready) {
        invalid(current);
        return;
      }
      if (frame.name !== name) {
        refuse(current, "name");
        return;
      }
      if (!(ADAPTER_PROTOCOLS as readonly number[]).includes(frame.protocol)) {
        refuse(current, "protocol");
        return;
      }
      if (current.helloTimer !== null) clearTimeout(current.helloTimer);
      current.helloTimer = null;
      current.ready = true;
      current.wants = frame.wants;
      current.protocol = frame.protocol;
      current.version = frame.version;
      state = "running";
      changed();
      deps.onReady?.();
      sendSnapshot(current);
      return;
    }
    // Only past the handshake, where nothing else flows before both hellos.
    if (!current.ready) {
      invalid(current);
      return;
    }
    if (frame.kind === "resync") {
      sendSnapshot(current);
      return;
    }
    if (deps.onFrame === undefined) {
      write(current, { kind: "error", code: "unsupported" });
      return;
    }
    deps.onFrame(frame);
  };

  const sendSnapshot = (current: Run): void => {
    const snapshot = deps.snapshot();
    if (adapterWants(current.wants, snapshot)) write(current, snapshot);
  };

  const onLine = (current: Run, bytes: Uint8Array | null): void => {
    if (current.ending !== null) return;
    if (bytes === null) {
      invalid(current);
      return;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      invalid(current);
      return;
    }
    if (text.trim() === "") return;
    const parsed = parseAdapterLine(text);
    if (parsed.ok) {
      onFrame(current, parsed.frame);
      return;
    }
    if (parsed.code === "invalid") {
      invalid(current);
      return;
    }
    write(current, { kind: "error", code: parsed.code });
  };

  /** Splits stdout into lines of at most `ADAPTER_LINE_MAX` bytes; a longer one is one invalid line, skipped to its end. */
  const read = async (current: Run): Promise<void> => {
    let held: Uint8Array[] = [];
    let heldBytes = 0;
    let overlong = false;
    try {
      for await (const chunk of current.proc.stdout) {
        let from = 0;
        for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, from)) {
          const part = chunk.subarray(from, at);
          from = at + 1;
          if (overlong || heldBytes + part.length > ADAPTER_LINE_MAX) onLine(current, null);
          else onLine(current, held.length === 0 ? part : Buffer.concat([...held, part]));
          held = [];
          heldBytes = 0;
          overlong = false;
        }
        const rest = chunk.subarray(from);
        if (overlong || rest.length === 0) continue;
        if (heldBytes + rest.length > ADAPTER_LINE_MAX) {
          overlong = true;
          held = [];
          heldBytes = 0;
          continue;
        }
        // A copy: the stream may reuse the chunk's buffer.
        held.push(Uint8Array.from(rest));
        heldBytes += rest.length;
      }
    } catch {
      // The pipe went with the child.
    }
  };

  const onExit = (current: Run, code: number | null, signal: string | null): void => {
    if (current.helloTimer !== null) clearTimeout(current.helloTimer);
    // Whatever the adapter left in its group goes with it.
    signalGroup(current.proc.pid, "SIGTERM");
    if (run === current) run = null;
    const reason = current.ending ?? "exited";
    audited(deps.audit.exit(name, signal ?? code, reason));
    const at = now();
    lastExit = { at, code: signal ?? code, reason };
    if (reason !== "restarted") exitCount += 1;
    if (stopping) return changed();
    if (relaunch) {
      relaunch = false;
      state = "stopped";
      launch();
      return changed();
    }
    if (state === "refused") return changed();
    if (at - current.startedAt >= stableMs) delay = backoffMs;
    exits.push(at);
    while ((exits[0] ?? at) <= at - failWindowMs) exits.shift();
    if (exits.length >= failExits) {
      state = "failed";
      audited(deps.audit.failed(name, exits.length));
      return changed();
    }
    schedule();
    changed();
  };

  const schedule = (): void => {
    state = "backoff";
    const wait = delay;
    delay = Math.min(delay * 2, backoffMaxMs);
    audited(deps.audit.restart(name, wait));
    retry = setTimeout(() => {
      retry = null;
      launch();
    }, wait);
  };

  const spawnFailed = (): void => {
    audited(deps.audit.exit(name, null, "spawn"));
    const at = now();
    lastExit = { at, code: null, reason: "spawn" };
    exitCount += 1;
    exits.push(at);
    while ((exits[0] ?? at) <= at - failWindowMs) exits.shift();
    if (exits.length >= failExits) {
      state = "failed";
      audited(deps.audit.failed(name, exits.length));
      return changed();
    }
    schedule();
    changed();
  };

  const launch = (): void => {
    if (stopping || run !== null || state === "failed" || state === "refused") return;
    if (deps.held?.() === true) {
      state = "held";
      changed();
      return;
    }
    state = "starting";
    void (async (): Promise<void> => {
      const env = adapterEnv(name, deps.dir);
      try {
        await mkdir(deps.dir, { recursive: true, mode: 0o700 });
        await chmod(deps.dir, 0o700);
      } catch {
        spawnFailed();
        return;
      }
      if (stopping) return;
      const [command, ...args] = deps.config.argv;
      // A bare name resolves through the env's PATH now, at each start: never a path recorded at install.
      const resolved =
        command === undefined ? null : isAbsolute(command) ? command : Bun.which(command, { PATH: env["PATH"] ?? "" });
      if (resolved === null) {
        spawnFailed();
        return;
      }
      let proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
      try {
        proc = Bun.spawn([resolved, ...args], {
          cwd: deps.dir,
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
          detached: true,
        });
      } catch {
        spawnFailed();
        return;
      }
      const exited = Promise.withResolvers<void>();
      const current: Run = {
        proc,
        startedAt: now(),
        ready: false,
        wants: [],
        protocol: null,
        version: null,
        ending: null,
        unread: 0,
        queue: [],
        writing: false,
        invalid: [],
        helloTimer: null,
        exited: exited.promise,
      };
      run = current;
      audited(deps.audit.start(name, deps.config.argv, proc.pid));
      changed();
      current.helloTimer = setTimeout(() => {
        current.helloTimer = null;
        if (!current.ready) end(current, "handshake");
      }, helloTimeoutMs);
      write(current, deps.hello);
      void read(current);
      void proc.exited.then((code) => {
        onExit(current, code, proc.signalCode);
        exited.resolve();
      });
    })();
  };

  return {
    start: (): void => {
      if (state === "held") state = "stopped";
      launch();
    },
    send: (frame): boolean => {
      if (run === null || !run.ready || !adapterWants(run.wants, frame)) return false;
      return write(run, frame);
    },
    wants: () => (run === null || !run.ready ? null : run.wants),
    state: () => state,
    info: (): SupervisorInfo => ({
      state,
      exits: exitCount,
      ...(run === null ? {} : { pid: run.proc.pid, startedAt: run.startedAt }),
      ...(run === null || run.protocol === null ? {} : { protocol: run.protocol }),
      ...(run === null || run.version === null ? {} : { version: run.version }),
      ...(lastExit === undefined ? {} : { lastExit }),
    }),
    restart: (): void => {
      if (stopping) return;
      exits.length = 0;
      delay = backoffMs;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      const current = run;
      if (current !== null) {
        // Its exit starts the next one; a process already ending for another reason is waited out the same way.
        relaunch = true;
        current.ending ??= "restarted";
        terminate(current);
        return;
      }
      state = "stopped";
      launch();
      changed();
    },
    stop: async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      const current = run;
      if (current !== null) {
        current.ending ??= "stopped";
        terminate(current);
        await current.exited;
      }
      if (state !== "failed" && state !== "refused") state = "stopped";
      audited(deps.audit.stop(name));
      changed();
    },
  };
}
