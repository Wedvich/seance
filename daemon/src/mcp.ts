import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  appRelayUrl,
  failureReasonText,
  importPsk,
  RelayClient,
  RequestFailure,
  type Machine,
  type RelayState,
  type RepoEntry,
  type RequestOp,
  type SessionsResponse,
  type SpawnClient,
  type SpawnRequest,
  type SpawnResponse,
} from "@seance/shared";
import type { Check } from "./check.ts";
import { loadConfig, loadPsk, type Config } from "./config.ts";
import { exec } from "./exec.ts";
import { recordedBunCheck } from "./link.ts";
import { localRequest, LocalUnavailable } from "./local-client.ts";
import { readState } from "./state.ts";

/**
 * The slice of the shared app-role RelayClient the tools consume — injectable
 * so tests can drive the tools without a socket. The relay is a network
 * boundary; the client itself is exercised against the real one in e2e.
 */
export interface AppRelay {
  readonly start: () => void;
  readonly stop: () => void;
  readonly getState: () => RelayState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly request: <T>(deviceId: string, op: RequestOp, payload: unknown) => Promise<T>;
}

/**
 * A Claude session can sit open for hours between tool calls, so the socket
 * dials on the first call and hangs up after this much silence rather than
 * holding an app socket per session. Comfortably past the longest op timeout
 * (spawn, 90s), so the line never drops under an in-flight call — and the
 * in-flight count below guards that anyway.
 */
const IDLE_MS = 5 * 60_000;

/** Bounds `acquire` when the relay is down; past it the call fails instead of riding the backoff forever. */
const CONNECT_TIMEOUT_MS = 10_000;

export interface LazyRelayOpts {
  /**
   * Async because the PSK is resolved here rather than at startup: local ops
   * need no key, so a box whose key only exists as a systemd-delivered
   * credential still gets a working MCP server for itself, and only a remote
   * op pays the "no PSK" error.
   */
  readonly create: () => AppRelay | Promise<AppRelay>;
  readonly idleMs?: number;
  readonly connectTimeoutMs?: number;
}

/**
 * Lazy-connect wrapper: `acquire` before a tool call, `release` after. The
 * client connects on first use, is shared by concurrent calls, and is stopped
 * once idle — the next call redials and gets a fresh registry push.
 */
export class LazyRelay {
  readonly #opts: LazyRelayOpts;
  #client: AppRelay | null = null;
  #connecting: Promise<AppRelay> | null = null;
  #inFlight = 0;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(opts: LazyRelayOpts) {
    this.#opts = opts;
  }

  async acquire(): Promise<AppRelay> {
    if (this.#stopped) throw new Error("the relay client is stopped");
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.#inFlight += 1;
    try {
      if (this.#client !== null) return this.#client;
      this.#connecting ??= this.#connect();
      return await this.#connecting;
    } catch (err) {
      this.#inFlight -= 1;
      throw err;
    } finally {
      this.#connecting = null;
    }
  }

  release(): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    if (this.#inFlight > 0 || this.#client === null) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#inFlight > 0) return;
      this.#client?.stop();
      this.#client = null;
    }, this.#opts.idleMs ?? IDLE_MS);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.#client?.stop();
    this.#client = null;
  }

  async #connect(): Promise<AppRelay> {
    // Awaited before `start()`, so a create that throws — an unresolvable PSK —
    // propagates with nothing to tear down.
    const client = await this.#opts.create();
    client.start();
    try {
      await this.#waitOpen(client);
      await this.#settleRegistry(client);
      // stop() may have raced this connect; adopting the client now would
      // leak its socket and heartbeat with no owner left to stop them.
      if (this.#stopped) throw new Error("stopped while connecting to the relay");
    } catch (err) {
      client.stop();
      throw err;
    }
    this.#client = client;
    return client;
  }

  async #waitOpen(client: AppRelay): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`the relay did not answer within ${this.#opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS}ms`));
      }, this.#opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
      // Referenced from the closures above and below, assigned before either can run:
      // the timer is async and check() is only called after subscribe returns.
      const check = (): void => {
        const state = client.getState();
        if (state.status === "open") {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        } else if (state.status === "rejected") {
          clearTimeout(timer);
          unsubscribe();
          reject(
            new Error(
              state.rejection === "unauthorized"
                ? "the relay rejected the bearer token — check bearerToken in config.json"
                : "the relay rejected the connection as malformed",
            ),
          );
        }
      };
      const unsubscribe = client.subscribe(check);
      check();
    });
  }

  /**
   * Waits for the client to mark this socket's registry authoritative. Bounded
   * by the client itself: `registrySettled` flips within REGISTRY_SETTLE_MS of
   * `open` even if no registry frame ever arrives.
   */
  async #settleRegistry(client: AppRelay): Promise<void> {
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (!client.getState().registrySettled) return;
        unsubscribe();
        resolve();
      };
      const unsubscribe = client.subscribe(check);
      check();
    });
  }
}

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
  /** The daemon's own persisted scan set — it rewrites state.json on every rescan. */
  readonly repos: readonly RepoEntry[];
  readonly request: <T>(op: RequestOp, payload: unknown) => Promise<T>;
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
function describeLocal(local: LocalMachine): Record<string, unknown> {
  return {
    name: local.name,
    deviceId: local.deviceId,
    platform: local.platform,
    connected: true,
    repos: local.repos.map((repo) => repo.name),
    local: true,
  };
}

/** A local op could not be reached or refused; `LocalUnavailable` is the one worth naming a fix for. */
function localFailureText(op: string, err: unknown): string {
  if (err instanceof LocalUnavailable) {
    return `${op} failed: ${err.message}`;
  }
  return `${op} failed: ${err instanceof Error ? err.message : String(err)}`;
}

