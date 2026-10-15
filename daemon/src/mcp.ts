import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  failureReasonText,
  importPsk,
  RequestFailure,
  type DespawnRequest,
  type DespawnResponse,
  type ErrorResponse,
  type Machine,
  type RepoEntry,
  type RequestOp,
  type SessionsResponse,
  type SpawnClient,
  type SpawnRequest,
  type SpawnResponse,
} from "@seance/shared";
import { appRelayClient, LazyRelay } from "./app-relay.ts";
import { BrokerError } from "./broker-client.ts";
import type { Check } from "./check.ts";
import { loadConfig, loadPsk, type Config } from "./config.ts";
import { exec } from "./exec.ts";
import {
  brokerFailureText,
  brokerFleet,
  FleetUnreachable,
  relayFleet,
  selectFleet,
  type Fleet,
  type FleetLease,
} from "./fleet.ts";
import { recordedBunCheck } from "./link.ts";
import { localRequest, localSocketReachable, LocalUnavailable } from "./local-client.ts";
import { readState } from "./state.ts";

/**
 * What this box is, and how to reach its daemon without the relay.
 *
 * Resolved from `config.json` and `state.json` rather than from the registry, so
 * recognising a target as local never depends on the relay being up — which is
 * what lets a local request fail with "the daemon isn't running" instead of
 * quietly paying a round trip to Cloudflare to be told the same thing.
 *
 * `request` is injectable so the tools can be driven without a socket; in
 * production it is `localRequest`.
 */
export interface LocalMachine {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  /**
   * Re-read per call, not snapshotted: the daemon rewrites state.json on every
   * rescan and `seanced mcp` outlives many of them. A snapshot rejects a repo
   * cloned since startup, and rejects every repo if the first scan hadn't landed.
   */
  readonly repos: () => Promise<readonly RepoEntry[]>;
  readonly request: <T>(op: RequestOp, payload: unknown) => Promise<T>;
  /** Whether its daemon is listening, asked without sending an op — nothing is run or audited. */
  readonly reachable: () => Promise<boolean>;
}

/**
 * Whether a tool's `machine` argument names this box. Same precedence as
 * `resolveMachine`: a deviceId matches exactly, a name case-insensitively.
 *
 * Local wins over a remote machine of the same name, deliberately — the point of
 * the short circuit is that the common case takes no round trip, and a name
 * collision is exactly what `deviceId` is the escape hatch for.
 */
export function isLocalRef(local: LocalMachine, ref: string): boolean {
  return ref === local.deviceId || ref.toLowerCase() === local.name.toLowerCase();
}

/**
 * `machine` is the human name from the target's config, resolved against the
 * live registry; a deviceId is accepted as the exact-match escape hatch for
 * names that collide. Misses come back with the candidates, because the model
 * on the other end of this tool can correct itself from a good error.
 */
export function resolveMachine(
  machines: readonly Machine[],
  ref: string,
): { readonly machine: Machine } | { readonly error: string } {
  const byId = machines.find((machine) => machine.deviceId === ref);
  if (byId !== undefined) return { machine: byId };
  const named = machines.filter((machine) => machine.name.toLowerCase() === ref.toLowerCase());
  const [only] = named;
  if (named.length === 1 && only !== undefined) return { machine: only };
  if (named.length > 1) {
    const ids = named.map((machine) => `${machine.name} (${machine.deviceId})`).join(", ");
    return { error: `"${ref}" names more than one machine — use a deviceId: ${ids}` };
  }
  const known = machines.map((machine) => machine.name).join(", ");
  return { error: `no machine named "${ref}" — known machines: ${known === "" ? "(none registered)" : known}` };
}

interface ToolResult {
  [key: string]: unknown;
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const errorResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function describeMachine(machine: Machine, local: LocalMachine | null): Record<string, unknown> {
  return {
    name: machine.name,
    deviceId: machine.deviceId,
    platform: machine.platform,
    connected: machine.connected,
    lastSeen: new Date(machine.lastSeen).toISOString(),
    repos: machine.repos.map((repo) => repo.name),
    // Named so the model knows which target costs nothing to reach; spawning
    // there goes straight to the daemon on this box.
    local: local !== null && machine.deviceId === local.deviceId,
  };
}

/** The local machine as `list_machines` renders it when the relay cannot be reached at all. */
async function describeLocal(local: LocalMachine, reachable: boolean): Promise<Record<string, unknown>> {
  return {
    name: local.name,
    deviceId: local.deviceId,
    platform: local.platform,
    connected: reachable,
    repos: (await local.repos()).map((repo) => repo.name),
    local: true,
  };
}

/** `LocalUnavailable` is the one worth naming a fix for — here, so every flavour of it carries the advice. */
function localFailureText(op: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof LocalUnavailable) {
    return `${op} failed: ${detail} — is seanced running? try \`seanced status\``;
  }
  return `${op} failed: ${detail}`;
}

