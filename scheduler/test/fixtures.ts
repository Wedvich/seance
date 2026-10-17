import type {
  DespawnRequest,
  DespawnResponse,
  ExclaveInfo,
  Machine,
  MachineStatus,
  QuotaObservation,
  RepoEntry,
  SessionEntry,
} from "@seance/shared";
import { bindTaskRecord, CAPABILITIES, STORE_PREFIXES } from "@seance/shared";
import {
  UNREACHABLE,
  type Fleet,
  type QueueStore,
  type Unreachable,
  type TaskSessionsReply,
  type TaskSpawnReply,
  type TaskSpawnRequest,
} from "../src/index.ts";
import type { TaskSpec } from "../src/task.ts";

export const NOW = 1_800_000_000_000;
export const NOW_S = NOW / 1000;
export const REPO = "github.com/acme/app";

export function exclave(id: string, accountId: string | null, extra: Partial<ExclaveInfo> = {}): ExclaveInfo {
  return { id, accountId, extraUsageEnabled: false, authOk: accountId !== null, skills: [], ...extra };
}

export function clone(name: string, exclaveId: string, origin = REPO): RepoEntry {
  return { name, path: `/home/u/${exclaveId}/${name}`, defaultBranch: "main", exclave: exclaveId, origin };
}

/** A quota reading; `at` defaults to a minute ago, resets to "not soon". */
export function obs(x: number, fields: Partial<QuotaObservation> = {}): QuotaObservation {
  return { x, h: 10, d: 10, s: "session", at: NOW_S - 60, ...fields };
}

export function status(fields: Partial<MachineStatus> = {}): MachineStatus {
  return { at: NOW_S - 10, scan: 1, cpu: 10, mem: 10, free: 50_000, ...fields };
}

/**
 * A connected, capable machine with one exclave `main` on `org:a` holding a
 * clone of REPO, observed at 10% — the candidate every reason test bends one
 * field of.
 */
export function machine(deviceId: string, fields: Partial<Machine> = {}): Machine {
  return {
    deviceId,
    name: deviceId,
    platform: "darwin",
    repos: [clone("app", "main")],
    scannedAt: 1,
    lastSeen: NOW,
    connected: true,
    capabilities: [CAPABILITIES.metrics, CAPABILITIES.taskId],
    exclaves: [exclave("main", `org:${deviceId}`)],
    status: status({ quota: [obs(0)] }),
    ...fields,
  };
}

export function spec(fields: Partial<TaskSpec> = {}): TaskSpec {
  return { repo: REPO, mode: "worktree", prompt: "do it", ...fields };
}

type SpawnScript = (request: TaskSpawnRequest) => TaskSpawnReply | Promise<TaskSpawnReply>;

/**
 * Fleet double: machines are whatever the test sets, spawns answer through a
 * per-device script (default: started, one session at the reply's path), and
 * every call is recorded.
 */
export class FakeFleet implements Fleet {
  fleet: Machine[];
  readonly spawns: { readonly deviceId: string; readonly request: TaskSpawnRequest }[] = [];
  readonly despawns: { readonly deviceId: string; readonly id: string }[] = [];
  readonly sessionCalls: string[] = [];
  readonly scripts = new Map<string, SpawnScript>();
  readonly running = new Map<string, SessionEntry[]>();
  /** Task ids each daemon would report in `sessions`' `ended`. */
  readonly ended = new Map<string, string[]>();
  /**
   * Each daemon's `ledgerSince`; null is a daemon that predates the ledger. A
   * day before `NOW` unless set: a ledger that long predates every reservation.
   */
  readonly ledgerSince = new Map<string, number | null>();
  sessionsReply: ((deviceId: string) => TaskSessionsReply) | null = null;
  #pane = 0;

  constructor(machines: Machine[]) {
    this.fleet = machines;
  }

  machines(): readonly Machine[] {
    return this.fleet;
  }

  /** A beat arriving from every connected machine: what a fake clock moving past 90s needs. */
  beat(nowMs: number): void {
    this.fleet = this.fleet.map((m) =>
      m.connected && m.status !== undefined ? { ...m, status: { ...m.status, at: nowMs / 1000 - 10 } } : m,
    );
  }

  async spawn(deviceId: string, request: TaskSpawnRequest): Promise<TaskSpawnReply> {
    this.spawns.push({ deviceId, request });
    const script = this.scripts.get(deviceId);
    if (script !== undefined) return script(request);
    return this.start(deviceId, request);
  }

  /** What a daemon does with a spawn that works: a session appears, carrying the task id. */
  start(deviceId: string, request: TaskSpawnRequest): TaskSpawnReply {
    const entry = {
      id: `%${++this.#pane}`,
      window: `w${this.#pane}`,
      repo: request.repo,
      path: `/wt/${request.taskId}`,
      taskId: request.taskId,
    };
    const sessions = [...(this.running.get(deviceId) ?? []), entry];
    this.running.set(deviceId, sessions);
    return { ok: true, window: entry.window, path: entry.path, sessions };
  }

  /** What a daemon does when a task's session exits: the pane goes, and the task id joins `ended`. */
  end(deviceId: string, taskId: string): void {
    this.running.set(
      deviceId,
      (this.running.get(deviceId) ?? []).filter((s) => s.taskId !== taskId),
    );
    this.ended.set(deviceId, [...(this.ended.get(deviceId) ?? []), taskId]);
  }

  async sessions(deviceId: string): Promise<TaskSessionsReply> {
    this.sessionCalls.push(deviceId);
    if (this.sessionsReply !== null) return this.sessionsReply(deviceId);
    // As the relay answers a request to a machine with no socket.
    if (!this.fleet.some((m) => m.deviceId === deviceId && m.connected)) return unreachable;
    const ended = this.ended.get(deviceId);
    const since = this.ledgerSince.has(deviceId) ? this.ledgerSince.get(deviceId) : NOW - 86_400_000;
    return {
      ok: true,
      sessions: this.running.get(deviceId) ?? [],
      ...(ended === undefined ? {} : { ended }),
      ...(since === null || since === undefined ? {} : { ledgerSince: since }),
    };
  }

  async despawn(deviceId: string, request: DespawnRequest): Promise<DespawnResponse> {
    this.despawns.push({ deviceId, id: request.id });
    return { ok: true, window: "w", outcome: "exited", sessions: [] };
  }
}

export const unreachable: Unreachable = { ok: false, code: UNREACHABLE, message: "no answer" };

/**
 * The store a `Scheduler` under test writes through: every put must pass the
 * rules each reader applies to an opened record (`bindTaskRecord`), as the
 * relay-backed adapter enforces on read. A test seeds through the raw store,
 * which may hold what no leader writes; only the library's own writes are held
 * to the readers' rules, and a bad one throws here instead of reading back
 * unreadable in production.
 */
export function readerChecked(store: QueueStore, now: () => number): QueueStore {
  return {
    list: () => store.list(),
    get: (id) => store.get(id),
    put: (id, expect, body) => {
      const key = `${STORE_PREFIXES.task.prefix}${id}`;
      const version = expect + 1;
      const bound = bindTaskRecord({ version, task: body }, { key, version }, now());
      if (typeof bound === "string")
        throw new Error(`the library wrote a task no reader opens: ${key} v${version} (${bound})`);
      return store.put(id, expect, body);
    },
    delete: (id, expect) => store.delete(id, expect),
    getPause: () => store.getPause(),
    putPause: (expect, holds) => store.putPause(expect, holds),
  };
}
