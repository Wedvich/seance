import { mkdir, readFile, unlink } from "node:fs/promises";
import { CUSTODIAN_STATES, isRecord, type CustodianState } from "@seance/shared";
import { dirname } from "node:path";
import { custodianRoundRequestPath, custodianSeatViewPath, custodianStatePath } from "./paths.ts";
import { writeDurable } from "./durable-write.ts";

/**
 * The owner's control files for the custodian (docs/custodian.md C45, C47; DESIGN.md, "The custodian's status and
 * the Machines row"): `custodian/state.json` (the pause), `round-request`, and the seat's `seat.json` view. Pure I/O
 * and imports no `log.ts`: the CLI writes the first two and the seat reads them, and the seat writes the third and
 * the CLI reads it. Files 0600 in the 0700 `custodian/` dir, written atomically.
 *
 * Not the main `state.json`: the CLI must not race the daemon's writes there. The pause has two writers, the CLI and
 * the daemon's app op, each a whole-file atomic rename that keeps the file's other keys: the later act wins (DESIGN.md,
 * "The custodian's status and the Machines row").
 */

/** ms. `until` null holds until `resume`. */
export interface CustodianPause {
  readonly at: number;
  readonly until: number | null;
}

export interface PauseRead {
  readonly pause: CustodianPause | null;
  /** The file exists but this daemon cannot read it: it loads as paused, indefinitely (the `closed` precedent). */
  readonly unreadable: boolean;
}

const UNREADABLE: PauseRead = { pause: { at: 0, until: null }, unreadable: true };

function pauseOf(raw: unknown): CustodianPause | null {
  if (!isRecord(raw)) return null;
  const { at, until } = raw;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (until !== null && !(typeof until === "number" && Number.isFinite(until))) return null;
  return { at, until };
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

export async function readControl(path: string = custodianStatePath()): Promise<PauseRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    return isMissing(err) ? { pause: null, unreadable: false } : UNREADABLE;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return UNREADABLE;
  }
  if (!isRecord(raw)) return UNREADABLE;
  if (raw["pause"] === undefined) return { pause: null, unreadable: false };
  const pause = pauseOf(raw["pause"]);
  return pause === null ? UNREADABLE : { pause, unreadable: false };
}

/** An expired `until` reads as not paused; nothing needs to clear it. */
export function pausedAt(read: PauseRead, now: number): boolean {
  return read.pause !== null && (read.pause.until === null || now < read.pause.until);
}

async function writeOwned(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeDurable(path, text, 0o600);
}

/** Sets or clears `pause`, keeping any other key the file holds. Over an unreadable file it writes a readable one. */
export async function writePause(pause: CustodianPause | null, path: string = custodianStatePath()): Promise<void> {
  let rest: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(raw)) rest = { ...raw };
  } catch {
    // Missing or unreadable: starts over.
  }
  delete rest["pause"];
  await writeOwned(path, `${JSON.stringify(pause === null ? rest : { ...rest, pause })}\n`);
}

/** A request older than this is stale: it covers a restart drain and a seat tick, and no more. */
export const ROUND_REQUEST_TTL_MS = 10 * 60_000;
/** A request is honoured only when no round started within this of now, so a looping writer cannot run rounds back to back. */
export const ROUND_REQUEST_MIN_GAP_MS = 15 * 60_000;

export async function requestRound(now: number, path: string = custodianRoundRequestPath()): Promise<void> {
  await writeOwned(path, `${JSON.stringify({ at: now })}\n`);
}

export type RoundRequest = "none" | "fresh" | "stale";

/** Fresh only for a finite `at` no later than `now` and within the TTL; anything malformed is stale. */
export async function peekRoundRequest(now: number, path: string = custodianRoundRequestPath()): Promise<RoundRequest> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    return isMissing(err) ? "none" : "stale";
  }
  let at: unknown;
  try {
    const raw: unknown = JSON.parse(text);
    at = isRecord(raw) ? raw["at"] : undefined;
  } catch {
    return "stale";
  }
  if (typeof at !== "number" || !Number.isFinite(at)) return "stale";
  const age = now - at;
  return age >= 0 && age <= ROUND_REQUEST_TTL_MS ? "fresh" : "stale";
}

export async function dropRoundRequest(path: string = custodianRoundRequestPath()): Promise<void> {
  await unlink(path).catch((err: unknown) => {
    if (!isMissing(err)) throw err;
  });
}

/**
 * What the seat publishes for `seanced custodian status` and `round` (which answer from files and cannot see the
 * daemon's memory): `cu` without `rc`, whether the host checks failed (a boolean, no detail), and the daemon's
 * version. Republished every tick by a running seat (a heartbeat); a seat whose checks failed writes it once, so the owner's commands treat a view older than five minutes as no report.
 */
export interface SeatView {
  readonly s: CustodianState;
  readonly e?: number;
  readonly n?: readonly [number, number, number];
  readonly at: number;
  readonly failed: boolean;
  readonly version: string;
}

export async function writeSeatView(view: SeatView, path: string = custodianSeatViewPath()): Promise<void> {
  await writeOwned(path, `${JSON.stringify(view)}\n`);
}

/** Null when missing or unreadable: a view the reader cannot trust says nothing. */
export async function readSeatView(path: string = custodianSeatViewPath()): Promise<SeatView | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(raw)) return null;
    const { s, e, n, at, failed, version } = raw;
    const state: CustodianState | undefined = CUSTODIAN_STATES.find((x) => x === s);
    if (state === undefined || typeof at !== "number") return null;
    if (typeof failed !== "boolean" || typeof version !== "string") return null;
    const [first, second, third] = Array.isArray(n) ? n : [];
    const counts =
      typeof first === "number" && typeof second === "number" && typeof third === "number"
        ? ([first, second, third] as const)
        : null;
    return {
      s: state,
      at,
      failed,
      version,
      ...(typeof e === "number" ? { e } : {}),
      ...(counts === null ? {} : { n: counts }),
    };
  } catch {
    return null;
  }
}
