import { isMessageId, isRecord, isWatchHead, parseGithubPr, parseGithubRun } from "@seance/shared";
import { exchange, LocalConnectionLost, LocalRequestFailed, LocalTimedOut, LocalUnavailable } from "./local-client.ts";
import { socketPath } from "./paths.ts";
import {
  WATCH_FRAME_KIND,
  WATCH_FRAME_VERSION,
  WATCH_MACHINE_MAX,
  WATCH_REPLY_CODES,
  WATCH_SESSION_MAX,
  type WatchReplyCode,
} from "./watch-frame.ts";

/**
 * `seance mcp`'s `watch_github` and `unwatch_github`: one `watch` frame on the local socket, which the daemon binds to
 * the session by the kernel's peer pid (the MCP server is a child of the session's `claude`), as `send_message` is.
 *
 * Imports nothing that logs: this runs inside `seance mcp`, whose stdout is the JSON-RPC channel. That is why the
 * frame, its codes and the caps live in `watch-frame.ts`, not the daemon's table.
 */

/**
 * The daemon's add can wait on the app-role leg's connect (10 s), the registry settle (3 s) and the leader's answer
 * (3 s), behind any earlier add of the same session. Past this the daemon may still make the watch, so it is the outer
 * bound, not a guess at the usual case.
 */
const WATCH_TIMEOUT_MS = 30_000;

export interface WatchGithubResult {
  readonly ok: boolean;
  readonly text: string;
  readonly id?: string;
  readonly kind?: "pr" | "run";
}

/** Whether this machine's daemon and the verified leader both keep watches; asked before an add is sent. */
export type WatchGate = () => Promise<{ readonly ok: true } | { readonly ok: false; readonly text: string }>;

export interface WatchGithubOpts {
  /** The local op socket; this machine's by default. */
  readonly path?: string;
  readonly timeoutMs?: number;
}

type Target =
  | { readonly kind: "pr"; readonly owner: string; readonly repo: string; readonly number: number }
  | { readonly kind: "run"; readonly owner: string; readonly repo: string; readonly id: string };

/** Rebuilt from the parsed parts, never the session's string, and at the 30 s floor. */
function pollYourself(target: Target): string {
  const repo = `${target.owner}/${target.repo}`;
  const command =
    target.kind === "pr"
      ? `gh pr checks ${target.number} -R ${repo} --watch -i 30 --fail-fast`
      : `gh run watch ${target.id} -R ${repo} -i 30 --exit-status`;
  return `wait on it yourself instead, in the background: \`${command}\` (never more often than every 30 s)`;
}

const UNBOUND =
  "this session is not in a tmux pane this machine's daemon can see, or this machine cannot name a socket's peer process";
const NO_SESSION = "this machine's daemon found no `claude` process above this tool, so there is no session to wake";
const NO_DAEMON = "the local daemon is not running";
const STOPPING = "this machine's daemon is stopping";
const INTERNAL = "this machine's daemon hit an error handling the watch (see its log)";
const PREDATES = "this machine's daemon keeps no watches (it predates them: `seance update`)";

const ADD_REFUSED = {
  invalid:
    "this machine's daemon or the scheduler refused the watch as unreadable or not pollable; a different build of either may be the cause (`seance update`)",
  unbound: UNBOUND,
  nosession: NO_SESSION,
  nolistener:
    "no inbox listener serves this session, so no note could reach it: its Claude account lacks the inbox mod (`seance mod install`), the session started before it was installed, or its task or listener changed while the watch was being made",
  too_many: `this session has ${WATCH_SESSION_MAX} watches, or this machine ${WATCH_MACHINE_MAX}; unwatch_github one you no longer wait on`,
  fleet_full: "the scheduler watches as many PRs or runs as it takes right now",
  no_leader: "no scheduler leader answers, so nothing would read GitHub for the watch",
  unsupported: "this machine's daemon or the scheduler's leader keeps no watches (`seance update`)",
  unknown: "this machine's daemon answered an add as a removal; it may be a different build (`seance update`)",
  stopping: STOPPING,
  internal: INTERNAL,
} as const satisfies Record<WatchReplyCode, string>;

const REMOVE_REFUSED = {
  invalid: "this machine's daemon could not read the removal; it may predate watches (`seance update`)",
  unbound: UNBOUND,
  nosession: NO_SESSION,
  nolistener: "this machine's daemon refused the removal (nolistener)",
  too_many: "this machine's daemon refused the removal (too_many)",
  fleet_full: "this machine's daemon refused the removal (fleet_full)",
  no_leader: "this machine's daemon refused the removal (no_leader)",
  unsupported: PREDATES,
  unknown:
    "this session has no such watch: it ended already (its target finished, it expired or was replaced), or another session made it; nothing to remove",
  stopping: STOPPING,
  internal: INTERNAL,
} as const satisfies Record<WatchReplyCode, string>;

type Reply =
  | { readonly ok: true; readonly id?: string; readonly kind?: "pr" | "run" }
  | { readonly ok: false; readonly code: WatchReplyCode };

