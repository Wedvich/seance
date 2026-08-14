// The mechanics behind `seanced raycast install|uninstall`, beside the doctor
// checks they earn — the same shape mcp.ts has next to `seanced mcp`. Delegates
// to Raycast's own CLI rather than writing its files, because the import is
// recorded in Raycast's encrypted sqlite and nothing outside the app may touch
// that (DESIGN.md).

import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Check } from "./check.ts";
import { childEnv, exec, execFailure } from "./exec.ts";
import { checkoutRoot } from "./selfsource.ts";

/**
 * Fallback only, for a `@raycast/api` whose manifest cannot be read — the floor
 * proper is read from the installed package (`nodeFloor`), so a dependency bump
 * moves it instead of leaving a stale literal here. Nothing else about node's
 * version matters.
 */
const MIN_NODE = [22, 22, 2] as const;

/** Raycast ships its own node for extensions; this is where the app keeps them. */
const BUNDLED_RUNTIME_DIR = join("Library", "Application Support", "com.raycast.macos", "NodeJS", "runtime");

/**
 * Where `ray develop` imports to. A *name*-keyed directory, not a UUID —
 * UUIDs are Store installs, and this extension is deliberately never published.
 * Not XDG-resolved: Raycast hardcodes `~/.config/raycast`, so honouring
 * `XDG_CONFIG_HOME` here would look in a directory the app never uses.
 */
export function importedExtensionDir(name: string, home: string = homedir()): string {
  return join(home, ".config", "raycast", "extensions", name);
}

/**
 * The extension workspace inside *this checkout* — resolved from the source
 * anchor, never from `process.execPath`, which is the realpath'd bun binary and
 * so points at a package manager's cellar rather than at any of our files.
 * `SEANCE_RAYCAST_DIR` is a test seam, like the other `SEANCE_*` overrides.
 */
export function raycastWorkspace(): string {
  return process.env["SEANCE_RAYCAST_DIR"] ?? join(checkoutRoot(), "raycast");
}

/** `bun install` runs from the workspace's parent — the repo root in a real checkout. */
function repoRoot(workspace: string): string {
  return dirname(workspace);
}

function rayBin(workspace: string): string {
  return join(workspace, "node_modules", ".bin", "ray");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The manifest's `name`, which is the only thing that decides where Raycast
 * imports to. Read rather than hardcoded: a constant here and a rename there
 * would leave install polling a directory that never appears and uninstall
 * refusing to remove the one that did.
 */
export async function manifestName(workspace: string = raycastWorkspace()): Promise<string> {
  const path = join(workspace, "package.json");
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch {
    throw new Error(`no extension manifest at ${path} — is this checkout complete?`);
  }
  const name = isRecord(raw) ? raw["name"] : undefined;
  if (typeof name !== "string" || name === "") {
    throw new Error(`${path} declares no "name" — Raycast imports by manifest name, so there is nothing to install`);
  }
  return name;
}

/** Dotted numeric prefix of a version string, `v` allowed. Null when it isn't one. */
export function parseVersion(text: string): readonly number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)/u.exec(text.trim());
  const digits = match?.[1];
  return digits === undefined ? null : digits.split(".").map(Number);
}

/**
 * `engines.node` of the installed `@raycast/api`, which is the only thing that
 * decides this floor. Read at use time — the package is there by then, the
 * `bun install` gate ran first — so a bump lands here without an edit.
 */
export async function nodeFloor(workspace: string = raycastWorkspace()): Promise<readonly number[]> {
  const raw = await Bun.file(join(workspace, "node_modules", "@raycast", "api", "package.json"))
    .json()
    .catch(() => null);
  const engines = isRecord(raw) && isRecord(raw["engines"]) ? raw["engines"]["node"] : undefined;
  const declared = typeof engines === "string" ? parseVersion(engines.replace(/^\s*>=\s*/u, "")) : null;
  return declared ?? MIN_NODE;
}

