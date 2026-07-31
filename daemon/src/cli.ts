import { chmod, mkdir, stat } from "node:fs/promises";
import { hostname } from "node:os";
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
import { dpapiRoundTrip } from "./dpapi.ts";
import { configDir, configPath, logPath, statePath } from "./paths.ts";
import { availablePskStore, type PskStore } from "./psk-store.ts";
import {
  doctorServiceChecks,
  installService,
  restartService,
  serviceLoaded,
  servicePath,
  uninstallService,
} from "./service.ts";
import { readTpmPsk, tpmAvailable, tpmPskPath, tpmRoundTrip } from "./tpmcreds.ts";
import { scanRepos } from "./scan.ts";
import { livePid, loadOrInitState, pidAlive, readRuntime, saveState } from "./state.ts";
import { isWsl } from "./wsl.ts";

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
    for (const check of await createBackend(config).doctor()) {
      if (check.level === "ok") ok(check.message);
      else if (check.level === "warn") warn(check.message);
      else fail(check.message);
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
  for (const check of await doctorServiceChecks()) {
    if (check.ok) ok(check.message);
    else warn(check.message);
  }
  if (isWsl()) {
    // Broken interop surfaces here as a warning, and as a FAIL above only
    // when the PSK actually lives in the blob and could not be read.
    const interop = await dpapiRoundTrip();
    if (interop === null) ok("DPAPI round-trip via powershell.exe interop");
    else warn(`${interop} — psk-import and a DPAPI-stored PSK won't work`);
  } else if (await tpmAvailable()) {
    // Same shape as the WSL interop probe: a broken TPM path warns here,
    // and FAILs above only when the PSK actually lives in the blob.
    if (await Bun.file(tpmPskPath()).exists()) {
      if ((await readTpmPsk()) !== null) ok("TPM-sealed PSK blob decrypts via systemd-creds");
      else
        warn(
          `sealed blob at ${tpmPskPath()} does not decrypt here — blobs are machine-bound by design; re-run \`seanced psk-import\` on this machine`,
        );
    } else {
      const probe = await tpmRoundTrip();
      if (probe === null) ok("TPM seal/unseal via systemd-creds (no PSK blob yet — `seanced psk-import` creates it)");
      else warn(`${probe} — psk-import and a TPM-sealed PSK won't work`);
    }
  } else if (process.platform === "linux") {
    if (await Bun.file(tpmPskPath()).exists()) {
      warn(
        `sealed PSK blob at ${tpmPskPath()} but no usable TPM here — machine-bound by design; re-run \`seanced psk-import\` on this machine`,
      );
    } else {
      ok("no usable TPM — psk stays in config.json");
    }
  }

  if (failed) process.exit(1);
}

export async function cmdInstall(): Promise<void> {
  const result = await installService();
  console.log(`installed and started the service (${result.target})`);
  for (const note of result.notes) console.log(`note: ${note}`);
  console.log(`logs: ${logPath()}`);
}

export async function cmdUninstall(): Promise<void> {
  const notes = await uninstallService();
  console.log("service stopped and removed");
  for (const note of notes) console.log(`note: ${note}`);
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
