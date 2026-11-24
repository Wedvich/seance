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

/**
 * `seance codex login | logout | status` (docs/codex.md, "Where the login lives"; DESIGN.md, Daemon, "Codex login"):
 * the owner's, typed at this machine's shell, never a frame, a local-socket op, a broker action, an app op or MCP.
 * `login` and `logout` hand the terminal to Codex's own `login --device-auth` and `logout` in the machine's one home,
 * so a sign-in works over SSH and Séance never sees the device code or a token; `status` runs one probe, as the daemon
 * does. Each verb is audited under origin `cli` with its outcome alone.
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
  usage();
}

const NO_CONFIG =
  'this machine has no `codex` block in config.json — add `"codex": {}` (the defaults) and let the daemon restart';

/** Codex's own verb, on this terminal, in the machine's home. The home's config is written first: it sets the file store. */
async function handOver(op: "login" | "logout"): Promise<void> {
  if ((await loadConfig()).codex === undefined) return end(op, "no_config", NO_CONFIG);
  const { home } = await prepareCodexHome();
  const env = codexEnv(home, homedir());
  const bin = codexBin();
  const version = await readCodexVersion(bin, env, home);
  if (version.kind !== "version") {
    return end(op, "missing", `could not run \`${bin} --version\` — install Codex (${CODEX_MIN_VERSION} or later)`);
  }
  if (!versionAtLeast(version.version)) {
    return end(
      op,
      "outdated",
      `codex ${printable(version.version, 40)} is older than ${CODEX_MIN_VERSION} — upgrade it, then run this again`,
    );
  }
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
