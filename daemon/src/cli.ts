import { chmod, mkdir, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { DAEMON_PATH, DEFAULT_EFFORT, DEFAULT_MODEL, fromBase64, type SpawnRequest } from "@seance/shared";
import { cliSink, spawnAudit } from "./audit.ts";
import {
  bearerTokenWarnings,
  configSkeleton,
  loadConfig,
  loadPsk,
  pskFingerprint,
  runnableProblems,
} from "./config.ts";
import { importKeychainPsk, importKeychainPskValue, PSK_SERVICE, readKeychainPsk } from "./keychain.ts";
import { installService, plistPath, restartService, serviceLoaded, uninstallService } from "./launchd.ts";
import { configDir, configPath, logPath, statePath } from "./paths.ts";
import { scanRepos } from "./scan.ts";
import { listClaudeSessions } from "./sessions.ts";
import { SpawnFailure, spawnSession } from "./spawn.ts";
import { livePid, loadOrInitState, pidAlive, readRuntime, saveState } from "./state.ts";
import { tmux } from "./tmux.ts";

export async function cmdInit(): Promise<void> {
  const path = configPath();
  if (await Bun.file(path).exists()) {
    console.log(`config already exists at ${path} — not touching it`);
  } else {
    await mkdir(configDir(), { recursive: true });
    await Bun.write(path, configSkeleton(hostname().replace(/\.local$/u, "")));
    await chmod(path, 0o600);
    console.log(`wrote ${path} (0600)`);
  }
  const state = await loadOrInitState();
  console.log(`deviceId: ${state.deviceId}`);
  console.log("\nnext steps:");
  // Standard base64 for the psk (it round-trips through atob); base64url for the
  // bearer token, which the app also has to pass through a `?t=` query value.
  console.log("  1. paste a PSK into psk — generate it offline, e.g. in 1Password or:");
  console.log("       openssl rand -base64 32");
  console.log("  2. fill in relayUrl, repoRoots, and a bearerToken shared with the relay:");
  console.log("       openssl rand -base64 32 | tr '+/' '-_' | tr -d '='");
  console.log("  3. run `seanced doctor`, then `seanced install`");
}

/**
 * Prints what the configured roots hold now, and primes the cache for the next
 * start — but only when no daemon is running. A live daemon holds `repos` in
 * memory and rewrites state.json from it on every rescan, so writing here would
 * be clobbered without ever reaching it: silently losing the work and leaving
 * `status` reporting a count nothing had registered.
 */
export async function cmdScan(): Promise<void> {
  const config = await loadConfig();
  const state = await loadOrInitState();
  const repos = await scanRepos(config.repoRoots, state.repos);
  const daemonPid = await livePid();
  if (daemonPid === null) await saveState({ ...state, repos, scannedAt: Date.now() });
  for (const repo of repos) {
    console.log(`${repo.name.padEnd(30)} ${(repo.defaultBranch ?? "-").padEnd(12)} ${repo.path}`);
  }
  console.log(`\n${repos.length} repos`);
  if (daemonPid !== null) {
    console.log(
      `cache untouched — daemon pid ${daemonPid} owns it. Refresh from the app to rescan, or \`seanced restart\` if you edited repoRoots.`,
    );
  }
}

export interface SpawnCliArgs {
  readonly repo: string;
  readonly here: boolean;
  readonly title?: string;
  readonly prompt?: string;
}

const SPAWN_USAGE = "usage: seanced spawn <repo> [--here] [-t <title>] [[-p] <task>]";

/** Mirrors /spawn: -p is optional, bare words join into the prompt. Exported for tests. */
export function parseSpawnArgs(argv: readonly string[]): SpawnCliArgs {
  let repo: string | undefined;
  let here = false;
  let title: string | undefined;
  const promptParts: string[] = [];
  let expect: "title" | "prompt" | null = null;
  for (const arg of argv) {
    if (expect === "title") {
      title = arg;
      expect = null;
    } else if (expect === "prompt") {
      promptParts.push(arg);
      expect = null;
    } else if (arg === "--here") {
      here = true;
    } else if (arg === "-t") {
      expect = "title";
    } else if (arg === "-p") {
      expect = "prompt";
    } else if (arg.startsWith("-")) {
      throw new Error(SPAWN_USAGE);
    } else if (repo === undefined) {
      repo = arg;
    } else {
      promptParts.push(arg);
    }
  }
  if (repo === undefined) throw new Error(SPAWN_USAGE);
  const prompt = promptParts.join(" ");
  return {
    repo,
    here,
    ...(title !== undefined ? { title } : {}),
    ...(prompt !== "" ? { prompt } : {}),
  };
}

/**
 * The relay-free spawn path — same code the app request runs, driven over SSH.
 * Audits to the same log the daemon writes, tagged `origin=cli`: a trail that
 * omitted the locally-reachable path would make it the quieter way in.
 */
export async function cmdSpawn(argv: readonly string[]): Promise<void> {
  const args = parseSpawnArgs(argv);
  const config = await loadConfig();
  const state = await loadOrInitState();
  const repos = state.repos.length > 0 ? state.repos : await scanRepos(config.repoRoots);
  const request: SpawnRequest = {
    repo: args.repo,
    mode: args.here ? "here" : "worktree",
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
  };
  const audit = spawnAudit("cli", cliSink);
  await audit.request(request);
  try {
    const outcome = await spawnSession(request, repos, config.tmuxSession);
    await audit.ok(outcome);
    if (outcome.note !== undefined) console.log(`note: ${outcome.note}`);
    console.log(`spawned '${outcome.window}' (${outcome.path})`);
  } catch (err) {
    if (err instanceof SpawnFailure) {
      await audit.failed(err.code);
      console.error(`spawn failed [${err.code}] — ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

export async function cmdStatus(): Promise<void> {
  const loaded = await serviceLoaded();
  console.log(`service:   ${loaded ? "loaded" : "not loaded"} (${plistPath()})`);
  const runtime = await readRuntime();
  if (runtime === null) {
    console.log("daemon:    no runtime info — never started?");
    return;
  }
  const alive = pidAlive(runtime.pid);
  console.log(`daemon:    pid ${runtime.pid} ${alive ? "running" : "not running"}`);
  console.log(
    `relay:     ${runtime.connected && alive ? `connected since ${new Date(runtime.connectedSince ?? 0).toISOString()}` : "disconnected"}`,
  );
  const state = await loadOrInitState();
  console.log(
    `repos:     ${state.repos.length}${state.scannedAt !== null ? ` (scanned ${new Date(state.scannedAt).toISOString()})` : ""}`,
  );
  console.log(`defaults:  model=${DEFAULT_MODEL} effort=${DEFAULT_EFFORT}`);
}

async function checkRelayReachable(url: string, bearerToken: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers: { authorization: `Bearer ${bearerToken}` } });
    } catch (err) {
      resolvePromise(String(err));
      return;
    }
    const timer = setTimeout(() => {
      ws.close();
      resolvePromise("timed out after 5s");
    }, 5_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      ws.close();
      resolvePromise(null);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      resolvePromise("connection failed");
    });
  });
}

const ok = (msg: string): void => console.log(`  ok    ${msg}`);
const warn = (msg: string): void => console.log(`  warn  ${msg}`);

export async function cmdDoctor(): Promise<void> {
  let failed = false;
  const fail = (msg: string): void => {
    failed = true;
    console.log(`  FAIL  ${msg}`);
  };

  console.log("config");
  let config;
  try {
    config = await loadConfig();
    ok(`loads from ${configPath()}`);
    const resolved = await loadPsk(config);
    const problems = runnableProblems(config, resolved?.psk ?? null);
    for (const problem of problems) fail(problem);
    // Independent of those failures: a token can be shape-valid and still be one
    // the app cannot pass through `?t=` intact.
    const tokenWarnings = bearerTokenWarnings(config.bearerToken);
    if (problems.length === 0) {
      ok(tokenWarnings.length === 0 ? "psk, bearerToken, relayUrl look valid" : "psk and relayUrl look valid");
      if (!config.relayUrl.endsWith(DAEMON_PATH)) {
        warn(`relayUrl does not end in ${DAEMON_PATH} — the relay rejects the upgrade and the daemon retries silently`);
      }
      if (resolved !== null) {
        // Printed on every device so a mismatched paste is one glance away,
        // rather than surfacing later as "nothing decrypts".
        ok(`psk from ${resolved.source}, fingerprint ${await pskFingerprint(resolved.psk)} — same on every device`);
        if (resolved.source === "config" && process.platform === "darwin") {
          warn(
            "psk sits in config.json, readable by anything running as you — `seanced psk-import` moves it to the keychain",
          );
        }
      }
    }
    for (const warning of tokenWarnings) warn(warning);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  console.log("binaries");
  for (const bin of ["tmux", "git", "claude"]) {
    const found = Bun.which(bin);
    if (found === null) fail(`${bin} not on PATH`);
    else ok(`${bin} at ${found}`);
  }

  if (config !== undefined) {
    console.log("repo roots");
    for (const root of config.repoRoots) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one stat per configured root, printed in order as it goes
        const info = await stat(root);
        if (info.isDirectory()) ok(root);
        else fail(`${root} is not a directory`);
      } catch {
        fail(`${root} does not exist`);
      }
    }

    console.log("tmux");
    const sessions = await tmux(["list-sessions", "-F", "#{session_name}"]);
    if (sessions.exitCode === 0) {
      ok(`server running (sessions: ${sessions.stdout.trim().split("\n").join(", ")})`);
    } else {
      warn("no tmux server — fine; spawn creates the session detached");
    }

    console.log("relay");
    if (/^wss?:\/\/.+/u.test(config.relayUrl)) {
      const problem = await checkRelayReachable(config.relayUrl, config.bearerToken);
      if (problem === null) ok(`reachable at ${config.relayUrl}`);
      else warn(`${config.relayUrl}: ${problem} (not deployed yet?)`);
    } else {
      warn("relayUrl not set — skipping reachability");
    }
  }

  console.log("state");
  const state = await loadOrInitState();
  ok(`deviceId ${state.deviceId} (${statePath()})`);

  const logFile = Bun.file(logPath());
  if (await logFile.exists()) {
    const size = logFile.size;
    if (size > 10 * 1024 * 1024)
      warn(`log is ${Math.round(size / 1024 / 1024)}MB — consider truncating (${logPath()})`);
    else ok(`log ${Math.round(size / 1024)}KB (${logPath()})`);
  }

  console.log("service");
  if (process.platform === "darwin") {
    if (await serviceLoaded()) ok("launchd agent loaded");
    else warn("launchd agent not loaded — run `seanced install`");
  } else {
    warn("not macOS — service management deferred (WSL support pending)");
  }

  if (failed) process.exit(1);
}

export async function cmdInstall(): Promise<void> {
  const target = await installService();
  console.log(`installed and started launchd agent (${target})`);
  console.log(`logs: ${logPath()}`);
}

export async function cmdUninstall(): Promise<void> {
  await uninstallService();
  console.log("launchd agent unloaded and plist removed");
}

export async function cmdRestart(): Promise<void> {
  await restartService();
  console.log("kickstarted");
}

export async function cmdSessions(): Promise<void> {
  const state = await loadOrInitState();
  const sessions = await listClaudeSessions(state.repos);
  for (const s of sessions) {
    console.log(`${s.window.padEnd(30)} ${(s.repo ?? "-").padEnd(20)} ${s.path}`);
  }
  console.log(`\n${sessions.length} running claude session${sessions.length === 1 ? "" : "s"}`);
}

/**
 * One-time setup, at the machine or over SSH: `security` prompts for the key on
 * the terminal, so it lands in neither argv nor shell history. With stdin piped
 * (e.g. from `op item get`), the value is read from the pipe instead — same
 * guarantee, since it crosses to `security` over stdin, never argv.
 */
export async function cmdPskImport(): Promise<void> {
  if (process.platform !== "darwin") {
    console.error("keychain storage is macOS-only — keep the psk in config.json on this platform");
    process.exit(1);
  }
  console.log(`storing the PSK as generic password "${PSK_SERVICE}" in the login keychain.`);
  if (process.stdin.isTTY) {
    console.log("security will prompt below — paste the base64 value (it will not echo).\n");
    await importKeychainPsk();
  } else {
    const piped = (await new Response(Bun.stdin.stream()).text()).trim();
    // Validate before storing: -U updates in place, and a bad pipe (empty
    // output, an op error message) must not clobber a good keychain entry.
    let byteLength: number;
    try {
      byteLength = fromBase64(piped).byteLength;
    } catch {
      console.error("piped value is not valid base64 — nothing stored");
      process.exit(1);
    }
    if (byteLength !== 32) {
      console.error(`piped value decodes to ${byteLength} bytes, need 32 — nothing stored`);
      process.exit(1);
    }
    await importKeychainPskValue(piped);
  }

  const stored = await readKeychainPsk();
  if (stored === null) {
    console.error(
      `\nstored, but reading it back failed — check \`security find-generic-password -s ${PSK_SERVICE} -w\``,
    );
    process.exit(1);
  }
  try {
    const bytes = fromBase64(stored);
    if (bytes.byteLength !== 32) {
      console.error(`\nstored value decodes to ${bytes.byteLength} bytes, need 32 — re-run with the right key`);
      process.exit(1);
    }
  } catch {
    console.error("\nstored value is not valid base64 — re-run with the right key");
    process.exit(1);
  }
  console.log(`\nstored — fingerprint ${await pskFingerprint(stored)}`);
  console.log(`now clear "psk" in ${configPath()} so the daemon reads the keychain, then \`seanced restart\``);
}
