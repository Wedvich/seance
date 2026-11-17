import { join } from "node:path";
import type { AdapterSession, AdapterDaemonFrame, DaemonHello, SessionTag } from "@seance/shared";
import { ADAPTER_FEATURES, ADAPTER_PROTOCOLS } from "@seance/shared";
import type { AdapterFeed, FeedFrame } from "./adapter-feed.ts";
import {
  createAdapterSupervisor,
  type AdapterSupervisor,
  type SupervisorState,
  type SupervisorTiming,
} from "./adapter-supervisor.ts";
import type { AdapterAudit } from "./audit.ts";
import type { AdaptersConfig } from "./config.ts";

/**
 * The adapters `config.json` names (docs/messaging.md §6; DESIGN.md, "Adapters"): one supervised child each, fed the
 * one state feed. An adapter is declared only in this machine's own `config.json`, never from a frame, the PWA, MCP or
 * another machine, and nothing about it crosses the relay. With `repos` set, an adapter sees only the sessions whose
 * `repo` it lists and the tasks launched in them (§6.2); an untasked session outside every known repo has no `repo`
 * and is out of scope too. Every session's `tags` reach it less any other adapter's `adapter.*` namespace.
 */

export interface AdapterHostDeps extends SupervisorTiming {
  readonly adapters: AdaptersConfig;
  readonly feed: AdapterFeed;
  /** The repo a launched task's worktree was noted under (`EndedTasks.taskRepo`), for `repos`. */
  readonly taskRepo: (taskId: string) => string | undefined;
  readonly machine: { readonly deviceId: string; readonly name: string };
  readonly version: string;
  readonly audit: AdapterAudit;
  /** Each adapter's own directory sits under this (`adaptersDir()`). */
  readonly root: string;
  /** True while the daemon drains for a restart: no adapter starts then. */
  readonly held: () => boolean;
}

export interface AdapterHost {
  /** Starts every adapter not held; call again when the hold lifts. */
  readonly start: () => void;
  readonly state: (name: string) => SupervisorState | undefined;
  readonly stop: () => Promise<void>;
}

/** Tags a given adapter may see: every namespace but another adapter's `adapter.<name>.*`. */
export function tagsFor(
  name: string,
  tags: Readonly<Record<string, SessionTag>>,
): Readonly<Record<string, SessionTag>> {
  const own = `adapter.${name}.`;
  return Object.fromEntries(Object.entries(tags).filter(([key]) => !key.startsWith("adapter.") || key.startsWith(own)));
}

export function startAdapterHost(deps: AdapterHostDeps): AdapterHost {
  const hello: DaemonHello = {
    kind: "hello",
    protocol: [...ADAPTER_PROTOCOLS],
    features: [...ADAPTER_FEATURES],
    machine: deps.machine,
    daemon: { version: deps.version },
  };
  const supervisors = new Map<string, AdapterSupervisor>();
  const unlisten: (() => void)[] = [];

  for (const [name, config] of Object.entries(deps.adapters)) {
    const repos = config.repos === undefined ? null : new Set(config.repos);
    const inScope = (session: AdapterSession): boolean =>
      repos === null || (session.repo !== undefined && repos.has(session.repo));
    const shown = (session: AdapterSession): AdapterSession => ({ ...session, tags: tagsFor(name, session.tags) });
    /** Keys this adapter was last told of, since its last snapshot: a `session-gone` goes only for one of them. */
    const told = new Set<string>();
    const supervisor = createAdapterSupervisor({
      ...deps,
      name,
      config,
      dir: join(deps.root, name),
      hello,
      snapshot: (): AdapterDaemonFrame => {
        const sessions = deps.feed.current().filter(inScope).map(shown);
        told.clear();
        for (const session of sessions) told.add(session.key);
        return { kind: "snapshot", sessions };
      },
    });
    supervisors.set(name, supervisor);
    const route = (frame: FeedFrame): void => {
      switch (frame.kind) {
        case "session": {
          if (inScope(frame.session)) {
            told.add(frame.session.key);
            supervisor.send({ kind: "session", session: shown(frame.session) });
            return;
          }
          // Moved out of scope: what the adapter holds of it no longer describes anything it may see.
          if (told.delete(frame.session.key)) {
            supervisor.send({ kind: "session-gone", key: frame.session.key, reason: "replaced" });
          }
          return;
        }
        case "session-gone":
          if (told.delete(frame.key)) supervisor.send(frame);
          return;
        case "task": {
          const repo = deps.taskRepo(frame.task);
          if (repos === null || (repo !== undefined && repos.has(repo))) supervisor.send(frame);
        }
      }
    };
    unlisten.push(deps.feed.listen(route));
  }

  return {
    start: (): void => {
      if (deps.held()) return;
      for (const supervisor of supervisors.values()) supervisor.start();
    },
    state: (name) => supervisors.get(name)?.state(),
    stop: async (): Promise<void> => {
      for (const each of unlisten) each();
      await Promise.all([...supervisors.values()].map((supervisor) => supervisor.stop()));
    },
  };
}
