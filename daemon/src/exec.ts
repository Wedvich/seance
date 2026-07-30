export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export async function exec(
  argv: readonly string[],
  opts: { readonly cwd?: string; readonly timeoutMs?: number; readonly stdin?: string } = {},
): Promise<ExecResult> {
  const proc = Bun.spawn([...argv], {
    cwd: opts.cwd,
    stdin: opts.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs ?? 60_000);
  const sink = proc.stdin;
  if (opts.stdin !== undefined && sink !== undefined && typeof sink !== "number") {
    // A child that dies before draining stdin rejects the flush with EPIPE;
    // its exit code and stderr already tell that story, so a write failure
    // must degrade to a non-zero result, not throw past the caller.
    try {
      sink.write(opts.stdin);
      await sink.end();
    } catch {
      // reported via exitCode/stderr
    }
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

/** Failure detail for error messages: names the timeout instead of a bare kill signal. */
export function execFailure(result: ExecResult): string {
  return result.timedOut ? "timed out" : `exit ${result.exitCode}: ${result.stderr.trim()}`;
}

export async function git(cwd: string, args: readonly string[], timeoutMs?: number): Promise<ExecResult> {
  return exec(["git", ...args], { cwd, timeoutMs });
}
