import { importPsk } from "@seance/shared";
import { appRelayClient, LazyRelay } from "./app-relay.ts";
import { cliSink, type AuditSink } from "./audit.ts";
import { enqueueAuto, resolveOrigin, specError, type AutoEnqueued, type AutoSpec } from "./auto.ts";
import type { SpawnCliArgs } from "./cli.ts";
import { loadConfig, loadPsk, type Config } from "./config.ts";
import { relayFleet, type Fleet, type FleetLease } from "./fleet.ts";
import type { PskStore } from "./psk-store.ts";

// `seanced spawn --auto`: queue the spawn for the scheduler as an app-role
// client, as `seanced mcp`'s `auto` does — a sealed task `store-put` at
// `expect: 0`, so it queues with no leader up. The one CLI form that dials the
// relay and needs the PSK; a direct `seanced spawn` stays relay-free.

/**
 * The broker's actions are fixed (DESIGN.md "Fleet broker") and enqueue is not
 * one, so a box whose key only the service can read gets no `--auto` — and no
 * fallback, as MCP's `auto` refuses there.
 */
export const KEYLESS_TEXT =
  "--auto needs this machine's own key, and this shell can read none (where only the seanced service can read it, that is by design) — `seanced doctor` says why; a spawn without --auto needs no key";

export interface AutoFleetOpts {
  /** Tests point these at stores that cannot exist. */
  readonly stores?: readonly PskStore[];
  readonly connectTimeoutMs?: number;
}

/** The direct app-role fleet over this shell's own key, or why there is none. */
export async function autoFleet(
  config: Config,
  opts: AutoFleetOpts = {},
): Promise<{ readonly fleet: Fleet } | { readonly error: string }> {
  const resolved = await loadPsk(config, opts.stores);
  if (resolved === null) return { error: KEYLESS_TEXT };
  const key = await importPsk(resolved.psk);
  const relay = new LazyRelay({
    // The wire log is the client's per-frame chatter; the outcome line is this command's answer.
    create: () => appRelayClient(config, key, () => {}),
    ...(opts.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: opts.connectTimeoutMs }),
  });
  return { fleet: relayFleet(relay) };
}

const failed = (text: string): AutoEnqueued => ({ ok: false, text });

/**
 * The spec from the CLI's flags — repo, mode, title, prompt, the fields both
 * forms share — resolved to the origin the scheduler keys repos by.
 */
export async function spawnAuto(args: SpawnCliArgs, fleet: Fleet, audit: AuditSink): Promise<AutoEnqueued> {
  const spec: AutoSpec = {
    repo: args.repo,
    mode: args.here ? "here" : "worktree",
    ...(args.title === undefined ? {} : { title: args.title }),
    ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
  };
  // Refused before the relay is dialled: no round trip to learn the prompt is too long.
  const invalid = specError(spec, "cli");
  if (invalid !== null) return failed(`auto refused: ${invalid}`);
  let lease: FleetLease;
  try {
    lease = await fleet.open();
  } catch (err) {
    return failed(`auto: not queued — ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    if (lease.scheduler === null) return failed(KEYLESS_TEXT);
    const resolved = resolveOrigin(lease.machines, args.repo);
    if ("error" in resolved) return failed(`auto refused: ${resolved.error}`);
    const resolvedSpec: AutoSpec = { ...spec, repo: resolved.origin };
    const longOrigin = specError(resolvedSpec, "cli");
    if (longOrigin !== null) return failed(`auto refused: ${longOrigin}`);
    return await enqueueAuto(lease.scheduler, resolvedSpec, audit, "cli");
  } finally {
    lease.release();
  }
}

export async function cmdSpawnAuto(args: SpawnCliArgs): Promise<void> {
  const config = await loadConfig();
  const built = await autoFleet(config);
  if ("error" in built) {
    console.error(built.error);
    process.exit(1);
  }
  const outcome = await spawnAuto(args, built.fleet, cliSink).finally(() => built.fleet.stop());
  if (!outcome.ok) {
    console.error(outcome.text);
    process.exit(1);
  }
  console.log(outcome.text);
  // As `seanced mcp` exits explicitly: a socket stuck closing must not hold the shell.
  process.exit(0);
}
