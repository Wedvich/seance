/**
 * Runs the suite as concurrent `bun test` processes, one per shard.
 *
 * Not `bun test --parallel` at the top level: that implies --isolate, which
 * re-evaluates modules per test file and so defeats the once-per-process memo in
 * relay/test/harness.ts — a second Bun.build in one process fails. Sharding by
 * process leaves every suite's process-scoped state exactly as a plain run has
 * it, and puts the concurrency where nothing is shared. --parallel is safe
 * *inside* the daemon shard, which touches neither Miniflare nor Bun.build.
 *
 * Shards are directory paths, not name patterns: `bun test relay` would also
 * sweep daemon/test/relay.test.ts. Counts must add up to a plain run's, which the
 * coverage check below enforces — every tracked test file has to fall in a shard.
 */
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_RUN_DIR_ENV } from "./test-run-dir.ts";

const TIMEOUT_MS = 15_000;

interface Shard {
  readonly name: string;
  readonly paths: readonly string[];
  readonly parallel?: boolean;
  /**
   * Claude Code mods import `claude-code/testing`, which only `claude plugin test`
   * provides — one plugin folder per path. Its summary is bun's format, so the
   * tally below reads it unchanged.
   */
  readonly runner?: "claude-plugin";
}

// Slowest first, so the short shards fill in behind the critical path.
const SHARDS: readonly Shard[] = [
  // Two shards, not one: on GitHub's Ubuntu runner a `bun test --parallel`
  // (1.4.2) run that has written about 64 KiB of reporter output stops dead —
  // exit 1, the output cut mid-line, no summary, no test named. It never
  // reproduced locally or in an ubuntu:24.04 container; the whole daemon suite
  // crossed that size with the reap tests. Each half stays well under it.
  { name: "daemon/test", paths: ["daemon/test/"], parallel: true },
  { name: "daemon/src+shared", paths: ["daemon/src/", "shared/"], parallel: true },
  { name: "e2e", paths: ["e2e/"] },
  { name: "relay", paths: ["relay/"] },
  { name: "pwa", paths: ["pwa/"] },
  { name: "raycast", paths: ["raycast/"] },
  { name: "scripts", paths: ["scripts/"] },
  { name: "claude-mods", paths: ["claude-mods/tmux-rename"], runner: "claude-plugin" },
];

// `bun run test <path>` narrows to one bun shard (plus one for mods), so a single file still runs with
// the timeout the workerd-booting suites need.
const filters = process.argv.slice(2);
// A filter overlapping a mod's folder (`claude-mods/`, the folder, a file inside it)
// goes to `claude plugin test` as that folder: bun can't import the mods' tests,
// and `claude plugin test` takes only plugin folders.
const modFolders = SHARDS.filter((shard) => shard.runner === "claude-plugin").flatMap((shard) => shard.paths);
const modsUnder = (filter: string): string[] =>
  modFolders.filter((folder) => filter.startsWith(folder) || folder.startsWith(filter));
const bunFilters = filters.filter((f) => modsUnder(f).length === 0);
const modFilters = filters.filter((f) => modsUnder(f).length > 0);
const shards: readonly Shard[] =
  filters.length === 0
    ? SHARDS
    : [
        ...(bunFilters.length === 0 ? [] : [{ name: bunFilters.join(" "), paths: bunFilters }]),
        ...(modFilters.length === 0
          ? []
          : [
              {
                name: modFilters.join(" "),
                paths: [...new Set(modFilters.flatMap(modsUnder))],
                runner: "claude-plugin" as const,
              },
            ]),
      ];

/**
 * The shard paths are prefixes, so a test file added outside all of them would simply
 * never run — and the run would still report every shard passing, which is worse than
 * a failure. Tracked test files are the source of truth for what must be covered.
 */
if (filters.length === 0) {
  const tracked = await new Response(Bun.spawn(["git", "ls-files", "*.test.ts"]).stdout).text();
  const unclaimed = tracked
    .split("\n")
    .filter((path) => path !== "")
    .filter((path) => !SHARDS.some((shard) => shard.paths.some((prefix) => path.startsWith(prefix))));
  if (unclaimed.length > 0) {
    console.error(`no shard covers: ${unclaimed.join(", ")}\nadd it to SHARDS in scripts/test.ts`);
    process.exit(1);
  }
}

/**
 * Suites' private tmux sockets land here (`usePrivateTmux`), and the sweep below
 * runs however the run ends. Their own teardown covers a clean finish; this
 * covers the ones that never reach it — a suite timing out in beforeAll, a
 * shard crashing, the run signalled — where a tmux server (holding a claude
 * stub) would otherwise outlive the run. bun test fires no exit hooks, so this
 * can only live in the parent.
 */
const runDir = await mkdtemp(join(tmpdir(), "seance-run-"));
// Passed explicitly: Bun.spawn's default env is the startup snapshot, blind to process.env writes.
const shardEnv = { ...process.env, [TEST_RUN_DIR_ENV]: runDir };
const running = new Set<Bun.Subprocess>();
/** Bounds each kill-server: a wedged server must not hang the run's exit. */
const KILL_SERVER_TIMEOUT_MS = 10_000;

