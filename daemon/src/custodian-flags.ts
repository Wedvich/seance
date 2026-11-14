import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord, isTaskId, parseTaskFlag, type CustodianEvent, type FlagReason, type TaskFlag } from "@seance/shared";
import { writeDurable } from "./durable-write.ts";
import type { PaneActivity, TrackedState } from "./pane-activity.ts";

/**
 * The daemon's open custodian flags (docs/custodian.md C30; DESIGN.md, "The custodian frame kind"): one entry per
 * flagged session in `stateDir()/custodian/sessions.json`, 0600 in the 0700 `custodian/` dir. Not `state.json`: that
 * file is the owner CLI's alone, an unreadable one there means "paused", and a daemon write racing the CLI's
 * read-modify-write could pause the seat. Nudge and interrupt counts join this file at item 8.
 *
 * The key is the pane's task id, or its pane id for an untasked pane (a `%`, which a task id never starts with).
 * A pane id means nothing after the tmux server restarts, which reuses them, so pane-keyed entries are dropped at
 * load. Nothing here logs or returns the note except `get`, whose one caller (`custodian-verbs.ts`) never passes it on.
 * Must not import `log.ts`: `warn` is a dependency, as `custodian-verbs.ts` takes it.
 */

export interface CustodianFlagsDeps {
  readonly path: string;
  readonly now: () => number;
  readonly warn: (line: string) => void;
}

/** What `set` did: a flag for a reason the key did not hold, a changed note under the same reason, or nothing. */
export type FlagSet = "new" | "note" | "same";

export interface CustodianFlags {
  readonly get: (key: string) => Promise<TaskFlag | null>;
  /** The same reason keeps its `at`. */
  readonly set: (key: string, reason: FlagReason, note: string | undefined) => Promise<FlagSet>;
  /**
   * True when there was an entry. Writes nothing for a missing key. With `only`, an entry that has changed since the
   * caller read it (another reason, note or time) is left: a send took a while, and what a round set meanwhile stands.
   * With `revision` too, so is an entry `set` was called for since, whether or not that changed anything: a round
   * flagging the same reason and note again leaves the entry as it was, yet its event may reach the leader after the
   * caller's `unflag` and put the flag back on the record.
   */
  readonly clear: (key: string, only?: TaskFlag, revision?: number) => Promise<boolean>;
  /** How many times `set` was called for the key in this process, as it was called: an in-memory stamp for `clear`. */
  readonly revision: (key: string) => number;
  /**
   * Every entry whose key is no live task id and no live pane id: the sessions are gone. Deletes nothing: an entry is
   * the daemon's record of what the leader's task record holds, so the caller clears it (`clear`, with `only`) once
   * the event that settles the record has been taken, and an event that was not taken leaves it for the next call.
   */
  readonly stale: (live: {
    readonly taskIds: ReadonlySet<string>;
    readonly panes: ReadonlySet<string>;
  }) => Promise<readonly (readonly [string, TaskFlag])[]>;
}

/** The reasons about a session's turn; `dirty` and `unpushed` are about its worktree, which a turn or a session's end leaves as it is. */
export const isTurnFlag = (flag: TaskFlag): boolean => flag.reason === "stuck" || flag.reason === "look";

/**
 * A bound `busy` frame after an `idle` this process saw: the session was given work, so a flag about what it was doing
 * is stale. An `idle` that did not end a turn counts (a respawn's, whose next prompt is a turn): any state the process
 * observed tells it apart from a pane it has not. A pane with no state retained is not a new turn: a restart, a config
 * reload or a seat that never started leaves none, a stuck session sends `busy` after every permission it is asked, and
 * lifting on the first one would let the next round flag it again and push twice. Not `needs-input` to `busy` (a
 * permission answered) and not `busy` to `busy`: the same turn. A turn the mod's pending report folded into one `busy`
 * after another `busy` is not seen either; the flag lifts at the next new turn, a close that kept nothing or the
 * re-assignment.
 */
export function isNewTurn(before: Pick<PaneActivity, "state"> | null, state: TrackedState): boolean {
  return state === "busy" && before !== null && before.state === "idle";
}