function failureText(op: string, err: unknown): string {
  const detail =
    err instanceof RequestFailure ? failureReasonText(err) : err instanceof Error ? err.message : String(err);
  return `${op} failed: ${detail}`;
}

/**
 * The MCP face of Séance: three tools mapping 1:1 onto the registry and the
 * `sessions`/`spawn` ops. Anything this hands to the relay rides the same
 * envelope crypto as the PWA — there is no separate MCP wire surface.
 *
 * `local` is what makes a self-targeted call skip the relay: the per-machine
 * ops go straight to this box's daemon over its op socket, which is the same
 * handler the relay leg reaches and so the same backend, repo set, machineTag
 * and audit trail — only tagged `origin=local`. Null on a box with no daemon
 * state, where every target is remote by definition.
 */
export function buildMcpServer(relay: LazyRelay, local: LocalMachine | null = null): McpServer {
  // 0.0.0 mirrors the package: the daemon versions by git sha, not semver.
  const server = new McpServer({ name: "seance", version: "0.0.0" });

  // Every tool bumps the idle clock via acquire/release, even ones that fail.
  const withRelay = async (fn: (client: AppRelay) => Promise<ToolResult>): Promise<ToolResult> => {
    let client: AppRelay;
    try {
      client = await relay.acquire();
    } catch (err) {
      return errorResult(failureText("connecting to the relay", err));
    }
    try {
      return await fn(client);
    } finally {
      relay.release();
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
      let client: AppRelay;
      try {
        client = await relay.acquire();
      } catch (err) {
        // The fleet needs the relay, but this box does not. Answering with the
        // local machine alone beats answering with nothing: on a
        // credential-delivered box the relay is unreachable by construction, and
        // a model that cannot see any machine cannot spawn on the one it is
        // sitting on either.
        if (local === null) return errorResult(failureText("connecting to the relay", err));
        return textResult(
          JSON.stringify(
            {
              machines: [describeLocal(local)],
              note: `the relay is unreachable (${failureText("connect", err)}) — only this machine is listed, and only local spawns will work`,
            },
            null,
            2,
          ),
        );
      }
      try {
        const machines = client.getState().machines.map((machine) => describeMachine(machine, local));
        return textResult(JSON.stringify(machines, null, 2));
      } finally {
        relay.release();
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
          const reply = await local.request<SessionsResponse>("sessions", {});
          return textResult(JSON.stringify(reply.sessions, null, 2));
        } catch (err) {
          return errorResult(localFailureText("get_sessions", err));
        }
      }
      return withRelay(async (client) => {
        const resolved = resolveMachine(client.getState().machines, machine);
        if ("error" in resolved) return errorResult(resolved.error);
        try {
          const reply = await client.request<SessionsResponse>(resolved.machine.deviceId, "sessions", {});
          return textResult(JSON.stringify(reply.sessions, null, 2));
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
        return textResult(`spawned window ${reply.window} on ${where} at ${reply.path}${note}`);
      };

      if (local !== null && isLocalRef(local, machine)) {
        // Same pre-check as the relay path and for the same reason — the daemon
        // resolves the repo authoritatively, this just answers with candidates
        // instead of costing a round trip to be told `repo_not_found`.
        if (!local.repos.some((entry) => entry.name === repo)) {
          const known = local.repos.map((entry) => entry.name).join(", ");
          return errorResult(`${local.name} has no repo named "${repo}" — its repos: ${known}`);
        }
        try {
          return rendered(await local.request<SpawnResponse>("spawn", request), local.name);
        } catch (err) {
          return errorResult(localFailureText("spawn_session", err));
        }
      }

      return withRelay(async (client) => {
        const resolved = resolveMachine(client.getState().machines, machine);
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
          return rendered(await client.request<SpawnResponse>(target.deviceId, "spawn", request), target.name);
        } catch (err) {
          return errorResult(failureText("spawn_session", err));
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
    repos: state.repos,
    request: <T>(op: RequestOp, payload: unknown): Promise<T> => localRequest<T>(op, payload),
  };
}

/**
 * Resolves and imports the PSK on first remote use, memoized. Deferred rather
 * than done at startup because local ops need no key at all: on a box where the
 * key only exists as a credential systemd delivers to the daemon's unit, this
 * throws — and only for the calls that actually need the relay.
 *
 * Cleared on failure so a later call retries rather than caching a rejection: a
 * keychain that was locked at the first attempt may be open at the second.
 */
function relayKey(config: Config): () => Promise<CryptoKey> {
  const resolve = async (): Promise<CryptoKey> => {
    const resolved = await loadPsk(config);
    if (resolved === null) {
      throw new Error(
        "no PSK — fill the psk field in config.json or run `seanced psk-import`. " +
          "Spawning on this machine needs no key; only reaching another one does.",
      );
    }
    return importPsk(resolved.psk);
  };
  let pending: Promise<CryptoKey> | null = null;
  return async (): Promise<CryptoKey> => {
    pending ??= resolve();
    try {
      return await pending;
    } catch (err) {
      pending = null;
      throw err;
    }
  };
}

/** `seanced mcp` — serve MCP over stdio until the client hangs up. */
export async function runMcpServer(): Promise<void> {
  const config = await loadConfig();
  const local = await localMachine(config);
  const key = relayKey(config);
  const relay = new LazyRelay({
    create: async () =>
      new RelayClient({
        url: appRelayUrl(config.relayUrl),
        token: config.bearerToken,
        key: await key(),
        // stdout carries the protocol frames — the wire log must land on stderr.
        log: (line) => console.error(line),
        // Bun dialing workerd needs this or frames die with close code 1002.
        createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
      }),
  });
  const handle = serveStdio(() => buildMcpServer(relay, local), {
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
  relay.stop();
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
