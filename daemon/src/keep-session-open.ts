import { isRecord } from "@seance/shared";
import { exchange, LocalConnectionLost, LocalRequestFailed, LocalTimedOut, LocalUnavailable } from "./local-client.ts";
import { socketPath } from "./paths.ts";
import {
  KEEP_OPEN_FRAME_KIND,
  KEEP_OPEN_FRAME_VERSION,
  KEEP_OPEN_MACHINE_MAX,
  KEEP_OPEN_REPLY_CODES,
  type KeepOpenReply,
  type KeepOpenReplyCode,
} from "./keep-open-frame.ts";

/**
 * `seance mcp`'s `keep_session_open`: one `keep-open` frame on the local socket, which the daemon binds to the session
 * by the kernel's peer pid (the MCP server is a child of the session's `claude`), as `watch_github` is.
 *
 * Imports nothing that logs: this runs inside `seance mcp`, whose stdout is the JSON-RPC channel.
 */

/** The daemon binds the peer and writes one small file: seconds at most. */
const KEEP_OPEN_TIMEOUT_MS = 10_000;

export interface KeepSessionOpenResult {
  readonly ok: boolean;
  readonly text: string;
}

export interface KeepSessionOpenOpts {
  /** The local op socket; this machine's by default. */
  readonly path?: string;
  readonly timeoutMs?: number;
}

const REFUSED = {
  invalid: "this machine's daemon could not read the request; it may be a different build (`seance update`)",
  unbound:
    "this session is not in a tmux pane this machine's daemon can see, or this machine cannot name a socket's peer process",
  nosession: "this machine's daemon found no `claude` process above this tool, so there is no session to hold",
  too_many: `this machine already holds ${KEEP_OPEN_MACHINE_MAX} sessions open`,
  unsupported: "this machine's daemon predates keep_session_open (`seance update`)",
  stopping: "this machine's daemon is stopping; call again in a minute",
  internal: "this machine's daemon hit an error handling the request (see its log)",
} as const satisfies Record<KeepOpenReplyCode, string>;

function parseReply(raw: unknown): KeepOpenReply | null {
  if (!isRecord(raw)) return null;
  if (raw["ok"] === true) return typeof raw["held"] === "boolean" ? { ok: true, held: raw["held"] } : null;
  const code = KEEP_OPEN_REPLY_CODES.find((c) => c === raw["code"]);
  return raw["ok"] === false && code !== undefined ? { ok: false, code } : null;
}

export async function keepSessionOpen(keep: boolean, opts: KeepSessionOpenOpts = {}): Promise<KeepSessionOpenResult> {
  let raw: unknown;
  try {
    // A retry is harmless (the frame is idempotent), but a dropped connection is reported, as the watch's is.
    raw = await exchange(
      { v: KEEP_OPEN_FRAME_VERSION, kind: KEEP_OPEN_FRAME_KIND, keep },
      {
        path: opts.path ?? socketPath(),
        timeoutMs: opts.timeoutMs ?? KEEP_OPEN_TIMEOUT_MS,
        timeoutText: "no answer from this machine's daemon",
      },
    );
  } catch (err) {
    // Each before the class it extends. An older daemon closes an unknown frame kind as malformed.
    if (err instanceof LocalTimedOut) return { ok: false, text: `${err.message}; call again` };
    if (err instanceof LocalRequestFailed || err instanceof LocalConnectionLost) {
      return { ok: false, text: REFUSED.unsupported };
    }
    if (err instanceof LocalUnavailable) return { ok: false, text: "the local daemon is not running" };
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
  const reply = parseReply(raw) ?? { ok: false, code: "unsupported" };
  if (!reply.ok) return { ok: false, text: `${keep ? "not held" : "not released"}: ${REFUSED[reply.code]}` };
  return {
    ok: true,
    text: reply.held
      ? "held open: this machine's custodian will not close this session while it runs. The owner can still end it, and a restarted `claude` (a resume included) holds nothing: call again then. Release it with keep: false once nothing needs it open."
      : "released: the custodian may close this session again once it judges it finished.",
  };
}
