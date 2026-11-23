import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autonomyOf, DEFAULT_EFFORT, DEFAULT_MODEL, STANDING_INSTRUCTION } from "@seance/shared";
import { exclaveConfigFile, exclaveSettingsFile } from "../exclaves.ts";
import { classifyPane, paneInfo, type PaneInfo } from "../sessions.ts";
import { shq } from "../shq.ts";
import { tmux } from "../tmux.ts";
import { ensureAttachmentsTrusted, ensureRepoTrusted } from "../trust.ts";
import type { AgentDriver, AgentLaunch, CloseOptions, LaunchSpec } from "./driver.ts";
import { CLAUDE_PANES } from "./panes.ts";

/** Between keys: an ESC chased too closely by the next key reads as one Alt chord. */
export const KEY_GAP_MS = 150;
const POLL_MS = 100;

/**
 * Past these claude 2.1.310 stops a resume of a session this old and this big on a "Resume from
 * summary / full session" dialog no remote can answer (the typical OOM'd session). An initial
 * message, which a continuation always has, is what skips it; these are defence in depth.
 */
const RESUME_NEVER_ASKS = [
  "CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=99999999",
  "CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=99999999",
] as const;

/** Claude Code in a tmux pane: the agent every séance session ran before the seam, unchanged by it. */
export const claudeDriver: AgentDriver = {
  panes: CLAUDE_PANES,
  launch: launchClaude,
  close: (pane, opts) => exitGracefully(pane, opts),
};

async function launchClaude(spec: LaunchSpec): Promise<AgentLaunch> {
  // Answer claude's trust dialog before it can block the session (fails open — see trust.ts). Asked for the
  // directory claude starts in: the clone for a fresh worktree (`--worktree` makes it from there), else the cwd.
  const dir = spec.worktree?.clone ?? spec.cwd;
  const configFile = exclaveConfigFile(spec.home, spec.exclave);
  await ensureRepoTrusted(dir, configFile);
  await ensureAttachmentsTrusted(spec.readDirs, configFile);
  // Every task gets an id of the daemon's own, so a continuation can name the conversation it resumes.
  const session =
    spec.resume === undefined
      ? spec.request.taskId === undefined
        ? undefined
        : { id: crypto.randomUUID(), resume: false }
      : { id: spec.resume, resume: true };
  const allowBypass = await planAllowsBypass(spec);
  const base = claudeCommand(spec, session, allowBypass);
  const seedDir = spec.seed === undefined ? null : await writeSeed(spec.seed);
  return {
    dir,
    // Redirect, not an operand: an argv operand would be the expanded prompt in every local process list for the
    // session's whole life — the same text the audit log deliberately reduces to a length and a hash. claude takes
    // non-tty stdin as its opening prompt and reopens /dev/tty for the UI, so the pane stays interactive. `--`
    // still terminates option parsing, and on macOS `caffeinate -is` passes the fd through to claude unchanged.
    command: seedDir === null ? base : `${base} -- < ${shq(join(seedDir, SEED_FILE))}`,
    env: session?.resume === true ? RESUME_NEVER_ASKS : [],
    started: () => Promise.resolve(session?.id),
    // The shell opens the redirect before `exec`, so the unlink drops the name, never the fd claude is reading:
    // cleanup cannot race the read.
    dispose: async () => {
      if (seedDir !== null) await rm(seedDir, { recursive: true, force: true });
    },
  };
}

const SEED_FILE = "seed.txt";

async function writeSeed(seed: string): Promise<string> {
  const seedDir = await mkdtemp(join(tmpdir(), "seance-seed-"));
  await Bun.write(join(seedDir, SEED_FILE), seed);
  return seedDir;
}

/**
 * `session` is a `crypto.randomUUID()` this daemon made, or for a resume the one its ledger noted at that
 * launch — never a wire value (`continues` is a ledger key and never reaches the command line).
 */
