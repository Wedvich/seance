// The files between `seance adapter restart | status` and the running daemon (DESIGN.md, "Adapters", "Installing"):
// the daemon publishes `adapter-status.json` and reads `adapter-restart.json`; the CLI does the opposite. Pure I/O, and
// an adapter module (`daemon/test/adapter-layering.test.ts`): nothing here logs. Never a socket op: the local socket's
// allowlist stays `sessions`, `spawn` and `despawn`, and these files are as private as `state.json` (0600 in the
// owner's state dir), which is all the shell's verbs need.
import { readFile, rename, unlink } from "node:fs/promises";
import { isAdapterName, isRecord } from "@seance/shared";
import type { AdapterReason } from "./audit.ts";
import { writeDurable } from "./durable-write.ts";
import { adapterRestartPath, adapterStatusPath } from "./paths.ts";
import type { SupervisorInfo, SupervisorState } from "./adapter-supervisor.ts";

const VIEW_VERSION = 1;

/** One adapter as the daemon last saw it. `version` is adapter-written: a reader prints it only through a scrub. */
export interface AdapterView extends SupervisorInfo {
  /** `adapterFingerprint` of the entry this daemon runs: the CLI compares it with `config.json`'s now. */
  readonly fingerprint: string;
  /** Owner restarts this daemon acted on: what `seance adapter restart` waits to see rise. */
  readonly restarts: number;
  /** Deliveries placed (`delivered` or `sent`) and session messages handed to it, since the daemon started. */
  readonly delivered: number;
  readonly messages: number;
}

export interface AdaptersView {
  /** The daemon process that wrote it: a view from another pid is a past run's. */
  readonly pid: number;
  readonly at: number;
  readonly adapters: Readonly<Record<string, AdapterView>>;
}

const STATES: readonly SupervisorState[] = ["starting", "running", "backoff", "failed", "refused", "stopped", "held"];
const REASONS: readonly AdapterReason[] = [
  "exited",
  "stopped",
  "invalid",
  "unread",
  "handshake",
  "spawn",
  "restarted",
  "protocol",
  "name",
];

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function parseView(raw: unknown): AdapterView | null {
  if (!isRecord(raw)) return null;
  const { state, pid, startedAt, protocol, version, exits, lastExit, fingerprint, restarts, delivered, messages } = raw;
  const known = STATES.find((each) => each === state);
  if (known === undefined || !isCount(exits) || !isCount(restarts) || !isCount(delivered) || !isCount(messages)) {
    return null;
  }
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(fingerprint)) return null;
  let exit: AdapterView["lastExit"];
  if (isRecord(lastExit)) {
    const reason = REASONS.find((each) => each === lastExit["reason"]);
    const { at, code } = lastExit;
    // An exit code, or a signal's name.
    const exitCode =
      code === null || isCount(code) || (typeof code === "string" && /^[A-Z0-9]{1,16}$/u.test(code)) ? code : undefined;
    if (reason !== undefined && isTime(at) && exitCode !== undefined) exit = { at, code: exitCode, reason };
  }
  return {
    state: known,
    exits,
    fingerprint,
    restarts,
    delivered,
    messages,
    ...(isCount(pid) ? { pid } : {}),
    ...(isTime(startedAt) ? { startedAt } : {}),
    ...(isCount(protocol) ? { protocol } : {}),
    ...(typeof version === "string" && version.length <= 64 ? { version } : {}),
    ...(exit === undefined ? {} : { lastExit: exit }),
  };
}

/** Null when missing or unreadable: a view the reader cannot trust says nothing. */
export async function readAdaptersView(path: string = adapterStatusPath()): Promise<AdaptersView | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw["v"] !== VIEW_VERSION || !isCount(raw["pid"]) || !isTime(raw["at"])) return null;
  const adapters: Record<string, AdapterView> = {};
  if (!isRecord(raw["adapters"])) return null;
  for (const [name, value] of Object.entries(raw["adapters"])) {
    const view = parseView(value);
    if (isAdapterName(name) && view !== null) adapters[name] = view;
  }
  return { pid: raw["pid"], at: raw["at"], adapters };
}

export async function writeAdaptersView(view: AdaptersView, path: string = adapterStatusPath()): Promise<void> {
  await writeDurable(path, `${JSON.stringify({ v: VIEW_VERSION, ...view })}\n`, 0o600);
}

/** A request older than this is a past one's: the daemon was not running to take it. */
export const ADAPTER_RESTART_TTL_MS = 60_000;

/** Adds `names` to any fresh request still waiting, so two restarts typed back to back both land. */
export async function requestAdapterRestart(
  names: readonly string[],
  now: number,
  path: string = adapterRestartPath(),
): Promise<void> {
  const waiting = await readRestartRequest(now, path);
  const all = [...new Set([...(waiting ?? []), ...names])];
  await writeDurable(path, `${JSON.stringify({ at: now, names: all })}\n`, 0o600);
}

/** The names a fresh request asks for; null for none, a stale one or a malformed one. */
async function readRestartRequest(now: number, path: string): Promise<readonly string[] | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isTime(raw["at"]) || !Array.isArray(raw["names"])) return null;
  const age = now - raw["at"];
  if (age < -5_000 || age > ADAPTER_RESTART_TTL_MS) return null;
  const names = raw["names"].filter(isAdapterName);
  return names.length === raw["names"].length ? names : null;
}

/**
 * The daemon's side: the names a fresh request asks for, the file removed whatever it held. Moved aside before it is
 * read, so a request written meanwhile is a new file, taken at the next look, never removed unread.
 */
export async function takeRestartRequest(
  now: number,
  path: string = adapterRestartPath(),
): Promise<readonly string[] | null> {
  const taking = `${path}.taking`;
  try {
    await rename(path, taking);
  } catch {
    return null;
  }
  const names = await readRestartRequest(now, taking);
  await unlink(taking).catch(() => {});
  return names;
}
