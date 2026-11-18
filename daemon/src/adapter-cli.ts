import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ADAPTERS_MAX, isAdapterName, isRecord, MESSAGE_KINDS, type MessageKind } from "@seance/shared";
import { readAdaptersView, requestAdapterRestart, type AdaptersView, type AdapterView } from "./adapter-control.ts";
import { checkoutCommit, readAdapterManifest } from "./adapter-manifest.ts";
import { adapterFingerprint } from "./adapter-subscriptions.ts";
import { adapterOwnerAudit, cliSink } from "./audit.ts";
import { usageLine } from "./commands.ts";
import { ADAPTER_DEFAULT_KINDS, loadConfig, type AdapterConfig } from "./config.ts";
import { printable } from "./custodian-owner-cli.ts";
import { writeDurable } from "./durable-write.ts";
import { adaptersDir, configPath } from "./paths.ts";
import { livePid, readState } from "./state.ts";

/**
 * `seance adapter add | remove | restart | status` (DESIGN.md, "Adapters", "Installing"): the
 * owner's, typed at this machine's shell, never a frame, a local-socket op, an app op or MCP. `add` and `remove` edit
 * this machine's `config.json` and nothing else of it (the daemon ends the name's subscriptions when it reads the new
 * config: `reconcileWith`, so `conversations.json` keeps one writer); `restart` and `status` talk to the running daemon
 * through two files (`adapter-control.ts`). Every act is audited under origin `cli`.
 *
 * Whatever the daemon's status view holds that an adapter wrote (its hello's version) reaches the terminal only through
 * `printable`.
 */

const USAGE = usageLine("adapter");

/** How long `restart` waits for the daemon to show it acted. */
const RESTART_WAIT_MS = 10_000;

const TRUST =
  "an adapter runs as you, with everything you can reach; séance bounds what it grants the adapter, not what the program can do";

const usage = (): void => {
  console.error(USAGE);
  process.exitCode = 2;
};

export async function cmdAdapter(rest: readonly string[]): Promise<void> {
  const [verb, ...args] = rest;
  if (verb === "add") return add(args);
  if (verb === "remove" && args.length === 1) return remove(args[0] ?? "");
  if (verb === "restart") return restart(args);
  if (verb === "status" && args.length === 0) return status();
  usage();
}

export interface AddArgs {
  readonly dir: string;
  readonly kinds?: readonly MessageKind[];
  readonly repos?: readonly string[];
}

/** Exported for tests. Null on a usage error. */
export function parseAddArgs(args: readonly string[]): AddArgs | null {
  let dir: string | undefined;
  let kinds: MessageKind[] | undefined;
  const repos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--kinds") {
      const list = (args[++i] ?? "").split(",");
      const valid = list.filter((k): k is MessageKind => (MESSAGE_KINDS as readonly string[]).includes(k));
      if (list.length === 0 || valid.length !== list.length || new Set(valid).size !== valid.length) return null;
      kinds = valid;
    } else if (arg === "--repo") {
      const repo = args[++i];
      if (repo === undefined || repo === "" || repo.startsWith("-") || repos.includes(repo)) return null;
      repos.push(repo);
    } else if (arg.startsWith("-") || dir !== undefined) {
      return null;
    } else {
      dir = arg;
    }
  }
  if (dir === undefined) return null;
  return { dir, ...(kinds === undefined ? {} : { kinds }), ...(repos.length === 0 ? {} : { repos }) };
}

interface RawConfig {
  readonly path: string;
  readonly raw: Record<string, unknown>;
  readonly adapters: Record<string, unknown>;
  readonly mode: number;
}

/** `config.json` as its JSON, after it loads as it stands: an edit never starts from a config the daemon refuses. */
async function readRawConfig(): Promise<RawConfig> {
  const path = configPath();
  await loadConfig(path);
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(raw)) throw new TypeError(`config at ${path} must be a JSON object`);
  const adapters = raw["adapters"] ?? {};
  if (!isRecord(adapters)) throw new TypeError(`config at ${path}: "adapters" must be an object`);
  return { path, raw, adapters: { ...adapters }, mode: (await stat(path)).mode & 0o777 };
}

/**
 * Writes `adapters` back into the config, after the whole new file loads (written beside it first): a mistake here
 * never leaves the daemon a config it cannot start on. Every other key stays as it was.
 */
