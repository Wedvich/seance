// Apart from `custodian-verbs.ts` so `seanced custodian`, which the round runs many times a turn, loads only these
// and not the daemon's side (tmux, the launch ledger, git), and never reaches `log.ts` (the CLI's stdout is the
// round's data channel). The codes are local-socket codes, not wire codes, so they live here as the session-event
// frame's do.
import { isRecord, type FlagReason } from "@seance/shared";
import { PANE_ID } from "./pane-id.ts";

export const CUSTODIAN_FRAME_VERSION = 1;

/** The local socket's sixth frame kind: the custodian round's verbs, bound to the round's own pane. */
export const CUSTODIAN_FRAME_KIND = "custodian";

export const CUSTODIAN_VERBS = ["sessions", "close", "flag", "nudge", "interrupt", "notes", "done"] as const;
export type CustodianVerb = (typeof CUSTODIAN_VERBS)[number];

/** C40: the round's summary is at most this many bytes. */
export const SUMMARY_MAX = 1_024;

export const CUSTODIAN_REPLY_CODES = [
  /** Not a frame this daemon reads. */
  "invalid",
  /** The sender is not a process of the pane the seat record names as the running round. */
  "not_custodian",
  /** This daemon runs no custodian seat. */
  "unsupported",
  /** A bug in the daemon's handling of the frame. */
  "internal",
  // A `close`'s refusals (`CloseRefusal`): the pane's state, per docs/custodian.md C24. `flag` answers `gone` and
  // `foreign` the same way.
  "gone",
  "foreign",
  "marked",
  "waiting",
  "busy",
  "too_soon",
  "unobserved",
  /** A `notes`, `done` or `nudge` text, or a `flag` note, over its cap. */
  "too_long",
  /** A `flag` reason outside `FLAG_REASONS`. */
  "bad_reason",
  /** A `done` at or past the round's deadline. */
  "too_late",
  /** A `close`, `flag`, `nudge`, `interrupt` or `notes` after the round's `done`. */
  "round_done",
  /** A `nudge` to a pane carrying no task this machine's launch ledger holds a launch of: messaging addresses tasks only. */
  "untasked",
  /** A `nudge` past `maxNudges` for the session, or a second `interrupt` of it. */
  "limit",
  /** A `nudge` to a session with no inbox listener now or within the grace: the mod is missing, or its listener dropped. */
  "no_listener",
  /** A second `nudge` of the session in one round. */
  "once_per_round",
  /** An `interrupt` of a pane whose last state is not `busy`, or that is not a live session. */
  "not_busy",
] as const;

export type CustodianReplyCode = (typeof CUSTODIAN_REPLY_CODES)[number];

/** Why a `close` did not act on a pane (`invalid` is a pane id that is not tmux's own form). */
export type CloseRefusal = Extract<
  CustodianReplyCode,
  "foreign" | "marked" | "waiting" | "busy" | "too_soon" | "unobserved" | "gone" | "invalid"
>;

/** Why an `interrupt` sent no key (C27). */
export type InterruptRefusal = Extract<
  CustodianReplyCode,
  "foreign" | "marked" | "waiting" | "not_busy" | "too_soon" | "limit" | "gone"
>;

/**
 * Why a closed task's worktree was kept (docs/custodian.md C32, C33): `dirty` and `unpushed` are the nothing-lost
 * rule's failures, the only two the round's owner is told about; the rest are the rule not answering or a guard.
 */
export type KeptWhy =
  | "dirty"
  | "unpushed"
  | "unevaluated"
  | "remove-failed"
  | "locked"
  | "touched"
  | "in-use"
  | "outside"
  | "unscanned";

export type CustodianFrame =
  | { readonly v: 1; readonly kind: "custodian"; readonly verb: "sessions" }
  | { readonly v: 1; readonly kind: "custodian"; readonly verb: "close"; readonly pane: string }
  | {
      readonly v: 1;
      readonly kind: "custodian";
      readonly verb: "flag";
      readonly pane: string;
      /** A string at parse time: the handler answers `bad_reason`, so the round learns why. */
      readonly reason: string;
      readonly note?: string;
    }
  | { readonly v: 1; readonly kind: "custodian"; readonly verb: "nudge"; readonly pane: string; readonly text: string }
  | { readonly v: 1; readonly kind: "custodian"; readonly verb: "interrupt"; readonly pane: string }
  | { readonly v: 1; readonly kind: "custodian"; readonly verb: "notes"; readonly text: string }
  | { readonly v: 1; readonly kind: "custodian"; readonly verb: "done"; readonly summary: string };