/**
 * Both legs need this: a handler that throws answers with an `ErrorResponse`, and
 * neither client treats that as a failure — `RequestFailure` is the relay refusing
 * to deliver, not the daemon refusing to serve. Unchecked, `sessions` is undefined
 * and `JSON.stringify` hands `textResult` a non-string.
 */
function renderSessions(reply: SessionsResponse | ErrorResponse): ToolResult {
  if ("ok" in reply) return errorResult(`get_sessions failed (${reply.code}): ${reply.message}`);
  return textResult(JSON.stringify(reply.sessions, null, 2));
}

/** One line per failure whichever transport carried it: a brokered `RequestFailure` renders as the direct one does. */
function failureText(op: string, err: unknown): string {
  const detail =
    err instanceof RequestFailure
      ? failureReasonText(err)
      : err instanceof BrokerError
        ? brokerFailureText(err)
        : err instanceof Error
          ? err.message
          : String(err);
  return `${op} failed: ${detail}`;
}

/** Why the fleet could not be opened at all. A keyless box's reason is self-explanatory; a direct failure is the relay's. */
function openFailureText(err: unknown): string {
  return err instanceof FleetUnreachable ? err.message : failureText("connecting to the relay", err);
}

/**
 * The MCP face of Séance: four tools mapping 1:1 onto the registry and the
 * `sessions`/`spawn`/`despawn` ops. Anything this hands to the relay rides the same
 * envelope crypto as the PWA — there is no separate MCP wire surface, whether
 * this process seals it or the daemon's broker does (`fleet.ts`).
 *
 * `local` is what makes a self-targeted call skip the relay: the per-machine
 * ops go straight to this box's daemon over its op socket, which is the same
 * handler the relay leg reaches and so the same backend, repo set, machineTag
 * and audit trail — only tagged `origin=local`. Null on a box with no daemon
 * state, where every target is remote by definition.
 */
