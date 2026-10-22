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
 * Waiting on a person is a `tool.check` that settles on `ask` with a person to
 * answer, or an AskUserQuestion call; that call's `tool.call` resolving means
 * the turn goes on. Auto mode also settles on `ask` (its classifier decides
 * without a person), so there each such call reports needs-input then busy
 * within the classifier's seconds: accepted, since no engine event says a
 * dialog was shown and the leader escalates only a needs-input that lasts.
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

// One report at a time, in the order raised: separate Bun starts race, and an
// Esc on a permission prompt raises busy (the call settled) then idle (the turn
// ended) within a millisecond.
let sending: Promise<void> = Promise.resolve();

function send($: EngineInterface, body: Report): void {
  // Never awaited by a hook: the run resolves when seanced exits.
  sending = sending
    .then(() => report($, body))
    .catch(() => {
      // seanced not on PATH, or it timed out: nothing for the session to do about it.
    });
}

/** Calls a person was asked to approve, by tool_use_id, until their `tool.call` settles. */
const asked = new Set<string>();

// Every hook fails open: a report that throws must never cost the event itself.
// Where the hook already called `next`, the handler's `next(e)` replays that
// settlement, so a tool never runs twice and its own rejection passes up unchanged.
// oxlint-disable promise/no-callback-in-promise -- each `.catch` is a hook registration's, not a Promise's
export const register: Register = (on) => {
  // Not raised for a /clear or a compaction, so idle here is a fresh process.
  on("session.start", ($, e, next) => {
    send($, { state: "idle" });
    return next(e);
  }).catch(($, e, next) => next(e));
  // A subagent's turns run inside the main loop's: only the main loop's say anything.
  on("turn.start", ($, e, next) => {
    if (e.agentId === undefined) send($, { state: "busy" });
    return next(e);
  }).catch(($, e, next) => next(e));
  on("turn.complete", ($, e, next) => {
    if (e.agentId === undefined) send($, { state: "idle" });
    return next(e);
  }).catch(($, e, next) => next(e));
  // Any loop's: a subagent's prompt holds the session as the main loop's does.
  // A `$.tool.check` query carries no tool_use_id and shows no dialog.
  on("tool.check", async ($, e, next) => {
    const verdict = await next(e);
    if (verdict.decision === "ask" && e.approver === "person" && e.tool_use_id !== undefined) {
      asked.add(e.tool_use_id);
      send($, { state: "needs-input" });
    }
    return verdict;
  }).catch(($, e, next) => next(e));
  on("tool.call", async ($, e, next) => {
    const isQuestion = e.tool === "AskUserQuestion";
    if (isQuestion) send($, { state: "needs-input" });
    const id = e.tool_use_id;
    const forget = (): boolean => id !== undefined && asked.delete(id);
    // A rejected call reports nothing: the turn is ending, and turn.complete says so.
    const settled = async <R>(run: Promise<R>): Promise<R> =>
      run.catch((err: unknown) => {
        forget();
        throw err;
      });
    // Narrowed before `next`, so it resolves to Bash's own record.
    if (e.tool === "Bash") {
      const ran = await settled(next(e));
      const wasAsked = forget();
      const isAnswered = ran.deny === undefined && ran.isError !== true;
      const prUrl = isAnswered ? prUrlFrom(e.command, ran.result.stdout) : null;
      if (prUrl !== null) send($, { state: "busy", prUrl });
      else if (wasAsked) send($, { state: "busy" });
      return ran;
    }
    const ran = await settled(next(e));
    if (forget() || isQuestion) send($, { state: "busy" });
    return ran;
  }).catch(($, e, next) => next(e));
  // Unawaited like the rest, so it may not outlive a fast exit; the daemon's
  // `ended` backstop counts a launched task whose pane is gone either way.
  // `/clear` and `/resume` end a conversation, not the process: the pane runs
  // on, so `ended` — terminal for the task — would be a lie.
  on("session.end", ($, e, next) => {
    if (!CONTINUES.has(e.reason)) send($, { state: "ended" });
    return next(e);
  }).catch(($, e, next) => next(e));
};
// oxlint-enable promise/no-callback-in-promise
