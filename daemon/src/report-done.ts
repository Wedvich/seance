import { isRecord } from "@seance/shared";
import { exchange, LocalUnavailable } from "./local-client.ts";
import { socketPath } from "./paths.ts";
import {
  SESSION_EVENT_KIND,
  SESSION_EVENT_REPLY_CODES,
  SESSION_EVENT_VERSION,
  type SessionEventReply,
} from "./session-event-frame.ts";

/**
 * A session's own `done` report (#21), as `seanced mcp`'s `report_task_done`
 * tool sends it, and its hand-off (`hand_off_task`): the same `session-event`
 * frame the mod's CLI sends, so the daemon binds it by the sender's pid and a
 * session settles or closes only its own task. The MCP server is a child of the
 * session's `claude`, itself in the pane, so the parent walk lands on that pane.
 *
 * Imports nothing that logs: this runs inside `seanced mcp`, whose stdout is the
 * JSON-RPC channel. That is why the reply codes live in `session-event-frame.ts`.
 */

/** The ingest does a pane lookup, a parent walk and a ledger write before it answers. */
const REPORT_TIMEOUT_MS = 5_000;

export interface ReportDoneResult {
  readonly ok: boolean;
  readonly text: string;
}

export interface ReportDoneOpts {
  /** The local op socket; this machine's by default. */
  readonly path?: string;
  /** `$TMUX_PANE`, consulted by the daemon only on a host that cannot name a peer. */
  readonly pane?: string;
}

type Refusals = Record<(typeof SESSION_EVENT_REPLY_CODES)[number], string>;

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
  // Only a hand-off is answered this; listed so every code has words.
  prless: "this machine's daemon noted no pull request for this session's task",
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
    "this machine's daemon noted no pull request for this session's task (it sees one only from `gh pr create` in this session), so its end would not wait for a merge" +
    KEEP_WATCHING,
} as const satisfies Refusals;

function parseReply(raw: unknown): SessionEventReply | null {
  if (!isRecord(raw)) return null;
  if (raw["ok"] === true) return { ok: true };
  const code = SESSION_EVENT_REPLY_CODES.find((c) => c === raw["code"]);
  return raw["ok"] === false && code !== undefined ? { ok: false, code } : null;
}

async function send(
  fields: { readonly state: "done" } | { readonly handoff: true },
  opts: ReportDoneOpts,
  refused: Refusals,
  sent: string,
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
      timeoutMs: REPORT_TIMEOUT_MS,
      timeoutText: "the daemon did not answer in time",
    });
  } catch (err) {
    if (err instanceof LocalUnavailable) return { ok: false, text: "the local daemon is not running" };
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
  const reply = parseReply(raw);
  if (reply === null) return { ok: false, text: "the daemon's answer was not a session-event reply" };
  if (reply.ok) return { ok: true, text: sent };
  return { ok: false, text: refused[reply.code] };
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