export function buildMcpServer(fleet: Fleet, local: LocalMachine | null = null): McpServer {
  // 0.0.0 mirrors the package: the daemon versions by git sha, not semver.
  const server = new McpServer({ name: "seance", version: "0.0.0" });

  // Every tool bumps the idle clock via open/release, even ones that fail.
  const withFleet = async (fn: (lease: FleetLease) => Promise<ToolResult>): Promise<ToolResult> => {
    let lease: FleetLease;
    try {
      lease = await fleet.open();
    } catch (err) {
      return errorResult(openFailureText(err));
    }
    try {
      return await fn(lease);
    } finally {
      lease.release();
    }
  };

  server.registerTool(
    "list_machines",
    {
      title: "List machines",
      description:
        "List the dev machines registered with the Séance relay: name, platform, connectivity, and the repos each one can spawn a Claude Code session in. Offline machines are listed with their last-seen time.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      let lease: FleetLease;
      try {
        lease = await fleet.open();
      } catch (err) {
        // The fleet needs the relay, but this box does not. Answering with the
        // local machine alone beats answering with nothing: a model that cannot
        // see any machine cannot spawn on the one it is sitting on either.
        if (local === null) return errorResult(openFailureText(err));
        const why =
          err instanceof FleetUnreachable ? err.message : `the relay is unreachable (${failureText("connect", err)})`;
        // Probed, not assumed: local ops need this box's daemon, and the reason
        // the fleet is out of reach may be that the daemon is down too.
        const reachable = await local.reachable();
        return textResult(
          JSON.stringify(
            {
              machines: [await describeLocal(local, reachable)],
              note: reachable
                ? `${why} — only this machine is listed, and only local spawns will work`
                : `${why} — only this machine is listed, and its daemon is not listening either, so nothing ` +
                  "will spawn until seanced is running (`seanced status`)",
            },
            null,
            2,
          ),
        );
      }
      try {
        const machines = lease.machines.map((machine) => describeMachine(machine, local));
        return textResult(JSON.stringify(machines, null, 2));
      } finally {
        lease.release();
      }
    },
  );

  server.registerTool(
    "get_sessions",
    {
      title: "List running sessions",
      description:
        "List the Claude Code tmux sessions currently running on a machine. Naming this machine answers from the local daemon without touching the relay.",
      inputSchema: z.object({ machine: z.string().describe("Machine name (or deviceId) from list_machines") }),
      annotations: { readOnlyHint: true },
    },
    async ({ machine }) => {
      if (local !== null && isLocalRef(local, machine)) {
        try {
          return renderSessions(await local.request<SessionsResponse | ErrorResponse>("sessions", {}));
        } catch (err) {
          return errorResult(localFailureText("get_sessions", err));
        }
      }
      return withFleet(async (lease) => {
        const resolved = resolveMachine(lease.machines, machine);
        if ("error" in resolved) return errorResult(resolved.error);
        try {
          return renderSessions(
            await lease.request<SessionsResponse | ErrorResponse>(resolved.machine.deviceId, "sessions", {}),
          );
        } catch (err) {
          return errorResult(failureText("get_sessions", err));
        }
      });
    },
  );

  server.registerTool(
    "spawn_session",
    {
      title: "Spawn a Claude Code session",
      description:
        "Spawn a remote-controlled Claude Code session on a machine, in a named repo. Defaults to a fresh git worktree; mode \"here\" runs in the repo's main checkout instead. Naming this machine goes straight to the local daemon, with no relay round trip; if a remote machine shares this one's name, reach it by deviceId.",
      inputSchema: z.object({
        machine: z.string().describe("Machine name (or deviceId) from list_machines"),
        repo: z.string().describe("Repo name from that machine's repo list"),
        prompt: z.string().optional().describe("The task for the spawned session"),
        title: z
          .string()
          .optional()
          .describe(
            "Name for the spawned Claude session — also names the window the backend runs it in, and the worktree branched for it. Defaults to a slug of the prompt.",
          ),
        mode: z.enum(["worktree", "here"]).default("worktree"),
        model: z.string().optional().describe('Model for the session, e.g. "opus"'),
        effort: z.string().optional().describe('Reasoning effort, e.g. "medium"'),
        plan: z
          .boolean()
          .optional()
          .describe(
            "Start the session in plan mode: it researches and writes an implementation plan for approval instead of editing files. Set this when the request is to plan, design, investigate or scope work rather than carry it out. Omit it otherwise.",
          ),
      }),
      annotations: { readOnlyHint: false },
    },
    async ({ machine, repo, prompt, title, mode, model, effort, plan }) => {
      const request: SpawnRequest = {
        repo,
        mode,
        client: "mcp" satisfies SpawnClient,
        ...(prompt === undefined ? {} : { prompt }),
        ...(title === undefined ? {} : { title }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(plan === undefined ? {} : { plan }),
      };
      const rendered = (reply: SpawnResponse, where: string): ToolResult => {
        if (!reply.ok) return errorResult(`spawn failed (${reply.code}): ${reply.message}`);
        const note = reply.note === undefined ? "" : `\nnote: ${reply.note}`;
        const state = reply.pending === true ? " (started, not registered yet)" : "";
        return textResult(`spawned window ${reply.window} on ${where} at ${reply.path}${state}${note}`);
      };

      if (local !== null && isLocalRef(local, machine)) {
        // Same pre-check as the relay path and for the same reason — the daemon
        // resolves the repo authoritatively, this just answers with candidates
        // instead of costing a round trip to be told `repo_not_found`. An empty
        // set means the first scan hasn't landed, not that there are no repos:
        // deny nothing then, and let the daemon answer.
        const repos = await local.repos();
        if (repos.length > 0 && !repos.some((entry) => entry.name === repo)) {
          const known = repos.map((entry) => entry.name).join(", ");
          return errorResult(`${local.name} has no repo named "${repo}" — its repos: ${known}`);
        }
        try {
          return rendered(await local.request<SpawnResponse>("spawn", request), local.name);
        } catch (err) {
          return errorResult(localFailureText("spawn_session", err));
        }
      }

      return withFleet(async (lease) => {
        const resolved = resolveMachine(lease.machines, machine);
        if ("error" in resolved) return errorResult(resolved.error);
        const target = resolved.machine;
        if (!target.connected) {
          return errorResult(`${target.name} is not connected — last seen ${new Date(target.lastSeen).toISOString()}`);
        }
        if (!target.repos.some((entry) => entry.name === repo)) {
          const known = target.repos.map((entry) => entry.name).join(", ");
          return errorResult(`${target.name} has no repo named "${repo}" — its repos: ${known}`);
        }
        try {
          return rendered(await lease.request<SpawnResponse>(target.deviceId, "spawn", request), target.name);
        } catch (err) {
          return errorResult(failureText("spawn_session", err));
        }
      });
    },
  );

  server.registerTool(
    "despawn_session",
    {
      title: "End a Claude Code session",
      description:
        "End a running Claude Code session on a machine and close its window. Asks claude to /exit — a worktree session keeps its worktree — and kills it if it hasn't exited within about five seconds; force kills straight away. Take the id from get_sessions. Naming this machine goes straight to the local daemon.",
      inputSchema: z.object({
        machine: z.string().describe("Machine name (or deviceId) from list_machines"),
        id: z.string().describe('The session\'s id from get_sessions, e.g. "%12"'),
        force: z.boolean().optional().describe("Kill without asking claude to exit first"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ machine, id, force }) => {
      const request: DespawnRequest = {
        id,
        client: "mcp" satisfies SpawnClient,
        ...(force === true ? { force } : {}),
      };
      // An `ErrorResponse` (a crashed handler) is `ok: false` too, and renders the same way.
      const rendered = (reply: DespawnResponse | ErrorResponse, where: string): ToolResult => {
        if (!reply.ok) return errorResult(`despawn failed (${reply.code}): ${reply.message}`);
        return textResult(`${reply.outcome} ${reply.window} on ${where}`);
      };

      if (local !== null && isLocalRef(local, machine)) {
        try {
          return rendered(await local.request<DespawnResponse | ErrorResponse>("despawn", request), local.name);
        } catch (err) {
          return errorResult(localFailureText("despawn_session", err));
        }
      }

      return withFleet(async (lease) => {
        const resolved = resolveMachine(lease.machines, machine);
        if ("error" in resolved) return errorResult(resolved.error);
        const target = resolved.machine;
        if (!target.connected) {
          return errorResult(`${target.name} is not connected — last seen ${new Date(target.lastSeen).toISOString()}`);
        }
        try {
          return rendered(
            await lease.request<DespawnResponse | ErrorResponse>(target.deviceId, "despawn", request),
            target.name,
          );
        } catch (err) {
          return errorResult(failureText("despawn_session", err));
        }
      });
    },
  );

  return server;
}

/**
 * This box, as the tools see it, or null when no daemon state exists here — a
 * checkout that has never run `seanced` has no deviceId, and `readState` will
 * not invent one just to answer the question.
 */
export async function localMachine(config: Config): Promise<LocalMachine | null> {
  const state = await readState();
  if (state === null) return null;
  return {
    deviceId: state.deviceId,
    name: config.name,
    platform: process.platform,
    // Falls back to the startup read: a transient failure shouldn't read as "no repos".
    repos: async (): Promise<readonly RepoEntry[]> => (await readState())?.repos ?? state.repos,
    request: <T>(op: RequestOp, payload: unknown): Promise<T> => localRequest<T>(op, payload),
    reachable: (): Promise<boolean> => localSocketReachable(),
  };
}

/**
 * The fleet as `seanced mcp` reaches it. The PSK is resolved on first remote
 * use, not at startup, because local ops need no key at all; when this process
 * can read none — the key exists only as a credential systemd delivers to the
 * daemon's unit — remote ops go through the daemon's broker instead, and the
 * key never enters this process. `selectFleet` memoizes the direct choice and
 * re-asks the stores after a while when there was nothing to find.
 */
function mcpFleet(config: Config): Fleet {
  return selectFleet({
    key: async (): Promise<CryptoKey | null> => {
      const resolved = await loadPsk(config);
      return resolved === null ? null : importPsk(resolved.psk);
    },
    direct: (key) =>
      relayFleet(
        // stdout carries the protocol frames — the wire log must land on stderr.
        new LazyRelay({ create: () => appRelayClient(config, key, (line) => console.error(line)) }),
      ),
    broker: brokerFleet(),
  });
}

/** `seanced mcp` — serve MCP over stdio until the client hangs up. */
export async function runMcpServer(): Promise<void> {
  const config = await loadConfig();
  const local = await localMachine(config);
  const fleet = mcpFleet(config);
  const handle = serveStdio(() => buildMcpServer(fleet, local), {
    onerror: (err) => console.error(`mcp: ${err.message}`),
  });
  await new Promise<void>((resolve) => {
    // The SDK's stdio transport watches 'data' but never 'end', so a client
    // that exits without signalling would leave this process — and any open
    // relay socket — orphaned behind it.
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
  });
  await handle.close();
  fleet.stop();
  process.exit(0);
}

/** `Command:` line of `claude mcp get` — the interpreter Claude Code will exec. Null when the output doesn't parse. */
export function mcpBunPath(output: string): string | null {
  return /^\s*Command:\s*(.+?)\s*$/mu.exec(output)?.[1] ?? null;
}

/** Whether the local Claude Code knows about `seanced mcp`, and whether its recorded bun still resolves; renders under doctor's binaries section. */
export async function mcpChecks(): Promise<readonly Check[]> {
  const claude = Bun.which("claude");
  if (claude === null) {
    return [{ level: "warn", message: "claude not on PATH — `seanced mcp install` needs Claude Code" }];
  }
  const result = await exec([claude, "mcp", "get", "seance"], { timeoutMs: 15_000 });
  if (result.exitCode !== 0) {
    return [{ level: "warn", message: "MCP server not registered with Claude Code — run `seanced mcp install`" }];
  }
  const registered: Check = { level: "ok", message: "MCP server registered with Claude Code" };
  // Same drift hazard as the plist/unit: `mcp install` records PATH's bun in
  // Claude's config, and nothing rewrites that entry on its own.
  const drift = await recordedBunCheck(mcpBunPath(result.stdout), "MCP entry", "seanced mcp install");
  return drift === null ? [registered] : [registered, drift];
}
