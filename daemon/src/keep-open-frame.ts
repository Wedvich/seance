// Apart from `keep-open.ts` so `seance mcp` (`keep_session_open`) loads only this and not the daemon's table, and never
// reaches `log.ts`: the MCP server's stdout is its JSON-RPC channel.
import { isRecord } from "@seance/shared";

export const KEEP_OPEN_FRAME_VERSION = 1;

/** A session's ask to its own daemon that the custodian leave it open (DESIGN.md, "Keep open"). */
export const KEEP_OPEN_FRAME_KIND = "keep-open";

/** Bounds `keep-open.json`: a hold is one entry per `claude` process, so this is far past any real machine. */
export const KEEP_OPEN_MACHINE_MAX = 64;

export const KEEP_OPEN_REPLY_CODES = [
  /** Not a frame this daemon reads. */
  "invalid",
  /** The sender is in no live pane this daemon can bind by peer pid (or the host names no peers). */
  "unbound",
  /** No `claude` process stands on the sender's chain, so there is no session to hold. */
  "nosession",
  /** Past the per-machine cap. */
  "too_many",
  /** This daemon keeps no holds (one that predates them). */
  "unsupported",
  "stopping",
  /** A bug in the daemon's handling of the frame. */
  "internal",
] as const;

export type KeepOpenReplyCode = (typeof KEEP_OPEN_REPLY_CODES)[number];

/** `held`: whether the session is held open now, after the frame. */
export type KeepOpenReply =
  | { readonly ok: true; readonly held: boolean }
  | { readonly ok: false; readonly code: KeepOpenReplyCode };

export interface KeepOpenFrame {
  readonly keep: boolean;
}

/** Routed on `kind` ahead of the `Plain` check, as watches are. */
export function isKeepOpenFrameKind(raw: unknown): boolean {
  return isRecord(raw) && raw["kind"] === KEEP_OPEN_FRAME_KIND;
}

const FIELDS: ReadonlySet<string> = new Set(["v", "kind", "keep"]);

/** No `pane`, `task` or `session` field, on purpose: the sender is bound by the kernel's peer pid and nothing it claims. */
export function parseKeepOpenFrame(raw: unknown): KeepOpenFrame | null {
  if (!isRecord(raw)) return null;
  if (raw["v"] !== KEEP_OPEN_FRAME_VERSION || raw["kind"] !== KEEP_OPEN_FRAME_KIND) return null;
  if (Object.keys(raw).some((key) => !FIELDS.has(key))) return null;
  const { keep } = raw;
  return typeof keep === "boolean" ? { keep } : null;
}
