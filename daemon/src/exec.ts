export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export async function exec(
  argv: readonly string[],
  opts: { readonly cwd?: string; readonly timeoutMs?: number } = {},
): Promise<ExecResult> {
  const proc = Bun.spawn([...argv], {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs ?? 60_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

export async function git(
  cwd: string,
  args: readonly string[],
  timeoutMs?: number,
): Promise<ExecResult> {
  return exec(["git", ...args], { cwd, timeoutMs });
}
