import { cliSink, custodianOwnerAudit } from "./audit.ts";
import { loadConfig, type Config } from "./config.ts";
import {
  pausedAt,
  readControl,
  readSeatView,
  requestRound,
  writePause,
  type CustodianPause,
  type SeatView,
} from "./custodian-control.ts";
import { readRounds, type RoundEntry } from "./custodian-rounds.ts";
import { FAILING_AFTER, ROUNDS_LIVE, trailingFailures } from "./custodian-seat.ts";
import { custodianRoundsPath } from "./paths.ts";
import { custodianSeatOf, pidAlive, readRuntime, readState } from "./state.ts";

/**
 * `seanced custodian status | log | round | pause [--for <dur>] | resume` (docs/custodian.md C43, C45, C47; DESIGN.md,
 * "The custodian's status and the Machines row"): the owner's, typed at this machine's shell. Never a frame, a
 * local-socket op or an app op, and `main.ts` loads it on demand, outside `custodian-cli.ts`'s import closure — this
 * one logs and audits, which the round's verbs must never reach. Every verb works from files, never the socket, so
 * `log` is machine-local by construction.
 *
 * Everything that came from a file goes to the terminal only through `printable`: a round's summary is model-written
 * from untrusted pane text, and an escape sequence in it would otherwise reach the owner's terminal.
 */

const USAGE = "usage: seanced custodian status | log | round | pause [--for <n>m|h|d] | resume";

const MINUTE_MS = 60_000;
const SEAT_VIEW_STALE_MS = 5 * MINUTE_MS;
const MIN_PAUSE_MS = MINUTE_MS;
const MAX_PAUSE_MS = 30 * 24 * 60 * MINUTE_MS;
const UNIT_MS = { m: MINUTE_MS, h: 60 * MINUTE_MS, d: 24 * 60 * MINUTE_MS } as const;
const FIELD_MAX = 120;
const SUMMARY_PRINT_MAX = 1_024;

/** Control characters, formatting characters (bidi, zero-width) and line and paragraph separators, replaced by U+FFFD. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/** A string from a file, safe to print: newlines survive only when asked (a summary's), and the length is capped. */
export function printable(text: string, max: number = FIELD_MAX, keepNewlines = false): string {
  const clipped = text.length > max ? `${text.slice(0, max)}…` : text;
  if (!keepNewlines) return clipped.replace(UNPRINTABLE, "�");
  return clipped
    .split("\n")
    .map((line) => line.replace(UNPRINTABLE, "�"))
    .join("\n");
}

const time = (ms: number): string => new Date(ms).toLocaleString();

/** `1h`, `30m`, `2d` in ms; null for anything else or out of 1m..30d. */
export function parseDuration(text: string): number | null {
  const match = /^(\d{1,4})([mhd])$/u.exec(text);
  if (match === null) return null;
  const unit = match[2] === "m" || match[2] === "h" || match[2] === "d" ? match[2] : null;
  if (unit === null) return null;
  const ms = Number(match[1]) * UNIT_MS[unit];
  return ms >= MIN_PAUSE_MS && ms <= MAX_PAUSE_MS ? ms : null;
}

const usage = (): void => {
  console.error(USAGE);
  process.exitCode = 2;
};

export async function cmdCustodianOwner(rest: readonly string[]): Promise<void> {
  const [verb, ...args] = rest;
  if (verb === "status" && args.length === 0) return status();
  if (verb === "log" && args.length === 0) return logRounds();
  if (verb === "round" && args.length === 0) return requestOwnerRound();
  if (verb === "resume" && args.length === 0) return resume();
  if (verb === "pause") return pause(args);
  usage();
}

async function configOf(): Promise<Config | null> {
  try {
    return await loadConfig();
  } catch {
    return null;
  }
}

const pauseLine = (read: Awaited<ReturnType<typeof readControl>>, now: number): string => {
  if (read.unreadable) return "yes (custodian/state.json is unreadable: `seanced custodian resume` rewrites it)";
  if (!pausedAt(read, now) || read.pause === null) return "no";
  return read.pause.until === null ? "until resume" : `until ${time(read.pause.until)}`;
};

async function status(): Promise<void> {
  const now = Date.now();
  const config = await configOf();
  const settings = config?.custodian;
  console.log(
    `seat:        ${settings === undefined ? "not configured" : `configured (every ${printable(String(settings.everyMinutes))} min)`}`,
  );
  console.log(`rounds:      ${ROUNDS_LIVE ? "live" : "held (docs/custodian.md, build item 4b)"}`);
  const view = await readSeatView();
  console.log(`daemon:      ${viewLine(view, now)}`);
  const control = await readControl();
  console.log(`paused:      ${pauseLine(control, now)}`);
  const state = await readState().catch(() => null);
  const running = state === null ? undefined : custodianSeatOf(state).round;
  console.log(
    `round:       ${
      running === undefined
        ? "none"
        : `running in pane ${running.pane === null ? "(starting)" : printable(running.pane)} since ${time(running.startedAt)} (exclave ${printable(running.exclave)})`
    }`,
  );
  const entries = await readRounds(custodianRoundsPath()).catch(() => [] as readonly RoundEntry[]);
  const last = entries.at(-1);
  console.log(`last round:  ${last === undefined ? "none" : lastLine(last)}`);
  const tail = trailingFailures(entries);
  const failing = view?.s === "failing" || tail >= FAILING_AFTER;
  if (failing) {
    console.log(
      `failing:     yes (${view?.failed === true ? "this host's checks failed, so no round can run" : `${FAILING_AFTER} failed rounds or attempts in a row`})`,
    );
  }
}

