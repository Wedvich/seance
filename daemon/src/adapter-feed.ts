import {
  ADAPTER_SESSION_STATES,
  displayName,
  isTaskId,
  type AdapterSession,
  type AdapterSessionState,
  type AdapterTaskEvent,
  type RepoEntry,
  type SessionGoneFrame,
  type SessionFrame,
  type SessionTag,
  type TaskFrame,
} from "@seance/shared";
import { closedBySeance } from "./closing-panes.ts";
import { sessionKey, type ClaudeProcess, type SessionKey } from "./claude-process.ts";
import type { Conversations } from "./conversations.ts";
import { exec } from "./exec.ts";
import { exclaveOf, type Exclave } from "./exclaves.ts";
import { hardenedGit } from "./git-hardened.ts";
import { CLAUDE_PANES } from "./agents/panes.ts";
import { parsePsParents, processNames, processStart } from "./peer.ts";
import type { EndedTasks } from "./session-events.ts";
import { repoNames } from "./sessions.ts";
import { CUSTODIAN_FIELD, FIELD_SEP, listAllPanes, TASK_FIELD } from "./tmux.ts";

/**
 * State out to adapters (DESIGN.md, "Adapters"): this machine's live Claude sessions as `Session` records, and each
 * change to them as a `session` or `session-gone` frame, plus the `task` events of the launch ledger. A session is a
 * live pane with a `claude`-named process in it (the one the conversation table holds for the pane, else the shallowest
 * one under the pane's process), keyed on that process. Its facts are the daemon's own: the conversation table's state
 * and tags (memory only, so `unknown` and none after a restart until the session reports), the pane's task, the scan
 * set's repo, the worktree's branch and the launch ledger's PR. Never a prompt, a screen, a path or an account id.
 *
 * It loads no `log.ts`: nothing it reads is anything but the daemon's own facts, and no line about it is needed
 * (`daemon/test/adapter-layering.test.ts`).
 */

const INTERVAL_MS = 5_000;
const DEBOUNCE_MS = 50;
const BRANCH_TTL_MS = 30_000;
/** Reads in a row thrown away as torn (`read`) before a cycle gives up until the next timer or nudge. */
const TORN_RETRIES = 5;
/** How deep under a pane's process a `claude` is looked for: a wrapper or two (`caffeinate`, a shell), never a tree. */
const DESCENT_MAX = 4;

/** A live pane as the feed reads it. */
export interface FeedPane {
  readonly id: string;
  readonly pid: number;
  readonly taskId: string | null;
  readonly window: string;
  readonly path: string;
}

const FEED_FORMAT = [
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_dead}",
  TASK_FIELD,
  CUSTODIAN_FIELD,
  // Window names are unvalidated wire text (a spawn's title): the separator is substituted out inside tmux.
  `#{s/[${FIELD_SEP}]/-/:window_name}`,
  "#{pane_current_path}",
].join(FIELD_SEP);

/** Pure parser over `list-panes -a` in `FEED_FORMAT`: live panes only, never the custodian's round (C10), path last. */
export function parseFeedPanes(raw: string): readonly FeedPane[] {
  const seen = new Set<string>();
  const panes: FeedPane[] = [];
  for (const line of raw.split("\n")) {
    const [id, pid, dead, task, custodian, window, ...rest] = line.split(FIELD_SEP);
    if (id === undefined || pid === undefined || window === undefined || rest.length === 0) continue;
    if (dead !== "0" || custodian === "1" || seen.has(id) || !/^%\d+$/u.test(id)) continue;
    seen.add(id);
    panes.push({ id, pid: Number(pid), taskId: isTaskId(task) ? task : null, window, path: rest.join(FIELD_SEP) });
  }
  return panes;
}

/** Every live pane; a failed read throws (`TmuxError`), so a tmux hiccup never reads as every session gone. */
export async function listFeedPanes(): Promise<readonly FeedPane[]> {
  return parseFeedPanes(await listAllPanes(FEED_FORMAT));
}