let sweep: Promise<void> | null = null;

/**
 * Moves the run dir aside before reading it: tmux won't create a socket's parent
 * directory, so from the rename on, a shard still booting a server fails to
 * bind instead of leaving one the sweep's listing missed. Everything in the
 * moved dir is a socket by construction; kill-server on a dead one just fails.
 * Memoized because the signal path and the main path both end here.
 */
function sweepRunDir(): Promise<void> {
  sweep ??= (async () => {
    const swept = `${runDir}-swept`;
    try {
      await rename(runDir, swept);
    } catch {
      return; // never created, or already swept
    }
    const entries = await readdir(swept);
    await Promise.all(
      entries.map(
        (name) =>
          Bun.spawn(["tmux", "-S", join(swept, name), "kill-server"], {
            stdout: "ignore",
            stderr: "ignore",
            timeout: KILL_SERVER_TIMEOUT_MS,
          }).exited,
      ),
    );
    await rm(swept, { recursive: true, force: true });
  })();
  return sweep;
}

/** How long a signalled shard gets to exit before the sweep goes ahead without it. */
const SHARD_EXIT_GRACE_MS = 5_000;
let signalExitCode: number | null = null;

/**
 * Only signals sent to the runner itself land here (CI cancel, `kill`). A ^C at
 * a terminal mostly doesn't: under the pty wrapper `script` puts the tty in raw
 * mode, so the keystroke interrupts only the shard reading it, and the run
 * finishes and sweeps on the normal path.
 */
function onSignal(signal: "SIGINT" | "SIGTERM", code: number): void {
  signalExitCode ??= code;
  const exits = [...running].map((proc) => {
    proc.kill(signal);
    return proc.exited;
  });
  void Promise.race([Promise.all(exits), Bun.sleep(SHARD_EXIT_GRACE_MS)])
    .then(sweepRunDir)
    .finally(() => process.exit(code));
}
process.on("SIGINT", () => onSignal("SIGINT", 130));
process.on("SIGTERM", () => onSignal("SIGTERM", 143));

interface Result {
  readonly name: string;
  readonly exitCode: number;
  readonly output: string;
  readonly skipped?: boolean;
}

/**
 * Shard output has to be captured — four runners streaming into one terminal are
 * unreadable, and a failure must stay attached to its shard — but a captured pipe
 * costs bun's tty reporter: no color, and a `(pass)` line per test in place of the
 * quiet ✓-for-notable-tests view. FORCE_COLOR restores neither. So hand each child
 * a pty, which `script` is the portable way to do (in two incompatible flavors),
 * and buffer that instead. bun emits only SGR colors there, no cursor rewrites, so
 * a buffered blob replays exactly as it looked live.
 *
 * Only when our own stdout is a tty: piped and CI runs keep the plain reporter,
 * which is what belongs in a log file.
 */
const usePty = process.stdout.isTTY === true && Bun.which("script") !== null;

function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

function command(argv: readonly string[]): string[] {
  if (!usePty) return [...argv];
  // BSD script takes the command as argv; util-linux needs -c with one string.
  return process.platform === "darwin"
    ? ["script", "-q", "/dev/null", ...argv]
    : ["script", "-qec", argv.map(shellQuote).join(" "), "/dev/null"];
}

/** A pty gives every line CRLF, and script opens with a stray EOT + backspaces. */
const PTY_PREAMBLE = new Set(["\u0004", "\u0008"]);

function clean(text: string): string {
  if (!usePty) return text;
  let start = 0;
  while (PTY_PREAMBLE.has(text[start] ?? "")) start++;
  return text.slice(start).replaceAll("\r\n", "\n");
}

function shardArgv(shard: Shard): string[] | null {
  if (shard.runner === "claude-plugin") {
    const claude = Bun.which("claude");
    return claude === null ? null : [claude, "plugin", "test", ...shard.paths];
  }
  const argv = ["bun", "test", ...shard.paths, "--timeout", String(TIMEOUT_MS)];
  if (shard.parallel === true) argv.push("--parallel");
  return argv;
}

