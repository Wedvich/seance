import {
  APP_ID,
  quote,
  type ArchiveStatusResponse,
  type ArchiveTasksResponse,
  type MetricsReply,
  type Plain,
} from "@seance/shared";

/** The request ops the archivist's seat answers; every other request is dropped unanswered. */
export const ARCHIVIST_OPS = ["archive-status", "archive-metrics", "archive-tasks"] as const;

export type ArchivistOp = (typeof ARCHIVIST_OPS)[number];

/**
 * What each op's handler may answer with (the ok shape or a structured refusal;
 * the failure refusals are added by `answerApp`), so a handler cannot be
 * paired with another op's name.
 */
interface ArchivistReplies {
  readonly "archive-status": ArchiveStatusResponse;
  readonly "archive-metrics": MetricsReply;
  readonly "archive-tasks": ArchiveTasksResponse;
}

interface Refusal {
  readonly ok: false;
  readonly code: "invalid_request" | "internal_error";
  readonly message: string;
}

/**
 * The seat's answer to one of its ops: only to a request sealed `from` the app
 * and carrying no `re`, and only once the op's own parser made a fresh value of
 * it. The transport has already checked addressing, opening and the replay
 * guard. A drop returns null; the reply goes back as the handler's return
 * value, which the shared client seals to the sender, answering `too_large` in
 * its place past the envelope bound. Nothing of the request is logged — a task
 * query may carry title text — and a failure's reply names only the op.
 */
export async function answerApp<Op extends ArchivistOp, Q>(
  plain: Plain,
  from: string,
  op: Op,
  parse: (payload: unknown) => Q | null,
  answer: (request: Q) => ArchivistReplies[Op] | Promise<ArchivistReplies[Op]>,
  log: { readonly warn: (line: string) => void },
): Promise<Plain | null> {
  if (from !== APP_ID || plain.re !== undefined) {
    log.warn(`dropped ${quote(plain.op)} from ${from}: not sealed from the app`);
    return null;
  }
  const what = op.replace("-", " ");
  const reply = async (): Promise<ArchivistReplies[Op] | Refusal> => {
    const request = parse(plain.payload);
    if (request === null) return { ok: false, code: "invalid_request", message: `malformed ${op} request` };
    try {
      return await answer(request);
    } catch (err) {
      log.warn(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, code: "internal_error", message: `${what} failed` };
    }
  };
  return { id: crypto.randomUUID(), ts: Date.now(), op, re: plain.id, payload: await reply() };
}
