// The Claude Code mods under claude-mods/, installed through Claude's own
// plugin CLI with this checkout as a directory marketplace. A directory
// marketplace is read in place (the copy Claude records under plugins/cache is
// not what loads; DESIGN.md, "Claude Code mods"), so a `git pull` reaches the next
// session (or `/reload-plugins`) with nothing to re-run — unlike the Raycast
// import. Marketplace and plugin names are read from the marketplace file
// rather than restated here. Plugins live per config dir, so every command here
// runs once per exclave (`userScopeTargets`), as `mcp install` does.

import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Check } from "./check.ts";
import { exec, execFailure } from "./exec.ts";
import { userScopeTargets, type ClaudeConfigTarget } from "./exclaves.ts";
import { checkoutRoot } from "./selfsource.ts";

export interface Marketplace {
  readonly name: string;
  readonly plugins: readonly { readonly name: string; readonly source: string }[];
}

/** Repo root, symlink-resolved: Claude records the folder it was given, and doctor compares against it. */
export async function realCheckoutRoot(): Promise<string> {
  const path = checkoutRoot();
  return realpath(path).catch(() => path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exported for tests. */
export function parseMarketplace(text: string): Marketplace {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || typeof raw["name"] !== "string" || !Array.isArray(raw["plugins"])) {
    throw new Error("marketplace.json: expected a name and a plugins list");
  }
  const plugins = raw["plugins"].map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry["name"] !== "string" || typeof entry["source"] !== "string") {
      throw new Error("marketplace.json: every plugin needs a name and a relative source");
    }
    return { name: entry["name"], source: entry["source"] };
  });
  return { name: raw["name"], plugins };
}

export async function readMarketplace(root: string): Promise<Marketplace> {
  return parseMarketplace(await Bun.file(join(root, ".claude-plugin", "marketplace.json")).text());
}

