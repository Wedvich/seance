export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * The daemon's environment minus the secrets its service manager delivered to
 * *it*. `Bun.spawn` inherits `process.env`, and under a
 * `LoadCredentialEncrypted=` unit that names the tmpfs holding the PSK — which
 * the daemon would hand to the tmux server it may cold-boot, and through it to
 * every Claude session on the box. DESIGN.md's "MCP on a credential-delivered
 * box is unsupported" and psk.md's "the plaintext exists only in the service's
 * tmpfs and the daemon's memory" are both true only while this holds, so this
 * is an invariant, not a precaution.
 *
 * Rebuilt per call rather than memoized: the test suites set their isolation
 * env vars after import, and a frozen copy would serve children the wrong ones.
 *
 * Exported so the one caller that spawns a long-running child itself
 * (`raycast.ts`, watching `ray develop`) inherits the scrub rather than
 * rebuilding it. `overrides` layer on top — a caller that has to point a child
 * at a different PATH must not have to reconstruct the exclusion to do it. An
 * `undefined` override unsets the variable: `default`'s Claude config is the
 * one reached *without* `CLAUDE_CONFIG_DIR`, so pointing at it means removal.
 */
export function childEnv(overrides: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete env[key];
  // Children only: the daemon's own process.env must keep it, or a supervisor reload
  // re-resolves the key from another source and silently turns the fleet broker off.
  delete env["CREDENTIALS_DIRECTORY"];
  return env;
}

export async function exec(
  argv: readonly string[],
  opts: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly stdin?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    /**
     * Run the child in its own process group and time out the whole group.
     * Otherwise the timeout kills only the child, and the result still waits for
     * every grandchild holding its stdout/stderr — a fetch's `ssh` or
     * `git-remote-https` on a dead network keeps it for its own connect timeout.
     */
    readonly killGroup?: boolean;
  } = {},
): Promise<ExecResult> {
  const proc = Bun.spawn([...argv], {
    cwd: opts.cwd,
    env: childEnv(opts.env),
    stdin: opts.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: opts.killGroup === true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (opts.killGroup !== true) {
      proc.kill();
      return;
    }
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      // group already gone
    }
  }, opts.timeoutMs ?? 60_000);
  const sink = proc.stdin;
  if (opts.stdin !== undefined && sink !== undefined && typeof sink !== "number") {
    // A child that dies before draining stdin rejects the flush with EPIPE;
    // its exit code and stderr already tell that story, so a write failure
    // must degrade to a non-zero result, not throw past the caller.
    try {
      // write() returns a promise under backpressure — unawaited, its EPIPE
      // rejection escapes this guard as an unhandled rejection.
      await sink.write(opts.stdin);
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
