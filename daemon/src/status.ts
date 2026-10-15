import { STATUS_MAX_CT_LENGTH, type MachineStatus, type QuotaObservation } from "@seance/shared";

/** AES-GCM's default tag, which `seal` leaves on the ciphertext. */
const AEAD_TAG_BYTES = 16;

/** The `Plain` around the payload — a UUID, a ms timestamp, the op — is fixed-width, so measured once. */
const PLAIN_OVERHEAD = JSON.stringify({ id: crypto.randomUUID(), ts: Date.now(), op: "status", payload: 0 }).length - 1;

/**
 * UTF-8 bytes the sealed payload may take: base64 costs a third, the tag
 * sixteen bytes, the wrapper its fixed width. With the schema's short keys
 * this holds four exclaves' quota with every field (~125 bytes each) — a
 * machine with more trims rather than sends a frame the relay would drop whole.
 */
export const STATUS_PAYLOAD_BUDGET = Math.floor(STATUS_MAX_CT_LENGTH / 4) * 3 - AEAD_TAG_BYTES - PLAIN_OVERHEAD;

const utf8 = new TextEncoder();

export function statusBytes(status: MachineStatus): number {
  return utf8.encode(JSON.stringify(status)).length;
}

function withoutModelWindows(quota: readonly QuotaObservation[]): readonly QuotaObservation[] {
  return quota.map(({ w: _w, ...rest }) => rest);
}

function withoutResets(quota: readonly QuotaObservation[]): readonly QuotaObservation[] {
  return quota.map(({ hr: _hr, dr: _dr, ...rest }) => rest);
}

/**
 * Trims a status until it fits the relay's bound, least useful fields first:
 * the per-model windows, then the reset stamps, then quota entries from the
 * last exclave down (`default` is index 0 and the one every machine has).
 * Pressure and `sess` always fit. Returns the input itself when it already
 * fits, so a caller can tell trimming happened by identity.
 */
export function fitStatus(status: MachineStatus, budget = STATUS_PAYLOAD_BUDGET): MachineStatus {
  if (statusBytes(status) <= budget) return status;
  const quota = status.quota ?? [];
  const steps: (() => readonly QuotaObservation[])[] = [
    () => withoutModelWindows(quota),
    () => withoutResets(withoutModelWindows(quota)),
  ];
  for (const step of steps) {
    const trimmed = { ...status, quota: step() };
    if (statusBytes(trimmed) <= budget) return trimmed;
  }
  let kept = withoutResets(withoutModelWindows(quota));
  while (kept.length > 0) {
    kept = kept.slice(0, -1);
    const trimmed = kept.length === 0 ? withoutQuota(status) : { ...status, quota: kept };
    if (statusBytes(trimmed) <= budget) return trimmed;
  }
  return withoutQuota(status);
}

function withoutQuota({ quota: _quota, ...rest }: MachineStatus): MachineStatus {
  return rest;
}