/** The last line of a `--json` run is its result; null when it doesn't parse. */
function jsonResult(stdout: string): Record<string, unknown> | null {
  const last = stdout.trim().split("\n").at(-1) ?? "";
  try {
    const parsed: unknown = JSON.parse(last);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function claudeBin(): string {
  const claude = Bun.which("claude");
  if (claude === null) throw new Error("claude not on PATH — install Claude Code first");
  return claude;
}

type Env = ClaudeConfigTarget["env"];

async function removeMarketplace(claude: string, name: string, env: Env): Promise<"removed" | "absent"> {
  const result = await exec([claude, "plugin", "marketplace", "remove", name, "--json"], { timeoutMs: 30_000, env });
  if (result.exitCode === 0) return "removed";
  if (jsonResult(result.stdout)?.["failureCode"] === "not_configured") return "absent";
  throw new Error(`claude plugin marketplace remove: ${execFailure(result)}`);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Runs `each` over every present config dir, in exclave order, one at a time:
 * each `claude plugin` call rewrites its dir's settings file. A failing dir
 * doesn't stop the rest; the failures are thrown together at the end.
 */
async function perTarget(
  report: (line: string) => void,
  each: (target: ClaudeConfigTarget) => Promise<void>,
): Promise<void> {
  const { present, missing } = await userScopeTargets();
  for (const target of missing) report(`skipped ${target.label} — ${target.configDir} does not exist yet`);
  const failures: string[] = [];
  for (const target of present) {
    // oxlint-disable-next-line no-await-in-loop -- serialized on purpose, see above
    await each(target).catch((err: unknown) => failures.push(`${target.label}: ${errorText(err)}`));
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

/**
 * `marketplace add` is idempotent against this folder and repoints in place
 * when the name was registered from another (a moved or re-cloned checkout),
 * carrying installed plugins along — so no remove-first, which would
 * cascade-delete each plugin's saved options and data. `install` is
 * idempotent too, so a re-run only ever converges.
 */
export async function installMods(report: (line: string) => void): Promise<void> {
  const claude = claudeBin();
  const root = await realCheckoutRoot();
  const market = await readMarketplace(root);
  await perTarget(report, async ({ label, env }) => {
    const added = await exec([claude, "plugin", "marketplace", "add", root, "--scope", "user", "--json"], {
      timeoutMs: 30_000,
      env,
    });
    if (added.exitCode !== 0) throw new Error(`claude plugin marketplace add: ${execFailure(added)}`);
    for (const plugin of market.plugins) {
      // oxlint-disable-next-line no-await-in-loop -- each install rewrites Claude's settings file; serialized on purpose
      const result = await exec([claude, "plugin", "install", `${plugin.name}@${market.name}`, "--scope", "user"], {
        timeoutMs: 60_000,
        env,
      });
      if (result.exitCode !== 0) throw new Error(`claude plugin install ${plugin.name}: ${execFailure(result)}`);
      report(`Claude mod ${plugin.name} installed in ${label}`);
    }
  });
}

/** Removing the marketplace uninstalls every plugin installed from it. */
export async function uninstallMods(report: (line: string) => void): Promise<void> {
  const claude = claudeBin();
  const market = await readMarketplace(await realCheckoutRoot());
  await perTarget(report, async ({ label, env }) => {
    report(
      (await removeMarketplace(claude, market.name, env)) === "removed"
        ? `removed the ${market.name} marketplace and its mods from ${label}`
        : `nothing installed in ${label}`,
    );
  });
}

/**
 * One line per mod: installed, and read from *this* checkout. The folder check
 * is the stale-clone hazard `cliOnPath` guards for the PATH link — a mod read
 * from a deleted or abandoned clone fails silently in every session. Exported
 * for tests; `listed` is `claude plugin list --json` run against the config dir
 * `label` names.
 */
export function modChecksFrom(market: Marketplace, root: string, listed: unknown, label: string): readonly Check[] {
  const installed = Array.isArray(listed) ? listed.filter(isRecord) : [];
  return market.plugins.map((plugin): Check => {
    const id = `${plugin.name}@${market.name}`;
    const entry = installed.find((row) => row["id"] === id);
    if (entry === undefined) {
      return {
        level: "warn",
        message: `Claude mod ${plugin.name} not installed in ${label} — run \`seance mod install\``,
      };
    }
    const expected = join(root, plugin.source);
    const folder = entry["readFromFolder"];
    if (folder !== expected) {
      return {
        level: "warn",
        message: `Claude mod ${plugin.name} in ${label} is read from ${String(folder)}, not this checkout's ${expected} — \`seance mod install\` repoints it`,
      };
    }
    if (entry["enabled"] === false) {
      return { level: "warn", message: `Claude mod ${plugin.name} installed in ${label} but disabled in Claude Code` };
    }
    return { level: "ok", message: `Claude mod ${plugin.name} installed in ${label}` };
  });
}

/** Doctor's mod lines, per exclave, rendered in the binaries section beside the MCP ones. */
export async function modChecks(): Promise<readonly Check[]> {
  const claude = Bun.which("claude");
  if (claude === null)
    return [{ level: "warn", message: "claude not on PATH — `seance mod install` needs Claude Code" }];
  const root = await realCheckoutRoot();
  let market: Marketplace;
  try {
    market = await readMarketplace(root);
  } catch (err) {
    // doctor gathers checks with Promise.all: a throw here would abort the whole report
    return [{ level: "warn", message: `Claude mods: ${errorText(err)}` }];
  }
  const { present } = await userScopeTargets();
  const checks = await Promise.all(
    present.map(async ({ label, env }): Promise<readonly Check[]> => {
      const result = await exec([claude, "plugin", "list", "--json"], { timeoutMs: 15_000, env });
      if (result.exitCode !== 0) {
        return [{ level: "warn", message: `claude plugin list (${label}): ${execFailure(result)}` }];
      }
      let listed: unknown;
      try {
        listed = JSON.parse(result.stdout);
      } catch {
        return [{ level: "warn", message: `claude plugin list --json (${label}) printed something other than JSON` }];
      }
      return modChecksFrom(market, root, listed, label);
    }),
  );
  return checks.flat();
}
