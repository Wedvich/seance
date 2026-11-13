import type { EngineInterface, Register } from "claude-code";

/**
 * Delivers messages other séance sessions sent to this one (DESIGN.md, "Session
 * messages"). At `session.start` it starts one child, the daemon CLI's `inbox`
 * command, which holds a connection to the local seanced; each message comes back
 * as one JSON line whose `push` text the daemon rendered, wrapper and fence
 * included. This mod pushes that text verbatim and holds no wording of its own.
 * The daemon binds the connection to a tmux pane by this child's pid and sends only
 * what was addressed to that pane's task, so nothing here names a pane or a task.
 *
 * Delivery is by two engine calls and nothing else: never `asUser` (a message is
 * not the person's own words and must read as a plugin's), never `$.prompt.fill`
 * and never tmux keys (they would land in whatever the person is typing). A
 * question or a request is `$.prompt.submit`, which waits for a running turn to
 * end and wakes an idle session. A note is `$.session.append`, a row added at once
 * (the model reads it within a running turn too) that never wakes an idle session,
 * held back only while a dialog is open and flushed when the last one closes. Any text over the daemon's push cap
 * arrives as a stub naming `read_messages`, whose body is kept here.
 *
 * Every message is also kept (newest within the cap the daemon's ack names) for
 * `read_messages`, in this worker's memory only: a hooks-worker respawn loses
 * them, and the tool says so.
 *
 * Engine events only, never `classic.*` (see session-events). The standing
 * instruction rides the ack and joins the system prompt through `prompt.compose`
 * (layer 1; a managed plugin may skip it, which is why the daemon also puts it on
 * the spawn's command line).
 *
 * Fire-and-forget throughout: nothing waits on the daemon, and a missing `bun`, a
 * stopped daemon or one that predates the frame costs the session nothing but a
 * backed-off retry.
 */

/** `mcp__<plugin>__<name>` for the tool this mod registers. */
const READ_MESSAGES = "mcp__inbox__read_messages";

/** Before the first ack; the daemon's own caps (`keep`) replace them. */
const DEFAULT_KEEP = { messages: 32, bytes: 262_144 } as const;

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 15_000;
/** A refusal a retry does not change soon: the daemon runs no delivery, or will not bind this pane. */
const REFUSED_RETRY_MS = 5 * 60_000;
/** The CLI's exit codes for `unsupported` (3) and for a refused pane, `unbound` or `untasked` (4). */
const REFUSED_EXITS: ReadonlySet<number | null> = new Set([3, 4]);

/** session.end reasons after which the same process, in the same pane, carries on. */
const CONTINUES: ReadonlySet<string> = new Set(["clear", "resume"]);

const KINDS: ReadonlySet<string> = new Set(["note", "question", "request"]);

const NOTHING_HELD =
  "No messages yet. If a message said to call this tool and nothing is here, it was lost when the inbox plugin reloaded; ask its sender (named in that message) to send it again.";

/**
 * The daemon's entry point, by path from this mod's own folder: a directory
 * marketplace is read in place, so the mod and the daemon are always the same
 * checkout. Copied from session-events because each mod is its own plugin root and
 * nothing outside the folder can be imported. Exported for tests.
 */
export function daemonMain(pluginRoot: string): string {
  const parts = pluginRoot.replace(/\/+$/u, "").split("/");
  // The plugin folder is <checkout>/claude-mods/<mod>.
  return [...parts.slice(0, -2), "daemon", "src", "main.ts"].join("/");
}

/**
 * How long to wait before the child is started again, and the failure delay for the
 * one after. An exit after an ack (a rebind, a daemon restart) restarts at once-ish
 * and resets the failure delay; an explicit refusal (`unsupported`, an unbindable
 * or untasked pane) waits out what a retry would not change; anything else,
 * including a close with no reply and no daemon at all, doubles from one second to
 * fifteen, since a pulled-but-not-restarted daemon looks exactly like that during a
 * self-update. Exported for tests.
 */
