import type { Socket } from "bun";
import { isRecord, OP_TIMEOUT_MS, type ErrorResponse, type Plain, type RequestOp } from "@seance/shared";
import { socketPath } from "./paths.ts";

/**
 * The peer side of `local-socket.ts`: one frame, one connection, no correlation
 * state and no heartbeat. This is deliberately not the relay protocol — there is
 * no reordering to correlate against and no network to survive, so a request
 * that needs a pending map here would be inventing a problem.
 *
 * Nothing in this module logs. `log.ts` writes to stdout and the caller this
 * exists for — `seanced mcp` — carries JSON-RPC frames there.
 */

/** Same cap as the server; a reply that runs past it is not one to parse. */
const MAX_REPLY_BYTES = 1_048_576;

const EMPTY = Buffer.alloc(0);

/**
 * The local path could not be reached at all — no daemon, or no socket. Distinct
 * from a daemon that answered with an error, because only this one means "the
 * short circuit is unavailable" rather than "the request failed".
 */
export class LocalUnavailable extends Error {
  /**
   * The socket file is there and nobody accepts on it: a daemon that exited without the clean
   * stop that unlinks it — a self-update's restart, a crash — and that its service manager is
   * about to relaunch, or never will. Only `exchange`'s restart grace reads it.
   */
  readonly refused: boolean;
  constructor(message: string, refused = false) {
    super(message);
    this.name = "LocalUnavailable";
    this.refused = refused;
  }
}

/**
 * The connection opened and then went away with no answer: the request may
 * have been read, and for a spawn may have run. A subclass, so every caller that
 * only cares whether the daemon is reachable keeps reading it as unavailable,
 * while the one that must not call a spawn "never happened" can tell it apart
 * from a connect that failed outright.
 */
export class LocalConnectionLost extends LocalUnavailable {
  constructor(message: string) {
    super(message);
    this.name = "LocalConnectionLost";
  }
}

/** The daemon answered, and the answer was a refusal or a crash. */
export class LocalRequestFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRequestFailed";
  }
}

/** No answer inside the deadline. Its own class because, unlike a refusal, it says nothing about whether the request ran. */
export class LocalTimedOut extends LocalRequestFailed {
  constructor(message: string) {
    super(message);
    this.name = "LocalTimedOut";
  }
}

/** The caller gave up (an interrupted tool call): the connection is closed unanswered, and the request may have run. */
export class LocalAborted extends LocalRequestFailed {
  constructor(message: string) {
    super(message);
    this.name = "LocalAborted";
  }
}

interface Deferred {
  readonly promise: Promise<unknown>;
  readonly resolve: (reply: unknown) => void;
  readonly reject: (err: Error) => void;
}

function deferred(): Deferred {
  let resolve!: (reply: unknown) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * How long a call that may be sent again waits for a restarting daemon to listen again: systemd's
 * `RestartSec=5` plus a cold start, or launchd holding a job that ran under 10 s
 * (`ThrottleInterval`) — a self-update shortly after a start — with room on a slow box.
 */
export const RESTART_GRACE_MS = 20_000;

/** Between tries at a restarting daemon's socket. */
const RESTART_POLL_MS = 250;

export interface ExchangeOpts {
  readonly path: string;
  readonly timeoutMs: number;
  readonly timeoutText: string;
  /**
   * For a frame whose repeat does nothing new — a read, an enqueue by its own task id — only:
   * how long to keep re-sending it while the daemon restarts. A connection lost before its
   * answer starts the clock, and so does a socket nobody accepts on (`LocalUnavailable.refused`);
   * a socket that is not there at all is a daemon not running, said at once. Each try still has
   * `timeoutMs`. Absent or 0, one try.
   */
  readonly restartGraceMs?: number;
  /** Closes the connection when it aborts, which the daemon reads as the caller having gone. */
  readonly signal?: AbortSignal;
}

/**
 * Writes one frame, reads one JSON-object line back, closes. Shared by the op
 * path below and the fleet broker client, which differ only in the frame they
 * send and how they check the answer.
 */
export async function exchange(frame: object, opts: ExchangeOpts): Promise<unknown> {
  const graceMs = opts.restartGraceMs ?? 0;
  let until: number | null = null;
  let lostLast = false;
  let lostEver = false;
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- each try follows the one before
      return await exchangeOnce(frame, opts);
    } catch (err) {
      if (graceMs <= 0 || !(err instanceof LocalUnavailable)) throw err;
      const lost = err instanceof LocalConnectionLost;
      // Once a restart is under way, a socket that is gone for a moment is part of it.
      if (until === null && !lost && !err.refused) throw err;
      // Taken and dropped twice running is a daemon refusing the frame (one older than it), not a restart:
      // a restarting one is not listening in between.
      if (lost && lostLast) throw err;
      lostLast = lost;
      lostEver ||= lost;
      until ??= Date.now() + graceMs;
      if (Date.now() + RESTART_POLL_MS > until) {
        // A try that reached the daemon may have run: giving up on a later connect must not read as never sent.
        throw lostEver && !lost ? new LocalConnectionLost(`${err.message}, after an earlier try was cut off`) : err;
      }
      // oxlint-disable-next-line no-await-in-loop -- the wait between tries
      await Bun.sleep(RESTART_POLL_MS);
    }
  }
}