const isClaude = async (pid: number): Promise<boolean> =>
  (await processNames(pid)).some((name) => CLAUDE_PANES.command.test(name));

/**
 * The shallowest `claude`-named process at or under each pane's process, by breadth: a pane that `exec`s claude is its
 * own, a séance spawn's is `caffeinate`'s child on macOS, a hand-started one is its shell's. One `ps` lists every parent,
 * only when some pane's own process is not one.
 */
export async function claudeUnder(panePids: readonly number[]): Promise<ReadonlyMap<number, ClaudeProcess>> {
  const found = new Map<number, ClaudeProcess>();
  const of = (pid: number): ClaudeProcess | null => {
    const start = processStart(pid);
    return start === null ? null : { pid, start, key: sessionKey(pid, start) };
  };
  const rest: number[] = [];
  for (const pid of panePids) {
    // oxlint-disable-next-line no-await-in-loop -- one name read per pane, exec-free on both platforms
    const own = (await isClaude(pid)) ? of(pid) : null;
    if (own === null) rest.push(pid);
    else found.set(pid, own);
  }
  if (rest.length === 0) return found;
  const listed = await exec(["ps", "-A", "-o", "pid=,ppid="], { timeoutMs: 5_000 }).catch(() => null);
  if (listed?.exitCode !== 0) return found;
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parsePsParents(listed.stdout)) {
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  for (const root of rest) {
    let level = children.get(root) ?? [];
    for (let depth = 0; depth < DESCENT_MAX && level.length > 0; depth++) {
      // oxlint-disable-next-line no-await-in-loop -- a level at a time: the shallowest wins
      const hits = await Promise.all(level.map(async (pid) => ((await isClaude(pid)) ? of(pid) : null)));
      const hit = hits.find((each) => each !== null);
      if (hit !== undefined && hit !== null) {
        found.set(root, hit);
        break;
      }
      level = level.flatMap((pid) => children.get(pid) ?? []);
    }
  }
  return found;
}

/** The worktree's branch, through the hardened git (a session can write repo-local config); null when detached or none. */
async function branchAt(path: string): Promise<string | null> {
  const read = await hardenedGit(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], 5_000).catch(() => null);
  const branch = read?.exitCode === 0 ? read.stdout.trim() : "";
  return branch === "" ? null : branch;
}

export type FeedFrame = SessionFrame | SessionGoneFrame | TaskFrame;

export interface AdapterFeedDeps {
  readonly conversations: Pick<Conversations, "sweep" | "process" | "tagsFor" | "taskTags" | "listen" | "ended">;
  readonly tasks: Pick<EndedTasks, "prUrl" | "ref" | "onTask">;
  readonly exclaves: () => readonly Exclave[];
  readonly repos: () => readonly RepoEntry[];
  readonly panes?: () => Promise<readonly FeedPane[]>;
  readonly claudeUnder?: (panePids: readonly number[]) => Promise<ReadonlyMap<number, ClaudeProcess>>;
  readonly branchOf?: (path: string) => Promise<string | null>;
  readonly closedBySeance?: (pane: string, pid: number) => boolean;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly debounceMs?: number;
}

export interface AdapterFeed {
  /** The first read, then the timer and the listeners: a snapshot taken after it resolves is whole. */
  readonly start: () => Promise<void>;
  /** The sessions as last read, for a `snapshot`: in step with every frame `listen` has heard. */
  readonly current: () => readonly AdapterSession[];
  readonly listen: (listener: (frame: FeedFrame) => void) => () => void;
  /** Reads again soon (debounced); resolves once a read begun after the call is done. */
  readonly refresh: () => Promise<void>;
  readonly stop: () => void;
}

interface Held {
  readonly session: AdapterSession;
  readonly json: string;
  readonly pane: string;
  readonly panePid: number;
}

const toState = (state: string | null): AdapterSessionState =>
  ADAPTER_SESSION_STATES.find((each) => each === state) ?? "unknown";

