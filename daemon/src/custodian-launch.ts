import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CustodianConfig } from "./config.ts";
import { roundSeed, NOTES_MAX } from "./custodian-agent.ts";
import { custodianFence, procSysReadOnly } from "./custodian-fence.ts";
import { PANE_ID } from "./pane-id.ts";
import { resolvedBun, resolvedMain } from "./link.ts";
import { ROUND_TMP, ROUND_TMP_PREFIX } from "./seat-record.ts";
import { DEFAULT_EXCLAVE, type Exclave } from "./exclaves.ts";
import { exec } from "./exec.ts";
import { log } from "./log.ts";
import { custodianDir, custodianNotesPath, runDir } from "./paths.ts";
import { sessionName, shq } from "./spawn.ts";
import {
  CUSTODIAN_FIELD,
  CUSTODIAN_OPTION,
  FIELD_SEP,
  listAllPanes,
  resolveTargetSession,
  tmux,
  tmuxOk,
} from "./tmux.ts";

/** The tmux side of the custodian's round (DESIGN.md, "The custodian's seat"; the tmp dir's shape is in `seat-record.ts`). */

/**
 * Where an exclave's round runs: the exclave is decided by the window shell's `$PWD` (the owner's hook picks
 * `CLAUDE_CONFIG_DIR` from it; the daemon never sets one, DESIGN.md "Exclaves"), so each gets its own dir. `default`
 * takes one under the state dir, outside every named root.
 */
export function roundDirFor(exclave: Exclave): string {
  return exclave.id === DEFAULT_EXCLAVE ? join(custodianDir(), "cwd") : join(exclave.root, ".seance-custodian");
}

/**
 * Creates the round dir (0700) and returns its real path: exclave roots are canonical and trust keys are absolute
 * paths. The caller has checked the exclave's root exists, so this never invents one.
 */
export async function ensureRoundDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return realpath(dir);
}

/** Whether an exclave's root is a directory: a root is never invented, so one that is not makes the exclave ineligible. */
export function exclaveRootExists(root: string): Promise<boolean> {
  return stat(root).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/**
 * Whether anything outside the round could have planted settings or an agent in the round dir:
 * `--setting-sources project` still loads a project `settings.json`, and a project agent of the same name may outrank
 * `--agents` (precedence unverified). Only a same-uid process outside the round can write there — the round's shell
 * cannot write its cwd — and `.claude/` itself is Claude Code's own (it writes there), so only these two count.
 */
export async function roundDirPlanted(dir: string): Promise<boolean> {
  const exists = (path: string): Promise<boolean> =>
    stat(path).then(
      () => true,
      () => false,
    );
  const [settings, agents] = await Promise.all([
    exists(join(dir, ".claude", "settings.json")),
    exists(join(dir, ".claude", "agents")),
  ]);
  return settings || agents;
}

/** The round's panes, found by `@seance-custodian`: live or dead, once each (grouped sessions repeat panes). */
export async function listRoundPanes(): Promise<readonly { readonly pane: string; readonly dead: boolean }[]> {
  const raw = await listAllPanes(["#{pane_id}", "#{pane_dead}", CUSTODIAN_FIELD].join(FIELD_SEP));
  const seen = new Set<string>();
  const panes: { pane: string; dead: boolean }[] = [];
  for (const line of raw.split("\n")) {
    const [pane, dead, custodian] = line.split(FIELD_SEP);
    if (pane === undefined || custodian !== "1" || !PANE_ID.test(pane) || seen.has(pane)) continue;
    seen.add(pane);
    panes.push({ pane, dead: dead === "1" });
  }
  return panes;
}

/**
 * Pid → pane for every live pane carrying `@seance-custodian`: what the `custodian` frame binds a peer against.
 * `listRoundPanes` has no pid, and `parsePanePids` skips round panes on purpose, so the one reader that wants them
 * is this. Throws when tmux cannot be read: an unreadable list must not read as "no round pane".
 */
export async function listRoundPanePids(): Promise<ReadonlyMap<number, string>> {
  const raw = await listAllPanes(["#{pane_id}", "#{pane_pid}", "#{pane_dead}", CUSTODIAN_FIELD].join(FIELD_SEP));
  const panes = new Map<number, string>();
  for (const line of raw.split("\n")) {
    const [pane, pid, dead, custodian] = line.split(FIELD_SEP);
    if (pane === undefined || pid === undefined || custodian !== "1" || dead === "1" || !PANE_ID.test(pane)) continue;
    if (!/^[1-9]\d{0,9}$/u.test(pid)) continue;
    panes.set(Number(pid), pane);
  }
  return panes;
}

/** Removes a round's tmp dir, and only that: the name must match, and it must be a real directory, not a symlink. */
export async function removeRoundTmp(path: string): Promise<void> {
  if (!ROUND_TMP.test(path)) return;
  const info = await lstat(path).catch(() => null);
  if (info === null || !info.isDirectory()) return;
  await rm(path, { recursive: true, force: true });
}

/**
 * The notes file's text for the seed (C37), null when there is none. Over `NOTES_MAX` it is not carried: one line
 * says its size, never its content.
 */
export async function readNotes(path: string = custodianNotesPath()): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(text) > NOTES_MAX) {
    log.warn(`custodian notes are ${Buffer.byteLength(text)} bytes, over the ${NOTES_MAX} the seed carries — not read`);
    return null;
  }
  return text;
}

const NO_BWRAP = "bwrap and socat must be on PATH (apt install bubblewrap socat)";
const BWRAP_BLOCKED =
  "bwrap cannot create a sandbox on this host (e.g. AppArmor's apparmor_restrict_unprivileged_userns)";
const BWRAP_PROBE_MS = 5_000;

