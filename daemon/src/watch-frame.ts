// Apart from `watches.ts` so `seance mcp` (step 4's `watch_github`) loads only this and not the daemon's table (tmux,
// messaging, the launch ledger), and never reaches `log.ts`: the MCP server's stdout is its JSON-RPC channel.
import { isMessageId, isRecord, isWatchHead, parseGithubPr, parseGithubRun, type WatchTarget } from "@seance/shared";

export const WATCH_FRAME_VERSION = 1;

/** A session's ask to its own daemon to watch a GitHub PR or Actions run (docs/gh-watch.md W1). */
export const WATCH_FRAME_KIND = "watch";

export const WATCH_REPLY_CODES = [
  /** Not a frame this daemon reads. */
  "invalid",
  /** The sender is in no live pane this daemon can bind by peer pid (or the host names no peers). */
  "unbound",
  /** No `claude` process stands on the sender's chain, so there is no session to wake. */
  "nosession",
  /** The pane has no inbox listener and none is expected, so a note could not reach the session. */
  "nolistener",
  /** Past the per-session or per-machine cap. */
  "too_many",
  /** The leader has no room for another watch (non-terminal for a watch already made: it stays unpolled). */
  "fleet_full",
  /** No verified scheduler leader answers. */
  "no_leader",
  /** The leader or this daemon keeps no watches (a daemon or leader that predates them). */
  "unsupported",
  /** `remove` named no watch of this session: the same answer for a wrong id, so an id is no oracle. */
  "unknown",
  "stopping",
  /** A bug in the daemon's handling of the frame. */
  "internal",
] as const;

export type WatchReplyCode = (typeof WATCH_REPLY_CODES)[number];

export type WatchReply =
  | { readonly ok: true; readonly id: string; readonly kind: "pr" | "run" }
  | { readonly ok: true }
  | { readonly ok: false; readonly code: WatchReplyCode };

export type WatchFrame =
  | { readonly op: "add"; readonly target: WatchTarget; readonly head?: string }
  | { readonly op: "remove"; readonly id: string };

/** Routed on `kind` ahead of the `Plain` check, as messages are. */
export function isWatchFrameKind(raw: unknown): boolean {
  return isRecord(raw) && raw["kind"] === WATCH_FRAME_KIND;
}

const ADD_FIELDS: ReadonlySet<string> = new Set(["v", "kind", "op", "url", "head"]);
const REMOVE_FIELDS: ReadonlySet<string> = new Set(["v", "kind", "op", "id"]);

/**
 * No `pane`, `task` or `session` field, on purpose: the sender is bound by the kernel's peer pid and nothing it claims.
 * The URL goes through the one grammar the leader polls by, so a string outside it never reaches the table.
 */
export function parseWatchFrame(raw: unknown): WatchFrame | null {
  if (!isRecord(raw)) return null;
  if (raw["v"] !== WATCH_FRAME_VERSION || raw["kind"] !== WATCH_FRAME_KIND) return null;
  const { op } = raw;
  if (op === "remove") {
    if (Object.keys(raw).some((key) => !REMOVE_FIELDS.has(key))) return null;
    const { id } = raw;
    return isMessageId(id) ? { op, id } : null;
  }
  if (op !== "add") return null;
  if (Object.keys(raw).some((key) => !ADD_FIELDS.has(key))) return null;
  const { url, head } = raw;
  if (typeof url !== "string") return null;
  const pr = parseGithubPr(url);
  if (pr !== null) {
    if (head === undefined) return { op, target: { kind: "pr", pr } };
    return isWatchHead(head) ? { op, target: { kind: "pr", pr }, head } : null;
  }
  const run = parseGithubRun(url);
  if (run === null || head !== undefined) return null;
  return { op, target: { kind: "run", run } };
}