export function createAdapterFeed(deps: AdapterFeedDeps): AdapterFeed {
  const now = deps.now ?? Date.now;
  const panes = deps.panes ?? listFeedPanes;
  const under = deps.claudeUnder ?? claudeUnder;
  const branchOf = deps.branchOf ?? branchAt;
  const closed = deps.closedBySeance ?? closedBySeance;
  const listeners = new Set<(frame: FeedFrame) => void>();
  const held = new Map<SessionKey, Held>();
  /** When the feed first saw a process the table holds nothing for: its `since`. */
  const firstSeen = new Map<SessionKey, number>();
  const branches = new Map<string, { readonly at: number; readonly branch: Promise<string | null> }>();
  const unsubscribe: (() => void)[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let waiters: (() => void)[] = [];
  let stopped = false;

  const tell = (frame: FeedFrame): void => {
    for (const listener of listeners) listener(frame);
  };

  const branchFor = (path: string): Promise<string | null> => {
    const at = now();
    const hit = branches.get(path);
    if (hit !== undefined && at - hit.at < BRANCH_TTL_MS) return hit.branch;
    const branch = branchOf(path).catch(() => null);
    branches.set(path, { at, branch });
    return branch;
  };

  /**
   * A read joins the pane list with facts read after it (the table's sweep lists panes again; the descent is a later
   * `ps`), so a pane re-tagged in between would pair one task with a process found under another: a record of a
   * session that never existed, then `replaced`. A second list after the last of those facts must show every pane both
   * lists hold under the same pid and task, or the read is `torn` and done again. A pane gone by the second list pairs
   * nothing wrongly (the next read sees it gone), so it tears nothing: churn elsewhere would starve the read.
   */
  const read = async (): Promise<Map<SessionKey, Held> | null | "torn"> => {
    let live: readonly FeedPane[];
    try {
      live = await panes();
    } catch {
      return null; // a failed read changes nothing; the next one tries again
    }
    await deps.conversations.sweep().catch(() => {});
    const exclaves = deps.exclaves();
    const views = new Map(live.map((pane) => [pane.id, deps.conversations.process(pane.id)]));
    const open = live.filter((pane) => {
      const view = views.get(pane.id);
      return view === null || view === undefined || view.taskId !== pane.taskId;
    });
    const descended = open.length === 0 ? new Map<number, ClaudeProcess>() : await under(open.map((p) => p.pid));
    const repos = await repoNames(
      live.map((pane) => pane.path),
      deps.repos(),
    ).catch(() => new Map<string, string>());
    const after = await panes().catch(() => null);
    if (after === null) return null;
    const relisted = new Map(after.map((pane) => [pane.id, pane]));
    const moved = live.some((pane) => {
      const later = relisted.get(pane.id);
      return later !== undefined && (later.pid !== pane.pid || later.taskId !== pane.taskId);
    });
    if (moved) return "torn";
    for (const path of branches.keys()) if (!live.some((pane) => pane.path === path)) branches.delete(path);
    const next = new Map<SessionKey, Held>();
    for (const pane of live) {
      const stored = views.get(pane.id);
      const view = stored !== null && stored !== undefined && stored.taskId === pane.taskId ? stored : null;
      const key = view?.key ?? descended.get(pane.pid)?.key;
      if (key === undefined || next.has(key) || deps.conversations.ended(key)) continue;
      const repo = repos.get(pane.path);
      // oxlint-disable-next-line no-await-in-loop -- memoized per path; a miss is one `symbolic-ref`
      const branch = repo === undefined ? null : await branchFor(pane.path);
      const tags: Readonly<Record<string, SessionTag>> =
        view === null
          ? pane.taskId === null
            ? {}
            : (deps.conversations.taskTags(pane.taskId) ?? {})
          : (deps.conversations.tagsFor(pane.id) ?? {});
      const prUrl = pane.taskId === null ? undefined : deps.tasks.prUrl(pane.taskId);
      const ref = pane.taskId === null ? undefined : deps.tasks.ref(pane.taskId);
      const state = toState(view?.state ?? null);
      const session: AdapterSession = {
        key,
        ...(view?.session === null || view?.session === undefined
          ? {}
          : {
              session: {
                id: view.session.id,
                verified: view.session.verified,
                ...(view.session.conflict ? { conflict: true as const } : {}),
              },
            }),
        ...(pane.taskId === null ? {} : { task: { id: pane.taskId, ...(ref === undefined ? {} : { ref }) } }),
        exclave: exclaveOf(pane.path, exclaves),
        ...(repo === undefined ? {} : { repo }),
        ...(branch === null ? {} : { branch }),
        state,
        ...(view?.turnEnded === true ? { turnEnded: true as const } : {}),
        ...(state === "needs-input" && view?.reason !== null && view?.reason !== undefined
          ? { reason: view.reason }
          : {}),
        ...(prUrl === undefined ? {} : { prUrl }),
        since: view?.since ?? firstSeen.get(key) ?? now(),
        name: displayName(tags, undefined, pane.window),
        tags,
      };
      if (view === null && !firstSeen.has(key)) firstSeen.set(key, session.since);
      next.set(key, { session, json: JSON.stringify(session), pane: pane.id, panePid: pane.pid });
    }
    for (const key of firstSeen.keys()) if (!next.has(key)) firstSeen.delete(key);
    return next;
  };

  const apply = (next: Map<SessionKey, Held>): void => {
    for (const [key, before] of held) {
      if (next.has(key)) continue;
      held.delete(key);
      tell({ kind: "session-gone", key, reason: closed(before.pane, before.panePid) ? "closed" : "exited" });
    }
    for (const [key, after] of next) {
      const before = held.get(key);
      held.set(key, after);
      if (before?.json === after.json) continue;
      // The same process under another task: the record a tool holds no longer describes it.
      if (before !== undefined && before.session.task?.id !== after.session.task?.id) {
        tell({ kind: "session-gone", key, reason: "replaced" });
      }
      tell({ kind: "session", session: after.session });
    }
  };

  const cycle = async (): Promise<void> => {
    let torn = 0;
    for (;;) {
      again = false;
      const done = waiters;
      waiters = [];
      // oxlint-disable-next-line no-await-in-loop -- one read at a time; a nudge during one runs one more
      const next = await read();
      if (next === "torn" && !stopped && ++torn <= TORN_RETRIES) {
        // A refresh resolves on a read that was applied, never on one thrown away.
        waiters = [...done, ...waiters];
        again = true;
        continue;
      }
      // Panes that keep moving: apply nothing this cycle rather than a record no instant held; the timer reads again.
      if (next !== null && next !== "torn" && !stopped) apply(next);
      torn = 0;
      for (const resolve of done) resolve();
      if (!again || stopped) break;
    }
    running = null;
  };

  const run = (): void => {
    if (stopped) return;
    if (running !== null) {
      again = true;
      return;
    }
    running = cycle();
  };

  const nudge = (): void => {
    if (stopped || debounce !== null) return;
    debounce = setTimeout(() => {
      debounce = null;
      run();
    }, deps.debounceMs ?? DEBOUNCE_MS);
  };

  const onTask = (taskId: string, event: AdapterTaskEvent): void => {
    if (stopped) return;
    const prUrl = deps.tasks.prUrl(taskId);
    tell({ kind: "task", task: taskId, event, ...(prUrl === undefined ? {} : { prUrl }) });
    nudge();
  };

  return {
    start: async (): Promise<void> => {
      run();
      await running;
      if (stopped) return;
      unsubscribe.push(deps.conversations.listen(nudge), deps.tasks.onTask(onTask));
      timer = setInterval(run, deps.intervalMs ?? INTERVAL_MS);
    },
    current: () => [...held.values()].map((each) => each.session),
    listen: (listener): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: (): Promise<void> => {
      if (stopped) return Promise.resolve();
      const done = new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
      if (running !== null) again = true;
      else run();
      return done;
    },
    stop: (): void => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      if (debounce !== null) clearTimeout(debounce);
      for (const each of unsubscribe) each();
      listeners.clear();
      for (const resolve of waiters) resolve();
      waiters = [];
    },
  };
}
