import { stat } from "node:fs/promises";
import { CODEX_MIN_VERSION, versionAtLeast } from "@seance/shared";
import { homedir } from "node:os";
import { codexOwnerAudit, cliSink, type CodexOwnerOp, type CodexOwnerOutcome } from "../audit.ts";
import { usageLine } from "../commands.ts";
import { loadConfig } from "../config.ts";
import { codexBin, codexEnv, codexHome, prepareCodexHome } from "./home.ts";
import { probeCodex, readCodexVersion, type ProbeResult } from "./probe.ts";
import { printable } from "../custodian-owner-cli.ts";
import { childEnv } from "../exec.ts";
import {
  awaitPairing,
  enableForPairing,
  listClients,
  openPairServer,
  pairedRecord,
  revokeClients,
  startPairing,
  type PairServer,
} from "./pair.ts";
import { readRemote, removeRemote, writeRemote } from "./remote.ts";

/**
 * `seance codex login | logout | status | pair | unpair` (docs/codex.md, "Where the login lives"; DESIGN.md, Daemon,
 * "Codex login", "Codex remote control"): the owner's, typed at this machine's shell, never a frame, a local-socket op,
 * a broker action, an app op or MCP. `login` and `logout` hand the terminal to Codex's own `login --device-auth` and
 * `logout` in the machine's one home, so a sign-in works over SSH and Séance never sees the device code or a token;
 * `status` runs one probe, as the daemon does; `pair` and `unpair` drive a server of their own on the home
 * (`pair.ts`), printing only the pairing code Codex gives. Each verb is audited under origin `cli` with its outcome
 * alone.
 */

const USAGE = usageLine("codex");

const usage = (): void => {
  console.error(USAGE);
  process.exitCode = 2;
};

const audit = codexOwnerAudit(cliSink);

const end = async (op: CodexOwnerOp, outcome: CodexOwnerOutcome, message?: string): Promise<void> => {
  await audit(op, outcome);
  if (message === undefined) return;
  console.error(message);
  process.exitCode = 1;
};

export async function cmdCodex(rest: readonly string[]): Promise<void> {
  const [verb, ...args] = rest;
  if (args.length > 0) return usage();
  if (verb === "login" || verb === "logout") return handOver(verb);
  if (verb === "status") return status();
  if (verb === "pair" || verb === "unpair") return remote(verb);
  usage();
}

const NO_CONFIG =
  'this machine has no `codex` block in config.json — add `"codex": {}` (the defaults) and let the daemon restart';

interface Ready {
  readonly home: string;
  readonly env: Readonly<Record<string, string>>;
  readonly bin: string;
}

/**
 * A verb that runs Codex: the `codex` block, the home (its config written first: it sets the file store) and a binary
 * at the floor. Null once it has ended the verb with the refusal.
 */
async function ready(op: CodexOwnerOp): Promise<Ready | null> {
  if ((await loadConfig()).codex === undefined) {
    await end(op, "no_config", NO_CONFIG);
    return null;
  }
  const { home } = await prepareCodexHome();
  const env = codexEnv(home, homedir());
  const bin = codexBin();
  const version = await readCodexVersion(bin, env, home);
  if (version.kind !== "version") {
    await end(op, "missing", `could not run \`${bin} --version\` — install Codex (${CODEX_MIN_VERSION} or later)`);
    return null;
  }
  if (!versionAtLeast(version.version)) {
    await end(
      op,
      "outdated",
      `codex ${printable(version.version, 40)} is older than ${CODEX_MIN_VERSION} — upgrade it, then run this again`,
    );
    return null;
  }
  return { home, env, bin };
}