async function writeAdapters(config: RawConfig, adapters: Record<string, unknown>): Promise<void> {
  const next: Record<string, unknown> = { ...config.raw };
  if (Object.keys(adapters).length === 0) delete next["adapters"];
  else next["adapters"] = adapters;
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const check = `${config.path}.adapter-check.tmp`;
  try {
    await writeDurable(check, text, 0o600);
    await loadConfig(check);
  } finally {
    await unlink(check).catch(() => {});
  }
  await writeDurable(config.path, text, config.mode);
}

async function daemonRunning(): Promise<number | null> {
  return livePid().catch(() => null);
}

/** The status view, only when the live daemon wrote it. */
async function liveView(): Promise<AdaptersView | null> {
  const pid = await daemonRunning();
  if (pid === null) return null;
  const view = await readAdaptersView();
  return view?.pid === pid ? view : null;
}

async function add(args: readonly string[]): Promise<void> {
  const parsed = parseAddArgs(args);
  if (parsed === null) return usage();
  const read = await readAdapterManifest(parsed.dir);
  if (!read.ok) {
    console.error(`not added: ${read.message}`);
    process.exitCode = 1;
    return;
  }
  const { name } = read.manifest;
  const config = await readRawConfig();
  const replaced = config.adapters[name] !== undefined;
  if (!replaced && Object.keys(config.adapters).length >= ADAPTERS_MAX) {
    console.error(`not added: this machine already names ${ADAPTERS_MAX} adapters, the most it may`);
    process.exitCode = 1;
    return;
  }
  const before = replaced ? (await loadConfig(config.path)).adapters?.[name] : undefined;
  const kinds = parsed.kinds ?? before?.kinds ?? ADAPTER_DEFAULT_KINDS;
  const repos = parsed.repos ?? before?.repos;
  const commit = await checkoutCommit(read.dir);
  const entry: AdapterConfig = {
    argv: read.argv,
    kinds,
    ...(repos === undefined ? {} : { repos }),
    ...(commit === null ? {} : { commit }),
    dir: read.dir,
    added: new Date().toISOString(),
  };
  await writeAdapters(config, { ...config.adapters, [name]: entry });
  await adapterOwnerAudit(cliSink).add(name, {
    argv: entry.argv,
    kinds,
    repos: repos?.length ?? null,
    commit: commit !== null,
    replaced,
  });

  console.log(`${replaced ? "replaced" : "added"} adapter ${name} in ${config.path}`);
  console.log(`  argv     ${entry.argv.join(" ")}`);
  console.log(`  kinds    ${kinds.join(", ")}${kinds.includes("request") ? "" : " (request is opt-in: --kinds)"}`);
  console.log(
    `  repos    ${repos === undefined ? "every session on this machine (--repo limits it)" : repos.join(", ")}`,
  );
  console.log(`  commit   ${commit ?? "none: not a git checkout, so doctor cannot tell when its code changes"}`);
  if (replaced) {
    console.log(
      `  its subscriptions end when the daemon reads this config: sessions that messaged it must message it again`,
    );
  }
  const known = new Set(((await readState().catch(() => null))?.repos ?? []).map((repo) => repo.name));
  for (const repo of repos ?? []) {
    if (!known.has(repo)) console.log(`  warn: no scanned repo is named ${repo} (\`seance scan\` lists them)`);
  }
  console.log(`\n${TRUST}.`);
  console.log(
    (await daemonRunning()) === null
      ? "it starts with the daemon."
      : "`seance restart` starts it (the daemon reads config.json at its start).",
  );
}

async function remove(name: string): Promise<void> {
  if (!isAdapterName(name)) return usage();
  const config = await readRawConfig();
  if (config.adapters[name] === undefined) {
    console.error(`no adapter named ${name} in ${config.path}`);
    process.exitCode = 1;
    return;
  }
  const { [name]: _gone, ...rest } = config.adapters;
  await writeAdapters(config, rest);
  await adapterOwnerAudit(cliSink).remove(name);
  console.log(`removed adapter ${name} from ${config.path}; its subscriptions end when the daemon reads this config`);
  console.log(`its own directory, ${join(adaptersDir(), name)}, is left as it is`);
  if ((await daemonRunning()) !== null)
    console.log("`seance restart` stops it (the daemon reads config.json at its start)");
}

