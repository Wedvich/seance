import { homedir } from "node:os";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { CLI_NAME } from "./commands.ts";
import type { CustodianConfig } from "./config.ts";
import { roundSeed, NOTES_MAX } from "./custodian-agent.ts";
import { custodianFence, procSysReadOnly, type ReadDeny } from "./custodian-fence.ts";
import { vsockFilter } from "./custodian-seccomp.ts";
import { LaunchRefused } from "./custodian-seat.ts";
import { PANE_ID } from "./pane-id.ts";
import { resolvedBun, resolvedMain } from "./link.ts";
import { ROUND_TMP, ROUND_TMP_PREFIX } from "./seat-record.ts";
import { DEFAULT_EXCLAVE, type Exclave } from "./exclaves.ts";
import { exec } from "./exec.ts";
import { log } from "./log.ts";
import {
  configDir,
  custodianDir,
  custodianNotesPath,
  custodianSessionsPath,
  pskBlobPathIn,
  stateDir,
} from "./paths.ts";
import { sessionName, shq } from "./spawn.ts";
import { loginName } from "./usage-refresh.ts";
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
 * Where an exclave's round runs: each exclave gets its own dir, and the launch sets that exclave's `CLAUDE_CONFIG_DIR`
 * itself (`roundEnv`; a spawn's window shell has the owner's hook pick it from `$PWD`, but a round runs under a built
 * env). `default` takes one under the state dir, outside every named root.
 */
export function roundDirFor(exclave: Exclave): string {
  return exclave.id === DEFAULT_EXCLAVE ? join(custodianDir(), "cwd") : join(exclave.root, ".seance-custodian");
}

/**
 * Claude Code 2.1.325's write-protected names, read from the binary; a snapshot, not a contract — a name a later release
 * adds fails the round at start (bwrap cannot create a mount point in a read-only dir). The round dir is read-only
 * inside the sandbox and bound back over a masked `$HOME`, so each name must already exist there or bwrap fails before
 * any command runs (Linux spike, "Inverted form").
 */
export const PROTECTED_NAMES = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".bash_login",
  ".bash_aliases",
  ".bash_logout",
  ".envrc",
  ".ripgreprc",
  ".mcp.json",
  ".claude.json",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".pnpmfile.cjs",
  "bunfig.toml",
  ".bunfig.toml",
  ".bazelrc",
  ".bazelversion",
  ".bazeliskrc",
  ".pre-commit-config.yaml",
  "lefthook.yml",
  ".lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yaml",
  "gradle-wrapper.properties",
  "maven-wrapper.properties",
  ".devcontainer.json",
  "pyrightconfig.json",
] as const;
export const PROTECTED_DIRS = [".vscode", ".idea"] as const;

/** The protected files a tool parses as JSON: an empty file would fail it, so they hold an empty object. */
const JSON_NAMES: ReadonlySet<string> = new Set([
  ".mcp.json",
  ".claude.json",
  ".devcontainer.json",
  "pyrightconfig.json",
]);

/**
 * Creates the round dir (0700) with the protected names in it, and returns its real path: exclave roots are canonical
 * and trust keys are absolute paths. The caller has checked the exclave's root exists, so this never invents one.
 * Nothing goes under `.claude/`: `roundDirPlanted` reads settings or agents there, or a symlink or hardlink anywhere in
 * the dir, as a plant. A file is made with `wx`, which neither follows nor replaces a symlink, so a name something else
 * holds is left as it is.
 */
export async function ensureRoundDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const real = await realpath(dir);
  await Promise.all([
    ...PROTECTED_NAMES.map(async (name) => {
      try {
        const handle = await open(join(real, name), "wx", 0o600);
        try {
          if (JSON_NAMES.has(name)) await handle.writeFile("{}\n");
        } finally {
          await handle.close();
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }),
    ...PROTECTED_DIRS.map((name) =>
      mkdir(join(real, name), { mode: 0o700 }).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }),
    ),
  ]);
  return real;
}

