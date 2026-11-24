import type { AgentKind } from "@seance/shared";
import { claudeDriver } from "./agents/claude.ts";
import { closeCodex } from "./agents/codex.ts";
import type { AgentDriver } from "./agents/driver.ts";
import { DespawnFailure, type DespawnResult } from "./backend.ts";
import { noteClosing } from "./closing-panes.ts";
import { exec } from "./exec.ts";
import { PANE_ID } from "./pane-id.ts";
import { isRegistered, paneInfo, type PaneInfo } from "./sessions.ts";
import { tmux } from "./tmux.ts";

const DEFAULT_GRACE_MS = 5_000;

/** Each agent's close, by the pane's own start mark (`PaneInfo.agent`), never a field of the request. */
const CLOSES: Readonly<Record<AgentKind, AgentDriver["close"]>> = { claude: claudeDriver.close, codex: closeCodex };
/** How long a killed pane's processes get to exit on their own, and again after SIGTERM. */
const DEFAULT_REAP_WAIT_MS = 2_000;

export interface DespawnOptions {
  /** Kill straight away instead of asking claude to exit first. */
  readonly force: boolean;
  readonly graceMs?: number;
  readonly reapWaitMs?: number;
  /**
   * Awaited before this despawn acts on a task's pane, so a close of Séance's own never reads as
   * `vanished` (`exit-status.ts`): noted first, a harvest pass that lists the pane gone sees it.
   */
  readonly closing?: (taskId: string) => Promise<unknown>;
  /**
   * A task pane that dies during the graceful exit is left for harvest to note and close. For a process
   * without the ledger (`seance despawn`): the pane-died hook keeps the server's last pane dead, and
   * closing it here would take tmux down (`exit-empty`) with the recorded exit and the close mark.
   */
  readonly leaveDeadTask?: boolean;
}

/**
 * Ends one session: asks its agent to leave (`AgentDriver.close`: claude's `/exit`, the worktree prompt that
 * follows answered Keep), and kills the pane if it is still there when the grace runs out. The window only — the
 * worktree and its branch are reap's.
 */
export async function despawnSession(id: string, opts: DespawnOptions): Promise<DespawnResult> {
  if (!PANE_ID.test(id)) {
    throw new DespawnFailure("invalid_target", `"${id}" is not a session id — take one from the session list (%12)`);
  }
  const pane = await paneInfo(id);
  // The session list's own predicate: despawn reaches exactly what a list offered. The seat's round is never
  // a session (C10), and answers as a gone pane so nothing about it leaks.
  if (pane === null || pane.custodian || !isRegistered(pane)) {
    throw new DespawnFailure("session_not_found", `no session in pane ${id} — it may have exited already`);
  }
  if (pane.taskId !== null) await opts.closing?.(pane.taskId);
  // A dead pane's process already ended on its own: its session left as `exited`, so there is nothing to note.
  if (pane.pid !== null) noteClosing(pane.paneId, pane.pid);
  const leaveDead = opts.leaveDeadTask === true && pane.taskId !== null;
  return close(pane, opts.force, opts.graceMs, opts.reapWaitMs, leaveDead);
}

/**
 * Ends the custodian seat's round, the only close that reaches one: a graceful `/exit` for a round that registered,
 * a straight kill for one that never did (stuck on a dialog). Its own entry point, with no option a frame can set, so
 * no wire path can close a round and none can name another pane as one (DESIGN.md, "The custodian's seat").
 */
export async function despawnRound(
  id: string,
  opts: { readonly graceMs?: number; readonly reapWaitMs?: number } = {},
): Promise<DespawnResult> {
  if (!PANE_ID.test(id)) {
    throw new DespawnFailure("invalid_target", `"${id}" is not a session id — take one from the session list (%12)`);
  }
  const pane = await paneInfo(id);
  if (pane === null || !pane.custodian) {
    throw new DespawnFailure("session_not_found", `no session in pane ${id} — it may have exited already`);
  }
  return close(pane, !isRegistered(pane), opts.graceMs, opts.reapWaitMs, false);
}

async function close(
  pane: PaneInfo,
  force: boolean,
  graceMs: number | undefined,
  reapWaitMs: number | undefined,
  leaveDead: boolean,
): Promise<DespawnResult> {
  const window = pane.windowName;
  const agent = pane.agent === "claude" ? {} : { agent: pane.agent };
  if (!force && (await CLOSES[pane.agent](pane, { graceMs: graceMs ?? DEFAULT_GRACE_MS, leaveDead }))) {
    return { window, outcome: "exited", ...agent };
  }
  await killPane(pane.paneId, reapWaitMs ?? DEFAULT_REAP_WAIT_MS);
  return { window, outcome: "killed", ...agent };
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