export function meetsNodeFloor(version: string, floor: readonly number[] = MIN_NODE): boolean {
  const parsed = parseVersion(version);
  if (parsed === null) return false;
  for (const [index, part] of floor.entries()) {
    const has = parsed[index] ?? 0;
    if (has !== part) return has > part;
  }
  return true;
}

/** Newest runtime that clears the floor, from Raycast's runtime directory listing. */
export function pickBundledRuntime(entries: readonly string[], floor: readonly number[] = MIN_NODE): string | null {
  let best: string | null = null;
  for (const entry of entries) {
    if (!meetsNodeFloor(entry, floor)) continue;
    if (best === null || compareVersions(entry, best) > 0) best = entry;
  }
  return best;
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a) ?? [];
  const right = parseVersion(b) ?? [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const APP_NAME = "Raycast.app";

/** `Bun.file().exists()` answers false for a directory, and an app bundle is one. */
async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** `/Applications` first, then the per-user one — the two places a Mac keeps an app. */
export async function raycastAppPath(home: string = homedir()): Promise<string | null> {
  for (const path of [join("/Applications", APP_NAME), join(home, "Applications", APP_NAME)]) {
    // oxlint-disable-next-line no-await-in-loop -- two stats, and the first hit wins
    if (await pathExists(path)) return path;
  }
  return null;
}

/**
 * `SEANCE_RAYCAST_ANY_PLATFORM` is a test seam, like `SEANCE_RAYCAST_DIR`:
 * `uninstall`'s guards below this are plain fs work against `HOME`, so CI
 * covers them off macOS. Opt-in and set only by the tests — nothing in the
 * shipped path sets it, and `install` off macOS still has no Raycast to talk to.
 */
function assertMacos(): void {
  if (process.platform === "darwin" || process.env["SEANCE_RAYCAST_ANY_PLATFORM"] === "1") return;
  throw new Error("the Séance Raycast extension is macOS-only — its manifest declares platforms: [macOS]");
}

/**
 * PATH for the `ray` children. Node's version matters only as `@raycast/api`'s
 * engine, so an old (or absent) PATH node falls back to the node Raycast ships
 * for exactly this. Resolved here, at use time, and never written anywhere: the
 * bundled runtime directory is versioned and disappears on the next app update.
 */
async function nodeCapablePath(home: string, workspace: string): Promise<string> {
  const path = process.env["PATH"] ?? "";
  const floor = await nodeFloor(workspace);
  const node = Bun.which("node");
  if (node !== null) {
    const version = await exec([node, "--version"], { timeoutMs: 10_000 });
    if (version.exitCode === 0 && meetsNodeFloor(version.stdout, floor)) return path;
  }
  const runtimes = join(home, BUNDLED_RUNTIME_DIR);
  const picked = pickBundledRuntime(await readdir(runtimes).catch(() => []), floor);
  if (picked === null) {
    throw new Error(
      `node ${floor.join(".")} or newer is needed (@raycast/api's engine) — ` +
        `PATH's node is ${node === null ? "missing" : "too old"} and ${runtimes} holds no usable runtime`,
    );
  }
  return `${join(runtimes, picked, "bin")}:${path}`;
}

/** `ray develop` prints this once the bundle is written. A hint that shortens the wait, never the proof. */
const READY_MARKER = "ready - built extension successfully";

const DEVELOP_BOUND_MS = 90_000;
const POLL_MS = 250;
/** Grace after the import is seen, before the child is stopped. */
const SETTLE_MS = 1_000;
/** How long the marker alone is given to be followed by a directory, before that combination is called a miss. */
const MARKER_GRACE_MS = 3_000;
const SIGKILL_AFTER_MS = 5_000;
/** Enough of `ray`'s own tail to carry its error; its message beats any of ours. */
const TAIL_CHARS = 2_048;

interface DevelopOutcome {
  readonly imported: boolean;
  readonly markerSeen: boolean;
  readonly tail: string;
}

async function mtimeMs(path: string): Promise<number | null> {
  return stat(path)
    .then((info) => info.mtimeMs)
    .catch(() => null);
}

/**
 * `ray develop` is a watcher: it never exits, so "the extension is imported"
 * has to be observed from outside the process — which is why `exec()`, which
 * buffers to child exit, is unusable here. The observation is the imported
 * manifest appearing or changing mtime; snapshotting it first is what makes a
 * *re*-install detectable, since the directory is already there.
 *
 * On SIGINT `ray` removes `cli.pid` and `dev.log` and leaves the rest, so the
 * extension stays imported — that is the whole mechanism. It also exits 1 doing
 * it, so the exit code is deliberately not consulted.
 */
async function developUntilImported(opts: {
  readonly ray: string;
  readonly cwd: string;
  readonly path: string;
  readonly manifest: string;
}): Promise<DevelopOutcome> {
  const before = await mtimeMs(opts.manifest);
  const proc = Bun.spawn([opts.ray, "develop"], {
    cwd: opts.cwd,
    env: childEnv({ PATH: opts.path }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Per stream, not shared: the two pumps run concurrently, so one tail would
  // let a stderr chunk land between the halves of a split marker and hide it —
  // and would report the streams as a nondeterministic interleaving.
  const tails: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
  let markerSeen = false;
  const pump = async (stream: ReadableStream<Uint8Array>, which: "stdout" | "stderr"): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      // Match against tail + chunk so a marker split across reads still lands.
      const text = tails[which] + decoder.decode(chunk, { stream: true });
      if (which === "stdout" && text.includes(READY_MARKER)) markerSeen = true;
      tails[which] = text.slice(-TAIL_CHARS);
    }
  };
  const pumps = [pump(proc.stdout, "stdout").catch(() => {}), pump(proc.stderr, "stderr").catch(() => {})];

  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });

  const deadline = Date.now() + DEVELOP_BOUND_MS;
  let imported = false;
  let markerAt: number | null = null;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- a poll is sequential by definition
    const now = await mtimeMs(opts.manifest);
    if (now !== null && now !== before) {
      imported = true;
      break;
    }
    if (markerSeen && markerAt === null) markerAt = Date.now();
    // Built successfully but nothing where we look: waiting out the full bound
    // buys nothing, and the caller has a more honest thing to say than "done".
    if (markerAt !== null && Date.now() - markerAt >= MARKER_GRACE_MS) break;
    if (exited) break;
    // oxlint-disable-next-line no-await-in-loop -- ditto
    await Bun.sleep(POLL_MS);
  }
  // A `ray` that wrote the directory and exited in the same tick would
  // otherwise leave through the `exited` break with the write unnoticed.
  if (!imported) {
    const last = await mtimeMs(opts.manifest);
    imported = last !== null && last !== before;
  }

  // The manifest is written before the bundle beside it; stopping on the mtime
  // alone would race a half-written import.
  if (imported) await Bun.sleep(SETTLE_MS);
  await stopChild(proc);
  await Promise.allSettled(pumps);
  const tail = [tails.stdout, tails.stderr]
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .join("\n");
  return { imported, markerSeen, tail };
}

