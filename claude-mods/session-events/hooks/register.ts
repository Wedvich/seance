import type { EngineInterface, Register } from "claude-code";

/**
 * Tells the local seanced what this session is doing, for séance's scheduler
 * (DESIGN.md, "Session events"): busy, idle, waiting on a person, ended, and
 * the PR it opened. Each report is one `session-event` run of this checkout's
 * daemon CLI (`daemonMain`) with the event as JSON on stdin. The daemon trusts
 * none of it about *which* session this is — it binds the report to a tmux pane
 * by this process tree — so nothing here names a session or a task.
 *
 * Engine events only, never `classic.*`: on Team/Enterprise orgs a built-in
 * plugin sits above every installed one on the classic chain and passes each
 * event on past them, so classic hooks here never ran.
 *
 * Waiting on a person is a `tool.check` whose verdict beneath this hook is
 * `ask` with a person to answer, or an AskUserQuestion call. Each such dialog is
 * kept with the loop it holds (`agentId`, unset for the main loop) until its
 * `tool.call` settles or rejects. The state reported is always the current one:
 * needs-input while any dialog is outstanding, else idle while the main loop is
 * at its prompt (`atPrompt`: set by its turn.complete, cleared by its
 * turn.start), else busy. So a subagent's dialog closing after the main turn
 * ended resumes to idle, and the main loop's own turn events drop its dialogs (one
 * cannot be open across them; any left is a leak) but never a subagent's.
 * Every `prUrl` goes with a state, since the daemon refuses a frame without one,
 * and the last one seen rides on `ended`. A needs-input while any outstanding
 * dialog is an AskUserQuestion carries `reason: "question"`, a permission ask
 * open beside it or not: a real choice is waiting either way, and unlike auto
 * mode's asks it cannot flicker, so the leader alerts it without its debounce.
 * Otherwise it carries `reason: "permission"`, with the `tool` only while exactly
 * one permission dialog is open: with two, the older is usually an approved call
 * still running and nothing says which prompt is on screen. Both are display-only
 * and part of the state: they go and come with the dialogs.
 *
 * A dialog closes only when its `tool.call` settles, after the tool ran: core
 * prompts and runs under one `next`, and no engine event says an ask was settled.
 * So an approved call reads needs-input for its whole run, a person's approval or
 * auto mode's classifier alike (core answers `ask` there too, and no event says a
 * dialog was shown): accepted, since the leader escalates only a needs-input that
 * lasts. Move the close once the engine signals a settled ask.
 * A plugin above this one may override the verdict this hook read: one that
 * asks over an allow is a missed needs-input; one that turns an ask into an
 * allow or deny is a brief needs-input with no dialog. No hook can see either.
 * Not covered: an MCP server's elicitation, which has no engine event.
 *
 * A tool call also reads the Remote Control bridge's session id and reports the
 * unchanged state once when the id is new (`noteBridge`), so the PWA's claude.ai
 * link need not wait for the first turn's end.
 *
 * Fire-and-forget throughout: no hook waits on the daemon, and a missing
 * `bun`, a stopped daemon or a slow one costs the session nothing.
 */

type State = "busy" | "idle" | "needs-input" | "ended";

interface Report {
  readonly state?: State;
  readonly prUrl?: string;
  /** Only beside `idle`: the main loop's own turn.complete put it there, not a `session.start`. */
  readonly turnEnded?: true;
  /** Only beside `needs-input`: an AskUserQuestion is open, else a permission ask. */
  readonly reason?: "question" | "permission";
  /** Only beside `reason: "permission"`: the one open prompt's tool. */
  readonly tool?: string;
}

/** Long enough for the daemon's parent walk, short enough to never pile up behind a wedged one. */
const SEND_TIMEOUT_MS = 3_000;

/** session.end reasons after which the same process, in the same pane, carries on. */
const CONTINUES: ReadonlySet<string> = new Set(["clear", "resume"]);

/**
 * The daemon's entry point, by path from this mod's own folder rather than the
 * CLI's name on PATH: a directory marketplace is read in place, so the mod and
 * the daemon are always the same checkout, while the PATH link is opt-in and
 * nothing re-points it on a pull. Exported for tests.
 */
export function daemonMain(pluginRoot: string): string {
  const parts = pluginRoot.replace(/\/+$/u, "").split("/");
  // The plugin folder is <checkout>/claude-mods/<mod>.
  return [...parts.slice(0, -2), "daemon", "src", "main.ts"].join("/");
}

