import { isEffort, isModel } from "./options.ts";
import type { LastUsed, PickerMachine } from "./form.ts";

/**
 * The slice of Raycast's `LocalStorage` this module uses. An interface rather
 * than the import, because nothing under src/lib may reach for `@raycast/api` —
 * it throws outside the Raycast host, so importing it here would put this
 * module out of reach of `bun test`. The view binds the real one.
 */
export interface Store {
  readonly getItem: (key: string) => Promise<string | undefined>;
  readonly setItem: (key: string, value: string) => Promise<void>;
}

export const REGISTRY_KEY = "registry";
export const LAST_USED_KEY = "last-used";

type Repo = PickerMachine["repos"][number];

/** The last registry projection, so the picker renders before a socket exists. */
export interface CachedRegistry {
  readonly machines: readonly PickerMachine[];
  /** When this projection was taken — not `scannedAt`, which is per machine and about repos. */
  readonly at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every read is fully validated and every failure answers null. A cache is an
 * optimisation: a blob written by an older build, half-written, or corrupt must
 * cost a slower first paint, never a broken form.
 */
function parse(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseRepo(raw: unknown): Repo | null {
  if (!isRecord(raw)) return null;
  const { name, path, defaultBranch } = raw;
  if (typeof name !== "string" || typeof path !== "string") return null;
  if (defaultBranch !== null && typeof defaultBranch !== "string") return null;
  return { name, path, defaultBranch };
}

function parseMachine(raw: unknown): PickerMachine | null {
  if (!isRecord(raw)) return null;
  const { deviceId, name, connected, lastSeen, scannedAt, repos } = raw;
  if (typeof deviceId !== "string" || typeof name !== "string") return null;
  if (typeof connected !== "boolean") return null;
  if (typeof lastSeen !== "number" || typeof scannedAt !== "number") return null;
  if (!Array.isArray(repos)) return null;
  const parsed: Repo[] = [];
  for (const entry of repos) {
    const repo = parseRepo(entry);
    // One unreadable repo invalidates the machine rather than silently
    // shortening its list: a picker missing the repo you wanted is worse than a
    // slow one.
    if (repo === null) return null;
    parsed.push(repo);
  }
  return { deviceId, name, connected, lastSeen, scannedAt, repos: parsed };
}

export async function readRegistry(store: Store): Promise<CachedRegistry | null> {
  const raw = parse(await store.getItem(REGISTRY_KEY));
  if (!isRecord(raw)) return null;
  const { machines, at } = raw;
  if (!Array.isArray(machines) || typeof at !== "number") return null;
  const parsed: PickerMachine[] = [];
  for (const entry of machines) {
    const machine = parseMachine(entry);
    if (machine === null) return null;
    parsed.push(machine);
  }
  return { machines: parsed, at };
}

/**
 * Projects explicitly rather than storing whatever the relay client handed
 * over: the stored shape is a compatibility surface across extension versions,
 * so it is pinned here instead of tracking `Machine`.
 */
export async function writeRegistry(store: Store, machines: readonly PickerMachine[], at: number): Promise<void> {
  const projection: CachedRegistry = {
    at,
    machines: machines.map((machine) => ({
      deviceId: machine.deviceId,
      name: machine.name,
      connected: machine.connected,
      lastSeen: machine.lastSeen,
      scannedAt: machine.scannedAt,
      repos: machine.repos.map((repo) => ({ name: repo.name, path: repo.path, defaultBranch: repo.defaultBranch })),
    })),
  };
  await store.setItem(REGISTRY_KEY, JSON.stringify(projection));
}

export async function readLastUsed(store: Store): Promise<LastUsed | null> {
  const raw = parse(await store.getItem(LAST_USED_KEY));
  if (!isRecord(raw)) return null;
  const { machineId, repos, model, effort, worktree } = raw;
  if (machineId !== null && typeof machineId !== "string") return null;
  if (!isRecord(repos)) return null;
  const byMachine: Record<string, string> = {};
  for (const [deviceId, repo] of Object.entries(repos)) {
    if (typeof repo !== "string") return null;
    byMachine[deviceId] = repo;
  }
  // An option this build no longer offers reads as no memory at all, so the
  // preferences reseed rather than the form opening on an unselectable value.
  if (!isModel(model) || !isEffort(effort)) return null;
  if (typeof worktree !== "boolean") return null;
  return { machineId, repos: byMachine, model, effort, worktree };
}

export async function writeLastUsed(store: Store, lastUsed: LastUsed): Promise<void> {
  await store.setItem(LAST_USED_KEY, JSON.stringify(lastUsed));
}