async function stopChild(proc: Bun.Subprocess): Promise<void> {
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill("SIGINT");
    // The loser of this race has to be cancelled, not just ignored: a live
    // timer keeps bun's loop open, so a `Bun.sleep` here would hold the whole
    // CLI up for the full grace period after the child had already gone.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), SIGKILL_AFTER_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!stopped) proc.kill("SIGKILL");
  }
  await proc.exited;
}

export interface InstallOutcome {
  readonly name: string;
  readonly path: string;
  /** The directory is the proof; a marker with no directory is false here, so the caller cannot claim success. */
  readonly imported: boolean;
  readonly warnings: readonly string[];
}

/**
 * Idempotent by re-running: every step either no-ops or repeats cleanly, so
 * this is also the update path after a `git pull` — nothing else rebuilds the
 * imported copy.
 */
export async function installExtension(report: (line: string) => void): Promise<InstallOutcome> {
  assertMacos();
  const home = homedir();
  const app = await raycastAppPath(home);
  if (app === null) {
    throw new Error("Raycast not found in /Applications or ~/Applications — install Raycast first");
  }
  // `ray develop` talks to the running app, so a launch is worth doing rather
  // than failing on; the app takes a moment to answer, which the import wait
  // below already absorbs.
  if ((await exec(["pgrep", "-x", "Raycast"])).exitCode !== 0) {
    report("Raycast is not running — starting it");
    const opened = await exec(["open", "-a", app], { timeoutMs: 30_000 });
    if (opened.exitCode !== 0) throw new Error(`could not start Raycast: ${execFailure(opened)}`);
  }

  const workspace = raycastWorkspace();
  const name = await manifestName(workspace);
  const ray = rayBin(workspace);
  if (!(await Bun.file(ray).exists())) {
    // Not just the build tool: the extension has a real runtime dependency
    // (`ws`), so an uninstalled workspace cannot run either. Never npm —
    // `workspace:*` is not an npm spec and npm would flatten the isolated
    // linker tree that keeps this workspace on its own TypeScript.
    report("installing workspace dependencies (bun install)");
    const installed = await exec(["bun", "install"], { cwd: repoRoot(workspace), timeoutMs: 300_000 });
    if (installed.exitCode !== 0) throw new Error(`bun install: ${execFailure(installed)}`);
  }

  const path = await nodeCapablePath(home, workspace);

  // The gate that catches `shared/` drift: `ray develop` skips the typecheck
  // entirely, so without this a wire-type change would import happily and fail
  // at the user. tsc's own message is the useful one, so it is passed through.
  report("building the extension (this is the typecheck)");
  const built = await exec([ray, "build", "-e", "dist", "-o", "dist", "--non-interactive", "--exit-on-error"], {
    cwd: workspace,
    timeoutMs: 300_000,
    env: { PATH: path },
  });
  if (built.exitCode !== 0) {
    throw new Error(`ray build failed:\n${`${built.stdout}${built.stderr}`.trim()}`);
  }

  const target = importedExtensionDir(name, home);
  report(`importing into Raycast (${target})`);
  const outcome = await developUntilImported({ ray, cwd: workspace, path, manifest: join(target, "package.json") });
  if (!outcome.imported) {
    if (!outcome.markerSeen) {
      throw new Error(
        `ray develop did not import the extension within ${DEVELOP_BOUND_MS / 1000}s — its last output:\n${outcome.tail}`,
      );
    }
    return {
      name,
      path: target,
      imported: false,
      warnings: [
        `ray reported a successful build but nothing appeared at ${target} — ` +
          "check Raycast's Manage Extensions before relying on it",
      ],
    };
  }
  return { name, path: target, imported: true, warnings: [] };
}

