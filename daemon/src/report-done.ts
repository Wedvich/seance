import { isBranchName, isRecord, isTaskId, OP_TIMEOUT_MS } from "@seance/shared";
import { exchange, LocalAborted, LocalConnectionLost, LocalTimedOut, LocalUnavailable } from "./local-client.ts";
import { socketPath } from "./paths.ts";
import {
  SESSION_EVENT_KIND,
  SESSION_EVENT_REPLY_CODES,
  SESSION_EVENT_VERSION,
  type PassAck,
  type SessionEventReply,
} from "./session-event-frame.ts";

/**
 * A session's own `done` report (#21), as `seanced mcp`'s `report_task_done`
 * tool sends it, its hand-off (`hand_off_task`) and its pass (`pass_to_successor`): the same
 * `session-event` frame the mod's CLI sends, so the daemon binds it by the sender's pid and a
 * session settles, closes or passes only its own task. The MCP server is a child of the
 * session's `claude`, itself in the pane, so the parent walk lands on that pane.
 *
 * Imports nothing that logs: this runs inside `seanced mcp`, whose stdout is the
 * JSON-RPC channel. That is why the reply codes live in `session-event-frame.ts`.
 */

/** The ingest does a pane lookup, a parent walk and a ledger write before it answers. */
const REPORT_TIMEOUT_MS = 5_000;

/**
 * A pass pushes the branch before it answers, so it outlasts the leader's own `push-branch` window (a push and
 * the fetch that follows a rejected one, with the git reads around them) by the time the daemon needs to hand the
 * report on. A timeout past this is still worded as "may have gone through", never as a refusal.
 */
const PASS_TIMEOUT_MS = OP_TIMEOUT_MS["push-branch"] + 30_000;

export interface ReportDoneResult {
  readonly ok: boolean;
  readonly text: string;
  /** A pass's answer: what the daemon pushed. */
  readonly pass?: PassAck;
  /**
   * No answer came (a timeout, or the connection lost): the request may have run. Set only on a pass, whose push
   * and report may have gone through; the caller must not word it as a refusal.
   */
  readonly unanswered?: true;
}

export interface ReportDoneOpts {
  /** The local op socket; this machine's by default. */
  readonly path?: string;
  /** `$TMUX_PANE`, consulted by the daemon only on a host that cannot name a peer. */
  readonly pane?: string;
  /** A pass only: aborts when the tool call is cancelled, which closes the connection, and the daemon sends no pass then. */
  readonly signal?: AbortSignal;
}

type ReplyCode = (typeof SESSION_EVENT_REPLY_CODES)[number];

/** The codes only a pass is answered: a `done` report or a hand-off never meets one. */
type PassOnlyCode =
  | "stopping_pushed"
  | "cancelled"
  | "here"
  | "dirty_worktree"
  | "detached_head"
  | "default_branch"
  | "no_upstream"
  | "push_rejected"
  | "push_failed"
  | "unsent";

type Refusals = Record<Exclude<ReplyCode, PassOnlyCode>, string>;

const COMMON = {
  unbound: "this session is not in a tmux pane this machine's daemon can see",
  unsupported: "this machine's daemon runs no session-event ingest",
} as const;

const REPORT_REFUSED = {
  ...COMMON,
  invalid: "this machine's daemon predates done reports; run `seanced update`",
  untasked: "this session runs no scheduler task, so there is nothing to report",
  unrecorded: "this machine's daemon holds no launch of this session's task, so nothing was reported",
  unwritten:
    "sent to the scheduler, but this machine's daemon could not save the report to disk, so a daemon restart could lose it",
  stopping: "this machine's daemon is stopping, so nothing was reported",
  // Only a hand-off is answered these; listed so every code has words.
  prless: "this machine's daemon noted no pull request for this session's task",
  passed: "this session already passed its task to a successor",
} as const satisfies Refusals;

/** Every refusal leaves the PR with the session, and says so. */
const KEEP_WATCHING = "; keep watching the PR yourself";

const HANDOFF_REFUSED = {
  unbound: COMMON.unbound + KEEP_WATCHING,
  unsupported: COMMON.unsupported + KEEP_WATCHING,
  invalid: "this machine's daemon predates hand-offs (run `seanced update`)" + KEEP_WATCHING,
  untasked: "this session runs no scheduler task, so nothing would watch the PR" + KEEP_WATCHING,
  unrecorded:
    "this machine's daemon holds no launch of this session's task, so nothing would watch the PR" + KEEP_WATCHING,
  // Never answered to a hand-off, which writes nothing; listed so every code has words.
  unwritten: "this machine's daemon could not save the hand-off" + KEEP_WATCHING,
  stopping: "this machine's daemon is stopping, so the hand-off was not taken" + KEEP_WATCHING,
  prless:
    "this machine's daemon noted no pull request for this session's task (it sees one only from `gh pr create` in this session, in the session it continues, or as the pull request a successor inherited), so its end would not wait for a merge" +
    KEEP_WATCHING,
  passed: "this session already passed its task to a successor, so there is nothing left to hand off",
} as const satisfies Refusals;