function claudeCommand(
  spec: LaunchSpec,
  session: { readonly id: string; readonly resume: boolean } | undefined,
  allowBypass: boolean,
): string {
  const { request } = spec;
  const claude = process.env["SEANCE_CLAUDE_BIN"] ?? "claude";
  const level = autonomyOf(request);
  const caffeinate = process.platform === "darwin" ? "caffeinate -is " : "";
  // `exec` keeps the pane's process-group-leader pid on claude itself — a
  // forked child under a compound command leaves pane_current_command as the
  // shell, hiding the window from session detection.
  //
  // `--permission-mode` is omitted unless the caller asked for plan mode (`plan`, or the `steer`
  // level): passing one unconditionally would override whatever the machine's settings.json
  // chose, so by default the session inherits the same mode an in-terminal `claude` gets on that
  // box. `plan` is the one exception, and only ever a tightening the caller opted into: no
  // autonomy level loosens the mode (DESIGN.md, "Autonomy level").
  // Any mode flag drops bypass out of the shift+tab cycle unless it started there, so on a
  // machine whose own user settings default to bypass, plan adds `--allow-dangerously-skip-permissions`
  // to keep it reachable — nothing an unflagged spawn there doesn't already start in.
  //
  // `--remote-control [name]` takes an optional value, so it sits before the
  // other flags: trailing, it swallowed a here-mode seed prompt as the session
  // name and the session started idle. The seed is off argv entirely now (see
  // `launchClaude`), so `--` guards nothing today — it stays as the standing terminator
  // for whatever lands at the tail next. It is also the pane's mark (`CLAUDE_PANES.startMark`).
  // `--add-dir <directories...>` is variadic, so it sits directly before `--model`, which ends it.
  // Daemon paths, never wire values, quoted like every path.
  const addDirs = spec.readDirs.map((dir) => `--add-dir ${shq(dir)} `).join("");
  return (
    `exec ${caffeinate}${claude} -n ${shq(spec.name)} --remote-control ${addDirs}` +
    `--model ${shq(request.model ?? DEFAULT_MODEL)} --effort ${shq(request.effort ?? DEFAULT_EFFORT)}` +
    // A constant, never wire text (docs/messaging.md, the standing instruction's second layer); only a task's
    // session is addressable, so an untracked spawn's command line stays byte-identical.
    `${request.taskId === undefined ? "" : ` --append-system-prompt ${shq(STANDING_INSTRUCTION)}`}` +
    // literal value, so nothing wire-supplied reaches the command line — no shq() needed
    `${level === "steer" ? " --permission-mode plan" : ""}` +
    `${level === "steer" && allowBypass ? " --allow-dangerously-skip-permissions" : ""}` +
    `${spec.worktree === undefined ? "" : ` --worktree ${shq(spec.worktree.name)}`}` +
    // `--resume <id>`, not `--continue`: claude files a `--worktree` session under the project it started
    // in, which may be the clone's, and `--continue` looks only in the cwd's (DESIGN.md, "Continuing a session").
    `${session === undefined ? "" : ` ${session.resume ? "--resume" : "--session-id"} ${shq(session.id)}`}`
  );
}

/**
 * Whether the exclave's user settings.json defaults to `bypassPermissions`. Read per spawn, uncached;
 * anything unreadable or misshapen answers false — the flag fails closed, the spawn never fails on it.
 * Managed/policy settings are not read: claude itself refuses bypass when policy disables it, so the flag
 * cannot override one. A settings.json that is a FIFO or huge is the machine owner's own doing.
 * User settings only: a repo's `.claude/settings.json` is whoever committed it, so it unlocks nothing.
 */
async function userDefaultsToBypass(home: string, exclave: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(exclaveSettingsFile(home, exclave), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("permissions" in parsed)) return false;
    const { permissions } = parsed;
    if (typeof permissions !== "object" || permissions === null || !("defaultMode" in permissions)) return false;
    return permissions.defaultMode === "bypassPermissions";
  } catch {
    return false;
  }
}

/** Only a plan (`steer`) spawn reads settings, so every other command line stays byte-identical. */
async function planAllowsBypass(spec: LaunchSpec): Promise<boolean> {
  return autonomyOf(spec.request) === "steer" && (await userDefaultsToBypass(spec.home, spec.exclave));
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

/**
 * Asks claude to `/exit` and answers the worktree prompt that follows with Keep. True once the pane is gone;
 * false when it outlived the grace.
 */
async function exitGracefully(pane: PaneInfo, { graceMs, leaveDead }: CloseOptions): Promise<boolean> {
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
    if (state === "dead" && leaveDead) return true;
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