/**
 * Why this host cannot sandbox a round, null when it can. Linux needs `bubblewrap` and `socat` (without them
 * `failIfUnavailable` refuses to start), and a host that forbids unprivileged user namespaces fails every command: one
 * real probe through the daemon's exec path (argv array, bare env, output never read or logged) approximates Claude
 * Code's own bwrap call. macOS has its own sandbox; other platforms never get here.
 */
export async function sandboxProblem(platform: "darwin" | "linux"): Promise<string | null> {
  if (platform === "darwin") return null;
  const bwrap = Bun.which("bwrap");
  if (bwrap === null || Bun.which("socat") === null) return NO_BWRAP;
  try {
    const probe = await exec(
      [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-user", "--unshare-pid", "true"],
      { timeoutMs: BWRAP_PROBE_MS, bareEnv: true, discardStdout: true, discardStderr: true, killGroup: true },
    );
    return probe.exitCode === 0 ? null : BWRAP_BLOCKED;
  } catch {
    return BWRAP_BLOCKED;
  }
}

/** Linux's `allowAllUnixSockets` needs `enableWeakerNestedSandbox` only where `/proc/sys` is read-only (a container). */
export async function weakerNestedNeeded(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    return procSysReadOnly(await readFile("/proc/self/mountinfo", "utf8"));
  } catch {
    return false;
  }
}

export interface LaunchOptions {
  readonly exclave: Exclave;
  /** The exclave's round dir, already created and real (`ensureRoundDir`). */
  readonly roundDir: string;
  readonly settings: CustodianConfig;
  /** The `--agents` JSON (`loadAgent`). */
  readonly agents: string;
  readonly notes: string | null;
  readonly tmuxSession: string;
  readonly machineTag?: string;
  readonly weakerNested: boolean;
  readonly platform: "darwin" | "linux";
  /** Awaited once the tmp dir exists and before any window does: the seat's write-ahead record. */
  readonly onTmp?: (tmpDir: string) => Promise<void>;
}

/**
 * Starts one round in tmux window `custodian` and tags its pane. Every value in the inner command goes through
 * `shq` (it is the second shell string the daemon builds, after spawn's); the fence and the seed are files in the
 * round's own 0700 tmp dir, which keeps a ~6 KB JSON off argv and out of `ps`. Neither is writable from the round's
 * sandbox, which writes only `<tmp>/claude-<uid>`. On any failure after the tmp dir exists it is removed.
 */
export async function launchRound(o: LaunchOptions): Promise<{ readonly pane: string; readonly tmpDir: string }> {
  const tmpDir = await mkdtemp(ROUND_TMP_PREFIX);
  try {
    await o.onTmp?.(tmpDir);
    const target = await resolveTargetSession(o.tmuxSession);
    const socket = (await tmuxOk(["display-message", "-p", "-t", `${target}:`, "#{socket_path}"])).trim();
    const fence = custodianFence({
      platform: o.platform,
      roundDir: o.roundDir,
      socketDirs: [dirname(socket), runDir()],
      weakerNested: o.weakerNested,
    });
    const fencePath = join(tmpDir, "fence.json");
    const seedPath = join(tmpDir, "seed.txt");
    await Promise.all([
      writeFile(fencePath, JSON.stringify(fence), { mode: 0o600 }),
      writeFile(seedPath, roundSeed(o.notes), { mode: 0o600 }),
    ]);
    // The fence allows `Bash(seanced custodian *)` by name, and nothing guarantees the tmux server's PATH holds a
    // `seanced` of this checkout (linking is opt-in and nothing re-points it on a pull): the round gets its own, first
    // on PATH, running this process's main. Like the fence, it is not writable from the round's sandbox.
    const binDir = join(tmpDir, "bin");
    await mkdir(binDir, { mode: 0o700 });
    await writeFile(
      join(binDir, "seanced"),
      `#!/bin/sh\nexec ${shq(resolvedBun())} ${shq(await resolvedMain())} "$@"\n`,
      {
        mode: 0o700,
      },
    );
    const claude = process.env["SEANCE_CLAUDE_BIN"] ?? "claude";
    const caffeinate = o.platform === "darwin" ? "caffeinate -is " : "";
    const command =
      `export CLAUDE_CODE_TMPDIR=${shq(tmpDir)} CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 PATH=${shq(binDir)}:"$PATH"; ` +
      `exec ${caffeinate}${claude} -n ${shq(sessionName("custodian", o.machineTag))} --remote-control ` +
      `--agents ${shq(o.agents)} --agent custodian --settings ${shq(fencePath)} --setting-sources project ` +
      `--permission-mode dontAsk --strict-mcp-config --model ${shq(o.settings.model)} --effort ${shq(o.settings.effort)} ` +
      `-- < ${shq(seedPath)}`;
    // Detached: a round every quarter hour must not take the owner's attached terminal's focus.
    const windowId = (
      await tmuxOk([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "-t",
        `${target}:`,
        "-c",
        o.roundDir,
        "-n",
        "custodian",
        command,
      ])
    ).trim();
    const pane = (await tmuxOk(["display-message", "-p", "-t", windowId, "#{pane_id}"])).trim();
    // Left open, as `tagTask`'s is: a daemon that dies between `new-window` and this leaves an untitled, untasked
    // pane no reader acts on, which the owner can despawn.
    const tagged = PANE_ID.test(pane)
      ? await tmux(["set-option", "-p", "-t", pane, CUSTODIAN_OPTION, "1"])
      : { exitCode: 1, stderr: "no pane id" };
    if (tagged.exitCode !== 0) {
      await tmux(["kill-window", "-t", windowId]);
      throw new Error(`could not mark the round's pane: ${tagged.stderr.trim()}`);
    }
    return { pane, tmpDir };
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
}