async function restart(args: readonly string[]): Promise<void> {
  if (args.length > 1 || (args[0] !== undefined && !isAdapterName(args[0]))) return usage();
  const configured = (await loadConfig()).adapters ?? {};
  const names = args[0] === undefined ? Object.keys(configured) : [args[0]];
  if (names.length === 0) {
    console.error("no adapters are configured on this machine");
    process.exitCode = 1;
    return;
  }
  const missing = names.filter((name) => configured[name] === undefined);
  if (missing.length > 0) {
    console.error(`no adapter named ${missing.join(", ")} in config.json`);
    process.exitCode = 1;
    return;
  }
  const audit = adapterOwnerAudit(cliSink);
  const view = await liveView();
  if (view === null) {
    await Promise.all(names.map(async (name) => audit.restart(name, "not_running")));
    console.error(
      (await daemonRunning()) === null
        ? "the daemon is not running: it starts its adapters when it starts"
        : "the daemon runs no adapters (config.json named none at its start): `seance restart`",
    );
    process.exitCode = 1;
    return;
  }
  const loaded = names.filter((name) => view.adapters[name] !== undefined);
  const unloaded = names.filter((each) => !loaded.includes(each));
  await Promise.all(unloaded.map(async (name) => audit.restart(name, "not_running")));
  for (const name of unloaded) {
    console.log(`${name}: not running in the daemon (added since it started) — \`seance restart\` starts it`);
  }
  if (loaded.length === 0) {
    process.exitCode = 1;
    return;
  }
  const before = new Map(loaded.map((name) => [name, view.adapters[name]?.restarts ?? 0]));
  await requestAdapterRestart(loaded, Date.now());
  await Promise.all(loaded.map(async (name) => audit.restart(name, "requested")));
  const deadline = Date.now() + RESTART_WAIT_MS;
  let seen: AdaptersView | null = view;
  const acted = (): boolean => loaded.every((name) => (seen?.adapters[name]?.restarts ?? 0) > (before.get(name) ?? 0));
  while (!acted() && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling the daemon's view
    await Bun.sleep(200);
    // oxlint-disable-next-line no-await-in-loop -- as above
    seen = await liveView();
  }
  if (!acted()) {
    console.error("the daemon did not take the request within 10 s: is it draining for a restart?");
    process.exitCode = 1;
    return;
  }
  for (const name of loaded) console.log(`${name}: restarted (${seen?.adapters[name]?.state ?? "unknown"})`);
}

const time = (ms: number): string => new Date(ms).toLocaleString();

function stateLine(view: AdapterView): string {
  const proc = view.pid === undefined ? "" : ` (pid ${view.pid}, since ${time(view.startedAt ?? 0)})`;
  return `${view.state}${proc}`;
}

async function status(): Promise<void> {
  const configured = (await loadConfig()).adapters ?? {};
  const names = Object.keys(configured);
  if (names.length === 0) {
    console.log("no adapters are configured on this machine (`seance adapter add <dir>`)");
    return;
  }
  const pid = await daemonRunning();
  const view = await liveView();
  if (pid === null) console.log("the daemon is not running: what follows is config.json only\n");
  for (const name of names) {
    const config = configured[name];
    if (config === undefined) continue;
    const live = view?.adapters[name];
    console.log(name);
    if (pid !== null) {
      if (live === undefined) {
        console.log("  state      not running in the daemon (added since it started: `seance restart`)");
      } else {
        console.log(`  state      ${stateLine(live)}`);
        if (live.protocol !== undefined) {
          console.log(
            `  protocol   ${live.protocol}${live.version === undefined ? "" : `, version ${printable(live.version, 64)}`}`,
          );
        }
        console.log(
          `  counts     ${live.delivered} delivered in, ${live.messages} messages out, ${live.exits} exits, ${live.restarts} restarts by you`,
        );
        if (live.lastExit !== undefined) {
          const { at, code, reason } = live.lastExit;
          console.log(`  last exit  ${time(at)}: ${reason}${code === null ? "" : `, code ${code}`}`);
        }
        if (live.fingerprint !== adapterFingerprint(config)) {
          console.log("  note       config.json changed since the daemon started it: `seance restart`");
        }
      }
    }
    console.log(`  kinds      ${config.kinds.join(", ")}`);
    console.log(`  repos      ${config.repos === undefined ? "all" : config.repos.join(", ")}`);
    if (config.dir !== undefined) console.log(`  dir        ${config.dir}`);
    console.log(`  commit     ${config.commit === undefined ? "none recorded" : config.commit.slice(0, 12)}`);
  }
}
