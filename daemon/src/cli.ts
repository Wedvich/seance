import { chmod, mkdir, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { DAEMON_PATH, DEFAULT_EFFORT, DEFAULT_MODEL, fromBase64, type SpawnRequest } from "@seance/shared";
import { cliSink, spawnAudit } from "./audit.ts";
import { createBackend } from "./backend-default.ts";
import { SpawnFailure } from "./backend.ts";
import {
  bearerTokenWarnings,
  configSkeleton,
  loadConfig,
  loadPsk,
  pskFingerprint,
  runnableProblems,
} from "./config.ts";
import type { Check } from "./check.ts";
import { cliOnPath, createLink, removeLinks, resolvedMain } from "./link.ts";
import { exec, execFailure } from "./exec.ts";
import { mcpChecks, runMcpServer } from "./mcp.ts";
import { configDir, configPath, logPath, statePath } from "./paths.ts";
import { availablePskStore, pskStoreChecks, type PskStore } from "./psk-store.ts";
import {
  doctorServiceChecks,
  installService,
  restartService,
  serviceLoaded,
  servicePath,
  uninstallService,
} from "./service.ts";
import { scanRepos } from "./scan.ts";
import { readSource } from "./selfsource.ts";
import { livePid, loadOrInitState, pidAlive, readRuntime, saveState } from "./state.ts";

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
    const outcome = await createBackend(config).spawn(request, repos);
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
  console.log(`service:   ${loaded ? "loaded" : "not loaded"} (${servicePath()})`);
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
  // The running process's sha, not the checkout's: after a `git pull` without a
  // restart those differ, and only the first one answers "what is serving".
  const disk = await readSource();
  if (alive && runtime.sha !== undefined && runtime.sha !== null) {
    const drifted = disk !== null && disk.sha !== runtime.sha;
    console.log(
      `running:   ${runtime.sha.slice(0, 12)}${drifted ? ` — checkout on disk is ${disk.sha.slice(0, 12)}, restart to pick it up` : ""}`,
    );
  }
  if (disk !== null) {
    console.log(
      `checkout:  ${disk.sha.slice(0, 12)}${disk.branch !== null ? ` on ${disk.branch}` : " (detached)"}, committed ${new Date(disk.commitTs).toISOString()}`,
    );
  }
  if (state.lastUpdate !== undefined) {
    const { outcome, at, detail } = state.lastUpdate;
    console.log(`update:    ${outcome} at ${new Date(at).toISOString()}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
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
  // Every section that can produce checks produces the same shape, so doctor
  // renders and never branches on where a check came from.
  const render = (checks: readonly Check[]): void => {
    for (const check of checks) {
      if (check.level === "ok") ok(check.message);
      else if (check.level === "warn") warn(check.message);
      else fail(check.message);
    }
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
        const store = resolved.source === "config" ? await availablePskStore() : null;
        if (store !== null) {
          warn(
            `psk sits in config.json, readable by anything running as you — \`seanced psk-import\` moves it to ${store.nag}`,
          );
        }
      }
    }
    for (const warning of tokenWarnings) warn(warning);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  console.log("binaries");
  const gitBin = Bun.which("git");
  if (gitBin === null) fail("git not on PATH");
  else ok(`git at ${gitBin}`);
  render([await cliOnPath()]);
  render(await mcpChecks());

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

    // The backend owns its own preflight — the tmux one checks its binaries and
    // probes the server; a replacement reports whatever it depends on instead.
    console.log("backend");
    render(await createBackend(config).doctor());

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
  const source = await readSource();
  if (source === null) warn("checkout version unreadable — not a git checkout? version reporting stays off");
  else ok(`checkout ${source.sha.slice(0, 12)}${source.branch !== null ? ` on ${source.branch}` : " (detached)"}`);

  const logFile = Bun.file(logPath());
  if (await logFile.exists()) {
    const size = logFile.size;
    if (size > 10 * 1024 * 1024)
      warn(`log is ${Math.round(size / 1024 / 1024)}MB — consider truncating (${logPath()})`);
    else ok(`log ${Math.round(size / 1024)}KB (${logPath()})`);
  }

  console.log("service");
  render(await doctorServiceChecks());
  render(await pskStoreChecks());

  if (failed) process.exit(1);
}

export async function cmdInstall(): Promise<void> {
  const result = await installService();
  console.log(`installed and started the service (${result.target})`);
  for (const note of result.notes) console.log(`note: ${note}`);
  // The service embeds the absolute main.ts path, so it never needs the name —
  // but every follow-up this CLI prints does, so say so now rather than let
  // `seanced restart` be the first discovery.
  const onPath = await cliOnPath();
  if (onPath.level !== "ok") console.log(`note: ${onPath.message}`);
  console.log(`logs: ${logPath()}`);
}

export async function cmdUninstall(): Promise<void> {
  const notes = await uninstallService();
  console.log("service stopped and removed");
  for (const note of notes) console.log(`note: ${note}`);
  // link is opt-in, unlinking is not: a name left behind would outlive the
  // checkout the user is presumably about to delete.
  const { removed } = await removeLinks(process.env.PATH ?? "", await resolvedMain());
  for (const file of removed) console.log(`unlinked ${file}`);
}

export async function cmdLink(argv: readonly string[]): Promise<void> {
  const main = await resolvedMain();
  const result = await createLink(process.env.PATH ?? "", homedir(), main, argv[0]);
  if (result.status === "already") console.log(`already linked: ${result.file} → ${main}`);
  else if (result.status === "repointed") console.log(`repointed ${result.file}: was ${result.previous}, now ${main}`);
  else console.log(`linked ${result.file} → ${main}`);
  if (Bun.which("seanced") === null) {
    console.log(`note: ${result.file} still doesn't resolve — is its dir actually on PATH in this shell?`);
  }
}