/** Signal 0 delivers nothing and only asks: ESRCH says gone, EPERM says alive under another user. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isRecord(err) && err["code"] === "EPERM";
  }
}

export interface UninstallOutcome {
  readonly removed: readonly string[];
  readonly wasImported: boolean;
}

/**
 * Removes what this checkout can honestly remove, and no more. Raycast records
 * imported development extensions in its own encrypted sqlite; there is no
 * supported way to un-import one, so the entry survives until it is removed in
 * Manage Extensions — which the command says out loud rather than implying.
 *
 * Idempotent like `uninstall`'s service teardown: removing what isn't there is
 * not an error.
 */
export async function uninstallExtension(): Promise<UninstallOutcome> {
  assertMacos();
  const workspace = raycastWorkspace();
  const name = await manifestName(workspace);
  const target = importedExtensionDir(name);
  const removed: string[] = [];

  // Never `rm -rf` a path that wasn't positively identified: the directory is
  // named from a manifest field, and a wrong or stale name would aim this at
  // somebody else's extension.
  const manifest = Bun.file(join(target, "package.json"));
  const present = await manifest.exists();
  const imported = present ? await manifest.json().catch(() => null) : null;
  // Absence means nothing was imported; an unreadable manifest means a `ray`
  // killed mid-write, and calling that "nothing imported" would leave the
  // directory on disk with no run of this command able to converge.
  if (present && !isRecord(imported)) {
    throw new Error(
      `${join(target, "package.json")} is present but unreadable — a half-written import; ` +
        `remove ${target} by hand, then re-run`,
    );
  }
  const wasImported = isRecord(imported) && imported["name"] === name;
  if (imported !== null && !wasImported) {
    throw new Error(`${target} does not name "${name}" — leaving it alone`);
  }
  if (wasImported) {
    // `ray` writes cli.pid while a develop session is live and removes it on
    // SIGINT — but a crash leaves it behind, so the pid is probed rather than
    // believed; a stale one must not wedge every uninstall after it.
    const claimed = await Bun.file(join(target, "cli.pid"))
      .text()
      .catch(() => "");
    const pid = Math.trunc(Number(claimed.trim()));
    if (Number.isFinite(pid) && pid > 0 && processAlive(pid)) {
      throw new Error(`a \`ray develop\` session is live (pid ${pid}) — stop it, then re-run`);
    }
    await rm(target, { recursive: true, force: true });
    removed.push(target);
  }

  for (const artifact of [join(workspace, "dist"), join(workspace, "raycast-env.d.ts")]) {
    // oxlint-disable-next-line no-await-in-loop -- two artifacts, reported in order
    if (!(await pathExists(artifact))) continue;
    // oxlint-disable-next-line no-await-in-loop -- ditto
    await rm(artifact, { recursive: true, force: true });
    removed.push(artifact);
  }
  return { removed, wasImported };
}

