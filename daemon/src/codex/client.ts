import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isRecord } from "@seance/shared";
import { WebSocket } from "ws";

/**
 * The daemon's connection to a Codex pane's own `codex app-server` (DESIGN.md, Daemon, "Codex sessions"; docs/codex.md,
 * "A pane that hosts its own server"): JSON-RPC over a WebSocket on the unix socket the pane's server listens on.
 *
 * `ws`, not Bun's WebSocket, which cannot dial a unix socket (S3), and not a client of our own over
 * `Bun.connect({ unix })`: `ws` dials `ws+unix:` under Bun, bounds a message (`maxPayload`) and handles fragmentation,
 * control frames and the close handshake, all of which a hand-rolled framer would have to get right first.
 *
 * Shed and keep running: no method here throws or rejects. A socket error, a close, an oversized or malformed message
 * and a timeout all read as an answer the caller narrows; a dying server is one closed connection.
 */

/** The `--listen` path's name in the run dir (`agents/codex.ts`). */
export const SOCKET_NAME = "s.sock";

/** One message, either way. A turn's notifications carry command output and diffs; past this the server is shed. */
export const CODEX_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
export const CODEX_REQUEST_TIMEOUT_MS = 30_000;

/** Constant method names only (threat model, "What the daemon sends a pane's server"): never a frame's text. */
export type CodexMethod =
  | "initialize"
  | "thread/start"
  | "turn/start"
  | "turn/steer"
  | "thread/resume"
  | "turn/interrupt"
  | "account/rateLimits/read"
  | "thread/turns/list";

/** A notification's method as the server named it: bounded, so nothing past it is held. */
const METHOD_MAX = 128;

/** A notification from the server: its method and its params, unparsed; the reader holds them to its own parser. */
export interface CodexNotification {
  readonly method: string;
  readonly params: unknown;
}

/** An answer reduced to what a caller may keep: a result's value, or an error's code. Never an error's message. */
export type CodexAnswer =
  | { readonly kind: "result"; readonly value: unknown }
  | { readonly kind: "error"; readonly code: number | null }
  | { readonly kind: "closed" }
  | { readonly kind: "timeout" };

