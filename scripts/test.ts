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
const TIMEOUT_MS = 15_000;

interface Shard {
  readonly name: string;
  readonly paths: readonly string[];
  readonly parallel?: boolean;
}

// Slowest first, so the short shards fill in behind the critical path.
const SHARDS: readonly Shard[] = [
  { name: "daemon+shared", paths: ["daemon/", "shared/"], parallel: true },
  { name: "e2e", paths: ["e2e/"] },
  { name: "relay", paths: ["relay/"] },
  { name: "pwa", paths: ["pwa/"] },
  // Last because it is the fastest: pure logic and a drift guard, no workerd,
  // no tmux, no Raycast host.
  { name: "raycast", paths: ["raycast/"] },
];

// `bun run test <path>` narrows to one shard, so a single file still runs with
// the timeout the workerd-booting suites need.
const filters = process.argv.slice(2);
const shards: readonly Shard[] = filters.length === 0 ? SHARDS : [{ name: filters.join(" "), paths: filters }];

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

interface Result {
  readonly name: string;
  readonly exitCode: number;
  readonly output: string;
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

function command(args: readonly string[]): string[] {
  if (!usePty) return ["bun", ...args];
  // BSD script takes the command as argv; util-linux needs -c with one string.
  return process.platform === "darwin"
    ? ["script", "-q", "/dev/null", "bun", ...args]
    : ["script", "-qec", ["bun", ...args].map(shellQuote).join(" "), "/dev/null"];
}

/** A pty gives every line CRLF, and script opens with a stray EOT + backspaces. */
const PTY_PREAMBLE = new Set(["\u0004", "\u0008"]);

function clean(text: string): string {
  if (!usePty) return text;
  let start = 0;
  while (PTY_PREAMBLE.has(text[start] ?? "")) start++;
  return text.slice(start).replaceAll("\r\n", "\n");
}

async function runShard(shard: Shard): Promise<Result> {
  const args = ["test", ...shard.paths, "--timeout", String(TIMEOUT_MS)];
  if (shard.parallel === true) args.push("--parallel");

  const proc = Bun.spawn(command(args), {
    stdin: usePty ? "inherit" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
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
const results = await Promise.all(shards.map(runShard));
const elapsedMs = Math.round((Bun.nanoseconds() - started) / 1e6);

for (const result of results) {
  const status = result.exitCode === 0 ? "pass" : `FAIL (exit ${result.exitCode})`;
  console.log(`\n${"═".repeat(72)}\n${result.name} — ${status}\n${"═".repeat(72)}`);
  console.log(result.output.trimEnd());
}

const failed = results.filter((r) => r.exitCode !== 0);
const verdict =
  failed.length === 0
    ? `all ${plural(results.length, "shard")} passed`
    : `${plural(failed.length, "shard")} of ${results.length} failed: ${failed.map((r) => r.name).join(", ")}`;

const summary = results.map((r) => parseSummary(r.output));
const unparsed = results.filter((_, i) => summary[i]?.tests === undefined);
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

process.exit(failed.length === 0 ? 0 : 1);