/**
 * Reads and writes both wait their turn, across every instance in the process: `writeDurable` is not serialized, and a
 * lazy load must not race a set. Instances still cache separately, so the daemon holds one per file (`run-capabilities.ts`).
 */
let chain: Promise<unknown> = Promise.resolve();

export const isPaneKey = (key: string): boolean => key.startsWith("%");

export interface LiftDeps {
  readonly flags: Pick<CustodianFlags, "clear" | "revision">;
  /** True when something took the event: a leader's running term in process, or the socket on the relay leg. */
  readonly send: (event: CustodianEvent) => Promise<boolean>;
  readonly now: () => number;
}

/**
 * Lifts an entry the way the record needs it: the leader's `unflag` first, and the entry only once that was taken, so a
 * send that was not keeps the entry for the next prune, new turn or close to try again (the local entry is the source
 * of truth for what the record holds). A pane-keyed entry has no record. True when the entry is gone.
 */
export async function liftEntry(deps: LiftDeps, key: string, flag: TaskFlag): Promise<boolean> {
  if (isPaneKey(key)) {
    await deps.flags.clear(key, flag);
    return true;
  }
  const revision = deps.flags.revision(key);
  if (!(await deps.send({ kind: "unflag", taskId: key, at: deps.now() }))) return false;
  // `only` and `revision`: a round may have set a flag while the send was out, a repeat of this one included.
  await deps.flags.clear(key, flag, revision);
  return true;
}

export interface NewTurnDeps {
  readonly flags: Pick<CustodianFlags, "get" | "clear" | "revision">;
  /** Undefined while no seat holds the flag store. */
  readonly send: ((event: CustodianEvent) => Promise<boolean>) | undefined;
  readonly now: () => number;
  readonly warn: (line: string) => void;
}

/**
 * The session started a new turn: a flag about the last one is stale, so the record's flag goes and then the entry, once
 * the `unflag` was taken (a send nothing took leaves the entry, and the next new turn, prune or close tries again).
 * `dirty` and `unpushed` are about the worktree, not the turn, and stay. A failure is a warning.
 */
export async function clearOnNewTurn(deps: NewTurnDeps, key: string, taskId: string | null): Promise<void> {
  try {
    const entry = await deps.flags.get(key);
    if (entry === null || !isTurnFlag(entry) || deps.send === undefined) return;
    if (taskId === null) {
      await deps.flags.clear(key, entry);
      return;
    }
    if (!(await liftEntry({ flags: deps.flags, send: deps.send, now: deps.now }, key, entry))) {
      deps.warn("custodian: an unflag on a new turn was not taken; the entry stays for the next call");
    }
  } catch (err) {
    deps.warn(`custodian: clearing a flag on a new turn failed (${err instanceof Error ? err.name : "error"})`);
  }
}