const PASS_REFUSED = {
  unbound: COMMON.unbound,
  unsupported: COMMON.unsupported,
  invalid: "this machine's daemon predates passing; restart seanced (`seanced update`)",
  untasked: "this session runs no scheduler task, so there is nothing to pass",
  unrecorded: "this machine's daemon holds no launch of this session's task, so nothing was pushed or passed",
  // Never answered to a pass, which writes no note; listed so every code has words.
  unwritten: "this machine's daemon could not save the pass",
  stopping: "this machine's daemon is stopping, so nothing was pushed or passed",
  prless: "this machine's daemon noted no pull request for this session's task",
  // Only a hand-off is answered this; listed so every code has words.
  passed: "this session already passed its task",
  here: "this task runs in place and has no branch of its own to pass; nothing was pushed",
  dirty_worktree:
    "commit your changes first, or discard what should not be carried (a stash is never pushed, so a successor would not have it); nothing was pushed",
  detached_head: "this worktree is on no branch; check one out with your commits, then call again; nothing was pushed",
  default_branch:
    "this worktree is on the repo's default branch, which a pass never pushes; move your commits to a task branch, then call again; nothing was pushed",
  no_upstream:
    "this task has a PR and this branch has no upstream; push to the PR's branch with `git push -u origin HEAD:<pr branch>` and call again; nothing was pushed",
  push_rejected:
    "origin rejected the push (not a fast-forward, or a protected branch); fetch and reconcile it yourself, then call again; nothing was forced",
  push_failed:
    "the push did not complete or could not be confirmed (network, credentials, repo configuration, or this machine's own log); try again, and tell the owner if it keeps failing",
  unsent:
    "the branch is pushed, but this machine's daemon could not hand the pass to the scheduler (no relay connection, or the scheduler here is still taking over); call again shortly",
  stopping_pushed:
    "the branch is pushed, but this machine's daemon is stopping and sent no pass; call again once it is back",
  // The caller is gone, so no one reads this; listed so every code has words.
  cancelled: "the call was cancelled before the pass was sent; the branch may be pushed",
} as const satisfies Record<ReplyCode, string>;

function parseAck(raw: unknown): PassAck | undefined {
  if (!isRecord(raw)) return undefined;
  const { taskId, remoteBranch, tip, pushed } = raw;
  if (!isTaskId(taskId) || !isBranchName(remoteBranch) || typeof tip !== "string" || typeof pushed !== "boolean") {
    return undefined;
  }
  return { taskId, remoteBranch, tip, pushed };
}

function parseReply(raw: unknown): SessionEventReply | null {
  if (!isRecord(raw)) return null;
  if (raw["ok"] === true) {
    const pass = parseAck(raw["pass"]);
    return pass === undefined ? { ok: true } : { ok: true, pass };
  }
  const code = SESSION_EVENT_REPLY_CODES.find((c) => c === raw["code"]);
  return raw["ok"] === false && code !== undefined ? { ok: false, code } : null;
}

async function send(
  fields: { readonly state: "done" } | { readonly handoff: true } | { readonly pass: true; readonly record: string },
  opts: ReportDoneOpts,
  refused: Readonly<Partial<Record<ReplyCode, string>>>,
  sent: string,
  timeoutMs: number = REPORT_TIMEOUT_MS,
): Promise<ReportDoneResult> {
  const pane = opts.pane ?? process.env["TMUX_PANE"];
  const frame = {
    v: SESSION_EVENT_VERSION,
    kind: SESSION_EVENT_KIND,
    ...fields,
    ...(pane === undefined || pane === "" ? {} : { pane }),
  };
  let raw: unknown;
  try {
    raw = await exchange(frame, {
      path: opts.path ?? socketPath(),
      timeoutMs,
      timeoutText: "the daemon did not answer in time",
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
  } catch (err) {
    // No answer says nothing about whether the request ran: a pass may have pushed and been sent.
    if (err instanceof LocalTimedOut || err instanceof LocalConnectionLost || err instanceof LocalAborted) {
      return { ok: false, text: err.message, unanswered: true };
    }
    if (err instanceof LocalUnavailable) return { ok: false, text: "the local daemon is not running" };
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
  const reply = parseReply(raw);
  if (reply === null) return { ok: false, text: "the daemon's answer was not a session-event reply" };
  if (reply.ok) return { ok: true, text: sent, ...(reply.pass === undefined ? {} : { pass: reply.pass }) };
  return { ok: false, text: refused[reply.code] ?? `the daemon refused with an unexpected code (${reply.code})` };
}

export function reportDone(opts: ReportDoneOpts = {}): Promise<ReportDoneResult> {
  return send(
    { state: "done" },
    opts,
    REPORT_REFUSED,
    "sent — settles the task if it was queued to settle on its report",
  );
}

export function handOff(opts: ReportDoneOpts = {}): Promise<ReportDoneResult> {
  return send(
    { handoff: true },
    opts,
    HANDOFF_REFUSED,
    "handed off — this session closes once this turn ends; the scheduler now watches the PR (awaiting merge), and its worktree is kept. End the turn now with your final summary.",
  );
}

/**
 * `pass_to_successor`: the daemon pushes this worktree's branch and reports the pass to the scheduler.
 * The text says only that it was taken; whether the leader committed it is the caller's to find out.
 */
export function passToSuccessor(record: string, opts: ReportDoneOpts = {}): Promise<ReportDoneResult> {
  return send(
    { pass: true, record },
    opts,
    PASS_REFUSED,
    "pushed, and the pass was sent to the scheduler",
    PASS_TIMEOUT_MS,
  );
}
