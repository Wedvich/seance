import type { EngineInterface, Register } from "claude-code";

/**
 * Tells the local seanced what this session is doing, for séance's scheduler
 * (DESIGN.md, "Session events"): busy, idle, waiting on a person, ended; the
 * PR it opened; and the account's rate-limit windows as the session last saw
 * them. Each report is one `seanced session-event` with the event as JSON on
 * stdin. The daemon trusts none of it about *which* session this is — it binds
 * the report to a tmux pane by this process tree — so nothing here names a
 * session or a task.
 *
 * Fire-and-forget throughout: no hook waits on the daemon, and a missing
 * `seanced`, a stopped daemon or a slow one costs the session nothing.
 */

type State = "busy" | "idle" | "needs-input" | "ended";

interface Report {
  readonly state?: State;
  readonly prUrl?: string;
  readonly rateLimits?: readonly { readonly kind: string; readonly percentUsed: number; readonly resetsAt?: string }[];
}

/** Long enough for the daemon's parent walk, short enough to never pile up behind a wedged one. */
const SEND_TIMEOUT_MS = 3_000;

/** Waiting on a person, as opposed to idle: a permission prompt or a question the session asked. */
const NEEDS_INPUT = new Set(["permission_prompt", "elicitation_dialog"]);

/** SessionEnd reasons after which the same process, in the same pane, carries on. */
const CONTINUES: ReadonlySet<string> = new Set(["clear", "resume"]);

export function notificationState(type: string): State | null {
  if (NEEDS_INPUT.has(type)) return "needs-input";
  return type === "idle_prompt" ? "idle" : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PR_URL = /https:\/\/[^\s"'<>]+\/pull\/\d+/u;

/**
 * The PR a `gh pr create` printed. Only Bash, only that command, only an
 * `https:` URL ending in `/pull/<n>` — the daemon re-checks the scheme anyway,
 * and nothing else a tool printed is worth reporting.
 */
export function prUrlFrom(toolName: string, input: unknown, response: unknown): string | null {
  if (toolName !== "Bash" || !isRecord(input) || typeof input["command"] !== "string") return null;
  if (!/\bgh\s+pr\s+create\b/u.test(input["command"])) return null;
  const out = isRecord(response) ? response["stdout"] : response;
  if (typeof out !== "string") return null;
  return PR_URL.exec(out)?.[0] ?? null;
}

async function report($: EngineInterface, body: Report): Promise<void> {
  // Outside a tmux pane (no tmux, or a `claude --bg` session's pty host) the daemon
  // answers `unbound` every time: not worth a Bun start and its tmux and ps calls
  // per event. The daemon still decides the binding for every report that goes out.
  const pane = await $.env.get("TMUX_PANE");
  if (pane === undefined || pane === "") return;
  await $.process.run(["seanced", "session-event"], { stdin: JSON.stringify(body), timeoutMs: SEND_TIMEOUT_MS });
}

function send($: EngineInterface, body: Report): void {
  // Unawaited: the run resolves when seanced exits, and no hook should wait for that.
  void report($, body).catch(() => {
    // seanced not on PATH, or it timed out: nothing for the session to do about it.
  });
}

// Every hook fails open: a report that throws must never cost the event itself.
// oxlint-disable promise/no-callback-in-promise -- each `.catch` is a hook registration's, not a Promise's
export const register: Register = (on) => {
  on("classic.SessionStart", ($, e, next) => {
    // A compaction can land mid-turn: the session is not idle because of it.
    if (e.source !== "compact") send($, { state: "idle" });
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.UserPromptSubmit", ($, e, next) => {
    send($, { state: "busy" });
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.Stop", ($, e, next) => {
    send($, { state: "idle" });
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.Notification", ($, e, next) => {
    const state = notificationState(e.notification_type);
    if (state !== null) send($, { state });
    return next(e);
  }).catch(($, e, next) => next(e));
  on("classic.PostToolUse", ($, e, next) => {
    const prUrl = prUrlFrom(e.tool_name, e.tool_input, e.tool_response);
    if (prUrl !== null) send($, { state: "busy", prUrl });
    return next(e);
  }).catch(($, e, next) => next(e));
  // Unawaited like the rest, so it may not outlive a fast exit; the daemon's
  // `ended` backstop counts a launched task whose pane is gone either way.
  // `/clear` and `/resume` end a conversation, not the process: the pane runs
  // on, so `ended` — terminal for the task — would be a lie.
  on("classic.SessionEnd", ($, e, next) => {
    if (!CONTINUES.has(e.reason)) send($, { state: "ended" });
    return next(e);
  }).catch(($, e, next) => next(e));
  // Rate limits as the status line has them, pushed after each turn and when a
  // window moves a point — the session's own reading of its account's quota.
  on("session.measure", ($, e, next) => {
    if (e.changed.includes("rateLimits") && e.rateLimits.length > 0) {
      send($, {
        rateLimits: e.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({
          kind,
          percentUsed,
          ...(resetsAt === undefined ? {} : { resetsAt }),
        })),
      });
    }
    return next(e);
  });
};
// oxlint-enable promise/no-callback-in-promise
