/**
 * Where a cold launch spent its time, so a slow one can be read after the fact
 * in Settings instead of caught live with a debugger attached. Every point is ms
 * from navigation start (`performance.now()` shares that origin), and splits the
 * wait three ways: the HTML (the service worker booting and reading its cache),
 * the module loading, and the key store's IndexedDB read the app cannot render
 * without. A resume that never reloaded the page is no launch and records
 * nothing.
 */

const LAUNCHES_KEY = "seance:launches";
/** A few, so a slow launch is still there after the reload that followed it. */
const KEPT = 5;

export interface LaunchTiming {
  /** Wall clock, for "when". */
  readonly at: number;
  /** The service worker started on the navigation; null when the page loaded uncontrolled. */
  readonly worker: number | null;
  readonly html: number;
  readonly script: number;
  readonly keysFrom: number;
  readonly keysTo: number;
  readonly rendered: number;
}

let scriptAt: number | null = null;
let keysFrom: number | null = null;
let keysTo: number | null = null;

export function markScript(): void {
  scriptAt = performance.now();
}

export function markKeys(phase: "from" | "to"): void {
  if (phase === "from") keysFrom = performance.now();
  else keysTo = performance.now();
}

/** After the first render that needed the keys; a no-op without the marks, or without navigation timing. */
export function recordLaunch(): void {
  if (scriptAt === null || keysFrom === null || keysTo === null) return;
  const [nav] = performance.getEntriesByType("navigation");
  if (!(nav instanceof PerformanceNavigationTiming)) return;
  const timing: LaunchTiming = {
    at: Date.now(),
    worker: nav.workerStart > 0 ? nav.workerStart : null,
    html: nav.responseEnd,
    script: scriptAt,
    keysFrom,
    keysTo,
    rendered: performance.now(),
  };
  try {
    localStorage.setItem(LAUNCHES_KEY, JSON.stringify([timing, ...readLaunches()].slice(0, KEPT)));
  } catch {
    // A launch that can't be kept is a diagnostic lost, nothing more.
  }
}

function isTiming(value: unknown): value is LaunchTiming {
  if (typeof value !== "object" || value === null) return false;
  const finite = (key: string): boolean => Number.isFinite(Reflect.get(value, key));
  const worker: unknown = Reflect.get(value, "worker");
  return (
    ["at", "html", "script", "keysFrom", "keysTo", "rendered"].every(finite) &&
    (worker === null || Number.isFinite(worker))
  );
}

/** Newest first. */
export function readLaunches(): readonly LaunchTiming[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LAUNCHES_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter(isTiming).slice(0, KEPT) : [];
  } catch {
    return [];
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** One line per launch: the total, then each wait, so the slow one stands out. */
export function describeLaunch(timing: LaunchTiming): string {
  const worker = timing.worker === null ? "no service worker" : `worker at ${seconds(timing.worker)}`;
  return [
    `${seconds(timing.rendered)} to the form`,
    `HTML ${seconds(timing.html)} (${worker})`,
    `script ${seconds(timing.script - timing.html)}`,
    `key store ${seconds(timing.keysTo - timing.keysFrom)}`,
  ].join(" · ");
}