/** Codex's own verb, on this terminal, in the machine's home. */
async function handOver(op: "login" | "logout"): Promise<void> {
  const r = await ready(op);
  if (r === null) return;
  const { home, env, bin } = r;
  const argv = op === "login" ? [bin, "login", "--device-auth"] : [bin, "logout"];
  // The terminal is Codex's: it prints the code and the URL, and nothing of it passes through this process.
  const proc = Bun.spawn(argv, {
    cwd: home,
    env: childEnv(env, true),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) return end(op, "failed", `codex ${op} exited ${exitCode}`);
  await audit(op, "ok");
  console.log(
    op === "login"
      ? "signed in — the running daemon reads it within a minute (`seance codex status` reads it now)"
      : "signed out — the running daemon reads it within a minute",
  );
}

function healthLine(result: ProbeResult): string {
  if (result.health === "ok") return result.accountId === null ? "signed in, unidentified" : "signed in";
  if (result.health === "signed_out") return "signed out (`seance codex login`)";
  if (result.health === "expired") return "expired: the backend refused the login (`seance codex login`)";
  return `unknown (${result.failure.replace("_", " ")})`;
}

async function status(): Promise<void> {
  if ((await loadConfig()).codex === undefined) return end("status", "no_config", NO_CONFIG);
  const home = codexHome();
  // Read-only: the daemon writes the home at its start, and `status` must not race a config it is rewriting.
  if ((await stat(home).catch(() => null))?.isDirectory() !== true) {
    return end(
      "status",
      "no_home",
      `${home} does not exist yet — the daemon writes it when it starts with a codex block`,
    );
  }
  const result = await probeCodex({ bin: codexBin(), env: codexEnv(home, homedir()), home, now: Date.now });
  await audit("status", result.health);
  console.log(`home      ${home}`);
  console.log(`codex     ${result.version === null ? "not found" : printable(result.version, 40)}`);
  console.log(`login     ${healthLine(result)}`);
  if (result.health !== "ok") return;
  if (result.accountId !== null) console.log(`account   ${printable(result.accountId, 128)}`);
  const { email, plan, workspace } = result.display;
  const who = [email, plan, workspace].filter((part) => part !== undefined).map((part) => printable(part, 80));
  if (who.length > 0) console.log(`          ${who.join(" · ")}`);
  const { h, d } = result.quota;
  console.log(`quota     5h ${h === undefined ? "—" : `${h}%`} · 7d ${d === undefined ? "—" : `${d}%`}`);
  console.log(`credits   ${result.credits ? "available" : "none"}${result.blocked ? " · included usage blocked" : ""}`);
}

/**
 * `pair` and `unpair`: a server of the verb's own on the home (`pair.ts`), ended however the verb ends, Ctrl-C
 * included. The daemon reads `remote.json` within a minute and offers the slot (or takes it back).
 */
async function remote(op: "pair" | "unpair"): Promise<void> {
  const r = await ready(op);
  if (r === null) return;
  const opened = await openPairServer(r);
  if (typeof opened === "string") return end(op, "failed", `${op} failed: ${opened}`);
  let cancelled = false;
  const onInterrupt = (): void => {
    cancelled = true;
  };
  process.on("SIGINT", onInterrupt);
  try {
    await (op === "pair" ? pair(opened, () => cancelled) : unpair(opened));
  } finally {
    process.off("SIGINT", onInterrupt);
    // Remote control off before the server goes, so the backend frees the slot at once rather than at its timeout.
    await opened.call("remoteControl/disable", { ephemeral: true }).catch(() => null);
    await opened.close();
  }
}

async function pair(server: PairServer, cancelled: () => boolean): Promise<void> {
  const environmentId = await enableForPairing(server);
  if (environmentId === null) return end("pair", "failed", "pair failed: Codex's remote control did not come up");
  const pairing = await startPairing(server);
  if (pairing === null) return end("pair", "failed", "pair failed: Codex gave no pairing code");
  const until = new Date(pairing.expiresAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  console.log(`pairing code  ${pairing.code}   (valid until ${until})`);
  console.log("in the ChatGPT app: Codex → pair a computer → enter the code. Waiting… (Ctrl-C to stop)");
  const waited = await awaitPairing(server, pairing, { cancelled });
  if (waited === "cancelled") return end("pair", "cancelled", "pair stopped: nothing was paired");
  if (waited === "lapsed") return end("pair", "lapsed", "the code lapsed unclaimed — run `seance codex pair` again");
  if (waited === "failed") return end("pair", "failed", "pair failed: Codex did not answer the pairing's status");
  const clients = await listClients(server, environmentId);
  const record = clients === null ? null : pairedRecord(environmentId, clients, Date.now());
  if (record === null) return end("pair", "failed", "pair failed: the paired phone is not on Codex's client list");
  await writeRemote(record);
  await audit("pair", "ok");
  console.log("paired — the running daemon gives a Codex session remote control within a minute");
}

async function unpair(server: PairServer): Promise<void> {
  const environmentId = await enableForPairing(server);
  if (environmentId === null) return end("unpair", "failed", "unpair failed: Codex's remote control did not come up");
  // Every phone the environment lists, not only the ones `remote.json` noted: one paired outside Séance reaches the
  // sessions as well.
  const clients = await listClients(server, environmentId);
  if (clients === null) return end("unpair", "failed", "unpair failed: Codex's client list could not be read");
  const failed = await revokeClients(server, environmentId, clients);
  if (failed > 0) {
    return end("unpair", "failed", `unpair failed: ${failed} of ${clients.length} phones could not be revoked`);
  }
  const noted = await readRemote();
  await removeRemote();
  await audit("unpair", clients.length === 0 && noted === null ? "not_paired" : "ok");
  console.log(
    clients.length === 0
      ? "no phone was paired"
      : `unpaired — ${clients.length} phone${clients.length === 1 ? "" : "s"} revoked; the daemon takes remote control back within a minute`,
  );
}