export async function cmdUnlink(): Promise<void> {
  const { removed, kept } = await removeLinks(process.env.PATH ?? "", await resolvedMain());
  for (const file of removed) console.log(`removed ${file}`);
  for (const entry of kept) console.log(`left ${entry.file} → ${entry.target} — not this checkout's, remove it there`);
  if (removed.length === 0 && kept.length === 0) console.log("nothing linked");
}

export async function cmdRestart(): Promise<void> {
  await restartService();
  console.log("restarted");
}

export async function cmdSessions(): Promise<void> {
  const backend = createBackend(await loadConfig());
  const state = await loadOrInitState();
  const sessions = await backend.sessions(state.repos);
  for (const s of sessions) {
    console.log(`${s.window.padEnd(30)} ${(s.repo ?? "-").padEnd(20)} ${s.path}`);
  }
  console.log(`\n${sessions.length} running claude session${sessions.length === 1 ? "" : "s"}`);
}

/** Shape complaint as a sentence fragment, or null when the value is a 32-byte base64 key. */
function pskShapeProblem(value: string): string | null {
  let byteLength: number;
  try {
    byteLength = fromBase64(value).byteLength;
  } catch {
    return "is not valid base64";
  }
  return byteLength === 32 ? null : `decodes to ${byteLength} bytes, need 32`;
}

/**
 * Cooked-mode line read with echo off. On macOS `security` owns its own
 * prompt, but DPAPI has no prompt, so on WSL the key is read here; stty
 * inherits our tty via stdin, which beats hand-rolling raw-mode juggling.
 */
async function readLineNoEcho(): Promise<string> {
  await Bun.spawn(["stty", "-echo"], { stdin: "inherit" }).exited;
  try {
    let buffer = "";
    for await (const chunk of process.stdin) {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline !== -1) return buffer.slice(0, newline);
    }
    return buffer;
  } finally {
    await Bun.spawn(["stty", "echo"], { stdin: "inherit" }).exited;
    console.log();
  }
}

/**
 * One-time setup, at the machine or over SSH. Where the store owns a prompt
 * (macOS `security`) an interactive run hands it the terminal, so the key
 * lands in neither argv nor shell history and never transits this process.
 * Otherwise — a pipe, or a promptless blob store — the value passes through
 * here before crossing to the store as stdin data, still never argv.
 *
 * Validated before storing on every path: an import updates in place, and a
 * bad pipe (empty output, an `op` error message) must not clobber a good entry.
 */
async function runPskImport(store: PskStore): Promise<void> {
  const tty = process.stdin.isTTY === true;
  console.log(store.intro);
  let psk: string | null = null;
  if (store.prompted !== undefined && tty) {
    console.log(store.prompted.notice);
    await store.prompted.run();
  } else {
    if (tty) console.log("paste the base64 value (it will not echo):");
    psk = tty ? (await readLineNoEcho()).trim() : (await new Response(Bun.stdin.stream()).text()).trim();
    const problem = pskShapeProblem(psk);
    if (problem !== null) {
      console.error(`${tty ? "value" : "piped value"} ${problem} — nothing stored`);
      process.exit(1);
    }
    await store.importValue(psk);
  }

  // The store's own prompt swallows the value, so a prompted import can only
  // check what came back is a usable key; the rest also check it is *the* key.
  const stored = await store.read();
  if (stored === null || (psk !== null && stored !== psk)) {
    console.error(`\nstored, but reading it back failed — ${store.readBackHint}`);
    process.exit(1);
  }
  const storedProblem = pskShapeProblem(stored);
  if (storedProblem !== null) {
    console.error(`\nstored value ${storedProblem} — re-run with the right key`);
    process.exit(1);
  }
  console.log(`\nstored — fingerprint ${await pskFingerprint(stored)}`);
  console.log(`now clear "psk" in ${configPath()} so the daemon reads ${store.clearHint}, then \`seanced restart\``);
}

export async function cmdPskImport(): Promise<void> {
  const store = await availablePskStore();
  if (store !== null) return runPskImport(store);
  console.error(`no platform key store here (no usable TPM) — the psk stays in ${configPath()}, keep it mode 0600`);
  // A piped value is an explicit request to store a secret, so losing it must
  // not look like success; an interactive invocation has read nothing yet.
  process.exit(process.stdin.isTTY ? 0 : 1);
}

/**
 * The registration is delegated to `claude mcp add/remove` rather than editing
 * ~/.claude.json — Claude Code owns that schema. Registered as bun + this
 * checkout's main.ts (the same target `link` points at), so it tracks git pull
 * and works whether or not `seanced` is on PATH.
 */
export async function cmdMcp(rest: readonly string[]): Promise<void> {
  const [sub] = rest;
  if (sub === undefined) return runMcpServer();
  if (sub !== "install" && sub !== "uninstall") {
    throw new Error(`unknown mcp subcommand "${sub}" — expected \`seanced mcp\`, \`mcp install\` or \`mcp uninstall\``);
  }
  const claude = Bun.which("claude");
  if (claude === null) throw new Error("claude not on PATH — install Claude Code first");
  const argv =
    sub === "install"
      ? [claude, "mcp", "add", "--scope", "user", "seance", "--", process.execPath, await resolvedMain(), "mcp"]
      : [claude, "mcp", "remove", "--scope", "user", "seance"];
  const result = await exec(argv, { timeoutMs: 30_000 });
  if (result.exitCode !== 0)
    throw new Error(`claude mcp ${sub === "install" ? "add" : "remove"}: ${execFailure(result)}`);
  console.log(
    sub === "install"
      ? "registered — Claude Code sessions can now list machines, query sessions, and spawn via the relay"
      : "removed — Claude Code no longer loads the séance MCP server",
  );
}