const PR_URL = /https:\/\/[^\s"'<>]+\/pull\/\d+/u;

/**
 * The PR a `gh pr create` printed. Only that command, only an `https:` URL
 * ending in `/pull/<n>` — the daemon re-checks the scheme anyway, and nothing
 * else a command printed is worth reporting.
 */
export function prUrlFrom(command: string, stdout: string): string | null {
  if (!/\bgh\s+pr\s+create\b/u.test(command)) return null;
  return PR_URL.exec(stdout)?.[0] ?? null;
}

async function report($: EngineInterface, body: Report): Promise<void> {
  // Outside a tmux pane (no tmux, or a `claude --bg` session's pty host) the daemon
  // answers `unbound` every time: not worth a Bun start and its tmux and ps calls
  // per event. The daemon still decides the binding for every report that goes out.
  const pane = await $.env.get("TMUX_PANE");
  if (pane === undefined || pane === "") return;
  // Bun by bare name, as `update.ts` does: resolved at use, never recorded.
  await $.process.run(["bun", daemonMain($.plugin.root), "session-event"], {
    stdin: JSON.stringify(body),
    timeoutMs: SEND_TIMEOUT_MS,
  });
}

/**
 * Newest state wins, a `prUrl` once seen is kept: a wedged daemon costs
 * SEND_TIMEOUT_MS a run, so a queue of reports would grow without bound, and
 * only the latest state is true by the time one is sent.
 */
function merge(older: Report | null, newer: Report): Report {
  const state = newer.state ?? older?.state;
  const prUrl = newer.prUrl ?? older?.prUrl;
  // Belong to their state, so they go wherever the state comes from.
  const turnEnded = newer.state === undefined ? older?.turnEnded : newer.turnEnded;
  const reason = newer.state === undefined ? older?.reason : newer.reason;
  const tool = newer.state === undefined ? older?.tool : newer.tool;
  return {
    ...(state === undefined ? {} : { state }),
    ...(prUrl === undefined ? {} : { prUrl }),
    ...(turnEnded === true ? { turnEnded } : {}),
    ...(reason === undefined ? {} : { reason }),
    ...(tool === undefined ? {} : { tool }),
  };
}

/**
 * Everything a registration tracks. Created inside `register`, so each
 * registration (and each test) starts fresh. It is a value passed to top-level
 * functions rather than closure state because the hooks compiler only follows `$`
 * into functions declared at the top of the file.
 */
interface Tracker {
  /** One report in flight and one pending slot: separate Bun starts race, and an
   * Esc on a permission prompt raises busy then idle within a millisecond, so the
   * second goes out only after the first has landed. */
  running: boolean;
  pending: Report | null;
  /** What holds a loop on a person, by tool_use_id; the value is the loop's `agentId` (unset: main). */
  readonly outstanding: Map<string, string | undefined>;
  /** The ids in `outstanding` that are AskUserQuestion dialogs, leaving with them. */
  readonly questions: Set<string>;
  /** Tool names of the permission dialogs in `outstanding`, by tool_use_id. */
  readonly tools: Map<string, string>;
  /** The main loop is at its prompt: its turn.complete came and no turn.start since. */
  atPrompt: boolean;
  /**
   * `atPrompt` came from the main loop's turn.complete. A `session.start` also sets `atPrompt`, on a
   * hooks-worker respawn mid-turn too, so only this says the turn's last message is written: what a
   * hand-off's close waits for (DESIGN.md, "Session events").
   */
  turnEnded: boolean;
  lastState: State | undefined;
  lastTurnEnded: boolean;
  /** What the last needs-input said about why: `""`, `"question"`, `"permission:<tool>"`. */
  lastWait: string;
  lastPrUrl: string | undefined;
  anonymous: number;
  /** The bridge's session id as a tool call last read it (`noteBridge`); unset until one did. */
  bridge: string | undefined;
  /** `bridge` when the last report went out: one that changed since is news even in an unchanged state. */
  lastBridge: string | undefined;
}

function newTracker(): Tracker {
  return {
    running: false,
    pending: null,
    outstanding: new Map(),
    questions: new Set(),
    tools: new Map(),
    atPrompt: false,
    turnEnded: false,
    lastState: undefined,
    lastTurnEnded: false,
    lastWait: "",
    lastPrUrl: undefined,
    anonymous: 0,
    bridge: undefined,
    lastBridge: undefined,
  };
}

async function drain($: EngineInterface, t: Tracker): Promise<void> {
  t.running = true;
  try {
    while (t.pending !== null) {
      const body: Report = t.pending;
      t.pending = null;
      // oxlint-disable-next-line no-await-in-loop -- one report at a time, in order
      await report($, body).catch(() => {
        // bun not on PATH, or the run timed out: nothing for the session to do about it.
      });
    }
  } finally {
    t.running = false;
  }
}

function send($: EngineInterface, t: Tracker, body: Report): void {
  // Never awaited by a hook: the run resolves when the CLI exits.
  if (body.state === "ended") {
    // Terminal, so it skips the queue: it must not wait out a wedged daemon's
    // timeouts, and whatever was pending is stale. A pending prUrl rides along.
    const last = merge(t.pending, body);
    t.pending = null;
    report($, last).catch(() => {
      // As above: nothing for the session to do about it.
    });
    return;
  }
  t.pending = merge(t.pending, body);
  if (!t.running) {
    drain($, t).catch(() => {
      // report() already swallows; this only keeps a bug here from going unhandled.
    });
  }
}

function current(t: Tracker): State {
  if (t.outstanding.size > 0) return "needs-input";
  return t.atPrompt ? "idle" : "busy";
}

/** Why a needs-input waits. Top-level: the hooks compiler follows `$` only into top-level functions. */
function waitOf(t: Tracker): { reason?: "question" | "permission"; tool?: string } {
  if (t.questions.size > 0) return { reason: "question" };
  const perms = [...t.outstanding.keys()].filter((id) => !t.questions.has(id));
  if (perms.length === 0) return {};
  const [only] = perms;
  const tool = perms.length === 1 && only !== undefined ? t.tools.get(only) : undefined;
  return { reason: "permission", ...(tool === undefined ? {} : { tool }) };
}

/** Reports the current state; an unchanged one goes out only to carry a `prUrl`. */
function sendCurrent($: EngineInterface, t: Tracker, prUrl?: string): void {
  const state = current(t);
  // Part of the state: a respawn's idle followed by the turn's own end is a change.
  const turnEnded = state === "idle" && t.turnEnded;
  // Part of the state too: a question opening beside a permission ask, or a different prompt being the only one left, is a change.
  const wait = state === "needs-input" ? waitOf(t) : {};
  const waitKey = `${wait.reason ?? ""}${wait.tool === undefined ? "" : `:${wait.tool}`}`;
  const same = state === t.lastState && turnEnded === t.lastTurnEnded && waitKey === t.lastWait;
  if (same && t.bridge === t.lastBridge && prUrl === undefined) return;
  t.lastState = state;
  t.lastTurnEnded = turnEnded;
  t.lastWait = waitKey;
  t.lastBridge = t.bridge;
  send($, t, {
    state,
    ...(prUrl === undefined ? {} : { prUrl }),
    ...(turnEnded ? { turnEnded } : {}),
    ...wait,
  });
}

/**
 * Reads the Remote Control bridge's session id, for `sendCurrent` to report a change in it. The CLI
 * already adds it to every report from the env it inherits, but the bridge connects a second or so
 * after the first turn starts, and a busy turn changes no state until it ends: without this, the
 * PWA's claude.ai link waits for that end. A session started under another's env (a tmux server
 * booted from inside a session) inherits that one's id until its own bridge replaces it, and this
 * corrects that too. Read live: the engine sets the variable on its own process.
 */
async function noteBridge($: EngineInterface, t: Tracker): Promise<void> {
  try {
    const id = await $.env.get("CLAUDE_CODE_BRIDGE_SESSION_ID");
    t.bridge = id === "" ? undefined : id;
  } catch {
    // Unreadable: the next state change carries whatever the env holds then.
  }
}

/**
 * A bridge id that is new since the last report, outside idle. An idle report is a turn's end to the
 * daemon (a hand-off's or a pass's close, the drain ask's prompt) when it carries `turnEnded`, so it
 * is never repeated for an id alone: the main loop's next `turn.start` carries the id instead.
 */
function shouldSendBridge(t: Tracker): boolean {
  return t.bridge !== t.lastBridge && current(t) !== "idle";
}

function dropMain(t: Tracker): void {
  for (const [id, loop] of t.outstanding) {
    if (loop !== undefined) continue;
    t.outstanding.delete(id);
    t.questions.delete(id);
    t.tools.delete(id);
  }
}

// Every hook fails open: a report that throws must never cost the event itself.
// Where the hook already called `next`, the handler's `next(e)` replays that
// settlement, so a tool never runs twice and its own rejection passes up unchanged.
// oxlint-disable promise/no-callback-in-promise -- each `.catch` is a hook registration's, not a Promise's
export const register: Register = (on) => {
  const t = newTracker();
  // Also raised on an enable, a hooks-worker respawn or a reload, not only a fresh
  // process, so a restart mid-turn reads idle until the next turn event. Gating on
  // a first start would take a `$.state` contract and a value this plugin owns:
  // too much machinery for a report the next turn event corrects.
  on("session.start", ($, e, next) => {
    t.atPrompt = true;
    t.turnEnded = false;
    sendCurrent($, t);
    return next(e);
  }).catch(($, e, next) => next(e));
  // A subagent's turns say nothing about whether the main loop is at its prompt.
  on("turn.start", ($, e, next) => {
    if (e.agentId === undefined) {
      // Not only a typed prompt: a continuation turn starts with `text: ""` while a
      // background subagent's dialog may be open, which therefore stays.
      dropMain(t);
      t.atPrompt = false;
      t.turnEnded = false;
      sendCurrent($, t);
    }
    return next(e);
  }).catch(($, e, next) => next(e));
  on("turn.complete", ($, e, next) => {
    if (e.agentId === undefined) {
      dropMain(t);
      t.atPrompt = true;
      t.turnEnded = true;
      sendCurrent($, t);
    }
    return next(e);
  }).catch(($, e, next) => next(e));
  // Any loop's: a subagent's prompt holds the session as the main loop's does.
  // A `$.tool.check` query carries no tool_use_id and shows no dialog.
  on("tool.check", async ($, e, next) => {
    // The verdict beneath this hook: a plugin above may still change it.
    const verdict = await next(e);
    if (verdict.decision === "ask" && e.approver === "person" && e.tool_use_id !== undefined) {
      t.outstanding.set(e.tool_use_id, e.agentId);
      if (typeof e.tool === "string") t.tools.set(e.tool_use_id, e.tool);
      sendCurrent($, t);
    }
    return verdict;
  }).catch(($, e, next) => next(e));
  on("tool.call", async ($, e, next) => {
    const isQuestion = e.tool === "AskUserQuestion";
    // Core's own check for AskUserQuestion settles ask/person under this id too.
    const id = e.tool_use_id ?? (isQuestion ? `question-${++t.anonymous}` : undefined);
    if (isQuestion && id !== undefined) {
      t.outstanding.set(id, e.agentId);
      t.questions.add(id);
      sendCurrent($, t);
    }
    // Unawaited, like every report: the tool never waits on the read.
    noteBridge($, t)
      .then(() => {
        if (shouldSendBridge(t)) sendCurrent($, t);
      })
      .catch(() => {
        // noteBridge already swallows; this only keeps a bug here from going unhandled.
      });
    /** Closes `id`; a dialog closing or a PR found reports the state the session is in now. */
    const finish = (prUrl?: string): void => {
      const wasOpen = id !== undefined && t.outstanding.delete(id);
      if (id !== undefined) {
        t.questions.delete(id);
        t.tools.delete(id);
      }
      if (prUrl !== undefined) t.lastPrUrl = prUrl;
      // sendCurrent dedupes: a closing prompt may change the reason or the one tool left.
      if (prUrl !== undefined || wasOpen) sendCurrent($, t, prUrl);
    };
    // A rejection closes too, so the session resumes whatever the turn does next.
    const settled = async <R>(run: Promise<R>): Promise<R> =>
      run.catch((err: unknown) => {
        finish();
        throw err;
      });
    // Narrowed before `next`, so it resolves to Bash's own record.
    if (e.tool === "Bash") {
      const ran = await settled(next(e));
      let prUrl: string | undefined;
      try {
        // An errored call still counts: `gh pr create && gh pr merge --auto` that fails at the
        // merge has opened the PR, and losing it refuses the session's hand-off. Core gives an
        // errored call no record, only the output as the model read it, stderr merged in.
        const output: unknown = ran.isError === true ? ran.text : ran.result.stdout;
        if (ran.deny === undefined && typeof output === "string") {
          prUrl = prUrlFrom(e.command, output) ?? undefined;
        }
      } catch {
        // A result of a shape this mod does not know: no PR to report.
      }
      finish(prUrl);
      return ran;
    }
    const ran = await settled(next(e));
    finish();
    return ran;
  }).catch(($, e, next) => next(e));
  // Unawaited like the rest, so it may not outlive a fast exit; the daemon's
  // `ended` backstop counts a launched task whose pane is gone either way.
  // `/clear` and `/resume` end a conversation, not the process: the pane runs
  // on, so `ended` — terminal for the task — would be a lie.
  on("session.end", ($, e, next) => {
    if (!CONTINUES.has(e.reason)) {
      send($, t, { state: "ended", ...(t.lastPrUrl === undefined ? {} : { prUrl: t.lastPrUrl }) });
    }
    return next(e);
  }).catch(($, e, next) => next(e));
};
// oxlint-enable promise/no-callback-in-promise
