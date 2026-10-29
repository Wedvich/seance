/**
 * PWA idle and resume cost, for before/after comparisons on one machine:
 * `bun run perf [A|B|C|D|all] [--runs N] [--duration S] [--cpu X] [--daemons N]`.
 * Opt-in and outside `bun run test` and CI (docs/development.md, "Measuring the PWA");
 * named off the `*.test.ts` pattern so the e2e shard never picks it up.
 *
 * Stack: `startSuite` (relay under workerd + the suite daemon) plus second daemons,
 * a production `vite build` of pwa/ served by `vite preview`, and headless Chromium
 * through playwright-core under CPU throttling. Per window: CDP Performance metric
 * deltas, DrawFrame trace events, WebSocket frames and localStorage writes.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskState } from "@seance/shared";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { pollUntil } from "../daemon/test/fixtures.ts";
import { PSK, startApp, TOKEN, wsUrl } from "./harness.ts";
import { startSuite } from "./suite.ts";

const ROOT = join(import.meta.dir, "..");
const PWA_DIR = join(ROOT, "pwa");
const DIST_DIR = join(PWA_DIR, "dist");
// `bun vite.js`, not the `.bin/vite` shim (a `node` shebang) or `bun run`: no node needed, and a kill reaches the server itself.
const VITE_JS = join(PWA_DIR, "node_modules", "vite", "bin", "vite.js");
const INSTALL_HINT = "bun x playwright-core install --only-shell chromium (from the repo root)";
const TRACE_END_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 20_000;
const SCENARIOS = ["A", "B", "C", "D"] as const;
type Scenario = (typeof SCENARIOS)[number];

const USAGE = "usage: bun run perf [A|B|C|D|all] [--runs N] [--duration S] [--cpu X] [--daemons N]";
// LeaderBox first: the suite nominates it (`secondLeaders`), and D needs a second leader to stop.
const SECOND_DAEMONS = ["LeaderBox", "PerfB", "PerfC", "PerfD", "PerfE"] as const;
const FINISHED = new Set<TaskState>(["lost", "done", "failed", "cancelled"]);

interface Options {
  readonly scenarios: readonly Scenario[];
  readonly runs: number;
  readonly durationMs: number;
  readonly cpuRate: number;
  readonly daemons: number;
}

function isScenario(value: string): value is Scenario {
  return SCENARIOS.some((s) => s === value);
}

function parseArgs(argv: readonly string[]): Options {
  // `bun run perf -- A` hands the script its `--`.
  const args = argv.filter((a) => a !== "--");
  const numbers = new Map<string, number>([
    ["--runs", 2],
    ["--duration", 60],
    ["--cpu", 4],
    ["--daemons", 4],
  ]);
  let scenarios: readonly Scenario[] | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (numbers.has(arg)) {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value <= 0) throw new UsageError(`${arg} needs a positive number`);
      if ((arg === "--runs" || arg === "--daemons") && !Number.isInteger(value)) {
        throw new UsageError(`${arg} needs a whole number`);
      }
      numbers.set(arg, value);
      continue;
    }
    if (scenarios !== null) throw new UsageError(`one scenario per run, got a second: ${arg}`);
    const upper = arg.toUpperCase();
    if (upper === "ALL") scenarios = SCENARIOS;
    else if (isScenario(upper)) scenarios = [upper];
    else throw new UsageError(`unknown argument ${arg}`);
  }
  const get = (name: string): number => numbers.get(name) ?? 0;
  const daemons = get("--daemons");
  if (daemons > SECOND_DAEMONS.length + 1) throw new UsageError(`--daemons is at most ${SECOND_DAEMONS.length + 1}`);
  return {
    scenarios: scenarios ?? SCENARIOS,
    runs: get("--runs"),
    durationMs: get("--duration") * 1000,
    cpuRate: get("--cpu"),
    daemons,
  };
}

class UsageError extends Error {}
/** A signal arrived: unwind to the top-level teardown without reporting a failure. */
class AbortError extends Error {}

