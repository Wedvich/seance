import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "@seance/shared";
import type { KeepOpenAudit } from "./audit.ts";
import { sessionAlive as processAlive, type SessionKey } from "./claude-process.ts";
import {
  KEEP_OPEN_MACHINE_MAX,
  parseKeepOpenFrame,
  type KeepOpenReply,
  type KeepOpenReplyCode,
} from "./keep-open-frame.ts";
import { bindPeer } from "./messages.ts";
import { peerPidSupported } from "./peer.ts";
import { PANE_ID } from "./pane-id.ts";
import type { BoundPane } from "./session-events.ts";
import { writeAtomic } from "./state.ts";

/**
 * Sessions that asked the custodian to leave them open (`keep_session_open`; DESIGN.md, "Keep open"). A hold is bound to
 * the `claude` process the peer's chain names, never to a field, so it ends with that process: a restarted or
 * resumed `claude` in the same pane holds nothing. It is kept in `keep-open.json` (0600) so a self-update does not
 * drop it, and reloaded only while that process still runs with the saved start time. It holds a pane from the
 * custodian's `close` and the seat's due check, and nothing else: the owner's despawn, a drain, a hand-off, a pass and
 * reap never read it.
 */

export interface KeepOpenDeps {
  readonly panes: () => Promise<readonly BoundPane[]>;
  readonly path: string;
  readonly audit: KeepOpenAudit;
  readonly now?: () => number;
  readonly hostNamesPeers?: () => boolean;
  /** Whether the `claude` process a key names still runs (`claude-process.ts`); a test drives its own. */
  readonly sessionAlive?: (session: SessionKey) => boolean;
  readonly warn?: (line: string) => void;
}

export interface KeepOpen {
  /** A `keep-open` frame from the local socket: `peer` is the kernel-reported pid of its sender, never a field of the frame. */
  readonly handle: (raw: unknown, peer: number | null) => Promise<KeepOpenReply>;
  /** Whether a live session in this pane asked to be left open: the custodian's `close` then refuses it `held_open`. */
  readonly holds: (pane: string) => boolean;
  /** Reloads the file, dropping holds whose session is gone. */
  readonly start: () => Promise<void>;
  /** The write chain: awaited where the daemon's shutdown can, so a restart's reload reads what this process saved. */
  readonly stop: () => Promise<void>;
}

interface Hold {
  readonly pane: string;
  /** `<pid>:<start>` of the session's `claude` process. */
  readonly session: SessionKey;
  readonly at: number;
}

const VERSION = 1;
const SESSION_KEY = /^\d+:.+$/u;

function savedHold(raw: unknown): Hold | null {
  if (!isRecord(raw)) return null;
  const { pane, session, at } = raw;
  if (typeof pane !== "string" || !PANE_ID.test(pane)) return null;
  if (typeof session !== "string" || !SESSION_KEY.test(session)) return null;
  if (typeof at !== "number" || !Number.isSafeInteger(at)) return null;
  return { pane, session, at };
}

/** Null for a file that is not this shape at all; a malformed entry alone is dropped. */
export function parseSavedHolds(raw: unknown): readonly Hold[] | null {
  if (!isRecord(raw) || raw["v"] !== VERSION || !Array.isArray(raw["holds"])) return null;
  return raw["holds"].flatMap((each: unknown) => savedHold(each) ?? []);
}

/** Writes in order, once per path per process, as `watches.ts` does: a second table over one path queues behind the first. */
const writeChains = new Map<string, Promise<void>>();

