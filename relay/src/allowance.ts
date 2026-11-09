import { ATTACHMENT_ALLOWANCE } from "@seance/shared";

/** The Hub's one storage key for the allowance: its own, so it aliases no `device:`, `scheduler:term` or store key. */
export const ALLOWANCE_KEY = "upload-allowance";

const HOUR_MS = 3_600_000;

/** `[hourIndex, bytes, uploads]`, `hourIndex` being `Math.floor(now / HOUR_MS)`. */
export type HourBucket = readonly [number, number, number];

export interface AllowanceLimits {
  readonly windowHours: number;
  readonly windowBytes: number;
  readonly hourBytes: number;
  readonly hourUploads: number;
}

export type UploadVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly window: "hour" | "month"; readonly retryAfter: number };

export interface Reservation {
  readonly verdict: UploadVerdict;
  /** What to store: pruned and, when accepted, carrying this reservation. Null when nothing changed. */
  readonly buckets: readonly HourBucket[] | null;
}

/**
 * Test-only overrides of the byte and count bounds (env vars are strings), so a
 * suite can exhaust a window in a few small uploads. Unset in production.
 */
export function allowanceLimits(overrides: {
  readonly windowBytes?: string | undefined;
  readonly hourBytes?: string | undefined;
  readonly hourUploads?: string | undefined;
}): AllowanceLimits {
  return {
    windowHours: ATTACHMENT_ALLOWANCE.windowHours,
    windowBytes: positive(overrides.windowBytes) ?? ATTACHMENT_ALLOWANCE.windowBytes,
    hourBytes: positive(overrides.hourBytes) ?? ATTACHMENT_ALLOWANCE.hourBytes,
    hourUploads: positive(overrides.hourUploads) ?? ATTACHMENT_ALLOWANCE.hourUploads,
  };
}

function positive(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Pure, so the caller's read and write stay one input-gated step. Nothing is
 * refunded: a reservation whose put fails stays spent, which fails toward the bound.
 * The month window spans `windowHours + 1` buckets, so "any trailing 30 days"
 * holds strictly at hour granularity.
 */
export function reserve(
  stored: readonly HourBucket[],
  bytes: number,
  now: number,
  limits: AllowanceLimits,
): Reservation {
  const hour = Math.floor(now / HOUR_MS);
  const oldest = hour - limits.windowHours;
  const live = stored.filter(([index]) => index >= oldest && index <= hour);
  const current = live.find(([index]) => index === hour) ?? [hour, 0, 0];
  const windowSum = live.reduce((sum, [, b]) => sum + b, 0);

  if (windowSum + bytes > limits.windowBytes) {
    return { verdict: { ok: false, window: "month", retryAfter: monthRetry(live, bytes, now, limits) }, buckets: null };
  }
  if (current[1] + bytes > limits.hourBytes || current[2] + 1 > limits.hourUploads) {
    return {
      verdict: { ok: false, window: "hour", retryAfter: secondsUntil((hour + 1) * HOUR_MS, now) },
      buckets: null,
    };
  }
  const next: HourBucket = [hour, current[1] + bytes, current[2] + 1];
  return { verdict: { ok: true }, buckets: [...live.filter(([index]) => index !== hour), next] };
}

/**
 * The first hour boundary at which enough old buckets have aged out for `bytes` to
 * fit. That boundary also opens a fresh hour bucket, so the hour bound never holds
 * longer. Never past a full window: a reservation bigger than `windowBytes` alone
 * (possible only under a test override) gets the longest honest wait.
 */
function monthRetry(live: readonly HourBucket[], bytes: number, now: number, limits: AllowanceLimits): number {
  const hour = Math.floor(now / HOUR_MS);
  for (let k = 1; k <= limits.windowHours + 1; k += 1) {
    const oldest = hour + k - limits.windowHours;
    const remaining = live.reduce((sum, [index, b]) => (index >= oldest ? sum + b : sum), 0);
    if (remaining + bytes <= limits.windowBytes) return secondsUntil((hour + k) * HOUR_MS, now);
  }
  return secondsUntil((hour + limits.windowHours + 1) * HOUR_MS, now);
}

function secondsUntil(at: number, now: number): number {
  return Math.max(1, Math.ceil((at - now) / 1000));
}