const log = (...message: unknown[]): void => console.error("[perf]", ...message);

// The in-process daemon (log.ts) and workerd write their log lines with console.log; routing them
// to stderr keeps stdout to the results alone.
console.log = console.error;
const printed: string[] = [];
const print = (line: string): void => void printed.push(line);

/** Awaits the write: process.exit right after a bare stdout.write can drop a piped tail (scripts/test.ts `flush`). */
function flushPrinted(): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${printed.join("\n")}\n`, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Child-process teardown, run newest first: the browser before the server it loads from, daemons
 * before the relay. Each step is bounded so one hung stop cannot strand the rest.
 */
const cleanups: (() => Promise<void> | void)[] = [];
let tearingDown: Promise<void> | null = null;
/** Set by the first signal; every start in `main` checks it, since teardown only sees what is registered by then. */
let aborting = false;
/** While the relay boots no cleanup is registered, so a signal waits for `startSuite` to return. */
let booting = false;

const alive = (): void => {
  if (aborting) throw new AbortError();
};

async function bounded(cleanup: () => Promise<void> | void): Promise<void> {
  let timer: Timer | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), CLEANUP_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([Promise.resolve().then(cleanup), timeout]);
    if (outcome === "timeout") log(`a cleanup step outlasted ${CLEANUP_TIMEOUT_MS}ms; moving on`);
  } catch (error) {
    log("cleanup failed", error);
  } finally {
    clearTimeout(timer);
  }
}

/** Registered after teardown began (something still starting when the signal came), a cleanup runs at once. */
function register(cleanup: () => Promise<void> | void): void {
  if (tearingDown !== null) {
    void bounded(cleanup);
    return;
  }
  cleanups.push(cleanup);
}

function teardown(): Promise<void> {
  tearingDown ??= inSeries(cleanups.toReversed().map((cleanup) => () => bounded(cleanup)));
  return tearingDown;
}

const SIGNALS = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const;
const onSignal = new Map(
  SIGNALS.map(([signal, code]) => [
    signal,
    (): void => {
      if (aborting) {
        log(`${signal}: again, exiting now`);
        process.exit(code);
      }
      aborting = true;
      process.exitCode = code;
      log(`${signal}: tearing down`);
      if (booting) return;
      void teardown().finally(() => process.exit(code));
    },
  ]),
);

/**
 * Leaves teardown the only signal listener. Miniflare's exit hook exits the process on a signal once
 * it has killed workerd, which would strand vite, tmux and the second daemons; its `exit` hook stays
 * as workerd's backstop. Miniflare registers when it boots, so this runs again while `startSuite` is
 * in flight; a signal in the few ms between its registration and the next run can still reach it.
 */
function claimSignals(): void {
  for (const [signal, handler] of onSignal) {
    for (const listener of process.listeners(signal)) if (listener !== handler) process.off(signal, listener);
    if (!process.listeners(signal).includes(handler)) process.on(signal, handler);
  }
}
claimSignals();

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = server.port ?? 0;
  await server.stop(true);
  return port;
}

/** One after another, without a loop of awaits: cleanups and scenarios each need the stack to themselves. */
async function inSeries(steps: readonly (() => Promise<void>)[]): Promise<void> {
  const [first, ...rest] = steps;
  if (first === undefined) return;
  await first();
  await inSeries(rest);
}

// Browser-side code goes over as strings: e2e typechecks without lib.dom (see tsconfig.json),
// and whatever comes back is checked here rather than asserted.

/** Counts localStorage writes, so a window can show the app persisting state while idle. */
const COUNT_STORAGE_WRITES = `
  window.__perfLs = { set: 0, remove: 0 };
  const set = Storage.prototype.setItem;
  const remove = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (...a) { window.__perfLs.set++; return set.apply(this, a); };
  Storage.prototype.removeItem = function (...a) { window.__perfLs.remove++; return remove.apply(this, a); };
