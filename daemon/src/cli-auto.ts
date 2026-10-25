import { appRelayClient, importAppKeys, LazyRelay } from "./app-relay.ts";
import { cliSink, type AuditSink } from "./audit.ts";
import {
  enqueueAuto,
  pinAccountGateError,
  placementInputError,
  placementNeedsPinAccount,
  resolveOrigin,
  resolvePlacement,
  specError,
  type AutoEnqueued,
  type AutoSpec,
  type PlacementInput,
  type PlacementNames,
} from "./auto.ts";
import type { SpawnCliArgs } from "./cli.ts";
import { BrokerError, type BrokerCallOpts } from "./broker-client.ts";
import { loadConfig, loadPsk, type Config } from "./config.ts";
import {
  brokerFailureText,
  brokerFleet,
  relayFleet,
  SCHEDULER_NEEDS_NEWER_DAEMON,
  type Fleet,
  type FleetLease,
} from "./fleet.ts";
import type { PskStore } from "./psk-store.ts";
import { readState } from "./state.ts";

// `seanced spawn --auto`: queue the spawn for the scheduler as an app-role
// client, as `seanced mcp`'s `auto` does — a sealed task `store-put` at
// `expect: 0`, so it queues with no leader up. A shell that can read the PSK
// dials the relay itself; one that cannot (a credential-delivered box, where
// only the service sees the key) asks the daemon's broker, which seals and
// sends it. A direct `seanced spawn` stays relay-free.

export interface AutoFleetOpts {
  /** Tests point these at stores that cannot exist. */
  readonly stores?: readonly PskStore[];
  readonly connectTimeoutMs?: number;
  /** Where the broker's socket is, for a shell with no key; tests point it at a double. */
  readonly broker?: BrokerCallOpts;
}

/** The direct app-role fleet over this shell's own key, or the daemon's broker when it has none. */
export async function autoFleet(config: Config, opts: AutoFleetOpts = {}): Promise<{ readonly fleet: Fleet }> {
  const resolved = await loadPsk(config, opts.stores);
  if (resolved === null) return { fleet: brokerFleet(opts.broker) };
  const keys = await importAppKeys(resolved.psk);
  const relay = new LazyRelay({
    // The wire log is the client's per-frame chatter; the outcome line is this command's answer.
    create: () => appRelayClient(config, keys, () => {}),
    ...(opts.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: opts.connectTimeoutMs }),
  });
  return { fleet: relayFleet(relay) };
}

const failed = (text: string): AutoEnqueued => ({ ok: false, text });

const CLI_PLACEMENT_NAMES: PlacementNames = { machine: "--machine", account: "--account", avoid: "--not" };

/** The word `--machine` and `--not` take for this box, resolved to its deviceId. */
const HERE = "here";

/** This box's deviceId from its state file; null before the daemon's first run. */
async function ownDeviceId(): Promise<string | null> {
  return (await readState())?.deviceId ?? null;
}

/**
 * `here` as this box's deviceId — the registry's own key for it, so a name
 * another machine shares cannot misdirect it. Any other ref passes as given.
 */
async function hereResolved(
  args: SpawnCliArgs,
  self: () => Promise<string | null>,
): Promise<{ readonly input: PlacementInput } | { readonly error: string }> {
  const refs = [args.machine, ...(args.not ?? [])];
  if (!refs.some((ref) => ref?.toLowerCase() === HERE)) {
    return { input: { machine: args.machine, account: args.account, avoid: args.not } };
  }
  const deviceId = await self();
  if (deviceId === null) {
    return {
      error: "`here` names this machine, which has no seanced state yet — start the daemon once, or give its name",
    };
  }
  const swap = (ref: string): string => (ref.toLowerCase() === HERE ? deviceId : ref);
  return {
    input: {
      machine: args.machine === undefined ? undefined : swap(args.machine),
      account: args.account,
      avoid: args.not?.map(swap),
    },
  };
}

export interface SpawnAutoOpts {
  /** What `here` resolves to; tests stand in for the state file. */
  readonly self?: () => Promise<string | null>;
}

/**
 * The spec from the CLI's flags — repo, mode, title, prompt, the fields both
 * forms share — resolved to the origin the scheduler keys repos by, and the
 * placement flags to the ids the spec stores.
 */
export async function spawnAuto(
  args: SpawnCliArgs,
  fleet: Fleet,
  audit: AuditSink,
  opts: SpawnAutoOpts = {},
): Promise<AutoEnqueued> {
  const spec: AutoSpec = {
    repo: args.repo,
    mode: args.here ? "here" : "worktree",
    ...(args.title === undefined ? {} : { title: args.title }),
    ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
  };
  // Refused before the relay is dialled: no round trip to learn the prompt is too long.
  const invalid = specError(spec, "cli");
  if (invalid !== null) return failed(`auto refused: ${invalid}`);
  const placement = await hereResolved(args, opts.self ?? ownDeviceId);
  if ("error" in placement) return failed(`auto refused: ${placement.error}`);
  const placementInvalid = placementInputError(placement.input, CLI_PLACEMENT_NAMES);
  if (placementInvalid !== null) return failed(`auto refused: ${placementInvalid}`);
  let lease: FleetLease;
  try {
    lease = await fleet.open();
  } catch (err) {
    const why = err instanceof BrokerError ? brokerFailureText(err) : err instanceof Error ? err.message : String(err);
    return failed(`auto: not queued — ${why}`);
  }
  try {
    if (lease.scheduler === null) return failed(`--auto unavailable: ${SCHEDULER_NEEDS_NEWER_DAEMON}`);
    const leg = { machines: lease.machines, scheduler: lease.scheduler };
    // Before any account listing: a leader that cannot route on them never gets the fields.
    if (placementNeedsPinAccount(placement.input)) {
      const gate = pinAccountGateError(leg, "--account / --not");
      if (gate !== null) return failed(gate);
    }
    const placed = await resolvePlacement(leg.machines, leg.scheduler.accounts, placement.input, CLI_PLACEMENT_NAMES);
    if ("error" in placed) return failed(`auto refused: ${placed.error}`);
    const resolved = resolveOrigin(placed.machines, args.repo, placed.scope);
    if ("error" in resolved) return failed(`auto refused: ${resolved.error}`);
    const resolvedSpec: AutoSpec = { ...spec, repo: resolved.origin, ...placed.fields };
    const longOrigin = specError(resolvedSpec, "cli");
    if (longOrigin !== null) return failed(`auto refused: ${longOrigin}`);
    const enqueued = await enqueueAuto(lease.scheduler, resolvedSpec, audit, "cli");
    return placed.echo === null || !enqueued.ok ? enqueued : { ...enqueued, text: `${enqueued.text}\n${placed.echo}` };
  } finally {
    lease.release();
  }
}

export async function cmdSpawnAuto(args: SpawnCliArgs): Promise<void> {
  const config = await loadConfig();
  const built = await autoFleet(config);
  const outcome = await spawnAuto(args, built.fleet, cliSink).finally(() => built.fleet.stop());
  if (!outcome.ok) {
    console.error(outcome.text);
    process.exit(1);
  }
  console.log(outcome.text);
  // As `seanced mcp` exits explicitly: a socket stuck closing must not hold the shell.
  process.exit(0);
}
