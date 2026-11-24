import { isRecord, type NeedsInputReason, type SessionState } from "@seance/shared";
import type { CodexNotification } from "./client.ts";

/**
 * A Codex session's notifications read into session events (docs/codex.md, "State: the server's notifications";
 * DESIGN.md, Daemon, "Codex session events"). Pure: the registry (`codex/sessions.ts`) feeds it what its connection
 * hears, and hands what comes back to the session-event step.
 *
 * Bound by construction: `thread` is the id this daemon's own `thread/start` returned, and a notification naming any
 * other is dropped (S3 saw Codex's own ephemeral thread report on the same connection mid-turn). What is kept is a
 * state, a turn id and a rate-limit nudge, after a parse that requires them; never a message's text.
 */

/** What one notification means for the session. */
export type CodexSignal =
  | {
      readonly kind: "state";
      readonly state: Exclude<SessionState, "done">;
      readonly turnEnded?: true;
      readonly reason?: NeedsInputReason;
    }
  | { readonly kind: "turn"; readonly turn: string | null }
  /** `account/rateLimits/updated`: the login's reading moved; the registry reads it whole (`account/rateLimits/read`). */
  | { readonly kind: "rateLimits" };

/** A turn id as the registry holds it for `turn/interrupt`: bounded, printable, never logged. */
const TURN_ID_MAX = 128;

/** The session state a thread status reads as (the table's rows), else null: `notLoaded`, `systemError`, garbage. */
export function stateOfStatus(status: unknown): Extract<CodexSignal, { kind: "state" }> | null {
  if (!isRecord(status)) return null;
  const { type } = status;
  if (type === "idle") return { kind: "state", state: "idle" };
  if (type !== "active") return null;
  const flags = status["activeFlags"];
  if (!Array.isArray(flags)) return null;
  // Approval first: the turn waits on it whatever else it waits on, and `permission` is the stricter word.
  if (flags.includes("waitingOnApproval")) return { kind: "state", state: "needs-input", reason: "permission" };
  if (flags.includes("waitingOnUserInput")) return { kind: "state", state: "needs-input", reason: "question" };
  return { kind: "state", state: "busy" };
}

/** A turn's id as `turn/interrupt` takes it, else null. */
export function turnIdOf(turn: unknown): string | null {
  if (!isRecord(turn)) return null;
  const { id } = turn;
  return typeof id === "string" && id !== "" && id.length <= TURN_ID_MAX && /^[\w.:-]+$/u.test(id) ? id : null;
}

/**
 * One notification, for the session on `thread`, as the signals it carries (none for most: deltas, items, MCP
 * status). `turn/completed` follows the status's `idle` (S3, and the item 7 spike): the status's `idle` is an idle
 * with no turn end, which an idle after a `systemError` stays; the turn's completion is the idle a turn's own end
 * raised (`turnEnded`), as Claude's `Stop` is, whether it completed, failed or was interrupted.
 */
export function codexSignals(notification: CodexNotification, thread: string): readonly CodexSignal[] {
  const { method, params } = notification;
  if (method === "account/rateLimits/updated") return [{ kind: "rateLimits" }];
  if (!isRecord(params) || params["threadId"] !== thread) return [];
  switch (method) {
    case "thread/status/changed": {
      const state = stateOfStatus(params["status"]);
      return state === null ? [] : [state];
    }
    case "turn/started":
      return [{ kind: "turn", turn: turnIdOf(params["turn"]) }];
    case "turn/completed":
      return [
        { kind: "turn", turn: null },
        { kind: "state", state: "idle", turnEnded: true },
      ];
    case "thread/closed":
      return [{ kind: "state", state: "ended" }];
    default:
      return [];
  }
}