`;
const RESET_STORAGE_COUNTS = "(() => { window.__perfLs.set = 0; window.__perfLs.remove = 0; })()";
const READ_STORAGE_COUNTS = "[window.__perfLs.set, window.__perfLs.remove]";
const VERDICT_TEXT = `document.querySelector(".verdict")?.textContent ?? ""`;

/** The home screen's primary button is enabled and, given a pattern, labelled to match. */
function primaryButtonReady(label: RegExp | null): string {
  const test = label === null ? "true" : `new RegExp(${JSON.stringify(label.source)}).test(b.textContent ?? "")`;
  return `(() => { const b = document.querySelector("button.primary"); return b !== null && !b.disabled && ${test}; })()`;
}

/** Pins `document.visibilityState` to `state` and fires the event, as a tab switch would. */
function setVisibility(state: "hidden" | "visible"): string {
  return `(() => {
    window.__perfVis = ${JSON.stringify(state)};
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__perfVis });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__perfVis === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  })()`;
}

async function verdictText(page: Page): Promise<string> {
  const text = await page.evaluate(VERDICT_TEXT);
  return typeof text === "string" ? text : "";
}

async function storageCounts(page: Page): Promise<{ readonly set: number; readonly remove: number }> {
  const counts = await page.evaluate(READ_STORAGE_COUNTS);
  if (!Array.isArray(counts)) throw new TypeError(`storage counts: unexpected ${JSON.stringify(counts)}`);
  const [set, remove]: unknown[] = counts;
  if (typeof set !== "number" || typeof remove !== "number") {
    throw new TypeError(`storage counts: unexpected ${JSON.stringify(counts)}`);
  }
  return { set, remove };
}

async function metricsOf(cdp: CDPSession): Promise<ReadonlyMap<string, number>> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return new Map(metrics.map((m) => [m.name, m.value]));
}

/** Opcode 2 is binary, whose payload CDP hands over base64-encoded. */
function payloadBytes(frame: { readonly opcode: number; readonly payloadData: string }): number {
  if (frame.opcode === 2) return Buffer.from(frame.payloadData, "base64").length;
  return Buffer.byteLength(frame.payloadData);
}

interface WsCounts {
  wsFramesOut: number;
  wsFramesIn: number;
  wsBytesOut: number;
  wsBytesIn: number;
  wsCreated: number;
  wsClosed: number;
}

const subWs = (a: WsCounts, b: WsCounts): WsCounts => ({
  wsFramesOut: a.wsFramesOut - b.wsFramesOut,
  wsFramesIn: a.wsFramesIn - b.wsFramesIn,
  wsBytesOut: a.wsBytesOut - b.wsBytesOut,
  wsBytesIn: a.wsBytesIn - b.wsBytesIn,
  wsCreated: a.wsCreated - b.wsCreated,
  wsClosed: a.wsClosed - b.wsClosed,
});

const zeroWs = (): WsCounts => ({
  wsFramesOut: 0,
  wsFramesIn: 0,
  wsBytesOut: 0,
  wsBytesIn: 0,
  wsCreated: 0,
  wsClosed: 0,
});

/** One fresh browser context, signed in through the Setup screen. */
interface Session {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly browserCdp: CDPSession;
  /** Since the last `resetWs`. */
  readonly ws: () => WsCounts;
  readonly resetWs: () => void;
  readonly close: () => Promise<void>;
}

/** CDP metrics are null when the build did not report them, so a missing one never reads as zero. */
interface Sample extends WsCounts {
  durationMs: number;
  taskDurationS: number | null;
  taskPct: number | null;
  scriptDurationS: number | null;
  layoutDurationS: number | null;
  recalcStyleDurationS: number | null;
  layoutCount: number | null;
  recalcStyleCount: number | null;
  drawFrames: number;
  drawFramesPerSec: number;
  swaps: number;
  threadTimeS: number | null;
  processTimeS: number | null;
  lsSetItem: number;
  lsRemoveItem: number;
  /** The trace dropped events: `drawFrames` and `swaps` undercount. */
  traceDataLoss: boolean;
}

interface Result {
  readonly scenario: Scenario;
  readonly run: number;
  readonly note: string;
  /** Null when the run failed. */
  readonly sample: Sample | null;
  readonly extra?: Record<string, unknown>;
}

function round(n: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env["PERF_CHROMIUM"];
  try {
    return await chromium.launch({
      headless: true,
      // Teardown owns signals: playwright's own handlers exit (SIGINT) or race the stack's cleanups.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      ...(executablePath !== undefined ? { executablePath } : {}),
    });
  } catch (error) {
    // "Executable doesn't exist" for a missing install, lower-case for a missing override.
    if (error instanceof Error && /executable doesn't exist/iu.test(error.message)) {
      const fix =
        executablePath !== undefined ? `PERF_CHROMIUM=${executablePath} is not a file` : `run ${INSTALL_HINT}`;
      throw new Error(`no headless Chromium: ${fix}`, { cause: error });
    }
    throw error;
  }
}

/** Runs vite in pwa/, throwing with its output if it fails; teardown kills it mid-run. */
async function runVite(args: readonly string[], env: Record<string, string | undefined>): Promise<void> {
  const argv = ["bun", VITE_JS, ...args];
  const proc = Bun.spawn(argv, { cwd: PWA_DIR, env, stdout: "pipe", stderr: "pipe" });
  register(async () => {
    proc.kill();
    await proc.exited;
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code}:\n${out}\n${err}`);
}