/** Newest mtime under a directory tree, or null when it has no files. */
async function newestMtime(dir: string): Promise<number | null> {
  const entries = await readdir(dir, { recursive: true }).catch(() => null);
  if (entries === null) return null;
  const times = await Promise.all(entries.map((entry) => mtimeMs(join(dir, entry))));
  const finite = times.filter((time): time is number => time !== null);
  return finite.length === 0 ? null : Math.max(...finite);
}

/**
 * Doctor's Raycast lines, rendered in the binaries section beside the MCP
 * ones. Silent off macOS, the way the TPM checks are silent off Linux — the
 * extension cannot exist there.
 *
 * The staleness check is the one that earns its place, and it is the direct
 * analogue of the plist/MCP recorded-bun drift warning: nothing rebuilds the
 * imported copy on a `git pull`, so the machine can sit indefinitely running an
 * extension older than the `shared/` types it speaks.
 */
export async function raycastChecks(home: string = homedir()): Promise<readonly Check[]> {
  if (process.platform !== "darwin") return [];
  const app = await raycastAppPath(home);
  if (app === null) return [{ level: "warn", message: "Raycast not installed — `seanced raycast install` needs it" }];

  const workspace = raycastWorkspace();
  const name = await manifestName(workspace).catch(() => null);
  if (name === null)
    return [{ level: "warn", message: `Raycast at ${app}, but this checkout has no extension manifest` }];

  const present: Check = { level: "ok", message: `Raycast at ${app}` };
  const target = importedExtensionDir(name, home);
  const builtAt = await mtimeMs(join(target, "package.json"));
  if (builtAt === null) {
    return [
      present,
      { level: "warn", message: `extension not imported into Raycast — run \`seanced raycast install\`` },
    ];
  }
  const imported: Check = { level: "ok", message: `extension "${name}" imported (${target})` };

  const sources = await Promise.all([
    mtimeMs(join(workspace, "package.json")),
    newestMtime(join(workspace, "src")),
    newestMtime(join(repoRoot(workspace), "shared", "src")),
  ]);
  const newest = Math.max(...sources.map((time) => time ?? 0));
  if (newest <= builtAt) return [present, imported];
  return [
    present,
    imported,
    {
      level: "warn",
      message:
        `the imported extension is older than raycast/src or shared/src — ` +
        "re-run `seanced raycast install` to rebuild it",
    },
  ];
}
