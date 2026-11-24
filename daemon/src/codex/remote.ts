import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, type AutonomyLevel } from "@seance/shared";
import { writeDurable } from "../durable-write.ts";
import { log } from "../log.ts";
import { stateDir } from "../paths.ts";
import { connectCodex, initializeCodex, type CodexAnswer, type CodexMethod } from "./client.ts";
import { codexDir } from "./home.ts";

/**
 * Remote control of a Codex session from the owner's phone (DESIGN.md, Daemon, "Codex remote control"; docs/codex.md,
 * "Remote control (phase 3)"). Three parts:
 *
 * - `remote.json`, the daemon's note that the home is paired, written and removed only by the owner's
 *   `seance codex pair | unpair` (`pair.ts`), read for `AgentLogin.paired` (display only) and to decide whether the
 *   slot is offered at all.
 * - One-shot calls on a session's server (`remoteCall`) over a connection of their own, opened with the experimental
 *   API that remote control needs; a session's own connection never opts in.
 * - The slot (`createRemoteSlot`): one server per home may hold remote control (a second reads `errored`, the item 9
 *   spike), so the daemon enables it on one live session's server, a `checkpoint` session's before an `auto` one's,
 *   and passes it on when that session ends. Always `ephemeral`, so nothing about it persists in the home and a
 *   server the daemon did not enable starts disabled. Pairing never decides whether a task starts (O3): the slot only
 *   ever follows sessions that already run.
 */

const REMOTE_FILE = "remote.json";
/** Codex's ids (`env_…`, `cli_…`) as seen: held to a closed alphabet and a bound, never logged. */
const REMOTE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
/** Phones a pairing may note: a bound, not a policy. */
export const REMOTE_CLIENTS_MAX = 16;
const REMOTE_CALL_TIMEOUT_MS = 15_000;

/** `remote.json`: the environment a `--listen` server on the home enrolls, and the phones paired to it. */
export interface RemoteRecord {
  readonly v: 1;
  readonly environmentId: string;
  readonly clients: readonly string[];
  /** When the pairing was noted (ms). */
  readonly at: number;
}

export function remotePath(stateDirectory: string = stateDir()): string {
  return join(codexDir(stateDirectory), REMOTE_FILE);
}

export function isRemoteId(value: unknown): value is string {
  return typeof value === "string" && REMOTE_ID.test(value);
}

/** Strict: every field required, nothing else kept; at least one client, since a record is written only on a pairing. */
export function parseRemoteRecord(raw: unknown): RemoteRecord | null {
  if (!isRecord(raw) || raw["v"] !== 1) return null;
  const { environmentId, clients, at } = raw;
  if (!isRemoteId(environmentId) || typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) return null;
  if (!Array.isArray(clients) || clients.length === 0 || clients.length > REMOTE_CLIENTS_MAX) return null;
  if (!clients.every(isRemoteId)) return null;
  return { v: 1, environmentId, clients: [...clients], at };
}