export interface CodexConnection {
  request(method: CodexMethod, params: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<CodexAnswer>;
  notify(method: "initialized"): void;
  /** Resolves once the connection is gone, however it went. */
  readonly closed: Promise<void>;
  close(): void;
}

export type SocketState = "ready" | "absent" | "refused";

/** `clientInfo.version`, as the probe's: the daemon has no version of its own but its sha. */
const CLIENT_VERSION = "1";

/** `path`'s realpath when it is a real directory (no link) this uid owns at 0700, else null. */
export async function ownDirectory(path: string): Promise<string | null> {
  const info = await lstat(path).catch(() => null);
  const uid = process.getuid?.();
  if (info === null || !info.isDirectory() || (info.mode & 0o777) !== 0o700) return null;
  if (uid !== undefined && info.uid !== uid) return null;
  return realpath(path).catch(() => null);
}

/**
 * The handshake every daemon connection opens with, the launch's and a reconnect's: `initialize`, its answer's
 * `codexHome` held to `home` (the home's realpath: a server on another home would run the session on another login,
 * the owner's own perhaps), then `initialized`. A failure carries the answer (`resultOf` keeps only its code), or `home`.
 */
export async function initializeCodex(
  connection: CodexConnection,
  home: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly answer: CodexAnswer | "home" }> {
  const init = await connection.request("initialize", {
    clientInfo: { name: "seance", title: null, version: CLIENT_VERSION },
    capabilities: null,
  });
  if (init.kind !== "result") return { ok: false, answer: init };
  const answered = isRecord(init.value) ? init.value["codexHome"] : undefined;
  if (typeof answered !== "string" || (await realpath(answered).catch(() => null)) !== home) {
    return { ok: false, answer: "home" };
  }
  connection.notify("initialized");
  return { ok: true };
}

/**
 * Whether `<runDir>/s.sock` may be dialled (threat model, "The pane server's socket"). Codex makes the `--listen` path
 * a symlink to a 0600 socket in its own 0700 `/tmp/codex-daemon-<uid>/` (S3): the link's target must be absolute, a
 * socket this uid owns, in a real directory (no link) this uid owns at exactly 0700. A socket bound at the path itself
 * is taken too, owned by this uid: it sits in the daemon's own 0700 run dir, the same guarantee by another road, so a
 * Codex that stops linking does not refuse every launch. Anything else is refused, never dialled.
 */
export async function socketState(runDir: string, uid: number | undefined = process.getuid?.()): Promise<SocketState> {
  const path = join(runDir, SOCKET_NAME);
  const at = await lstat(path).catch(() => null);
  if (at === null) return "absent";
  if (at.isSocket()) return uid === undefined || at.uid === uid ? "ready" : "refused";
  if (!at.isSymbolicLink()) return "refused";
  const target = await readlink(path).catch(() => null);
  if (target === null || !isAbsolute(target)) return "refused";
  const [dir, socket] = await Promise.all([lstat(dirname(target)).catch(() => null), lstat(target).catch(() => null)]);
  // The link is written before the server binds its target: not there yet is not refused.
  if (dir !== null && socket === null) return "absent";
  if (dir === null || socket === null) return "refused";
  const ownDir = dir.isDirectory() && (uid === undefined || dir.uid === uid) && (dir.mode & 0o777) === 0o700;
  const ownSocket = socket.isSocket() && (uid === undefined || socket.uid === uid);
  return ownDir && ownSocket ? "ready" : "refused";
}

/**
 * Dials `<runDir>/s.sock`, only once `socketState` says it is ready, and resolves null when the handshake does not
 * complete. Called only for a pane this daemon launched, with a run dir it made.
 */
export async function connectCodex(
  runDir: string,
  onNotification?: (notification: CodexNotification) => void,
): Promise<CodexConnection | null> {
  if ((await socketState(runDir)) !== "ready") return null;
  let ws: WebSocket;
  try {
    ws = new WebSocket(`ws+unix://${join(runDir, SOCKET_NAME)}:/`, {
      maxPayload: CODEX_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  const pending = new Map<number, (answer: CodexAnswer) => void>();
  let nextId = 1;
  let open = false;
  let resolveClosed = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const settleAll = (): void => {
    open = false;
    for (const answer of pending.values()) answer({ kind: "closed" });
    pending.clear();
    resolveClosed();
  };
  // An `error` is always followed by `close`; listening is what keeps it from being thrown.
  ws.on("error", () => undefined);
  ws.on("close", settleAll);
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const value = parseJson(String(data));
    if (onNotification !== undefined) {
      const notification = notificationOf(value);
      if (notification !== null) {
        try {
          onNotification(notification);
        } catch {
          // The reader's own failure is never the connection's: shed the one message and keep reading.
        }
        return;
      }
    }
    const message = answerOf(value);
    if (message === null) return;
    const answer = pending.get(message.id);
    if (answer === undefined) return;
    pending.delete(message.id);
    answer(message.answer);
  });
  const opened = await new Promise<boolean>((resolve) => {
    ws.once("open", () => resolve(true));
    ws.once("close", () => resolve(false));
  });
  if (!opened) return null;
  open = true;

  const send = (message: Readonly<Record<string, unknown>>): boolean => {
    if (!open) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };
  return {
    request: (method, params, timeoutMs = CODEX_REQUEST_TIMEOUT_MS) => {
      const id = nextId++;
      return new Promise<CodexAnswer>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ kind: "timeout" });
        }, timeoutMs);
        pending.set(id, (answer) => {
          clearTimeout(timer);
          resolve(answer);
        });
        if (!send({ id, method, params })) {
          pending.delete(id);
          clearTimeout(timer);
          resolve({ kind: "closed" });
        }
      });
    },
    notify: (method) => {
      send({ method });
    },
    closed,
    close: () => {
      try {
        ws.close();
      } catch {
        // already closing
      }
    },
  };
}

/**
 * A response to one of the daemon's requests, else null: a notification, a server request (an approval, which the
 * daemon never answers) or anything malformed. An error keeps only its code: its message may quote a backend's body.
 */
export function parseMessage(text: string): { readonly id: number; readonly answer: CodexAnswer } | null {
  return answerOf(parseJson(text));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function answerOf(message: unknown): { readonly id: number; readonly answer: CodexAnswer } | null {
  if (!isRecord(message) || "method" in message) return null;
  const { id } = message;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  if ("error" in message) {
    const { error } = message;
    const code = isRecord(error) && typeof error["code"] === "number" ? error["code"] : null;
    return { id, answer: { kind: "error", code } };
  }
  if (!("result" in message)) return null;
  return { id, answer: { kind: "result", value: message["result"] } };
}

/**
 * A notification, else null: a message with a bounded string `method` and no `id`. A server request (an approval,
 * which carries an id) is none: the daemon never answers one, and never reads it either.
 */
export function parseNotification(text: string): CodexNotification | null {
  return notificationOf(parseJson(text));
}

function notificationOf(message: unknown): CodexNotification | null {
  if (!isRecord(message) || "id" in message) return null;
  const { method } = message;
  if (typeof method !== "string" || method === "" || method.length > METHOD_MAX) return null;
  return { method, params: message["params"] };
}
