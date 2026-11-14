import type { CustodianRequest, CustodianResponse } from "@seance/shared";
import type { CustodianOwnerAudit } from "./audit.ts";
import {
  pausedAt,
  readControl,
  requestRound,
  ROUND_REQUEST_MIN_GAP_MS,
  writePause,
  type CustodianPause,
  type SeatView,
} from "./custodian-control.ts";
import type { RoundEntry } from "./custodian-rounds.ts";
import type { SeatRecord } from "./seat-record.ts";

/**
 * The owner's acts on the custodian, one implementation for both surfaces (docs/custodian.md C45; DESIGN.md, "The
 * custodian's status and the Machines row"): `seanced custodian round | pause | resume` at the shell
 * (`custodian-owner-cli.ts`) and the `custodian` app op (`handlers.ts`, wired in `run.ts`). The caller supplies what
 * differs: where the seat record comes from, whether rounds are live and configured, and the audit's origin. Log-free,
 * like `custodian-control.ts`: each caller says what it says in its own channel.
 */

/** A seat view older than this is no report: the daemon may have stopped or its host been fixed since. */
export const SEAT_VIEW_STALE_MS = 5 * 60_000;

export function freshView(view: SeatView | null, now: number): view is SeatView {
  return view !== null && now - view.at <= SEAT_VIEW_STALE_MS;
}

export interface OwnerRoundInputs {
  readonly now: number;
  /** `ROUNDS_LIVE`, or a test's seam: false refuses `held` before anything is read. */
  readonly live: boolean;
  /** The machine's config.json carries a `custodian` key. */
  readonly configured: () => Promise<boolean>;
  readonly seatView: () => Promise<SeatView | null>;
  /** The daemon's record of its running round and last end: the CLI's from `state.json`, the daemon's from memory. */
  readonly seatRecord: () => Promise<SeatRecord | undefined>;
  readonly rounds: () => Promise<readonly RoundEntry[]>;
  /** Writes `round-request`; a seam for tests. */
  readonly request?: (now: number) => Promise<void>;
}

export type OwnerRound =
  | { readonly outcome: "requested"; readonly view: SeatView | null }
  | { readonly outcome: "held" | "unconfigured" | "failed" | "running" }
  | { readonly outcome: "too_soon"; readonly latest: number; readonly after: number };

/**
 * Round now: what the seat would drop silently at its tick (`custodian-seat.ts` `step`) is refused here instead, with
 * the reason, and nothing is requested then. The seat's own launch attempts are in its memory only, so a request right
 * after a failed launch can still be dropped there.
 */
export async function ownerRound(inputs: OwnerRoundInputs, audit: CustodianOwnerAudit): Promise<OwnerRound> {
  const decided = await decideRound(inputs);
  if (decided.outcome === "requested") await (inputs.request ?? requestRound)(inputs.now);
  await audit.round(decided.outcome);
  return decided;
}

async function decideRound(inputs: OwnerRoundInputs): Promise<OwnerRound> {
  if (!inputs.live) return { outcome: "held" };
  if (!(await inputs.configured())) return { outcome: "unconfigured" };
  const { now } = inputs;
  const read = await inputs.seatView().catch(() => null);
  const view = freshView(read, now) ? read : null;
  if (view?.failed === true) return { outcome: "failed" };
  const [record, entries] = await Promise.all([
    inputs.seatRecord().catch(() => undefined),
    inputs.rounds().catch((): readonly RoundEntry[] => []),
  ]);
  if (record?.round !== undefined || view?.s === "running") return { outcome: "running" };
  const latest = Math.max(record?.lastEndedAt ?? 0, entries.at(-1)?.start ?? 0);
  if (now - latest < ROUND_REQUEST_MIN_GAP_MS) {
    return { outcome: "too_soon", latest, after: latest + ROUND_REQUEST_MIN_GAP_MS };
  }
  return { outcome: "requested", view };
}

/** Pauses the seat from `now`: `until` null holds until resumed. A pause does not stop a round already running. */
export async function ownerPause(
  now: number,
  until: number | null,
  audit: CustodianOwnerAudit,
  path?: string,
): Promise<CustodianPause> {
  const pause: CustodianPause = { at: now, until };
  await writePause(pause, path);
  await audit.pause(until);
  return pause;
}

export async function ownerResume(audit: CustodianOwnerAudit, path?: string): Promise<void> {
  await writePause(null, path);
  await audit.resume();
}

const ROUND_CODES = {
  held: { code: "held", message: "rounds are held on this build" },
  unconfigured: { code: "unconfigured", message: "no custodian is configured on this machine" },
  failed: { code: "host_failed", message: "this host's checks failed, so no round can run" },
  running: { code: "running", message: "a round is running" },
} as const;

/**
 * The `custodian` app op's act (`handlers.ts` parses and gates it; `run.ts` runs it one at a time): the same
 * functions the shell's verbs call, its refusals as codes. The reply carries the pause that holds after the act.
 */
export async function ownerAct(
  request: CustodianRequest,
  inputs: Omit<OwnerRoundInputs, "now"> & { readonly now: () => number; readonly path?: string },
  audit: CustodianOwnerAudit,
): Promise<CustodianResponse> {
  const now = inputs.now();
  if (request.act === "pause") {
    const until = request.minutes === undefined ? null : now + request.minutes * 60_000;
    await ownerPause(now, until, audit, inputs.path);
    return { ok: true, pause: { until } };
  }
  if (request.act === "resume") {
    await ownerResume(audit, inputs.path);
    return { ok: true, pause: null };
  }
  const decided = await ownerRound({ ...inputs, now }, audit);
  if (decided.outcome === "requested") return { ok: true, pause: await pauseNow(now, inputs.path) };
  if (decided.outcome === "too_soon") {
    return { ok: false, code: "too_soon", message: "a round started or ended too recently", after: decided.after };
  }
  return { ok: false, ...ROUND_CODES[decided.outcome] };
}

/** The pause that holds now, as the op's reply says it: an unreadable file holds indefinitely. */
export async function pauseNow(now: number, path?: string): Promise<{ readonly until: number | null } | null> {
  const read = await readControl(path);
  if (!pausedAt(read, now) || read.pause === null) return null;
  return { until: read.pause.until };
}