/** The record, or null when there is none or it is not a plain file that parses: an unreadable note reads unpaired. */
export async function readRemote(path: string = remotePath()): Promise<RemoteRecord | null> {
  const info = await lstat(path).catch(() => null);
  if (info === null || !info.isFile()) return null;
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return parseRemoteRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function writeRemote(record: RemoteRecord, path: string = remotePath()): Promise<void> {
  await writeDurable(path, `${JSON.stringify(record)}\n`, 0o600);
}

export async function removeRemote(path: string = remotePath()): Promise<void> {
  await rm(path, { force: true });
}

export const REMOTE_STATES = ["disabled", "connecting", "connected", "errored"] as const;
export type RemoteState = (typeof REMOTE_STATES)[number];

/** `remoteControl/status/read`, `enable` and `disable` answer this; a server name and installation id are not kept. */
export interface RemoteStatus {
  readonly status: RemoteState;
  readonly environmentId: string | null;
}

export function parseRemoteStatus(value: unknown): RemoteStatus | null {
  if (!isRecord(value)) return null;
  const { status, environmentId } = value;
  const state = REMOTE_STATES.find((s) => s === status);
  if (state === undefined) return null;
  if (environmentId !== null && environmentId !== undefined && !isRemoteId(environmentId)) return null;
  return { status: state, environmentId: isRemoteId(environmentId) ? environmentId : null };
}

/** A server whose remote control is on, whether or not it holds the backend's one connection yet. */
export function remoteEnabled(status: RemoteStatus): boolean {
  return status.status !== "disabled";
}

export type RemoteMethod = Extract<CodexMethod, `remoteControl/${string}`>;

/**
 * One remote-control request on the server listening in `runDir`, over a connection of its own (dialled only once
 * `socketState` passes, as every daemon dial is) whose `initialize` must answer `home`. Null for anything but a
 * result: no socket, another home, an error (its code kept by `CodexAnswer`, never its message), a close, a timeout.
 */
export async function remoteCall(
  runDir: string,
  home: string,
  method: RemoteMethod,
  params: Readonly<Record<string, unknown>>,
): Promise<CodexAnswer | null> {
  const connection = await connectCodex(runDir);
  if (connection === null) return null;
  try {
    if (!(await initializeCodex(connection, home, { experimental: true })).ok) return null;
    return await connection.request(method, params, REMOTE_CALL_TIMEOUT_MS);
  } finally {
    connection.close();
  }
}

/** `remoteCall` for the three status-answering methods, the answer parsed. */
export async function remoteStatusCall(
  runDir: string,
  home: string,
  method: "remoteControl/enable" | "remoteControl/disable" | "remoteControl/status/read",
): Promise<RemoteStatus | null> {
  // `ephemeral`: the enable lasts this server's life and writes nothing to the home, so the next server starts
  // disabled (a plain `enable` is persisted, and every later server on the home would come up competing for the slot).
  const params = method === "remoteControl/status/read" ? {} : { ephemeral: true };
  const answer = await remoteCall(runDir, home, method, params);
  return answer?.kind === "result" ? parseRemoteStatus(answer.value) : null;
}

/** A live session the slot may go to. */
export interface SlotMember {
  readonly paneId: string;
  readonly runDir: string;
  /** The task's level as its launch had it; null when unknown, which ranks with `auto`. */
  readonly level: AutonomyLevel | null;
}

export interface RemoteSlotDeps {
  /** Whether the home is paired (`remote.json`): no phone, no slot to give. */
  readonly paired: () => boolean;
  /** `enable` or `disable` (ephemeral) on a member's server; null when it could not be made. */
  readonly control: (
    runDir: string,
    method: "remoteControl/enable" | "remoteControl/disable",
  ) => Promise<RemoteStatus | null>;
}

export interface RemoteSlot {
  /** A session joined; `enabled` when its server already has remote control on (a daemon restart's re-join). */
  readonly join: (member: SlotMember, enabled?: boolean) => void;
  /** A session ended or was dropped: the slot passes on if it held it. */
  readonly leave: (paneId: string) => void;
  /** Pairing changed: offer the slot, or take it back. */
  readonly reconcile: () => void;
  readonly holder: () => string | null;
  /** Resolves once no step is queued: for tests and shutdown. */
  readonly settled: () => Promise<void>;
  /** Forgets every member without touching a server: their servers keep remote control for the next daemon process. */
  readonly stop: () => void;
}

/**
 * The machine's one remote-control slot. Every step runs on one chain, so the slot is never enabled on two servers by
 * this daemon at once. A `checkpoint` session takes the slot from a holder at any other level, because that is where
 * a person answers; never from another `checkpoint` one, and the oldest member goes first among equals. A server
 * whose `enable` fails is not asked again while it lives.
 */
export function createRemoteSlot(deps: RemoteSlotDeps): RemoteSlot {
  const members = new Map<string, SlotMember>();
  const refused = new Set<string>();
  let holder: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;

  const enqueue = (step: () => Promise<void>): void => {
    chain = chain
      .then(async () => (stopped ? undefined : step()))
      .catch((err: unknown) => log.warn(`codex: the remote-control slot failed a step (${String(err)})`));
  };

  const pick = (): SlotMember | undefined => {
    const open = [...members.values()].filter((m) => !refused.has(m.paneId));
    return open.find((m) => m.level === "checkpoint") ?? open[0];
  };

  const disable = async (member: SlotMember): Promise<void> => {
    await deps.control(member.runDir, "remoteControl/disable");
  };

  const settle = async (): Promise<void> => {
    if (!deps.paired()) {
      const held = holder === null ? undefined : members.get(holder);
      holder = null;
      if (held !== undefined) await disable(held);
      return;
    }
    // Bounded: each pass either settles or refuses one member.
    for (let pass = 0; pass <= members.size; pass++) {
      const want = pick();
      const held = holder === null ? undefined : members.get(holder);
      if (held !== undefined) {
        if (held.level === "checkpoint" || want?.level !== "checkpoint") return;
        holder = null;
        // oxlint-disable-next-line no-await-in-loop -- one server at a time, by design
        await disable(held);
      }
      if (want === undefined) return;
      // oxlint-disable-next-line no-await-in-loop -- as above
      const status = await deps.control(want.runDir, "remoteControl/enable");
      if (stopped) return;
      if (status !== null && remoteEnabled(status)) {
        // `errored` too: another server (a pairing in progress) holds the backend's connection, and Codex retries
        // until it is free (the item 9 spike).
        holder = members.has(want.paneId) ? want.paneId : null;
        return;
      }
      refused.add(want.paneId);
      log.warn("codex: a session's server refused remote control — the slot goes to the next session");
    }
  };

  return {
    join: (member, enabled = false): void => {
      members.set(member.paneId, member);
      enqueue(async () => {
        if (enabled && members.has(member.paneId)) {
          if (holder === null) holder = member.paneId;
          // A second server left enabled (two daemon processes' worth): one holder only.
          else if (holder !== member.paneId) await disable(member);
        }
        await settle();
      });
    },
    leave: (paneId): void => {
      const member = members.get(paneId);
      members.delete(paneId);
      refused.delete(paneId);
      enqueue(async () => {
        if (holder === paneId) {
          holder = null;
          // A server whose pane still lives (a lost connection, never re-joined) would keep the slot: let it go.
          if (member !== undefined) await disable(member);
        }
        await settle();
      });
    },
    reconcile: (): void => enqueue(settle),
    holder: () => holder,
    settled: async (): Promise<void> => {
      for (let pending = chain; ; pending = chain) {
        // oxlint-disable-next-line no-await-in-loop -- a step queued while waiting is waited for too
        await pending;
        if (pending === chain) return;
      }
    },
    stop: (): void => {
      stopped = true;
      members.clear();
      refused.clear();
      holder = null;
    },
  };
}
