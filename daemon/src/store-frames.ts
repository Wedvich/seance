import {
  RequestFailure,
  STORE_CREATE_MAX_CT_LENGTH,
  STORE_MAX_CT_LENGTH,
  type Envelope,
  type StoreDeleteFrame,
  type StorePutFrame,
  type StoreReplyFrame,
  type StoreRequestFrame,
} from "@seance/shared";

/**
 * The store-frame plumbing the leader's adapters share (`queue-store.ts`,
 * `settings-store.ts`): send a frame, map the relay's answer. Scheduler-free,
 * so a module outside `LEADER_MODULES` can use it — the one thing that differs
 * is the error a term's end throws (`StoreRevoked` lives in `@seance/scheduler`),
 * which the caller supplies as `revoked`.
 */

/** What an adapter sends on: the daemon's relay client (`RelayClient.store`). */
export interface StoreLeg {
  /** Null is a reply this build cannot read; rejects `RequestFailure` when nothing answered. */
  store(frame: StoreRequestFrame): Promise<StoreReplyFrame | null>;
}

/**
 * Why a write did not land, as a value (`STORE_WRITE_FAILURES` in the library's
 * ports has the same codes; the library's `StoreWrite` is this shape).
 */
export type FrameWrite =
  | { readonly ok: true; readonly version: number }
  | {
      readonly ok: false;
      readonly code: "version_conflict" | "indeterminate" | "too_large" | "store_full" | "rate_limited" | "refused";
    };

/** Codes an adapter can carry as they stand. Any other refusal is the request itself being wrong. */
const PASSED_THROUGH = ["version_conflict", "too_large", "rate_limited", "store_full"] as const;

function isPassedThrough(code: string): code is (typeof PASSED_THROUGH)[number] {
  return PASSED_THROUGH.some((passed) => passed === code);
}

/** A create is held to a tighter bound than an overwrite (`STORE_CREATE_MAX_CT_LENGTH`). */
export function withinCap(env: Envelope, expect: number): boolean {
  return env.ct.length <= (expect === 0 ? STORE_CREATE_MAX_CT_LENGTH : STORE_MAX_CT_LENGTH);
}

export interface StoreIo {
  /**
   * A read that cannot be answered rejects: a short list read as the whole
   * queue would be tasks the new leader never runs, and the takeover that
   * fails is retried; a settings read that fails is no verdict on the record,
   * and the term's tick tries it again.
   */
  readonly read: (frame: StoreRequestFrame) => Promise<StoreReplyFrame>;
  /** The adapter's answer to a write: the relay's reply mapped, or the term's end thrown. */
  readonly write: (frame: StorePutFrame | StoreDeleteFrame, version: number) => Promise<FrameWrite>;
}

export function storeIo(leg: StoreLeg, revoked: (why: string) => Error): StoreIo {
  const read = async (frame: StoreRequestFrame): Promise<StoreReplyFrame> => {
    const reply = await leg.store(frame);
    if (reply === null) throw new Error(`${frame.t}: the reply was unreadable`);
    if (reply.t === "store-refused") throw new Error(`${frame.t}: the relay refused it (${reply.code})`);
    return reply;
  };

  const write = async (frame: StorePutFrame | StoreDeleteFrame, version: number): Promise<FrameWrite> => {
    let reply: StoreReplyFrame | null;
    try {
      reply = await leg.store(frame);
    } catch (err) {
      if (!(err instanceof RequestFailure)) throw err;
      // Nothing was sent: the socket the term belongs to is gone, so the term is over.
      if (err.reason === "disconnected") throw revoked(`no socket to send ${frame.t} on`);
      // Sent, then no answer: it may have committed.
      return { ok: false, code: "indeterminate" };
    }
    if (reply === null) return { ok: false, code: "indeterminate" };
    if (reply.t === "store-written") {
      return reply.version === version ? { ok: true, version } : { ok: false, code: "indeterminate" };
    }
    if (reply.t !== "store-refused") return { ok: false, code: "indeterminate" };
    if (reply.code === "not_leader") throw revoked(`the relay refused ${frame.t} as not_leader`);
    return { ok: false, code: isPassedThrough(reply.code) ? reply.code : "refused" };
  };

  return { read, write };
}
