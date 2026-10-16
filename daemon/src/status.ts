import { AEAD_TAG_BYTES, STATUS_MAX_CT_LENGTH, type MachineStatus, type QuotaObservation } from "@seance/shared";

/** The `Plain` around the payload — a UUID, a ms timestamp, the op — is fixed-width, so measured once. */
const PLAIN_OVERHEAD = JSON.stringify({ id: crypto.randomUUID(), ts: Date.now(), op: "status", payload: 0 }).length - 1;

/**
 * UTF-8 bytes the sealed payload takes — `fitStatus` pads every status to
 * exactly this. Base64 costs a third, the tag sixteen bytes, the wrapper its
 * fixed width. With the schema's short keys this holds four exclaves' quota
 * with every field (~125 bytes each) — a machine with more trims rather than
 * sends a frame the relay would drop whole.
 */
export const STATUS_PAYLOAD_BUDGET = Math.floor(STATUS_MAX_CT_LENGTH / 4) * 3 - AEAD_TAG_BYTES - PLAIN_OVERHEAD;

/** What the filler costs before its first space: it trails the object, so a comma and an empty `_`. */
const FILLER_OVERHEAD = `,"_":""`.length;

const utf8 = new TextEncoder();

export function statusBytes(status: MachineStatus): number {
  return utf8.encode(JSON.stringify(status)).length;
}

/** A status as sent: `MachineStatus` plus the filler that pads it to the budget. */
export type PaddedStatus = MachineStatus & { readonly _: string };

/**
 * Trims a status to fit the relay's bound, then pads it to exactly `budget`
 * bytes. Every bearer-token holder receives every status, so a ciphertext
 * whose length tracks load, session counts and whether quota is present is an
 * activity channel; padded, every status seals to the same `ct` length. The
 * filler is a trailing `_` of spaces, a field the parser ignores.
 *
 * Trimming takes the least useful fields first: the per-model windows, then
 * the reset stamps, then quota entries from the last exclave down (`default`
 * is index 0 and the one every machine has). Pressure and `sess` always fit.
 * Any trim sets `tr` to the count of quota entries dropped — 0 when only
 * detail went — so a reader can tell an exclave left out from one with no
 * quota observed; `tr` is absent when nothing was trimmed.
 */
export function fitStatus(status: MachineStatus, budget = STATUS_PAYLOAD_BUDGET): PaddedStatus {
  const room = budget - FILLER_OVERHEAD;
  const trimmed = trimStatus(status, room);
  return { ...trimmed, _: " ".repeat(Math.max(0, room - statusBytes(trimmed))) };
}

function trimStatus(status: MachineStatus, budget: number): MachineStatus {
  if (statusBytes(status) <= budget) return status;
  if (status.quota !== undefined) {
    const { quota } = status;
    const steps: (() => readonly QuotaObservation[])[] = [
      () => withoutModelWindows(quota),
      () => withoutResets(withoutModelWindows(quota)),
    ];
    for (const step of steps) {
      const trimmed: MachineStatus = { ...status, quota: step(), tr: 0 };
      if (statusBytes(trimmed) <= budget) return trimmed;
    }
    let kept = withoutResets(withoutModelWindows(quota));
    while (kept.length > 1) {
      kept = kept.slice(0, -1);
      const trimmed: MachineStatus = { ...status, quota: kept, tr: quota.length - kept.length };
      if (statusBytes(trimmed) <= budget) return trimmed;
    }
  }
  const pressureOnly: MachineStatus = { ...withoutQuota(status), tr: status.quota?.length ?? 0 };
  if (statusBytes(pressureOnly) <= budget) return pressureOnly;
  // Only an exclave list far past anything real gets here; a frame over the
  // bound is refused whole, so even `sess` goes before the pressure does.
  const { sess: _sess, ...pressure } = pressureOnly;
  return pressure;
}

function withoutModelWindows(quota: readonly QuotaObservation[]): readonly QuotaObservation[] {
  return quota.map(({ w: _w, ...rest }) => rest);
}

function withoutResets(quota: readonly QuotaObservation[]): readonly QuotaObservation[] {
  return quota.map(({ hr: _hr, dr: _dr, ...rest }) => rest);
}

function withoutQuota({ quota: _quota, ...rest }: MachineStatus): MachineStatus {
  return rest;
}