/** One pane of the `sessions` reply: what the round judges by, and the verdict `close` would reach right now. */
export interface CustodianPaneView {
  readonly pane: string;
  readonly window: string;
  readonly cwd: string;
  readonly owner: "ours" | "foreign";
  readonly classification: string;
  readonly state: string | null;
  /** Whole minutes the last state has held, null when none was observed. */
  readonly stateMinutes: number | null;
  readonly turnEnded: boolean;
  /** Whole minutes the screen has been unchanged, null when not sampled. */
  readonly screenMinutes: number | null;
  readonly taskId: string | null;
  readonly prUrl: string | null;
  readonly worktree: string | null;
  readonly marked: boolean;
  /** Nudges this session was sent and whether it was interrupted: the daemon's counts (C30), zero for a new session. */
  readonly nudges: number;
  readonly interrupted: boolean;
  /** The pane's open flag, its reason and when; never the note, which is model-written from pane text. */
  readonly flag: { readonly reason: FlagReason; readonly at: number } | null;
  /** `"ok"`, or the refusal `close` would answer. */
  readonly close: "ok" | CloseRefusal;
}

export type CustodianReply =
  | {
      readonly ok: true;
      readonly verb: "sessions";
      readonly now: number;
      /** When this process began retaining pane state: a pane with no state before it is "unobserved after a restart". */
      readonly retainedSince: number | null;
      readonly panes: readonly CustodianPaneView[];
      /** The file reap last wrote (DESIGN.md, "Nothing lost"), as read; null when none. */
      readonly reapRefusals: unknown;
    }
  | {
      readonly ok: true;
      readonly verb: "close";
      readonly pane: string;
      readonly taskId: string | null;
      readonly outcome: "exited" | "killed" | "harvested";
      readonly worktree: { readonly removed: true; readonly how: string } | { readonly kept: KeptWhy } | null;
    }
  | {
      readonly ok: true;
      readonly verb: "flag";
      readonly pane: string;
      readonly taskId: string | null;
      readonly reason: FlagReason;
      /** Whether the event reached a leader or the relay: false for an untasked pane, or when not connected. */
      readonly sent: boolean;
    }
  | {
      readonly ok: true;
      readonly verb: "nudge";
      readonly pane: string;
      readonly taskId: string;
      /** `sent`: held for the pane's listener, which had not connected yet. */
      readonly outcome: "delivered" | "sent";
      /** This session's nudges, this one included. */
      readonly nudges: number;
    }
  | { readonly ok: true; readonly verb: "interrupt"; readonly pane: string; readonly taskId: string | null }
  | { readonly ok: true; readonly verb: "notes"; readonly kept: readonly string[]; readonly dropped: number }
  | { readonly ok: true; readonly verb: "done" }
  | { readonly ok: false; readonly code: CustodianReplyCode };

export function isCustodianFrameKind(raw: unknown): boolean {
  return isRecord(raw) && raw["kind"] === CUSTODIAN_FRAME_KIND;
}

// Each verb's accepted key sets: a flag's `note` is optional, so it takes two.
const KEYS: Record<CustodianVerb, readonly (readonly string[])[]> = {
  sessions: [["v", "kind", "verb"]],
  close: [["v", "kind", "verb", "pane"]],
  flag: [
    ["v", "kind", "verb", "pane", "reason"],
    ["v", "kind", "verb", "pane", "reason", "note"],
  ],
  nudge: [["v", "kind", "verb", "pane", "text"]],
  interrupt: [["v", "kind", "verb", "pane"]],
  notes: [["v", "kind", "verb", "text"]],
  done: [["v", "kind", "verb", "summary"]],
};

/**
 * Shape only: the exact key set for the verb, `v` 1, a pane that is tmux's own id form, text that is a string. Sizes
 * are the handler's to refuse (`too_long`), so the round learns why.
 */
export function parseCustodianFrame(raw: unknown): CustodianFrame | null {
  if (!isRecord(raw) || raw["v"] !== CUSTODIAN_FRAME_VERSION || raw["kind"] !== CUSTODIAN_FRAME_KIND) return null;
  const verb = CUSTODIAN_VERBS.find((candidate) => candidate === raw["verb"]);
  if (verb === undefined) return null;
  const keys = Object.keys(raw);
  const exact = KEYS[verb].some(
    (expected) => keys.length === expected.length && expected.every((key) => keys.includes(key)),
  );
  if (!exact) return null;
  const base = { v: CUSTODIAN_FRAME_VERSION, kind: CUSTODIAN_FRAME_KIND } as const;
  switch (verb) {
    case "sessions":
      return { ...base, verb };
    case "close":
    case "interrupt": {
      const pane = raw["pane"];
      return typeof pane === "string" && PANE_ID.test(pane) ? { ...base, verb, pane } : null;
    }
    case "nudge": {
      const { pane, text } = raw;
      return typeof pane === "string" && PANE_ID.test(pane) && typeof text === "string"
        ? { ...base, verb, pane, text }
        : null;
    }
    case "flag": {
      const { pane, reason, note } = raw;
      if (typeof pane !== "string" || !PANE_ID.test(pane) || typeof reason !== "string") return null;
      if (note === undefined) return { ...base, verb, pane, reason };
      return typeof note === "string" ? { ...base, verb, pane, reason, note } : null;
    }
    case "notes": {
      const text = raw["text"];
      return typeof text === "string" ? { ...base, verb, text } : null;
    }
    case "done": {
      const summary = raw["summary"];
      return typeof summary === "string" ? { ...base, verb, summary } : null;
    }
  }
}