/** Whether an exclave's root is a directory: a root is never invented, so one that is not makes the exclave ineligible. */
export function exclaveRootExists(root: string): Promise<boolean> {
  return stat(root).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/**
 * Whether anything outside the round could have planted settings, an agent or a link in the round dir:
 * `--setting-sources project` still loads a project `settings.json`, and a project agent of the same name may outrank
 * `--agents` (precedence unverified). Only a same-uid process outside the round can write there — the round's shell
 * cannot write its cwd — and `.claude/` itself is Claude Code's own (it writes there), so only these count. Checked
 * when the round is picked, not while it runs: a plant after the pick is a same-uid process that could already read
 * what it would point at (DESIGN.md records the bound).
 */
export async function roundDirPlanted(dir: string): Promise<boolean> {
  const exists = (path: string): Promise<boolean> =>
    stat(path).then(
      () => true,
      () => false,
    );
  const [settings, agents, linked] = await Promise.all([
    exists(join(dir, ".claude", "settings.json")),
    exists(join(dir, ".claude", "agents")),
    holdsLink(dir),
  ]);
  return settings || agents || linked;
}

/** Entries `holdsLink` looks at before it stops reading and refuses: a round dir holds a few dozen at most. */
const LINK_WALK_MAX = 5_000;
const LINK_WALK_DEPTH = 4;

/**
 * Whether anything under the round dir is a symlink or a hardlinked file (`nlink > 1`). The Read tool may read the whole
 * tree, and a rule that matches the requested path, not its target, would follow a link planted there (by a same-uid
 * process outside the round) to any file that uid reads; a hardlink is a regular file, so only its link count shows it.
 * The daemon creates none, and Claude Code writes no links, so one is a plant. A tree too big or deep to walk is refused.
 */
async function holdsLink(dir: string): Promise<boolean> {
  let seen = 0;
  const walk = async (path: string, depth: number): Promise<boolean> => {
    const names = await readdir(path).catch(() => [] as string[]);
    seen += names.length;
    if (seen > LINK_WALK_MAX) return true;
    const infos = await Promise.all(names.map((name) => lstat(join(path, name)).catch(() => null)));
    for (const [at, info] of infos.entries()) {
      if (info === null) continue;
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) return true;
      if (!info.isDirectory()) continue;
      if (depth >= LINK_WALK_DEPTH) return true;
      // oxlint-disable-next-line no-await-in-loop -- bounded by `LINK_WALK_MAX`, and the first hit ends the walk
      if (await walk(join(path, names[at] ?? ""), depth + 1)) return true;
    }
    return false;
  };
  return walk(dir, 0);
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
const BWRAP_NESTED_BLOCKED =
  "bwrap cannot run inside another bwrap on this host (e.g. AppArmor's bwrap-userns-restrict, as on Ubuntu 24.04), and a round runs Claude Code's bwrap inside the vsock filter's";
const BWRAP_PROBE_MS = 5_000;

/**
 * Why this host cannot sandbox a round, null when it can. Linux needs `bubblewrap` and `socat` (without them
 * `failIfUnavailable` refuses to start), and a host that forbids unprivileged user namespaces fails every command: one
 * real probe through the daemon's exec path (argv array, bare env, output never read or logged) approximates Claude
 * Code's own bwrap call. The same probe runs again inside an outer bwrap, as the vsock filter's wraps Claude Code's in
 * both of bwrap's modes: an AppArmor profile can allow `/usr/bin/bwrap` a user namespace only when it is not nested
 * (Ubuntu 24.04's `bwrap-userns-restrict`), and such a host would fail every round's start rather than be refused.
 * macOS has its own sandbox; other platforms never get here.
 */
export async function sandboxProblem(platform: "darwin" | "linux"): Promise<string | null> {
  if (platform === "darwin") return null;
  const bwrap = Bun.which("bwrap");
  if (bwrap === null || Bun.which("socat") === null) return NO_BWRAP;
  const inner = [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-user", "--unshare-pid", "true"];
  if (!(await bwrapProbe(inner))) return BWRAP_BLOCKED;
  return (await bwrapProbe([bwrap, "--dev-bind", "/", "/", "--", ...inner])) ? null : BWRAP_NESTED_BLOCKED;
}

async function bwrapProbe(argv: readonly string[]): Promise<boolean> {
  try {
    const probe = await exec(argv, {
      timeoutMs: BWRAP_PROBE_MS,
      bareEnv: true,
      discardStdout: true,
      discardStderr: true,
      killGroup: true,
    });
    return probe.exitCode === 0;
  } catch {
    return false;
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

/** Top-level entries of `/` that stay readable on Linux: the system tree a command needs to run at all. */
export const LINUX_SYSTEM_DIRS = [
  "usr",
  "bin",
  "sbin",
  "lib",
  "lib32",
  "lib64",
  "libx32",
  "etc",
  "proc",
  "dev",
  "sys",
] as const;

/**
 * macOS masks that are not spiked (the macOS spike masked `$HOME` only), kept apart so that one that breaks a round's
 * start can be narrowed or dropped, with the reason recorded, in one place. Homebrew's bun under `/opt/homebrew` comes
 * back through `allowRead`. `/Users` is `$HOME`'s generalisation: other users' homes and `/Users/Shared`.
 */
export const DARWIN_EXTRA_MASKS = [
  "/Users",
  "/opt",
  "/usr/local",
  "/private/tmp",
  "/private/var/folders",
  // World-writable, where other tools drop session files and tokens; not a root the round or Claude Code uses.
  "/private/var/tmp",
  "/Library/Keychains",
  "/Volumes",
];

/**
 * macOS's Data volume holds `/Users`, `/opt`, `/usr/local` and `/private/*` and firmlinks them into `/`. Whether
 * Seatbelt's subpath rule also matches a path opened through the volume's own mount point is not shown by any spike
 * (`realpath` answers the short form for every such path, which suggests the kernel does too), so every mask and every
 * re-allow is also written under that prefix (`withDataVolume`; the drill's E2 tries the aliases). Both sides, so an
 * allow entry (bun under `/opt/homebrew`) wins over its mask in each form, whichever form Seatbelt matches.
 */
export const DARWIN_DATA_VOLUME = "/System/Volumes/Data";

/** One top-level entry of `/` with where it really lives (a symlink such as `/bin` resolves under `/usr`). */
export interface RootEntry {
  readonly name: string;
  readonly real: string;
}

const isUnder = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** Drops every entry nested under another of the same list (and repeats), keeping the order of the rest. */
export function dedupeNested(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (paths.some((other) => other !== path && isUnder(path, other))) continue;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * What the round's bun and `seance` need to run inside the mask: bun's own dirs (as found and as resolved) and the
 * parts of the checkout the CLI's import closure loads (`daemon/`, `shared/`, `node_modules/` and the configs bun
 * reads). Never the whole checkout: `relay/.dev.vars` holds the relay's bearer token.
 */
export function toolchainAllow(t: Pick<RoundToolchain, "bun" | "bunReal" | "checkout">): string[] {
  return [
    dirname(t.bun),
    dirname(t.bunReal),
    join(t.checkout, "daemon"),
    join(t.checkout, "shared"),
    join(t.checkout, "node_modules"),
    join(t.checkout, "package.json"),
    join(t.checkout, "tsconfig.json"),
    join(t.checkout, "tsconfig.base.json"),
  ];
}

export interface RoundToolchain {
  readonly bun: string;
  readonly bunReal: string;
  /** Bun's real file is a script, or is not named `bun*`: a version manager's shim, not the binary. */
  readonly bunShim: boolean;
  readonly main: string;
  /** `main` is `<checkout>/daemon/src/main.ts`. */
  readonly checkout: string;
}

/** A version manager's shim is a script, or a link to the manager's own binary: neither is bun's executable. */
async function isShim(bunReal: string): Promise<boolean> {
  if (!basename(bunReal).toLowerCase().startsWith("bun")) return true;
  const handle = await open(bunReal, "r").catch(() => null);
  if (handle === null) return false;
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await handle.read(head, 0, 2, 0);
    return bytesRead === 2 && head.toString("latin1") === "#!";
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

export async function roundToolchain(): Promise<RoundToolchain> {
  const bun = resolvedBun();
  const bunReal = await realpath(bun).catch(() => bun);
  const main = await resolvedMain();
  return { bun, bunReal, bunShim: await isShim(bunReal), main, checkout: dirname(dirname(dirname(main))) };
}

/** The inputs of the masks, shared by the fence, the launch-time check and the seat's and doctor's earlier one. */
export interface MaskInputs {
  readonly platform: "darwin" | "linux";
  readonly home: string;
  readonly state: string;
  readonly config: string;
  readonly tmuxSocketDir: string;
  /** The machine's own roots (`extraMasks`: repo roots, exclave roots, the checkout). */
  readonly extraMasks: readonly string[];
  readonly rootEntries: readonly RootEntry[];
}

/** Each path also under the Data volume's mount point, on macOS (`DARWIN_DATA_VOLUME`); the paths alone elsewhere. */
export function withDataVolume(platform: "darwin" | "linux", paths: readonly string[]): string[] {
  return platform === "darwin" ? [...paths, ...paths.map((path) => `${DARWIN_DATA_VOLUME}${path}`)] : [...paths];
}

/**
 * Every path the round's sandbox masks, not deduplicated: the one list `roundSandboxPaths` writes (nested entries
 * dropped) and `toolchainProblem` guards (an allow entry that equals or contains any of these re-opens it, and a path a
 * dedupe drops as nested, such as the checkout under the home, still counts).
 *
 * Linux inverts the tree: every top-level entry of `/` but the system dirs is masked (a bwrap tmpfs, so a `connect()`
 * gets ENOENT), which covers `/home`, `/var` (LXD's, snap's and docker's sockets), `/tmp`, `/run`, `/mnt`, `/opt`,
 * `/nix` and anything unknown, and a symlinked entry is judged by where it lands. macOS has no tree to invert in srt, so
 * it names its roots; unix sockets there are bounded by `allowUnixSockets` alone, not by a read mask. Both add the
 * machine's own paths.
 */
export function sandboxMasks(o: MaskInputs): string[] {
  const system = LINUX_SYSTEM_DIRS.map((name) => `/${name}`);
  const root =
    o.platform === "linux"
      ? o.rootEntries.filter((entry) => !system.some((dir) => isUnder(entry.real, dir))).map((entry) => entry.real)
      : DARWIN_EXTRA_MASKS;
  return withDataVolume(o.platform, [...root, o.home, o.state, o.config, o.tmuxSocketDir, ...o.extraMasks]);
}

/**
 * Why the round's `seance` would not run under the mask, or would undo it, null when it is safe to start (decision 7:
 * fail closed, audited as `toolchain`). Refused:
 * - a `main.ts` outside the parts of the checkout `allowRead` re-adds (`toolchainAllow`), which holds only when it is
 *   `<checkout>/daemon/src/main.ts`; an unreadable `main.ts` is not a clean failure — bun execs the unreadable script
 *   again and again — so the seat refuses rather than launch it (and the shim guards the same at run time);
 * - a bun that is a shim, not the binary (`bunShim`): it execs a bun somewhere under the masked home, outside every
 *   allow entry, so each round would fail with no cause;
 * - an allow entry that is, or contains, a masked path (`masks`, from `sandboxMasks`: the home, state, config, tmux
 *   socket dir, repo and exclave roots, the checkout and the system roots). srt lets an allow beat a deny, so a bun
 *   installed as `~/bun` would re-open the whole home, and one at `<checkout>/bun` the relay's `.dev.vars`.
 */
export function toolchainProblem(t: RoundToolchain, masks: readonly string[]): string | null {
  const allow = toolchainAllow(t);
  if (!allow.some((dir) => isUnder(t.main, dir))) {
    return "the daemon's checkout is not laid out as the round's sandbox expects (daemon/src/main.ts)";
  }
  if (t.bunShim) {
    return `bun resolves to ${basename(t.bunReal)}, a shim and not the bun binary (a version manager?) — put the real bun first on PATH`;
  }
  const broad = allow.find((dir) => masks.some((path) => isUnder(path, dir)));
  if (broad !== undefined) {
    return `bun or the checkout sits in ${broad}, which holds paths the round must not read — install bun in a directory of its own`;
  }
  return null;
}

/** The tmux socket's dir as the daemon's own tmux calls would find it, before any server is asked: the seat's and doctor's guess. */
function expectedTmuxDir(): string {
  const socket = process.env["SEANCE_TMUX_SOCKET"];
  if (socket !== undefined && socket !== "") return dirname(socket);
  return join(process.env["TMUX_TMPDIR"] ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`);
}

/**
 * `toolchainProblem` against the masks this machine's rounds would get, for the seat's start and `seance doctor`
 * (before any round, so the tmux dir is the expected one; `launchRound` re-checks with the real one). Paths are
 * realpath'd as the launch does, so both read the same list.
 */
export async function toolchainRefusal(
  platform: "darwin" | "linux",
  rootMasks: readonly string[],
): Promise<string | null> {
  const toolchain = await roundToolchain();
  const real = (path: string): Promise<string> => realpath(path).catch(() => path);
  return toolchainProblem(
    toolchain,
    sandboxMasks({
      platform,
      home: await real(homedir()),
      state: await real(stateDir()),
      config: await real(configDir()),
      tmuxSocketDir: await real(expectedTmuxDir()),
      extraMasks: [...rootMasks, toolchain.checkout],
      rootEntries: platform === "linux" ? await rootEntriesOf() : [],
    }),
  );
}

/**
 * What the round's sandbox masks and re-allows (docs/custodian.md item 4b), as paths that may not exist yet
 * (`existingPaths` filters before the fence is written): `denyRead` is `sandboxMasks` with nested entries dropped,
 * `guarded` the same masks before that, and `allowRead` the round's own dirs and the read-only toolchain, in every
 * form `denyRead` is, so an allow beats its mask whichever form a path is opened through.
 */
export function roundSandboxPaths(
  o: MaskInputs & {
    readonly roundDir: string;
    readonly tmpDir: string;
    readonly socketDir: string;
    readonly toolchain: Pick<RoundToolchain, "bun" | "bunReal" | "checkout">;
  },
): { readonly denyRead: string[]; readonly allowRead: string[]; readonly guarded: string[] } {
  const guarded = sandboxMasks(o);
  return {
    denyRead: dedupeNested(guarded),
    allowRead: dedupeNested(
      withDataVolume(o.platform, [o.roundDir, o.tmpDir, o.socketDir, ...toolchainAllow(o.toolchain)]),
    ),
    guarded,
  };
}

/**
 * Secrets the Read tool is denied too (it runs outside the sandbox, so `denyRead` does not stop it; the narrowed allow
 * is the real bound and these are the guard behind it). No `stateDir` dir deny: the default exclave's round dir is under
 * it, and a deny beats an allow. The round's tmp dir is denied because its `claude-<uid>` is the one place the sandboxed
 * Bash can write and Claude Code auto-allows Read of its internal paths there, so a planted link would be read.
 */
export function roundReadDenies(o: {
  readonly platform: "darwin" | "linux";
  readonly home: string;
  readonly state: string;
  readonly config: string;
  /** The tmp dir as the round's `TMPDIR` names it and as it resolves (`/tmp/…` and `/private/tmp/…` on macOS). */
  readonly tmpDirs: readonly string[];
  /**
   * The flags file (`custodian-flags.ts`) as named and as it resolves: its notes quote untrusted pane text, which a
   * later round must not read back (the `sessions` reply leaves them out for the same reason). The state-dir mask
   * already hides it from the sandbox; this keeps it from the Read tool too.
   */
  readonly flagsPaths: readonly string[];
  readonly exclave: Pick<Exclave, "id" | "configDir">;
}): ReadDeny[] {
  const file = (path: string): ReadDeny => ({ path, dir: false });
  const dir = (path: string): ReadDeny => ({ path, dir: true });
  return [
    file(join(o.state, "state.json")),
    file(pskBlobPathIn(o.state)),
    dir(o.config),
    dir(join(o.home, ".ssh")),
    dir(join(o.home, ".gnupg")),
    dir(join(o.home, ".config", "gh")),
    dir(join(o.home, ".aws")),
    dir(join(o.home, ".config", "gcloud")),
    dir(join(o.home, ".docker")),
    file(join(o.home, ".netrc")),
    file(join(o.home, ".npmrc")),
    file(join(o.exclave.configDir, ".credentials.json")),
    // Every task session's transcript, prompts included: Claude Code may auto-allow its own config dir's internals.
    dir(join(o.exclave.configDir, "projects")),
    ...(o.exclave.id === DEFAULT_EXCLAVE ? [] : [file(join(o.home, ".claude", ".credentials.json"))]),
    ...(o.platform === "darwin" ? [dir(join(o.home, "Library", "Keychains"))] : []),
    ...[...new Set(o.tmpDirs)].map(dir),
    ...[...new Set(o.flagsPaths)].map(file),
  ];
}

/**
 * The round's `seance` shim. The `-r` guard is load-bearing: bun execs an unreadable executable script (`main.ts` is
 * mode 755 with a `#!/usr/bin/env bun` shebang) and the result is an unbounded fork storm (macOS spike Q7: 66
 * processes in 3 s), so a main the sandbox cannot read must stop here.
 */
export function seanceShim(bun: string, main: string): string {
  return `#!/bin/sh\n[ -r ${shq(main)} ] || { echo ${shq(`seance: ${main} is not readable in this sandbox`)} >&2; exit 2; }\nexec ${shq(bun)} ${shq(main)} "$@"\n`;
}

/**
 * The round's whole environment, built, never inherited: srt and Claude Code strip nothing, so `SSH_AUTH_SOCK`,
 * `GH_TOKEN` and `GPG_*` would arrive unchanged. `HOME`, the login name (Claude Code's macOS keychain lookup needs it,
 * `usageEnv`), a fixed shell, the round's tmp dir as both `TMPDIR` (srt's proxy bridge sockets are made there, and the
 * `/tmp` mask hides them otherwise) and `CLAUDE_CODE_TMPDIR`, the round's socket, and `CLAUDE_CONFIG_DIR` for a named
 * exclave: the daemon picked the exclave, so it says which.
 */
export function roundEnv(o: {
  readonly home: string;
  readonly user: string | null;
  readonly tmpDir: string;
  readonly socket: string;
  readonly exclave: Pick<Exclave, "id" | "configDir">;
}): (readonly [string, string])[] {
  const env: (readonly [string, string])[] = [["HOME", o.home]];
  if (o.user !== null) env.push(["USER", o.user], ["LOGNAME", o.user]);
  env.push(
    ["SHELL", "/bin/bash"],
    ["TMPDIR", o.tmpDir],
    ["CLAUDE_CODE_TMPDIR", o.tmpDir],
    ["CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"],
    ["SEANCE_CUSTODIAN_SOCKET", o.socket],
  );
  if (o.exclave.id !== DEFAULT_EXCLAVE) env.push(["CLAUDE_CONFIG_DIR", o.exclave.configDir]);
  return env;
}

/**
 * Passed through from the tmux server's env when set: Claude Code itself (outside the sandbox) may need a proxy, and
 * the CA bundle that goes with one. No credential or provider name (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
 * `CLAUDE_CODE_USE_*`, `AWS_*`): srt strips nothing from the env a sandboxed command inherits, so one would be readable
 * by the round's Bash; a round authenticates through its exclave's own credential store. For the same reason a proxy
 * URL that carries userinfo (`user:token@host`) is dropped, not passed (`PROXY_URLS`).
 */
const PASSTHROUGH = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

/** The pass-through names that hold a URL, which may carry a credential in its userinfo. */
const PROXY_URLS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;

/**
 * The round's launch script, which tmux's window runs as `/bin/sh <script>` (`roundCommand`): `claude` under `env -i`
 * with `roundEnv`'s names, `PATH` with the round's `bin` first, a `TERM`, and the pass-through names above only when
 * the window's shell has them (the sandbox's network is empty regardless). Every value goes through `shq` but `claude`,
 * which is the owner's own `SEANCE_CLAUDE_BIN`, and `args`, which the caller has quoted. `${X+X="$X"}` is POSIX: unset
 * gives nothing and set gives one word, whatever the value holds. A proxy URL with `user:pass@` is unset first: a
 * match on `://…@` also drops one with an `@` in its path, which fails closed. With `seccomp` (Linux, both bwrap modes) the
 * whole command runs under an outer `bwrap --seccomp` reading that filter file on fd 3 (`vsockFilter`): it binds `/`
 * whole, so the round sees the host as before, and the filter outlives every exec under it, srt's bwrap included.
 */
export function roundScript(o: {
  readonly claude: string;
  readonly caffeinate: boolean;
  readonly seccomp?: string;
  readonly env: readonly (readonly [string, string])[];
  readonly binDir: string;
  readonly args: string;
  readonly seed: string;
}): string {
  const built = o.env.map(([key, value]) => shq(`${key}=${value}`));
  const passed = PASSTHROUGH.map((name) => `\${${name}+${name}="$${name}"}`);
  const dropped = PROXY_URLS.map((name) => `case "\${${name}-}" in *://*@*) unset ${name} ;; esac`);
  const words = [
    "/usr/bin/env",
    "-i",
    ...built,
    `PATH=${shq(o.binDir)}:"$PATH"`,
    'TERM="${TERM:-xterm-256color}"',
    ...passed,
    o.claude,
    o.args,
  ];
  const wrap = o.caffeinate ? "caffeinate -is " : o.seccomp === undefined ? "" : "bwrap --dev-bind / / --seccomp 3 -- ";
  const fd3 = o.seccomp === undefined ? "" : ` 3< ${shq(o.seccomp)}`;
  return `#!/bin/sh\n${dropped.join("\n")}\nexec ${wrap}${words.join(" ")} < ${shq(o.seed)}${fd3}\n`;
}

/**
 * The window's command: one `exec /bin/sh '<script>'`. tmux runs it through the owner's `default-shell`, which
 * `~/.tmux.conf` may set to one that is not POSIX (fish, nushell), so the command holds nothing but a path from
 * `ROUND_TMP` — no `$`, no expansion, no quote inside a quote — and the script, which is POSIX `sh`'s, holds the rest.
 */
export function roundCommand(script: string): string {
  return `exec /bin/sh ${shq(script)}`;
}

/**
 * Each path's real path, dropping those that do not exist (srt binds every one it is given). A Data-volume alias is
 * kept as written, after an existence check: `realpath` answers the firmlink's short form for it, which would make the
 * alias a repeat of the entry beside it and drop it from the fence.
 */
export async function existingPaths(paths: readonly string[], volume: string = DARWIN_DATA_VOLUME): Promise<string[]> {
  const found = await Promise.all(
    paths.map((path) =>
      isUnder(path, volume)
        ? stat(path).then(
            () => path,
            () => null,
          )
        : realpath(path).catch(() => null),
    ),
  );
  return dedupeNested(found.filter((path): path is string => path !== null));
}

/** The top-level entries of `/`, each with its real path, for the Linux inversion. */
async function rootEntriesOf(): Promise<RootEntry[]> {
  const names = await readdir("/").catch(() => [] as string[]);
  const entries = await Promise.all(
    names.map(async (name) => {
      const real = await realpath(`/${name}`).catch(() => null);
      return real === null ? null : { name, real };
    }),
  );
  return entries.filter((entry): entry is RootEntry => entry !== null);
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
  /** The round's own socket (`custodian-socket.ts`): its directory is the one the round may connect through. */
  readonly custodianSocket: string;
  /** The machine's own roots, masked from the round: `config.repoRoots` and every exclave's root. */
  readonly rootMasks: readonly string[];
  /** Awaited once the tmp dir exists and before any window does: the seat's write-ahead record. */
  readonly onTmp?: (tmpDir: string) => Promise<void>;
}

/**
 * Starts one round in tmux window `custodian` and tags its pane. The round is contained (docs/custodian.md item 4b;
 * DESIGN.md, "The custodian's seat"): its sandbox reads nothing but its own dirs and the read-only toolchain
 * (`roundSandboxPaths`), reaches no network and one acting socket, its own (`o.custodianSocket`), and its environment
 * is built (`roundEnv`), not inherited. Every value in the launch script goes through `shq` (it is the second shell
 * text the daemon builds, after spawn's); the fence, the seed and the script are files in the round's own 0700 tmp dir,
 * which keeps a ~6 KB JSON off argv and out of `ps` and the window's command to a path. None is writable from the
 * round's sandbox, which writes only `<tmp>/claude-<uid>`. On any failure after the tmp dir exists it is removed. A
 * toolchain the masks would undo is `LaunchRefused`, not a failure.
 */
export async function launchRound(o: LaunchOptions): Promise<{ readonly pane: string; readonly tmpDir: string }> {
  const tmpDir = await mkdtemp(ROUND_TMP_PREFIX);
  try {
    await o.onTmp?.(tmpDir);
    const target = await resolveTargetSession(o.tmuxSession);
    // Still looked up: a `SEANCE_TMUX_SOCKET` outside `/tmp` would stay reachable under Linux's `allowAllUnixSockets`.
    const socket = (await tmuxOk(["display-message", "-p", "-t", `${target}:`, "#{socket_path}"])).trim();
    const home = homedir();
    const [toolchain, realHome, realState, realConfig, realTmux, realTmp, realSocketDir, rootEntries] =
      await Promise.all([
        roundToolchain(),
        realpath(home).catch(() => home),
        realpath(stateDir()).catch(() => stateDir()),
        realpath(configDir()).catch(() => configDir()),
        realpath(dirname(socket)).catch(() => dirname(socket)),
        realpath(tmpDir).catch(() => tmpDir),
        realpath(dirname(o.custodianSocket)).catch(() => dirname(o.custodianSocket)),
        o.platform === "linux" ? rootEntriesOf() : Promise.resolve([]),
      ]);
    const paths = roundSandboxPaths({
      platform: o.platform,
      home: realHome,
      state: realState,
      config: realConfig,
      tmuxSocketDir: realTmux,
      roundDir: o.roundDir,
      tmpDir: realTmp,
      socketDir: realSocketDir,
      toolchain,
      rootEntries,
      extraMasks: [...o.rootMasks, toolchain.checkout],
    });
    // The seat checked at its start, with the expected tmux dir and before every exclave's root was known: the masks
    // here are this round's own. Refused, not failed: the seat audits it as its own `toolchain` refusal.
    const unsafe = toolchainProblem(toolchain, paths.guarded);
    if (unsafe !== null) throw new LaunchRefused("toolchain", unsafe);
    const fence = custodianFence({
      platform: o.platform,
      roundDir: o.roundDir,
      socketDir: realSocketDir,
      denyRead: await existingPaths(paths.denyRead),
      allowRead: await existingPaths(paths.allowRead),
      readDenies: roundReadDenies({
        platform: o.platform,
        home: realHome,
        state: realState,
        config: realConfig,
        tmpDirs: [tmpDir, realTmp],
        flagsPaths: [custodianSessionsPath(), join(realState, relative(stateDir(), custodianSessionsPath()))],
        exclave: o.exclave,
      }),
      weakerNested: o.weakerNested,
    });
    const fencePath = join(tmpDir, "fence.json");
    const seedPath = join(tmpDir, "seed.txt");
    // Every Linux round, in both bwrap modes (`sandboxDrilled`): a container shares its host's kernel, whose vsock
    // loopback no network namespace covers. Like the fence, the file is not writable from the round's sandbox.
    const linux = o.platform === "linux";
    const filter = linux ? vsockFilter(process.arch) : null;
    if (linux && filter === null) throw new LaunchRefused("toolchain", `no vsock filter for ${process.arch}`);
    const seccompPath = filter === null ? undefined : join(tmpDir, "seccomp.bpf");
    await Promise.all([
      writeFile(fencePath, JSON.stringify(fence), { mode: 0o600 }),
      writeFile(seedPath, roundSeed(o.notes), { mode: 0o600 }),
      ...(filter === null || seccompPath === undefined ? [] : [writeFile(seccompPath, filter, { mode: 0o600 })]),
    ]);
    // The fence allows `Bash(seance custodian *)` by name, and nothing guarantees the tmux server's PATH holds a
    // `seance` of this checkout (linking is opt-in and nothing re-points it on a pull): the round gets its own, first
    // on PATH, running this process's main. Like the fence, it is not writable from the round's sandbox. Bun by its
    // resolved path: bwrap binds an allow entry at its realpath, so a symlinked dir on the way (mise's
    // `installs/bun/latest`) does not exist inside, and the shim dies with the round (no keg to outlive).
    const binDir = join(tmpDir, "bin");
    await mkdir(binDir, { mode: 0o700 });
    await writeFile(join(binDir, CLI_NAME), seanceShim(toolchain.bunReal, toolchain.main), { mode: 0o700 });
    const claude = process.env["SEANCE_CLAUDE_BIN"] ?? "claude";
    // A file, not a string for the owner's `default-shell` to parse: the agents JSON holds apostrophes, and any quoting
    // of it that survives two shells differs between them. Like the fence, it is not writable from the round's sandbox.
    const scriptPath = join(tmpDir, "run.sh");
    await writeFile(
      scriptPath,
      roundScript({
        claude,
        caffeinate: o.platform === "darwin",
        ...(seccompPath === undefined ? {} : { seccomp: seccompPath }),
        env: roundEnv({ home, user: loginName(), tmpDir, socket: o.custodianSocket, exclave: o.exclave }),
        binDir,
        args:
          `-n ${shq(sessionName("custodian", o.machineTag))} --remote-control ` +
          `--agents ${shq(o.agents)} --agent custodian --settings ${shq(fencePath)} --setting-sources project ` +
          `--permission-mode dontAsk --strict-mcp-config --model ${shq(o.settings.model)} --effort ${shq(o.settings.effort)} ` +
          `--`,
        seed: seedPath,
      }),
      { mode: 0o700 },
    );
    const command = roundCommand(scriptPath);
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
