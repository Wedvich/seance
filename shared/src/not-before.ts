/**
 * A task's not-before time (DESIGN.md, Scheduler, "Not before"): one resolver for the CLI, MCP and
 * the PWA, so the three cannot drift. Pure: reachable from `seance mcp`, so it never touches `log.ts`.
 *
 * Local-time arithmetic goes through `Date`'s own setters: a time inside a spring-forward gap moves
 * an hour forward, and an autumn overlap takes its first occurrence. Accepted.
 */

/** Epoch ms as a positive safe integer: what `TaskSpec.notBefore` holds. */
export function isNotBefore(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const DURATION_PATTERN = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/u;
const CLOCK_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/u;
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/u;

const MS = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;

/** `90m`, `2h`, `1d2h`: milliseconds, or null when malformed, zero or not a safe integer. */
export function parseDuration(text: string): number | null {
  const match = DURATION_PATTERN.exec(text);
  if (match === null || text === "") return null;
  const [, d, h, m] = match;
  const total = Number(d ?? 0) * MS.d + Number(h ?? 0) * MS.h + Number(m ?? 0) * MS.m;
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

/** The next local `hh:mm` strictly after `now`: today's if still ahead, else tomorrow's. */
export function nextClockTime(hh: number, mm: number, now: number): number {
  const at = new Date(now);
  at.setHours(hh, mm, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

export function parseClockTime(text: string): { readonly hh: number; readonly mm: number } | null {
  const match = CLOCK_PATTERN.exec(text);
  if (match === null) return null;
  return { hh: Number(match[1]), mm: Number(match[2]) };
}

/**
 * `YYYY-MM-DD[T ]HH:MM[:SS]` with an optional `Z` or `±HH:MM`; none means local time, refused when
 * `requireOffset`. Range-checked by round trip, so `2026-02-30` is refused.
 */
export function parseDateTime(text: string, opts: { readonly requireOffset: boolean }): number | null {
  const match = DATE_TIME_PATTERN.exec(text.trim());
  if (match === null) return null;
  const [, y, mo, d, h, mi, s, zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s ?? 0);
  if (second > 59) return null;
  let at: number;
  if (zone === undefined) {
    if (opts.requireOffset) return null;
    const local = new Date(year, month - 1, day, hour, minute, second);
    if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) return null;
    at = local.getTime();
  } else {
    const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
    if (utc.getUTCHours() !== hour || utc.getUTCMinutes() !== minute) return null;
    let offset = 0;
    if (zone !== "Z") {
      const oh = Number(zone.slice(1, 3));
      const om = Number(zone.slice(4, 6));
      if (oh > 23 || om > 59) return null;
      offset = (zone.startsWith("-") ? -1 : 1) * (oh * 60 + om) * MS.m;
    }
    at = utc.getTime() - offset;
  }
  return isNotBefore(at) ? at : null;
}

export type ResolvedNotBefore =
  | { readonly ok: true; readonly at: number }
  | { readonly ok: false; readonly error: string };

/** The CLI's `--at <HH:MM | ISO>` / `--in <duration>`, resolved against `now`; exactly one of the two. */
export function resolveNotBefore(
  input: { readonly at?: string; readonly in?: string },
  now: number,
): ResolvedNotBefore {
  if (input.at !== undefined && input.in !== undefined) return { ok: false, error: "--at and --in are exclusive" };
  if (input.in !== undefined) {
    const ms = parseDuration(input.in);
    if (ms === null) return { ok: false, error: `--in ${input.in}: expected a duration like 90m, 2h or 1d2h` };
    return { ok: true, at: now + ms };
  }
  if (input.at === undefined) return { ok: false, error: "no time given" };
  const clock = parseClockTime(input.at);
  if (clock !== null) return { ok: true, at: nextClockTime(clock.hh, clock.mm, now) };
  const at = parseDateTime(input.at, { requireOffset: false });
  if (at === null) return { ok: false, error: `--at ${input.at}: expected HH:MM or YYYY-MM-DDTHH:MM` };
  if (at <= now) return { ok: false, error: `--at ${input.at} is in the past` };
  return { ok: true, at };
}

/**
 * "Wed 18 Nov, 21:30" in `timeZone` (the host's own when omitted). `withOffset` appends the zone's
 * offset ("GMT+1"): the CLI and MCP confirmations use it, since a host in UTC resolves `--at 21:30`
 * as 21:30 UTC and a line without the offset would hide that.
 */
export function formatNotBefore(at: number, timeZone?: string, opts: { readonly withOffset?: boolean } = {}): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(opts.withOffset === true ? { timeZoneName: "shortOffset" } : {}),
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const text = `${get("weekday")} ${get("day")} ${get("month")}, ${get("hour")}:${get("minute")}`;
  return opts.withOffset === true ? `${text} ${get("timeZoneName")}` : text;
}
