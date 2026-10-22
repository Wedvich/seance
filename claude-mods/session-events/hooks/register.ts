import type { EngineInterface, Register } from "claude-code";

/**
 * Tells the local seanced what this session is doing, for séance's scheduler
 * (DESIGN.md, "Session events"): busy, idle, waiting on a person, ended, and
 * the PR it opened. Each report is one `seanced session-event` with the event as JSON on
 * stdin. The daemon trusts none of it about *which* session this is — it binds
 * the report to a tmux pane by this process tree — so nothing here names a
 * session or a task.
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
 * and the last one seen rides on `ended`.
 *
 * Auto mode also settles on `ask` (its classifier decides without a person), so
 * there each such call reports needs-input then busy within the classifier's
 * seconds: accepted, since no engine event says a dialog was shown and the leader
 * escalates only a needs-input that lasts.
 * A plugin above this one may override the verdict this hook read: one that
 * asks over an allow is a missed needs-input; one that turns an ask into an
 * allow or deny is a brief needs-input with no dialog. No hook can see either.
 * Not covered: an MCP server's elicitation, which has no engine event.
 *
 * Fire-and-forget throughout: no hook waits on the daemon, and a missing
 * `seanced`, a stopped daemon or a slow one costs the session nothing.
 */

type State = "busy" | "idle" | "needs-input" | "ended";

interface Report {
  readonly state?: State;
  readonly prUrl?: string;
}

/** Long enough for the daemon's parent walk, short enough to never pile up behind a wedged one. */
const SEND_TIMEOUT_MS = 3_000;

/** session.end reasons after which the same process, in the same pane, carries on. */
const CONTINUES: ReadonlySet<string> = new Set(["clear", "resume"]);

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
  await $.process.run(["seanced", "session-event"], { stdin: JSON.stringify(body), timeoutMs: SEND_TIMEOUT_MS });
}

/**
 * Newest state wins, a `prUrl` once seen is kept: a wedged daemon costs
 * SEND_TIMEOUT_MS a run, so a queue of reports would grow without bound, and
 * only the latest state is true by the time one is sent.
 */
function merge(older: Report | null, newer: Report): Report {
  const state = newer.state ?? older?.state;
  const prUrl = newer.prUrl ?? older?.prUrl;
  return { ...(state === undefined ? {} : { state }), ...(prUrl === undefined ? {} : { prUrl }) };
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
  /** The main loop is at its prompt: its turn.complete came and no turn.start since. */
  atPrompt: boolean;
  lastState: State | undefined;
  lastPrUrl: string | undefined;
  anonymous: number;
}

function newTracker(): Tracker {
  return {
    running: false,
    pending: null,
    outstanding: new Map(),
    atPrompt: false,
    lastState: undefined,
    lastPrUrl: undefined,
    anonymous: 0,
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
        // seanced not on PATH, or it timed out: nothing for the session to do about it.
      });
    }
  } finally {
    t.running = false;
  }
}

function send($: EngineInterface, t: Tracker, body: Report): void {
  // Never awaited by a hook: the run resolves when seanced exits.
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

/** Reports the current state; an unchanged one goes out only to carry a `prUrl`. */
function sendCurrent($: EngineInterface, t: Tracker, prUrl?: string): void {
  const state = current(t);
  if (state === t.lastState && prUrl === undefined) return;
  t.lastState = state;
  send($, t, { state, ...(prUrl === undefined ? {} : { prUrl }) });
}

function dropMain(t: Tracker): void {
  for (const [id, loop] of t.outstanding) {
    if (loop === undefined) t.outstanding.delete(id);
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
      sendCurrent($, t);
    }
    return next(e);
  }).catch(($, e, next) => next(e));
  on("turn.complete", ($, e, next) => {
    if (e.agentId === undefined) {
      dropMain(t);
      t.atPrompt = true;
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
      sendCurrent($, t);
    }
    /** Closes `id`; a dialog closing or a PR found reports the state the session is in now. */
    const finish = (prUrl?: string): void => {
      const wasOpen = id !== undefined && t.outstanding.delete(id);
      if (prUrl !== undefined) t.lastPrUrl = prUrl;
      if (prUrl !== undefined || (wasOpen && t.outstanding.size === 0)) sendCurrent($, t, prUrl);
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
        const stdout: unknown = ran.result.stdout;
        if (ran.deny === undefined && ran.isError !== true && typeof stdout === "string") {
          prUrl = prUrlFrom(e.command, stdout) ?? undefined;
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