export function restartDelay(
  exitCode: number | null,
  acked: boolean,
  failureMs: number,
): { readonly delayMs: number; readonly failureMs: number } {
  if (acked) return { delayMs: FIRST_RETRY_MS, failureMs: FIRST_RETRY_MS };
  if (REFUSED_EXITS.has(exitCode)) return { delayMs: REFUSED_RETRY_MS, failureMs };
  return { delayMs: failureMs, failureMs: Math.min(failureMs * 2, MAX_RETRY_MS) };
}

interface Held {
  readonly id: string;
  readonly text: string;
}

/** A line the daemon sent for this session: its push text, and the full body when the push is a stub. */
interface Delivery {
  readonly id: string;
  readonly messageKind: string;
  readonly push: string;
  readonly body?: string;
}

/**
 * Everything a registration tracks. Created inside `register`, so each registration
 * (and each test) starts fresh; a value passed to top-level functions because the
 * hooks compiler only follows `$` into functions declared at the top of the file.
 */
interface Tracker {
  /** What holds a loop on a person, by tool_use_id; the value is the loop's `agentId` (unset: main). */
  readonly outstanding: Map<string, string | undefined>;
  /** From the daemon's ack; present only for a pane that carries a task. */
  instruction: string | undefined;
  keep: { messages: number; bytes: number };
  /** Oldest first, capped by `keep`. */
  held: Held[];
  /** `push` texts of notes waiting for the dialogs to close. */
  pendingNotes: string[];
  buffer: string;
  /** The running listen loop, null before the first `session.start` and after a terminal `session.end`. */
  loop: Loop | null;
  registered: boolean;
  /** The current child has been acked: it spoke to a daemon that runs delivery. */
  acked: boolean;
  /** Ids for an AskUserQuestion call that carries none. */
  anonymous: number;
}

/** One listen loop's lifetime. A new loop never shares a `stopped` flag with an old one still winding down. */
interface Loop {
  stopped: boolean;
  /** Resolves when the loop is told to stop, so a wait on the child or on a backoff ends at once. */
  readonly cancelled: Promise<void>;
  readonly cancel: () => void;
}

function newLoop(): Loop {
  const { promise, resolve } = Promise.withResolvers<void>();
  const loop: Loop = {
    stopped: false,
    cancelled: promise,
    cancel: () => {
      loop.stopped = true;
      resolve();
    },
  };
  return loop;
}

