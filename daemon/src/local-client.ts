import type { Socket } from "bun";
import { OP_TIMEOUT_MS, type Plain, type RequestOp } from "@seance/shared";
import { socketPath } from "./paths.ts";

/**
 * The peer side of `local-socket.ts`: one op, one connection, no correlation
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
  constructor(message: string) {
    super(message);
    this.name = "LocalUnavailable";
  }
}

/** The daemon answered, and the answer was a refusal or a crash. */
export class LocalRequestFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRequestFailed";
  }
}

interface Deferred {
  readonly promise: Promise<Plain>;
  readonly resolve: (plain: Plain) => void;
  readonly reject: (err: Error) => void;
}

function deferred(): Deferred {
  let resolve!: (plain: Plain) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<Plain>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Sends one op to the local daemon and returns its payload. `timeoutMs` defaults
 * to the same per-op deadline the app-role client uses, so a local spawn gets the
 * same 90s ceiling as a relayed one rather than a second number to keep in sync.
 */
export async function localRequest<T>(
  op: RequestOp,
  payload: unknown,
  opts: { readonly path?: string; readonly timeoutMs?: number } = {},
): Promise<T> {
  const path = opts.path ?? socketPath();
  const request: Plain = { id: crypto.randomUUID(), ts: Date.now(), op, payload };
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
      finish(() => settled.reject(new LocalUnavailable(err instanceof Error ? err.message : String(err))));
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
            finish(() => settled.resolve(reply as Plain));
          } catch (err) {
            finish(() => settled.reject(new LocalRequestFailed(`unparseable reply: ${String(err)}`)));
          }
        },
        // A close before a reply is the daemon going away mid-request, not a
        // clean end — the resolve above has already fired in the normal case.
        close: (): void => {
          finish(() => settled.reject(new LocalUnavailable("the daemon closed the local socket before replying")));
        },
        error: (_sock, err: Error): void => {
          finish(() => settled.reject(new LocalUnavailable(err.message)));
        },
        drain: (sock): void => flush(sock),
      },
    });
  } catch (err) {
    // Remediation belongs to `localFailureText`, which carries it for every
    // `LocalUnavailable`, not just this one.
    throw new LocalUnavailable(
      `no daemon listening at ${path} (${(err as NodeJS.ErrnoException).code ?? String(err)})`,
    );
  }

  const timeoutMs = opts.timeoutMs ?? OP_TIMEOUT_MS[op];
  const timer = setTimeout(() => {
    finish(() => settled.reject(new LocalRequestFailed(`the daemon did not answer ${op} within ${timeoutMs}ms`)));
  }, timeoutMs);

  try {
    outbound = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
    flush(socket);
    const reply = await settled.promise;
    // One connection per request, so this can only be our own reply — checked
    // anyway, because a mismatch means the two ends disagree about the protocol
    // and that is worth failing loudly rather than returning someone's payload.
    if (reply.re !== request.id) {
      throw new LocalRequestFailed(`the daemon answered a different request (${String(reply.re)})`);
    }
    return reply.payload as T;
  } finally {
    clearTimeout(timer);
    socket.end();
  }
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