function viewLine(view: SeatView | null, now: number): string {
  if (view === null || now - view.at > SEAT_VIEW_STALE_MS) {
    return "has not reported (not running, not enabled on this host, or an older daemon)";
  }
  const parts = [view.s, ...(view.held ? ["held"] : []), ...(view.failed ? ["host checks failed"] : [])];
  return `${parts.join(", ")} (reported ${Math.max(0, Math.round((now - view.at) / 1000))}s ago, version ${printable(view.version, 12)})`;
}

function lastLine(entry: RoundEntry): string {
  const outcome = entry.outcome === "healthy" ? "healthy" : `failed (${printable(entry.reason)})`;
  return `ended ${time(entry.end)}, ${outcome}, closed ${entry.counts.close.ok}`;
}

async function logRounds(): Promise<void> {
  const entries = await readRounds(custodianRoundsPath()).catch(() => null);
  if (entries === null) {
    console.error("seanced custodian: the round log could not be read");
    process.exitCode = 1;
    return;
  }
  if (entries.length === 0) {
    console.log("no rounds logged");
    return;
  }
  const blocks = entries.toReversed().map((entry) => {
    const { sessions, close, notes, done, worktrees } = entry.counts;
    const lines = [
      `${time(entry.start)} -> ${time(entry.end)}  exclave ${printable(entry.exclave)}  ${entry.outcome} (${printable(entry.reason)})`,
      `  sessions ${sessions.ok}/${sessions.refused}, close ${close.ok}/${close.refused}, notes ${notes.ok}/${notes.refused}, done ${done.ok}/${done.refused}, worktrees removed ${worktrees.removed} kept ${worktrees.kept}`,
    ];
    if (entry.summary !== undefined) {
      lines.push(
        ...printable(entry.summary, SUMMARY_PRINT_MAX, true)
          .split("\n")
          .map((line) => `    ${line}`),
      );
    }
    return lines.join("\n");
  });
  console.log(blocks.join("\n\n"));
}

/** `live` is a seam for tests: production passes none, and rounds are held while `ROUNDS_LIVE` is false. */
export async function requestOwnerRound(live: boolean = ROUNDS_LIVE): Promise<void> {
  const audit = custodianOwnerAudit(cliSink);
  if (!live) {
    console.error("seanced custodian: rounds are held until docs/custodian.md build item 4b; nothing requested");
    process.exitCode = 1;
    await audit.round("held");
    return;
  }
  const config = await configOf();
  if (config?.custodian === undefined) {
    console.error("seanced custodian: no custodian configured in config.json; nothing requested");
    process.exitCode = 1;
    await audit.round("unconfigured");
    return;
  }
  const view = await readSeatView();
  if (view?.held === true || view?.failed === true) {
    console.error(
      view.failed
        ? "seanced custodian: this host's checks failed, so no round can run; nothing requested"
        : "seanced custodian: rounds are held; nothing requested",
    );
    process.exitCode = 1;
    await audit.round(view.failed ? "failed" : "held");
    return;
  }
  const runtime = await readRuntime();
  if (runtime === null || !pidAlive(runtime.pid)) {
    console.error("seanced custodian: the daemon is not running; the request runs when it next ticks, if still fresh");
  } else if (view === null || Date.now() - view.at > SEAT_VIEW_STALE_MS) {
    console.error("seanced custodian: the daemon has not reported a seat; it may not honour the request");
  }
  await requestRound(Date.now());
  await audit.round("requested");
  console.log("round requested; the seat starts it within a minute");
}

async function pause(args: readonly string[]): Promise<void> {
  let until: number | null = null;
  const now = Date.now();
  if (args.length > 0) {
    const flag = args[0];
    const value =
      flag === "--for" ? args[1] : flag?.startsWith("--for=") === true ? flag.slice("--for=".length) : undefined;
    const given = flag === "--for" ? args.length === 2 : args.length === 1;
    const ms = value === undefined || !given ? null : parseDuration(value);
    if (ms === null) {
      console.error("seanced custodian: --for takes <n>m, <n>h or <n>d, from 1m to 30d");
      usage();
      return;
    }
    until = now + ms;
  }
  const record: CustodianPause = { at: now, until };
  await writePause(record);
  await custodianOwnerAudit(cliSink).pause(until);
  console.log(until === null ? "paused until resume" : `paused until ${time(until)}`);
}

async function resume(): Promise<void> {
  await writePause(null);
  await custodianOwnerAudit(cliSink).resume();
  console.log("resumed");
}