function newTracker(): Tracker {
  return {
    outstanding: new Map(),
    instruction: undefined,
    keep: { ...DEFAULT_KEEP },
    held: [],
    pendingNotes: [],
    buffer: "",
    loop: null,
    registered: false,
    acked: false,
    anonymous: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Drops the oldest until both caps hold; the newest is always kept, however large. */
function trim(t: Tracker): void {
  let bytes = t.held.reduce((sum, h) => sum + byteLength(h.text), 0);
  while (t.held.length > 1 && (t.held.length > t.keep.messages || bytes > t.keep.bytes)) {
    const dropped = t.held.shift();
    if (dropped !== undefined) bytes -= byteLength(dropped.text);
  }
}

/** Never awaited by the reader: a submit stays pending until a running turn ends. */
function submit($: EngineInterface, text: string): void {
  $.prompt.submit({ text }).catch(() => {
    // The session is going away, or a plugin above refused: nothing to do about it.
  });
}

function append($: EngineInterface, text: string): void {
  $.session.append({ message: { type: "user", content: [{ type: "text", text }] } }).catch(() => {
    // As above.
  });
}

function flushNotes($: EngineInterface, t: Tracker): void {
  if (t.outstanding.size > 0) return;
  for (const text of t.pendingNotes.splice(0)) append($, text);
}

function parseDelivery(value: unknown): Delivery | null {
  if (!isRecord(value) || value["v"] !== 1) return null;
  const { id, messageKind, push, body } = value;
  if (typeof id !== "string" || typeof messageKind !== "string" || !KINDS.has(messageKind)) return null;
  if (typeof push !== "string" || (body !== undefined && typeof body !== "string")) return null;
  return { id, messageKind, push, ...(body === undefined ? {} : { body }) };
}

function onAck(t: Tracker, ack: Record<string, unknown>): void {
  t.acked = true;
  t.instruction = typeof ack["instruction"] === "string" ? ack["instruction"] : undefined;
  const keep = ack["keep"];
  if (!isRecord(keep)) return;
  const { messages, bytes } = keep;
  if (typeof messages === "number" && messages > 0) t.keep.messages = messages;
  if (typeof bytes === "number" && bytes > 0) t.keep.bytes = bytes;
}

function onLine($: EngineInterface, t: Tracker, line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (isRecord(parsed) && parsed["ok"] === true) {
    onAck(t, parsed);
    return;
  }
  // `{ok:false}`: the child exits next and the loop backs off.
  const delivery = parseDelivery(parsed);
  if (delivery === null) return;
  t.held.push({ id: delivery.id, text: delivery.body ?? delivery.push });
  trim(t);
  if (delivery.messageKind !== "note") {
    submit($, delivery.push);
    return;
  }
  if (t.outstanding.size > 0) {
    t.pendingNotes.push(delivery.push);
    return;
  }
  append($, delivery.push);
}

function onText($: EngineInterface, t: Tracker, text: string): void {
  t.buffer += text;
  let end = t.buffer.indexOf("\n");
  while (end >= 0) {
    const line = t.buffer.slice(0, end);
    t.buffer = t.buffer.slice(end + 1);
    if (line !== "") onLine($, t, line);
    end = t.buffer.indexOf("\n");
  }
}

/** One child's life: its stdout lines to `onLine`, ending with its exit code (null on a signal, a stop or a failed start). */
async function runChild($: EngineInterface, t: Tracker, loop: Loop): Promise<number | null> {
  t.acked = false;
  t.buffer = "";
  try {
    const proc = $.process.spawn({ argv: ["bun", daemonMain($.plugin.root), "inbox"] });
    // By hand, not `for await`: the exit code is the generator's return value.
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- pieces in order
      const step = await Promise.race([proc.next(), loop.cancelled]);
      if (step === undefined) {
        // The session ended for good: leaving the stream is what kills the child.
        proc.return({ code: null, signal: null }).catch(() => {});
        return null;
      }
      if (step.done === true) return step.value.code;
      // stderr carries nothing the session needs: the CLI is silent by design.
      if (step.value.stream === "stdout") onText($, t, step.value.text);
    }
  } catch {
    // `bun` missing, or the child could not start.
    return null;
  } finally {
    t.buffer = "";
  }
}

/**
 * The child for the session's life: restarted with backoff until the session ends for good. The backoff is the
 * engine's `$.clock.sleep`, never a timer of this module's own: a hot reload cancels the old environment's waits,
 * which rejects here and ends the loop, where a raw timer would fire into an unloaded `$` and retry as a zombie.
 */
async function listenLoop($: EngineInterface, t: Tracker, loop: Loop): Promise<void> {
  let failureMs = FIRST_RETRY_MS;
  try {
    while (!loop.stopped) {
      // oxlint-disable-next-line no-await-in-loop -- one child at a time
      const code = await runChild($, t, loop);
      if (loop.stopped) return;
      const next = restartDelay(code, t.acked, failureMs);
      failureMs = next.failureMs;
      // oxlint-disable-next-line no-await-in-loop -- the backoff
      await Promise.race([$.clock.sleep(next.delayMs), loop.cancelled]);
    }
  } catch {
    // The wait was cancelled with the environment: this loop belongs to one that is gone.
  } finally {
    // The next `session.start` may begin a loop of its own; a stopped loop was already replaced or cleared.
    if (t.loop === loop) t.loop = null;
  }
}

/** Moves the main loop's own dialogs out, as session-events' `dropMain` does: one cannot be open across its turn events. */
function dropMain(t: Tracker): void {
  for (const [id, loop] of t.outstanding) {
    if (loop === undefined) t.outstanding.delete(id);
  }
}

async function start($: EngineInterface, t: Tracker): Promise<void> {
  // Outside a tmux pane (no tmux, or a `claude --bg` session's pty host) the daemon
  // could bind nothing: no child, no tool.
  const pane = await $.env.get("TMUX_PANE");
  if (pane === undefined || pane === "") return;
  if (!t.registered) {
    t.registered = true;
    await $.tool.register({
      name: "read_messages",
      description:
        "Read the messages other séance sessions sent to this session, oldest first. Call it when a message says to.",
    });
  }
  // session.start comes again on a hooks-worker respawn or a reload: one child per registration is enough.
  if (t.loop !== null) return;
  const loop = newLoop();
  t.loop = loop;
  listenLoop($, t, loop).catch(() => {
    // runChild already swallows; this only keeps a bug here from going unhandled.
  });
}

function readMessages(t: Tracker): string {
  // The session now has them, so a note still waiting would only repeat.
  t.pendingNotes.length = 0;
  if (t.held.length === 0) return NOTHING_HELD;
  const texts = t.held.map((h) => h.text).join("\n\n---\n\n");
  return `${t.held.length} message(s) this session has received, oldest first:\n\n${texts}`;
}

// Every hook fails open: a delivery that throws must never cost the event itself.
// Where the hook already called `next`, the handler's `next(e)` replays that
// settlement, so a tool never runs twice and its own rejection passes up unchanged.
// oxlint-disable promise/no-callback-in-promise -- each `.catch` is a hook registration's, not a Promise's
export const register: Register = (on) => {
  const t = newTracker();
  on("session.start", async ($, e, next) => {
    await start($, t);
    return next(e);
  }).catch(($, e, next) => next(e));
  on("turn.start", ($, e, next) => {
    if (e.agentId === undefined) {
      dropMain(t);
      flushNotes($, t);
    }
    return next(e);
  }).catch(($, e, next) => next(e));
  on("turn.complete", ($, e, next) => {
    if (e.agentId === undefined) {
      dropMain(t);
      flushNotes($, t);
    }
    return next(e);
  }).catch(($, e, next) => next(e));
  // Any loop's: a subagent's prompt holds the session as the main loop's does.
  on("tool.check", async ($, e, next) => {
    // The verdict beneath this hook: a plugin above may still change it.
    const verdict = await next(e);
    if (verdict.decision === "ask" && e.approver === "person" && e.tool_use_id !== undefined) {
      t.outstanding.set(e.tool_use_id, e.agentId);
    }
    return verdict;
  }).catch(($, e, next) => next(e));
  on("tool.call", async ($, e, next) => {
    const isQuestion = e.tool === "AskUserQuestion";
    const id = e.tool_use_id ?? (isQuestion ? `question-${++t.anonymous}` : undefined);
    if (isQuestion && id !== undefined) t.outstanding.set(id, e.agentId);
    /** A dialog closes only when its call settles, after the tool ran. */
    const finish = (): void => {
      if (id === undefined || !t.outstanding.delete(id)) return;
      flushNotes($, t);
    };
    try {
      const ran = await next(e);
      finish();
      return ran;
    } catch (err) {
      finish();
      throw err;
    }
  }).catch(($, e, next) => next(e));
  on("tool.call", { tool: READ_MESSAGES }, () => ({ result: readMessages(t) })).catch(($, e, next) => next(e));
  // Layer 1 of the standing instruction (the spawn's command line is layer 2).
  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e);
    if (t.instruction === undefined) return composed;
    return {
      sections: [...composed.sections, { id: "inbox:standing", text: t.instruction, scope: "session" as const }],
    };
  }).catch(($, e, next) => next(e));
  // A session that carries on in the same process keeps its child. Any other end stops the loop and its child here
  // (the module unloading would too, but a process may outlive an end such as a logout).
  on("session.end", ($, e, next) => {
    if (!CONTINUES.has(e.reason) && t.loop !== null) {
      t.loop.cancel();
      t.loop = null;
    }
    return next(e);
  }).catch(($, e, next) => next(e));
};
// oxlint-enable promise/no-callback-in-promise