export function createCustodianFlags(deps: CustodianFlagsDeps): CustodianFlags {
  let entries: Map<string, TaskFlag> | null = null;
  const revisions = new Map<string, number>();
  const turn = <T>(act: () => Promise<T>): Promise<T> => {
    const next = chain.then(act);
    chain = next.catch(() => {});
    return next;
  };

  const load = async (): Promise<Map<string, TaskFlag>> => {
    if (entries !== null) return entries;
    const loaded = new Map<string, TaskFlag>();
    let text: string | null = null;
    try {
      text = await readFile(deps.path, "utf8");
    } catch (err) {
      if (!(isRecord(err) && err["code"] === "ENOENT")) deps.warn("custodian: the flags file could not be read");
    }
    if (text !== null) {
      let raw: unknown = null;
      try {
        raw = JSON.parse(text);
      } catch {
        // Warned below.
      }
      if (isRecord(raw) && raw["v"] === 1 && isRecord(raw["flags"])) {
        for (const [key, value] of Object.entries(raw["flags"])) {
          const flag = parseTaskFlag(value);
          // A bad entry is dropped alone; a pane id is dead after a restart.
          if (flag !== null && isTaskId(key)) loaded.set(key, flag);
        }
      } else {
        // Never the content: it holds a note.
        deps.warn("custodian: the flags file is malformed and was read as empty");
      }
    }
    entries = loaded;
    return loaded;
  };

  const persist = async (held: ReadonlyMap<string, TaskFlag>): Promise<void> => {
    await mkdir(dirname(deps.path), { recursive: true, mode: 0o700 });
    await writeDurable(deps.path, `${JSON.stringify({ v: 1, flags: Object.fromEntries(held) })}\n`, 0o600);
  };

  /** A change applied to memory and then to disk; a write that fails leaves memory as the disk is. */
  const changing = async <T>(change: (held: Map<string, TaskFlag>) => T | null): Promise<T | null> => {
    const held = await load();
    const before = new Map(held);
    const result = change(held);
    if (result === null) return null;
    try {
      await persist(held);
    } catch (err) {
      held.clear();
      for (const [key, flag] of before) held.set(key, flag);
      throw err;
    }
    return result;
  };

  return {
    get: (key) => turn(async () => (await load()).get(key) ?? null),
    revision: (key) => revisions.get(key) ?? 0,
    set: (key, reason, note) => {
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
      return turn(async () => {
        const result = await changing<FlagSet>((held) => {
          const was = held.get(key);
          if (was?.reason === reason && was.note === note) return null;
          held.set(key, {
            reason,
            ...(note === undefined ? {} : { note }),
            at: was?.reason === reason ? was.at : deps.now(),
          });
          return was?.reason === reason ? "note" : "new";
        });
        return result ?? "same";
      });
    },
    clear: (key, only, revision) =>
      turn(async () => {
        const result = await changing<true>((held) => {
          const was = held.get(key);
          if (was === undefined) return null;
          if (revision !== undefined && (revisions.get(key) ?? 0) !== revision) return null;
          if (only !== undefined && !(was.reason === only.reason && was.note === only.note && was.at === only.at)) {
            return null;
          }
          held.delete(key);
          return true;
        });
        return result === true;
      }),
    stale: (live) =>
      turn(async () =>
        [...(await load())].filter(([key]) => !(isPaneKey(key) ? live.panes.has(key) : live.taskIds.has(key))),
      ),
  };
}

export interface RetainedPane {
  readonly id: string;
  readonly ours: boolean;
}

/**
 * Session-events ingest's `retain` hook: the retained state is read before `observe` replaces it, since a new turn is a
 * `busy` after what the pane showed last, which only the prior state says. Only a pane séance started is read: an
 * foreign pane has no flag to lift.
 */
export function retainFrame<P extends RetainedPane>(deps: {
  /** The pane's retained state so far (`PaneActivityTracker.activity`). */
  readonly activity: (paneId: string) => Pick<PaneActivity, "state"> | null;
  readonly observe: (pane: P, state: TrackedState, turnEnded: boolean) => void;
  /** Lifts the flag of a pane whose turn is new; undefined while no seat holds the flag store. */
  readonly onNewTurn: () => ((pane: P) => void) | undefined;
}): (pane: P, state: TrackedState, turnEnded: boolean) => void {
  return (pane, state, turnEnded) => {
    const before = pane.ours ? deps.activity(pane.id) : null;
    deps.observe(pane, state, turnEnded);
    const lift = deps.onNewTurn();
    if (!pane.ours || lift === undefined || !isNewTurn(before, state)) return;
    lift(pane);
  };
}

/**
 * Where a `custodian-event` goes: in process when this machine leads, which answers whether a running term took it (false
 * while one is still taking over), else sealed to the scheduler over the relay, where true is only that the envelope was
 * written to the socket: no ack comes back.
 */
export function deliverEvent(
  deps: {
    readonly leads: () => boolean;
    readonly inProcess: (event: CustodianEvent) => Promise<boolean>;
    readonly relay: (event: CustodianEvent) => Promise<boolean>;
  },
  event: CustodianEvent,
): Promise<boolean> {
  if (deps.leads()) return deps.inProcess(event);
  return deps.relay(event);
}
