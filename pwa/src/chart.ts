import { METRIC_NAMES, type MetricsSeries } from "@seance/shared";

/**
 * Geometry for the machines screen's history chart, kept apart from the
 * component so the gap and hold rules are testable without a DOM. Every series
 * charted is whole percent, so the y axis is a fixed 0–100.
 */

export interface ChartLine {
  readonly key: string;
  readonly label: string;
  /** SVG path data in the chart's own units; empty when nothing falls in the window. */
  readonly d: string;
}

const LABELS: Readonly<Record<string, string>> = {
  [METRIC_NAMES.cpu]: "CPU",
  [METRIC_NAMES.mem]: "Memory",
  [METRIC_NAMES.h]: "5h",
  [METRIC_NAMES.d]: "7d",
};

/**
 * Quota samples carry the observation's own time, not the tick's, so a series
 * moves only when the account was seen anew: a level that holds until the next
 * point, never a slope between them.
 */
const HELD = new Set<string>([METRIC_NAMES.h, METRIC_NAMES.d, METRIC_NAMES.w]);

function seriesLabel(series: MetricsSeries): string {
  const model = series.labels["model"];
  const window = model === undefined ? (LABELS[series.metric] ?? series.metric) : `7d ${model}`;
  const exclave = series.labels["exclave"];
  return exclave === undefined ? window : `${exclave} ${window}`;
}

function seriesKey(series: MetricsSeries): string {
  const labels = Object.entries(series.labels)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`);
  return [series.metric, ...labels].join(",");
}

/**
 * One account's quota series out of a machine's reply. Two exclaves signed in
 * as the same account observe the same windows, so their series fold into one
 * per window — a later observation at the same second replaces the earlier.
 */
export function accountSeries(series: readonly MetricsSeries[], accountId: string): MetricsSeries[] {
  const windows = new Map<string, { metric: string; model: string | undefined; points: Map<number, number> }>();
  for (const entry of series) {
    if (!HELD.has(entry.metric) || entry.labels["account"] !== accountId) continue;
    const model = entry.labels["model"];
    const key = `${entry.metric}/${model ?? ""}`;
    const window = windows.get(key) ?? { metric: entry.metric, model, points: new Map() };
    for (const [ts, value] of entry.points) window.points.set(ts, value);
    windows.set(key, window);
  }
  return [...windows.values()].map(
    ({ metric, model, points }): MetricsSeries => ({
      metric,
      labels: model === undefined ? {} : { model },
      points: [...points].toSorted(([a], [b]) => a - b),
    }),
  );
}

function format(value: number): string {
  return String(Math.round(value * 10) / 10);
}

export function chartLines(
  series: readonly MetricsSeries[],
  window: { readonly from: number; readonly to: number; readonly step: number },
  size: { readonly width: number; readonly height: number },
): ChartLine[] {
  const span = Math.max(1, window.to - window.from);
  const x = (ts: number): number => ((ts - window.from) / span) * size.width;
  const y = (value: number): number => size.height - (Math.min(100, Math.max(0, value)) / 100) * size.height;
  // Missing ticks (asleep, daemon down) break a gauge's line rather than
  // bridging a gap nobody measured; half a step of slack absorbs raw-tier jitter,
  // so one missed tick (two steps apart) already breaks it.
  const gap = window.step * 1.5;

  return series.map((entry) => {
    const held = HELD.has(entry.metric);
    const parts: string[] = [];
    let previous: readonly [number, number] | null = null;
    for (const point of entry.points) {
      const [ts, value] = point;
      if (ts < window.from || ts > window.to) continue;
      const px = format(x(ts));
      const py = format(y(value));
      if (previous === null || (!held && ts - previous[0] > gap)) parts.push(`M${px} ${py}`);
      else parts.push(held ? `H${px}V${py}` : `L${px} ${py}`);
      previous = point;
    }
    return { key: seriesKey(entry), label: seriesLabel(entry), d: parts.join("") };
  });
}
