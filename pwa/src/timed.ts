/** A relative time as printed ("6m ago", "resets in 2h") beside the instant it stands for, epoch ms. */
export interface Moment {
  readonly text: string;
  readonly at: number;
}

/**
 * A line of view text whose relative times kept their instants, so the
 * component can show the timestamp on hover. A view model that flattened them
 * into a string would leave the component nothing to recover it from.
 */
export type Timed = readonly (string | Moment)[];

function isTimed(value: string | Moment | Timed): value is Timed {
  return Array.isArray(value);
}

/** Tag for a `Timed` line: interpolate strings, moments and other lines alike. */
export function timed(strings: TemplateStringsArray, ...values: readonly (string | Moment | Timed)[]): Timed {
  const parts: (string | Moment)[] = [];
  const push = (part: string | Moment): void => {
    const last = parts.at(-1);
    if (part === "") return;
    if (typeof part === "string" && typeof last === "string") parts[parts.length - 1] = last + part;
    else parts.push(part);
  };
  strings.forEach((chunk, index) => {
    push(chunk);
    const value = values[index];
    if (value === undefined) return;
    if (isTimed(value)) value.forEach(push);
    else push(value);
  });
  return parts;
}

/** The line as text alone: for an attribute, an accessible name, or text that animates as a string. */
export function plain(line: Timed): string {
  return line.map((part) => (typeof part === "string" ? part : part.text)).join("");
}

// Built once: constructing a formatter costs far more than a format call. Norwegian whatever the
// browser says: day before month and a 24-hour clock, in the viewer's zone.
const STAMP = new Intl.DateTimeFormat("nb-NO", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/** The full timestamp a hover shows, Norwegian-formatted, in the viewer's zone. */
export function formatStamp(at: number, format: Intl.DateTimeFormat = STAMP): string {
  return format.format(at);
}