function parseReply(raw: unknown): Reply | null {
  if (!isRecord(raw)) return null;
  if (raw["ok"] === true) {
    const { id, kind } = raw;
    if (id === undefined && kind === undefined) return { ok: true };
    if (!isMessageId(id) || (kind !== "pr" && kind !== "run")) return null;
    return { ok: true, id, kind };
  }
  const code = WATCH_REPLY_CODES.find((c) => c === raw["code"]);
  return raw["ok"] === false && code !== undefined ? { ok: false, code } : null;
}

/**
 * A step 2 daemon advertises `watches` and closes a `watch` frame as malformed, so a dropped connection, like an answer
 * that is no watch reply, is `unsupported` and the session waits on its own (DESIGN.md, "Watches", "Step 4"). A restart
 * also drops it, rarely: an add it had persisted may then still note the session, which only ends a wait early.
 * `sent` is false only when the frame never left this process.
 */
async function send(
  frame: object,
  opts: WatchGithubOpts,
): Promise<Reply | { readonly failed: string; readonly sent: boolean }> {
  let raw: unknown;
  try {
    // No restart grace: a dropped connection is reported, never retried, since a retried add could mint a second watch.
    raw = await exchange(frame, {
      path: opts.path ?? socketPath(),
      timeoutMs: opts.timeoutMs ?? WATCH_TIMEOUT_MS,
      timeoutText: "no answer from this machine's daemon",
    });
  } catch (err) {
    // Each before the class it extends.
    if (err instanceof LocalTimedOut) return { failed: err.message, sent: true };
    if (err instanceof LocalRequestFailed) return { ok: false, code: "unsupported" };
    if (err instanceof LocalConnectionLost) return { ok: false, code: "unsupported" };
    if (err instanceof LocalUnavailable) return { failed: NO_DAEMON, sent: false };
    return { failed: err instanceof Error ? err.message : String(err), sent: true };
  }
  return parseReply(raw) ?? { ok: false, code: "unsupported" };
}

export async function watchGithub(
  request: { readonly url: string; readonly head?: string },
  gate: WatchGate,
  opts: WatchGithubOpts = {},
): Promise<WatchGithubResult> {
  const { url, head } = request;
  const pr = parseGithubPr(url);
  const run = pr === null ? parseGithubRun(url) : null;
  const target: Target | null = pr !== null ? { kind: "pr", ...pr } : run === null ? null : { kind: "run", ...run };
  if (target === null) {
    return {
      ok: false,
      text: "`url` is not a GitHub pull request (https://github.com/<owner>/<repo>/pull/<n>) or Actions run (https://github.com/<owner>/<repo>/actions/runs/<id>) URL",
    };
  }
  if (head !== undefined && target.kind === "run") {
    return { ok: false, text: "`head` is for a pull request only; leave it out for a run" };
  }
  if (head !== undefined && !isWatchHead(head)) {
    return { ok: false, text: "`head` is not a full commit sha (40 or 64 lowercase hex characters)" };
  }
  const fallback = pollYourself(target);

  let gated: Awaited<ReturnType<WatchGate>>;
  try {
    gated = await gate();
  } catch (err) {
    gated = { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
  if (!gated.ok) return { ok: false, text: `not watched: ${gated.text}; ${fallback}` };

  const reply = await send(
    {
      v: WATCH_FRAME_VERSION,
      kind: WATCH_FRAME_KIND,
      op: "add",
      url,
      ...(head === undefined ? {} : { head }),
    },
    opts,
  );
  if ("failed" in reply) {
    return {
      ok: false,
      text: reply.sent
        ? `${reply.failed}; the watch may or may not have been made: call watch_github again (the same URL replaces it), or ${fallback}`
        : `not watched: ${reply.failed}; ${fallback}`,
    };
  }
  if (!reply.ok) {
    if (reply.code === "stopping")
      return { ok: false, text: `not watched: ${STOPPING}; call again in a minute, or ${fallback}` };
    return { ok: false, text: `not watched: ${ADD_REFUSED[reply.code]}; ${fallback}` };
  }
  if (reply.id === undefined || reply.kind === undefined) {
    return { ok: false, text: `not watched: ${ADD_REFUSED.unsupported}; ${fallback}` };
  }
  return {
    ok: true,
    id: reply.id,
    kind: reply.kind,
    text: `watching (${reply.kind === "pr" ? "pull request" : "Actions run"}), watch id ${reply.id}. End your turn now: a note in this session's inbox wakes it when something happens. Do not poll it yourself meanwhile.`,
  };
}

export async function unwatchGithub(id: string, opts: WatchGithubOpts = {}): Promise<WatchGithubResult> {
  if (!isMessageId(id)) return { ok: false, text: "`id` is not a watch id: it is the id watch_github answered" };
  const reply = await send({ v: WATCH_FRAME_VERSION, kind: WATCH_FRAME_KIND, op: "remove", id }, opts);
  if ("failed" in reply) {
    return {
      ok: false,
      text: `${reply.failed}; ${reply.sent ? "the watch may or may not have been removed" : "nothing was sent"}`,
    };
  }
  if (!reply.ok) return { ok: false, text: REMOVE_REFUSED[reply.code] };
  return { ok: true, text: `watch ${id} removed` };
}