async function exchangeOnce(frame: object, opts: ExchangeOpts): Promise<unknown> {
  const { path, timeoutMs, signal } = opts;
  const settled = deferred();
  let inbound = EMPTY;
  let outbound = EMPTY;
  let done = false;

  const finish = (fn: () => void): void => {
    if (done) return;
    done = true;
    fn();
  };

  /**
   * Mirrors the server's `flush`: Bun's write is short under backpressure and
   * keeps no remainder, and a half-written request has no newline — the daemon
   * would buffer it and answer nothing until the op timed out. A spawn prompt is
   * free text, so it meets backpressure easily.
   */
  const flush = (sock: Socket<undefined>): void => {
    if (outbound.length === 0) return;
    try {
      const written = sock.write(outbound);
      outbound = written >= outbound.length ? EMPTY : outbound.subarray(written);
    } catch (err) {
      outbound = EMPTY;
      finish(() => settled.reject(new LocalConnectionLost(err instanceof Error ? err.message : String(err))));
    }
  };

  let socket: Socket<undefined>;
  try {
    socket = await Bun.connect<undefined>({
      unix: path,
      socket: {
        data: (_sock, chunk: Buffer): void => {
          inbound = Buffer.concat([inbound, chunk]);
          if (inbound.length > MAX_REPLY_BYTES) {
            finish(() => settled.reject(new LocalRequestFailed("the daemon's reply ran past the frame cap")));
            return;
          }
          const nl = inbound.indexOf(0x0a);
          if (nl === -1) return;
          const line = inbound.subarray(0, nl).toString("utf8");
          try {
            const reply: unknown = JSON.parse(line);
            if (typeof reply !== "object" || reply === null) throw new TypeError("reply is not an object");
            finish(() => settled.resolve(reply));
          } catch (err) {
            finish(() => settled.reject(new LocalRequestFailed(`unparseable reply: ${String(err)}`)));
          }
        },
        // A close before a reply is the daemon going away mid-request, not a
        // clean end — the resolve above has already fired in the normal case.
        close: (): void => {
          finish(() => settled.reject(new LocalConnectionLost("the daemon closed the local socket before replying")));
        },
        error: (_sock, err: Error): void => {
          finish(() => settled.reject(new LocalConnectionLost(err.message)));
        },
        drain: (sock): void => flush(sock),
      },
    });
  } catch (err) {
    // Remediation belongs to `localFailureText`, which carries it for every
    // `LocalUnavailable`, not just this one.
    const code = err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
    throw new LocalUnavailable(`no daemon listening at ${path} (${code ?? String(err)})`, code === "ECONNREFUSED");
  }

  const timer = setTimeout(() => {
    finish(() => settled.reject(new LocalTimedOut(opts.timeoutText)));
  }, timeoutMs);
  const onAbort = (): void => finish(() => settled.reject(new LocalAborted("the caller gave up")));
  if (signal?.aborted === true) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    outbound = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    flush(socket);
    return await settled.promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    socket.end();
  }
}

/**
 * Sends one op to the local daemon and returns its payload — the op's own reply,
 * or the `ErrorResponse` the op socket answers a crashed handler with. `timeoutMs` defaults
 * to the same per-op deadline the app-role client uses, so a local spawn gets the
 * same 90s ceiling as a relayed one rather than a second number to keep in sync.
 */
export async function localRequest<T>(
  op: RequestOp,
  payload: unknown,
  opts: { readonly path?: string; readonly timeoutMs?: number; readonly restartGraceMs?: number } = {},
): Promise<T | ErrorResponse> {
  const request: Plain = { id: crypto.randomUUID(), ts: Date.now(), op, payload };
  const timeoutMs = opts.timeoutMs ?? OP_TIMEOUT_MS[op];
  const reply = await exchange(request, {
    path: opts.path ?? socketPath(),
    timeoutMs,
    timeoutText: `the daemon did not answer ${op} within ${timeoutMs}ms`,
    // Only a read rides out a restart: a lost spawn or despawn may have run.
    restartGraceMs: op === "sessions" ? (opts.restartGraceMs ?? RESTART_GRACE_MS) : 0,
  });
  // One connection per request, so this can only be our own reply — checked
  // anyway, because a mismatch means the two ends disagree about the protocol
  // and that is worth failing loudly rather than returning someone's payload.
  const re = isRecord(reply) ? reply["re"] : undefined;
  if (!isRecord(reply) || re !== request.id) {
    throw new LocalRequestFailed(`the daemon answered a different request (${String(re)})`);
  }
  return reply["payload"] as T | ErrorResponse;
}

/** Whether a daemon is listening locally — `status` and `doctor` report it, and it is the pre-check for a clear error. */
export async function localSocketReachable(path: string = socketPath()): Promise<boolean> {
  try {
    const probe = await Bun.connect<undefined>({
      unix: path,
      socket: { data: (): void => {}, error: (): void => {} },
    });
    probe.end();
    return true;
  } catch {
    return false;
  }
}