async function runShard(shard: Shard): Promise<Result> {
  const argv = shardArgv(shard);
  // Skipped, not failed: Claude Code is a runtime dependency of the mods, not of
  // the repo — CI has no claude. Named in its header and the total so it can't pass unseen.
  if (argv === null) return { name: shard.name, exitCode: 0, output: "skipped — claude not on PATH", skipped: true };

  const proc = Bun.spawn(command(argv), {
    env: shardEnv,
    stdin: usePty ? "inherit" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  running.add(proc);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  running.delete(proc);
  return { name: shard.name, exitCode, output: clean(`${stdout}${stderr}`) };
}

interface Summary {
  readonly counts: Readonly<Record<string, number>>;
  readonly expectCalls: number;
  readonly tests?: number;
  readonly files?: number;
}

// The shards each print their own bun summary; this re-adds them into one, so the
// bottom line matches what a single `bun test` over everything would report.
const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "gu");
const COUNT_LINE = /^\s*(\d+) (pass|fail|skip|todo)\s*$/u;
const EXPECT_LINE = /^\s*(\d+) expect\(\) calls\s*$/u;
const RAN_LINE = /^Ran (\d+) tests? across (\d+) files?\./u;

function parseSummary(output: string): Summary {
  const counts: Record<string, number> = {};
  let expectCalls = 0;
  let tests: number | undefined;
  let files: number | undefined;

  for (const line of output.replaceAll(SGR, "").split("\n")) {
    const count = COUNT_LINE.exec(line);
    if (count?.[1] !== undefined && count[2] !== undefined) {
      counts[count[2]] = (counts[count[2]] ?? 0) + Number(count[1]);
      continue;
    }
    const expects = EXPECT_LINE.exec(line);
    if (expects?.[1] !== undefined) {
      expectCalls += Number(expects[1]);
      continue;
    }
    const ran = RAN_LINE.exec(line);
    if (ran?.[1] !== undefined && ran[2] !== undefined) {
      tests = Number(ran[1]);
      files = Number(ran[2]);
    }
  }
  return { counts, expectCalls, ...(tests === undefined ? {} : { tests }), ...(files === undefined ? {} : { files }) };
}

function tally(summaries: readonly Summary[]): {
  counts: Record<string, number>;
  expectCalls: number;
  tests: number;
  files: number;
} {
  const counts: Record<string, number> = {};
  let expectCalls = 0;
  let tests = 0;
  let files = 0;
  for (const summary of summaries) {
    for (const [label, count] of Object.entries(summary.counts)) counts[label] = (counts[label] ?? 0) + count;
    expectCalls += summary.expectCalls;
    tests += summary.tests ?? 0;
    files += summary.files ?? 0;
  }
  return { counts, expectCalls, tests, files };
}

const SGR_CODES = { green: 32, red: 31, dim: 2, bold: 1 } as const;

/** Mirrors bun's own green/red/dim, and only where it would use them. */
function paint(color: keyof typeof SGR_CODES, text: string): string {
  return process.stdout.isTTY === true ? `${ESC}[${SGR_CODES[color]}m${text}${ESC}[0m` : text;
}

/** bun dims the brackets around a duration and bolds the number inside them. */
function duration(ms: number): string {
  const text = ms >= 1_000 ? `${(ms / 1_000).toFixed(2)}s` : `${ms.toFixed(2)}ms`;
  return process.stdout.isTTY === true ? paint("dim", `[${paint("bold", text)}${ESC}[${SGR_CODES.dim}m]`) : `[${text}]`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const started = Bun.nanoseconds();
let results: Result[];
try {
  results = await Promise.all(shards.map(runShard));
} finally {
  await sweepRunDir();
}
// The signal handler owns the exit code; killed shards resolving here must not report over it.
if (signalExitCode !== null) process.exit(signalExitCode);
const elapsedMs = Math.round((Bun.nanoseconds() - started) / 1e6);

for (const result of results) {
  const status =
    result.skipped === true ? "skipped" : result.exitCode === 0 ? "pass" : `FAIL (exit ${result.exitCode})`;
  console.log(`\n${"═".repeat(72)}\n${result.name} — ${status}\n${"═".repeat(72)}`);
  console.log(result.output.trimEnd());
}

const failed = results.filter((r) => r.exitCode !== 0);
const verdict =
  failed.length === 0
    ? `all ${plural(results.length, "shard")} passed`
    : `${plural(failed.length, "shard")} of ${results.length} failed: ${failed.map((r) => r.name).join(", ")}`;

const summary = results.map((r) => parseSummary(r.output));
const unparsed = results.filter((r, i) => r.skipped !== true && summary[i]?.tests === undefined);
const skipped = results.filter((r) => r.skipped === true);
const totals = tally(summary);

console.log(`\n${"═".repeat(72)}\ntotal — ${verdict}\n${"═".repeat(72)}`);
for (const label of ["pass", "fail", "skip", "todo"] as const) {
  const count = totals.counts[label] ?? 0;
  // bun prints skip/todo only when they happened; match that.
  if (count === 0 && label !== "pass" && label !== "fail") continue;
  // Green for passes, red only for failures that happened — a clean 0 fail is dim.
  const color = label === "pass" ? "green" : label === "fail" && count > 0 ? "red" : "dim";
  console.log(paint(color, ` ${count} ${label}`));
}
console.log(` ${totals.expectCalls} expect() calls`);
console.log(`Ran ${plural(totals.tests, "test")} across ${plural(totals.files, "file")}. ${duration(elapsedMs)}`);
// A shard that dies before printing its summary contributes nothing above, so the
// total would quietly under-report the suite.
if (unparsed.length > 0)
  console.log(paint("red", `warning: no summary from ${unparsed.map((r) => r.name).join(", ")}`));
if (skipped.length > 0) console.log(`skipped shards: ${skipped.map((r) => r.name).join(", ")}`);

process.exit(failed.length === 0 ? 0 : 1);
