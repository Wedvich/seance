import { DespawnFailure, type DespawnResult } from "./backend.ts";
import { exec } from "./exec.ts";
import { classifyPane, isRegistered, paneInfo, type PaneInfo } from "./sessions.ts";
import { tmux } from "./tmux.ts";

/**
 * tmux's own pane-id form, and the only target a wire-supplied id may name:
 * `-t` would also resolve `main:1.0`, `{marked}` or `=name`, none of which a
 * session list ever handed out.
 */
const PANE_ID = /^%\d+$/u;

const DEFAULT_GRACE_MS = 5_000;
/** How long a killed pane's processes get to exit on their own, and again after SIGTERM. */
const DEFAULT_REAP_WAIT_MS = 2_000;
/** Between keys: an ESC chased too closely by the next key reads as one Alt chord. */
const KEY_GAP_MS = 150;
const POLL_MS = 100;

export interface DespawnOptions {
  /** Kill straight away instead of asking claude to exit first. */
  readonly force: boolean;
  readonly graceMs?: number;
  readonly reapWaitMs?: number;
}

/**
 * Ends one session: asks claude to `/exit`, answers the worktree prompt that
 * follows with Keep, and kills the pane if it is still there when the grace
 * runs out. The window only — the worktree and its branch are reap's.
 */
export async function despawnSession(id: string, opts: DespawnOptions): Promise<DespawnResult> {
  if (!PANE_ID.test(id)) {
    throw new DespawnFailure("invalid_target", `"${id}" is not a session id — take one from the session list (%12)`);
  }
  const pane = await paneInfo(id);
  // The session list's own predicate: despawn reaches exactly what a list offered.
  if (pane === null || !isRegistered(pane)) {
    throw new DespawnFailure("session_not_found", `no session in pane ${id} — it may have exited already`);
  }
  const window = pane.windowName;
  if (!opts.force && (await exitGracefully(pane, opts.graceMs ?? DEFAULT_GRACE_MS))) {
    return { window, outcome: "exited" };
  }
  await killPane(id, opts.reapWaitMs ?? DEFAULT_REAP_WAIT_MS);
  return { window, outcome: "killed" };
}

/**
 * Enter on the worktree exit prompt, whose preselected first option is Keep:
 * claude exits 0 and leaves the worktree (measured on 2.1.295). Never Esc,
 * which cancels the exit. The caller has classified the pane as `exit-prompt`.
 */
export async function answerKeepWorktree(paneId: string): Promise<void> {
  await tmux(["send-keys", "-t", paneId, "Enter"]);
}

/**
 * Esc interrupts a running turn. Ctrl+C then clears the draft, if any: Esc
 * alone only arms "Esc again to clear", so `/exit` would be appended to the
 * draft and Enter would send it as a prompt, and Ctrl+U clears just one line
 * of a multi-line one. On an empty box Ctrl+C only arms "press again to exit",
 * which typing disarms. Measured on Claude Code 2.1.295.
 *
 * `tmux`, not `tmuxOk`: a pane that exits mid-sequence is the outcome asked
 * for, not a failure.
 */
async function askToExit(paneId: string): Promise<void> {
  for (const keys of [["Escape"], ["C-c"], ["-l", "/exit"], ["Enter"]]) {
    // oxlint-disable-next-line no-await-in-loop -- keystrokes, in order and paced
    await tmux(["send-keys", "-t", paneId, ...keys]);
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(KEY_GAP_MS);
  }
}

/** True once the pane is gone; false when it outlived the grace. */
async function exitGracefully(pane: PaneInfo, graceMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  // Already on the prompt — answering it is the whole exit.
  let answered = (await classifyPane(pane)) === "exit-prompt";
  if (answered) await answerKeepWorktree(pane.paneId);
  else await askToExit(pane.paneId);
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling: each check gates the next
    const now = await paneInfo(pane.paneId);
    if (now === null) return true;
    // oxlint-disable-next-line no-await-in-loop
    const state = await classifyPane(now);
    // claude has gone; what is left is a pane remain-on-exit kept, or the shell a
    // hand-started claude ran from, and closing the window was the point.
    if (state === "dead" || state === "shell") {
      // oxlint-disable-next-line no-await-in-loop
      await tmux(["kill-pane", "-t", pane.paneId]);
      return true;
    }
    if (state === "exit-prompt" && !answered) {
      answered = true;
      // oxlint-disable-next-line no-await-in-loop
      await answerKeepWorktree(pane.paneId);
    }
    if (Date.now() >= deadline) return false;
    // oxlint-disable-next-line no-await-in-loop
    await Bun.sleep(POLL_MS);
  }
}

/**
 * `kill-pane` closes the pty, and the SIGHUP that sends is what normally ends
 * claude. On macOS the pane's process is `caffeinate`, with claude its child,
 * so a claude that ignores SIGHUP would run on with no window and no parent.
 * The pane's process and its children are recorded first and escalated to
 * SIGTERM, then SIGKILL, if they outlive the pane. A dead pane (remain-on-exit)
 * still reports its long-reaped `pane_pid`, which may name an unrelated process
 * by now, so nothing is watched there.
 */
async function killPane(paneId: string, waitMs: number): Promise<void> {
  const field = await tmux(["display-message", "-p", "-t", paneId, "#{pane_dead} #{pane_pid}"]);
  const [dead, pidText] = field.stdout.trim().split(" ");
  const pid = Number(pidText);
  const live = field.exitCode === 0 && dead === "0" && pid > 0;
  const watched = live ? [pid, ...(await childrenOf(pid))] : [];
  await tmux(["kill-pane", "-t", paneId]);
  let alive = await survivors(watched, waitMs);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (alive.length === 0) return;
    for (const survivor of alive) signalQuietly(survivor, signal);
    // oxlint-disable-next-line no-await-in-loop -- escalation: each signal waits on the last
    alive = await survivors(alive, waitMs);
  }
}

/** Empty where `pgrep` isn't installed (a minimal Linux image): the pane's own process is still watched. */
async function childrenOf(pid: number): Promise<readonly number[]> {
  try {
    const result = await exec(["pgrep", "-P", String(pid)], { timeoutMs: 5_000 });
    return result.stdout
      .split("\n")
      .map(Number)
      .filter((child) => child > 0);
  } catch {
    return [];
  }
}

/** A process that exits between the check and the signal is the outcome wanted, not an error. */
function signalQuietly(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

async function survivors(pids: readonly number[], waitMs: number): Promise<readonly number[]> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const alive = pids.filter(isAlive);
    if (alive.length === 0 || Date.now() >= deadline) return alive;
    // oxlint-disable-next-line no-await-in-loop -- polling
    await Bun.sleep(50);
  }
}