async function main(opts: Options): Promise<void> {
  log(
    `scenarios=${opts.scenarios.join(",")} runs=${opts.runs} duration=${opts.durationMs / 1000}s cpu=${opts.cpuRate}x daemons=${opts.daemons}`,
  );
  // Everything the run writes outside the stack lives here, so one cleanup owns it.
  const workDir = await mkdtemp(join(tmpdir(), "seance-perf-"));
  register(() => rmSync(workDir, { recursive: true, force: true }));
  // As scripts/test.ts does: a leader here must never run the developer's authenticated gh.
  process.env["SEANCE_GH_BIN"] = join(workDir, "no-gh");

  booting = true;
  const reclaim = setInterval(claimSignals, 25);
  const suite = await startSuite("perf").finally(() => {
    clearInterval(reclaim);
    booting = false;
  });
  claimSignals();
  // Registered before the suite's dispose, so it runs after it: a hung relay dispose must not strand the tmux server.
  const tmuxSocket = process.env["SEANCE_TMUX_SOCKET"];
  if (tmuxSocket !== undefined) {
    register(async () => {
      await Bun.spawn(["tmux", "-S", tmuxSocket, "kill-server"], { stdout: "ignore", stderr: "ignore" }).exited;
    });
  }
  register(() => suite.dispose());
  alive();
  const { stack } = suite;

  const seconds = new Map<string, () => Promise<void>>();
  // stack.dispose stops every second daemon still running; `seconds` is for D's own stops.
  const startSecond = async (name: string): Promise<void> => {
    alive();
    const daemon = await stack.startSecondDaemon({ name });
    seconds.set(name, daemon.stop);
    // Started while teardown ran: its dispose has already looked at the daemons that existed.
    if (aborting) await daemon.stop();
    alive();
  };
  await inSeries(SECOND_DAEMONS.slice(0, opts.daemons - 1).map((name) => () => startSecond(name)));
  log(`${1 + seconds.size} daemons up`);

  const relayAppUrl = wsUrl(stack.relay, "/app");
  const env = { ...process.env, VITE_RELAY_URL: relayAppUrl };
  // The build writes to pwa/dist unconditionally (vite.config.ts pins its CSP plugin to it), pointed at
  // this run's throwaway relay: refuse rather than overwrite a developer's own build, and move the
  // output out right after so that directory is occupied only for the build's own duration.
  alive();
  if (existsSync(DIST_DIR)) throw new Error(`${DIST_DIR} exists; move or delete it first — this run builds into it`);
  const servedDir = join(workDir, "dist");
  let builtHere = true;
  register(() => {
    if (builtHere) rmSync(DIST_DIR, { recursive: true, force: true });
  });
  log("vite build");
  await runVite(["build"], env);
  alive();
  cpSync(DIST_DIR, servedDir, { recursive: true });
  rmSync(DIST_DIR, { recursive: true, force: true });
  builtHere = false;

  const port = await freePort();
  alive();
  const preview = Bun.spawn(
    ["bun", VITE_JS, "preview", "--outDir", servedDir, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: PWA_DIR, env, stdout: "ignore", stderr: "ignore" },
  );
  register(async () => {
    preview.kill();
    await preview.exited;
  });
  const baseUrl = `http://127.0.0.1:${port}/`;
  await pollUntil(
    () =>
      fetch(baseUrl).then(
        (r) => r.ok,
        () => false,
      ),
    "vite preview",
    20_000,
  );
  log("preview up", baseUrl);

  alive();
  const browser = await launchBrowser();
  register(() => browser.close());
  alive();

  // In-process app (real RelayClient + Store): pauses the queue for B, watches leadership for D.
  const watcher = startApp(stack);
  register(() => watcher.stop());
  await watcher.waitForApp((s) => s.relay.scheduler.kind === "ready", "leader verified");
  await stack.daemon.leader.settled();
  await watcher.waitForApp(
    (s) => s.relay.machines.filter((m) => m.connected && m.repos.length > 0).length >= 1 + seconds.size,
    "all machines listed with repos",
  );
  const machinesSeen = watcher.store.getState().relay.machines.length;

  const newSession = async (): Promise<Session> => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      // The service worker's precache and update check are not under test; blocked, they add no fetches or reloads.
      serviceWorkers: "block",
    });
    let browserCdp: CDPSession | undefined;
    try {
      await context.addInitScript(COUNT_STORAGE_WRITES);
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const traceCdp = await browser.newBrowserCDPSession();
      browserCdp = traceCdp;
      await cdp.send("Network.enable");
      await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: opts.cpuRate });
      let ws = zeroWs();
      cdp.on("Network.webSocketFrameSent", (p) => {
        ws.wsFramesOut++;
        ws.wsBytesOut += payloadBytes(p.response);
      });
      cdp.on("Network.webSocketFrameReceived", (p) => {
        ws.wsFramesIn++;
        ws.wsBytesIn += payloadBytes(p.response);
      });
      cdp.on("Network.webSocketCreated", () => void ws.wsCreated++);
      cdp.on("Network.webSocketClosed", () => void ws.wsClosed++);

      // First run lands on Setup: fill the credentials as a user would; saving reloads into home.
      await page.goto(baseUrl);
      await page.waitForSelector("#setup-form");
      await page.fill("#relay-url", relayAppUrl);
      await page.fill("#username", TOKEN);
      await page.fill("#password", PSK);
      await Promise.all([page.waitForNavigation().catch(() => null), page.click("button[type=submit]")]);
      await page.waitForSelector("textarea", { timeout: 20_000 });
      return {
        page,
        cdp,
        browserCdp: traceCdp,
        ws: () => ({ ...ws }),
        resetWs: () => {
          ws = zeroWs();
        },
        close: async () => {
          await traceCdp.detach().catch(() => null);
          await context.close().catch(() => null);
        },
      };
    } catch (error) {
      // A leaked page would break measure's one-page assumption for every later run.
      await browserCdp?.detach().catch(() => null);
      await context.close().catch(() => null);
      throw error;
    }
  };

  /** Connected with machines listed; then a pause so the opening burst (sessions fan-out, status) is not measured. */
  const ready = async (s: Session): Promise<void> => {
    await s.page.waitForFunction(primaryButtonReady(/^Queue/u), undefined, { timeout: 30_000 });
    await Bun.sleep(3000);
  };

  const submitAndAwaitVerdict = async (s: Session, label: string): Promise<void> => {
    await s.page.waitForFunction(primaryButtonReady(null), undefined, { timeout: 30_000 });
    await s.page.click("button.primary");
    await s.page.waitForSelector(".verdict", { timeout: 20_000 });
    // The verdict's entrance animation (1.6 s) and its first poll stay out of the window.
    await Bun.sleep(3000);
    log(`verdict (${label}):`, (await verdictText(s.page)).slice(0, 160));
  };

  /** Runs `during` (default: waits `ms`) between two metric reads, with tracing on for DrawFrame counts. */
  const measure = async (s: Session, ms: number, during?: () => Promise<void>): Promise<Sample> => {
    const events: { readonly [key: string]: string }[] = [];
    const onData = (p: { readonly value: { readonly [key: string]: string }[] }): void => void events.push(...p.value);
    let dataLoss = false;
    let finish = (): void => {};
    const complete = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onComplete = (p: { readonly dataLossOccurred: boolean }): void => {
      dataLoss = p.dataLossOccurred;
      finish();
    };
    s.browserCdp.on("Tracing.dataCollected", onData);
    s.browserCdp.on("Tracing.tracingComplete", onComplete);
    let window: {
      readonly m0: ReadonlyMap<string, number>;
      readonly m1: ReadonlyMap<string, number>;
      readonly elapsed: number;
      readonly ls: { readonly set: number; readonly remove: number };
      readonly ws: WsCounts;
    };
    let tracingOn = false;
    try {
      await s.browserCdp.send("Tracing.start", {
        transferMode: "ReportEvents",
        traceConfig: {
          includedCategories: [
            "devtools.timeline",
            "disabled-by-default-devtools.timeline",
            "disabled-by-default-devtools.timeline.frame",
            "cc",
            "viz",
          ],
        },
      });
      tracingOn = true;
      s.resetWs();
      await s.page.evaluate(RESET_STORAGE_COUNTS);
      const m0 = await metricsOf(s.cdp);
      const t0 = performance.now();
      await (during ?? (() => Bun.sleep(ms)))();
      const elapsed = performance.now() - t0;
      const m1 = await metricsOf(s.cdp);
      window = { m0, m1, elapsed, ls: await storageCounts(s.page), ws: s.ws() };
    } finally {
      // Always ended and unhooked: a stuck trace or a leftover listener would corrupt the next run's counts.
      try {
        if (tracingOn) {
          await s.browserCdp.send("Tracing.end");
          const outcome = await Promise.race([
            complete,
            Bun.sleep(TRACE_END_TIMEOUT_MS).then(() => "timeout" as const),
          ]);
          if (outcome === "timeout") log(`tracing did not complete within ${TRACE_END_TIMEOUT_MS}ms`);
        }
      } finally {
        s.browserCdp.off("Tracing.dataCollected", onData);
        s.browserCdp.off("Tracing.tracingComplete", onComplete);
      }
    }

    const { m0, m1, elapsed, ls, ws } = window;
    const delta = (k: string): number | null => {
      const a = m0.get(k);
      const b = m1.get(k);
      return a === undefined || b === undefined ? null : b - a;
    };
    const rounded = (n: number | null, places?: number): number | null => (n === null ? null : round(n, places));
    const elapsedS = elapsed / 1000;
    const taskDuration = delta("TaskDuration");
    // One page in the browser, so every DrawFrame traced is that page's.
    const drawFrames = events.filter((e) => e["name"] === "DrawFrame").length;
    const swapEvents = events.filter((e) => e["name"] === "Graphics.Pipeline.DrawAndSwap");
    // Async begin/end pairs where the build emits them; count each swap once.
    const swapBegins = swapEvents.filter((e) => e["ph"] === "b").length;
    return {
      ...ws,
      durationMs: Math.round(elapsed),
      taskDurationS: rounded(taskDuration),
      taskPct: taskDuration === null ? null : round((taskDuration / elapsedS) * 100, 2),
      scriptDurationS: rounded(delta("ScriptDuration")),
      layoutDurationS: rounded(delta("LayoutDuration")),
      recalcStyleDurationS: rounded(delta("RecalcStyleDuration")),
      layoutCount: delta("LayoutCount"),
      recalcStyleCount: delta("RecalcStyleCount"),
      drawFrames,
      drawFramesPerSec: round(drawFrames / elapsedS),
      swaps: swapBegins > 0 ? swapBegins : swapEvents.length,
      threadTimeS: rounded(delta("ThreadTime"), 2),
      processTimeS: rounded(delta("ProcessTime"), 2),
      lsSetItem: ls.set,
      lsRemoveItem: ls.remove,
      traceDataLoss: dataLoss,
    };
  };

  const withSession = async <T>(body: (s: Session) => Promise<T>): Promise<T> => {
    const s = await newSession();
    try {
      return await body(s);
    } finally {
      await s.close();
    }
  };

  /** Cancels whatever the queue still holds that has not finished, so no run's task is dispatched into a later one. */
  const cancelOpenTasks = async (): Promise<void> => {
    // A leader just back answers `pending` until it has taken the queue over, and refuses a cancel
    // while it is dispatching the task: cancel until a read shows nothing open.
    await pollUntil(
      async () => {
        const queue = await watcher.client.queue().catch(() => null);
        if (queue === null || !("tasks" in queue)) return false;
        const open = queue.tasks.filter((t) => !FINISHED.has(t.state));
        if (open.length === 0) return true;
        await Promise.all(open.map((t) => watcher.client.cancel(t.id).catch(() => null)));
        await Bun.sleep(300);
        return false;
      },
      "the queue to hold no open task",
      15_000,
    ).catch((error: unknown) => log("tasks left in the queue:", String(error)));
  };

  const scenarios: Record<Scenario, (n: number) => Promise<Result>> = {
    A: (n) =>
      withSession(async (s) => {
        await ready(s);
        return { scenario: "A", run: n, note: "idle on home", sample: await measure(s, opts.durationMs) };
      }),
    B: async (n) => {
      const paused = await watcher.client.pause({ until: "resume" });
      if (paused === null || !("holds" in paused)) throw new Error(`pause failed: ${JSON.stringify(paused)}`);
      try {
        return await withSession(async (s) => {
          await ready(s);
          await s.page.fill("textarea", "perf B");
          await submitAndAwaitVerdict(s, "B");
          const sample = await measure(s, opts.durationMs);
          const extra = { verdictText: await verdictText(s.page) };
          return { scenario: "B", run: n, note: "verdict, queue paused, leader up", sample, extra };
        });
      } finally {
        // Cancelled while still paused: resumed first, the leader could dispatch the task.
        await cancelOpenTasks();
        await watcher.client.resume().catch(() => null);
      }
    },
    C: (n) =>
      withSession(async (s) => {
        await ready(s);
        let hiddenPhase = zeroWs();
        // A fixed 10s window; --duration does not apply.
        const sample = await measure(s, 0, async () => {
          await s.page.evaluate(setVisibility("hidden"));
          await Bun.sleep(5000);
          hiddenPhase = s.ws();
          await s.page.evaluate(setVisibility("visible"));
          await Bun.sleep(5000);
        });
        // `sample`'s ws counts span both phases, like every other scenario's.
        const extra = { hiddenPhase, resumePhase: subWs(s.ws(), hiddenPhase) };
        return { scenario: "C", run: n, note: "5s hidden, then 5s visible (one 10s window)", sample, extra };
      }),
    D: (n) =>
      withSession(async (s) => {
        await ready(s);
        await s.page.fill("textarea", "perf D");
        // Both nominees down; the other second daemons stay connected.
        stack.daemon.stop();
        await seconds.get("LeaderBox")?.();
        await watcher.waitForApp((st) => st.relay.scheduler.kind === "none", "no leader");
        await submitAndAwaitVerdict(s, "D");
        const sample = await measure(s, opts.durationMs);
        const extra = { verdictText: await verdictText(s.page) };
        return { scenario: "D", run: n, note: "verdict, no leader, follow polls", sample, extra };
      }),
  };

  /** D stops both leaders; the next run, of any scenario, needs them back. */
  const restoreLeaders = async (): Promise<void> => {
    alive();
    // A D that failed before its stops leaves them running: stop (idempotent) before starting, so no
    // second daemon shares the first's deviceId.
    await seconds.get("LeaderBox")?.();
    await stack.restartDaemon();
    if (seconds.has("LeaderBox")) await startSecond("LeaderBox");
    await watcher.waitForApp((st) => st.relay.scheduler.kind === "ready", "leader back");
    // D's task sat queued with no leader; the new one would dispatch it into the next run.
    await cancelOpenTasks();
    await Bun.sleep(2000);
  };

  const results: Result[] = [];
  let stopped: string | null = null;
  const runs = opts.scenarios.flatMap((scenario) =>
    Array.from({ length: opts.runs }, (_, i) => async (): Promise<void> => {
      if (stopped !== null || aborting) return;
      const n = i + 1;
      log(`scenario ${scenario} run ${n}`);
      try {
        results.push(await scenarios[scenario](n));
      } catch (error) {
        log(`scenario ${scenario} run ${n} failed`, error);
        results.push({ scenario, run: n, note: `FAILED: ${String(error)}`, sample: null });
      }
      if (scenario !== "D") return;
      try {
        await restoreLeaders();
      } catch (error) {
        // Later runs would measure a stack without its leaders: stop, and still report what was collected.
        if (aborting) return;
        log("restoring the leaders failed", error);
        stopped = `leaders not restored after ${scenario} #${n}: ${String(error)}`;
      }
    }),
  );
  await inSeries(runs);
  alive();

  const report = {
    daemons: 1 + seconds.size,
    machinesSeen,
    cpuThrottle: opts.cpuRate,
    durationMs: opts.durationMs,
    stopped,
    results,
  };
  print("JSON_BEGIN");
  print(JSON.stringify(report, null, 2));
  print("JSON_END");
  const columns = [
    "durationMs",
    "taskDurationS",
    "taskPct",
    "scriptDurationS",
    "layoutCount",
    "recalcStyleCount",
    "drawFrames",
    "drawFramesPerSec",
    "swaps",
    "threadTimeS",
    "wsFramesOut",
    "wsFramesIn",
    "wsBytesOut",
    "wsBytesIn",
    "wsCreated",
    "lsSetItem",
    "traceDataLoss",
  ] as const satisfies readonly (keyof Sample)[];
  print(`\nscenario run | ${columns.join(" | ")}`);
  for (const r of results) {
    const cells = columns.map((c) => {
      const value = r.sample?.[c];
      return value === undefined || value === null ? "-" : String(value);
    });
    print(`${r.scenario} #${r.run} | ${cells.join(" | ")}  (${r.note})`);
  }
  for (const r of results.filter((x) => x.scenario === "C")) print(`C #${r.run} phases: ${JSON.stringify(r.extra)}`);
  if (stopped !== null) print(`\nSTOPPED EARLY: ${stopped}`);
  await flushPrinted();
}

try {
  await main(parseArgs(process.argv.slice(2)));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n${USAGE}`);
    process.exitCode = 2;
  } else if (!(error instanceof AbortError)) {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  await teardown();
}
// Exit explicitly: a lingering socket or timer from the stack must not keep the process up.
process.exit(process.exitCode ?? 0);