export function createKeepOpen(deps: KeepOpenDeps): KeepOpen {
  const now = deps.now ?? Date.now;
  const hostNamesPeers = deps.hostNamesPeers ?? peerPidSupported;
  const alive = deps.sessionAlive ?? processAlive;
  const warn = deps.warn ?? ((): void => {});
  /** Keyed by session: one hold per `claude` process. */
  const holds = new Map<SessionKey, Hold>();
  let stopped = false;
  /** `start`'s reload: a frame waits for it, or its save would overwrite the file before the reload read it. */
  let loaded: Promise<void> = Promise.resolve();

  const writeFile = async (snapshot: object): Promise<void> => {
    await mkdir(dirname(deps.path), { recursive: true, mode: 0o700 });
    await writeAtomic(deps.path, snapshot);
  };

  /** Nothing is written once stopped: a restart's table may already have read the file, and a late write would undo it. */
  const save = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    const snapshot = { v: VERSION, holds: [...holds.values()] };
    const write = (writeChains.get(deps.path) ?? Promise.resolve())
      .then(() => writeFile(snapshot))
      .catch(() => {
        // The path only: the file holds pane ids and process identity.
        warn(`keep-open: could not write ${deps.path}`);
      });
    writeChains.set(deps.path, write);
    return write;
  };

  /** Drops the holds whose `claude` is gone; true when any was. */
  const sweep = async (): Promise<boolean> => {
    let dropped = false;
    for (const [session] of [...holds]) {
      if (alive(session)) continue;
      holds.delete(session);
      dropped = true;
      // oxlint-disable-next-line no-await-in-loop -- one line per dropped hold, in order
      await deps.audit({ op: "end" });
    }
    return dropped;
  };

  const handle: KeepOpen["handle"] = async (raw, peer) => {
    const frame = parseKeepOpenFrame(raw);
    if (frame === null) {
      await deps.audit({ op: isRecord(raw) && raw["keep"] === false ? "release" : "hold", outcome: "invalid" });
      return { ok: false, code: "invalid" };
    }
    const op = frame.keep ? "hold" : "release";
    const refuse = async (code: KeepOpenReplyCode): Promise<KeepOpenReply> => {
      await deps.audit({ op, outcome: code });
      return { ok: false, code };
    };
    if (stopped) return await refuse("stopping");
    if (peer === null || !hostNamesPeers()) return await refuse("unbound");
    await loaded;
    const bound = await bindPeer(peer, await deps.panes(), hostNamesPeers);
    if (bound === null) return await refuse("unbound");
    if (bound.session === null) return await refuse("nosession");
    const session = bound.session.key;
    // The stop could land during the binding's awaits: nothing is written after it.
    if (stopped) return await refuse("stopping");
    const swept = await sweep();
    // The sweep's audit lines await too: a hold taken after the stop would be answered held and never saved.
    if (stopped) return await refuse("stopping");
    if (!frame.keep) {
      const had = holds.delete(session);
      if (had || swept) await save();
      await deps.audit({ op, outcome: "ok" });
      return { ok: true, held: false };
    }
    if (!holds.has(session) && holds.size >= KEEP_OPEN_MACHINE_MAX) {
      if (swept) await save();
      return await refuse("too_many");
    }
    holds.set(session, { pane: bound.pane.id, session, at: now() });
    await save();
    await deps.audit({ op, outcome: "ok" });
    return { ok: true, held: true };
  };

  const holdsPane: KeepOpen["holds"] = (pane) => {
    for (const hold of holds.values()) if (hold.pane === pane && alive(hold.session)) return true;
    return false;
  };

  const load = async (): Promise<void> => {
    if (stopped) return;
    await (writeChains.get(deps.path) ?? Promise.resolve());
    let text: string;
    try {
      text = await readFile(deps.path, "utf8");
    } catch (err) {
      if (!(isRecord(err) && err["code"] === "ENOENT"))
        warn(`keep-open: could not read ${deps.path}; no session is held`);
      return;
    }
    let saved: readonly Hold[] | null = null;
    try {
      saved = parseSavedHolds(JSON.parse(text));
    } catch {
      // Falls through to the warning.
    }
    if (saved === null) {
      warn(`keep-open: ${deps.path} is unreadable; no session is held`);
      return;
    }
    // A stopped table ends nothing, and its restart reads the file as it stands.
    if (stopped) return;
    for (const hold of saved) {
      if (!holds.has(hold.session) && holds.size < KEEP_OPEN_MACHINE_MAX) holds.set(hold.session, hold);
    }
    if ((await sweep()) || holds.size !== saved.length) await save();
  };

  const start: KeepOpen["start"] = () => {
    const run = load();
    loaded = run.catch(() => {});
    return run;
  };

  const stop: KeepOpen["stop"] = () => {
    stopped = true;
    return writeChains.get(deps.path) ?? Promise.resolve();
  };

  return { handle, holds: holdsPane, start, stop };
}
