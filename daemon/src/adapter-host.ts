import { join } from "node:path";
import type {
  AdapterDeliveryOutcome,
  AdapterResultCode,
  AdapterResultOutcome,
  AdapterSession,
  AdapterDaemonFrame,
  DaemonHello,
  DeliverFrame,
  MessageOutFrame,
  SessionTag,
  TagFrame,
} from "@seance/shared";
import { ADAPTER_FEATURES, ADAPTER_LINE_MAX, ADAPTER_PROTOCOLS, encodeDaemonFrame } from "@seance/shared";
import type { AdapterView } from "./adapter-control.ts";
import type { AdapterFeed, FeedFrame } from "./adapter-feed.ts";
import { adapterFingerprint, type Subscriptions } from "./adapter-subscriptions.ts";
import {
  createAdapterSupervisor,
  type AdapterSupervisor,
  type SupervisorState,
  type SupervisorTiming,
} from "./adapter-supervisor.ts";
import type { AdapterAudit, AdapterMessageOutcome } from "./audit.ts";
import type { AdaptersConfig } from "./config.ts";
import type { Conversations } from "./conversations.ts";
import type { AdapterDeliveryContext, AdapterOutlet, AdapterOutletAnswer, Messages } from "./messages.ts";

/**
 * The adapters `config.json` names (DESIGN.md, "Adapters"): one supervised child each, fed the
 * one state feed. An adapter is declared only in this machine's own `config.json`, never from a frame, the PWA, MCP or
 * another machine, and nothing about it crosses the relay. With `repos` set, an adapter sees only the sessions whose
 * `repo` it lists and the tasks launched in them (§6.2); an untasked session outside every known repo has no `repo`
 * and is out of scope too. Every session's `tags` reach it less any other adapter's `adapter.*` namespace.
 *
 * Text in and out (3b): an adapter's `deliver` goes through messages' local delivery, bounded by its `kinds` and
 * `repos`, and a session's message to `adapter:<name>` comes out as a `message` frame, subscribing the sender's verified
 * conversation (DESIGN.md, "Adapters", "The subscription"). Its `tag` writes `adapter.<name>.*` and nothing else. The audit lines carry ids, kind,
 * a byte count and an outcome: never text, a label, a message id or a conversation id.
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
  /** Text in and out; absent, the host runs state out only and answers a `deliver` or `tag` `unsupported`. */
  readonly messages?: Pick<Messages, "deliverFromAdapter" | "setAdapters">;
  readonly conversations?: Pick<Conversations, "setAdapterTag" | "clearAdapterTags">;
  readonly subscriptions?: Subscriptions;
  /** The launch's time when this machine's ledger holds the task (a `tag` by task names only such a task). */
  readonly launchedAt?: (taskId: string) => number | undefined;
  /** What `view` returns moved: an adapter's state, process or counts. */
  readonly onChange?: () => void;
}

export interface AdapterHost {
  /** Starts every adapter not held; call again when the hold lifts. */
  readonly start: () => void;
  readonly state: (name: string) => SupervisorState | undefined;
  /** Every configured adapter as `seance adapter status` shows it. */
  readonly view: () => Readonly<Record<string, AdapterView>>;
  /** The owner's `seance adapter restart` (`AdapterSupervisor.restart`); the names it acted on, the others not configured. */
  readonly restart: (names: readonly string[]) => readonly string[];
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
  const counts = new Map<string, { delivered: number; messages: number; restarts: number }>();
  const changed = (): void => deps.onChange?.();
  const count = (name: string, key: "delivered" | "messages" | "restarts"): void => {
    const each = counts.get(name);
    if (each === undefined) return;
    each[key] += 1;
    changed();
  };
  /** Per adapter, whether a target (its task, else the session the key names) is inside its `repos`. */
  const scopes = new Map<string, (target: { readonly task: string | null; readonly key: string | null }) => boolean>();
  const unlisten: (() => void)[] = [];
  const { messages, conversations, subscriptions } = deps;
  const launchedAt = deps.launchedAt ?? ((): undefined => undefined);
  const audited = (write: Promise<void>): void => {
    // An audit sink that failed has nowhere to say so from here: adapter modules load no logger.
    void write.catch(() => {});
  };

  const fingerprints = new Map(
    Object.entries(deps.adapters).map(([name, config]) => [name, adapterFingerprint(config)]),
  );
  // A name no longer configured, or configured as another program, inherits no subscription (DESIGN.md, "Adapters",
  // "The subscription").
  subscriptions?.reconcile(fingerprints);

  for (const [name, config] of Object.entries(deps.adapters)) {
    const repos = config.repos === undefined ? null : new Set(config.repos);
    const inScope = (session: AdapterSession): boolean =>
      repos === null || (session.repo !== undefined && repos.has(session.repo));
    const targetInScope = (target: { readonly task: string | null; readonly key: string | null }): boolean => {
      if (repos === null) return true;
      if (target.task !== null) {
        const repo = deps.taskRepo(target.task);
        return repo !== undefined && repos.has(repo);
      }
      const session = target.key === null ? undefined : deps.feed.current().find((each) => each.key === target.key);
      return session !== undefined && inScope(session);
    };
    scopes.set(name, targetInScope);
    const shown = (session: AdapterSession): AdapterSession => ({ ...session, tags: tagsFor(name, session.tags) });
    /** Keys this adapter was last told of, since its last snapshot: a `session-gone` goes only for one of them. */
    const told = new Set<string>();
    counts.set(name, { delivered: 0, messages: 0, restarts: 0 });
    const supervisor = createAdapterSupervisor({
      ...deps,
      onChange: changed,
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
      // A fresh run replays its tags after the snapshot; what the last run set is gone with it.
      onReady: () => conversations?.clearAdapterTags(name),
      ...(messages === undefined || conversations === undefined || subscriptions === undefined
        ? {}
        : {
            onFrame: (frame: DeliverFrame | TagFrame): void => {
              if (frame.kind === "deliver") void deliver(frame);
              else tag(frame);
            },
          }),
    });

    const deliver = async (frame: DeliverFrame): Promise<void> => {
      if (messages === undefined || subscriptions === undefined) return;
      const to = "to" in frame ? frame.to : "toSession" in frame ? "session" : "reply";
      const bytes = Buffer.byteLength(frame.text, "utf8");
      const line = (outcome: AdapterResultOutcome | AdapterDeliveryOutcome, code?: AdapterResultCode): void =>
        audited(
          deps.audit.deliver(name, {
            to,
            kind: frame.messageKind,
            bytes,
            outcome,
            ...(code === undefined ? {} : { code }),
          }),
        );
      if (!config.kinds.includes(frame.messageKind)) {
        supervisor.send({ kind: "result", ref: frame.ref, outcome: "refused", code: "kind" });
        line("refused", "kind");
        return;
      }
      const context: AdapterDeliveryContext = {
        inScope: targetInScope,
        subscribed: (conversation) => subscriptions.has(name, conversation),
        settle: (id, outcome) => {
          supervisor.send({ kind: "delivery", id, outcome });
          line(outcome);
        },
      };
      const result = await messages.deliverFromAdapter(name, frame, context);
      supervisor.send({
        kind: "result",
        ref: frame.ref,
        outcome: result.outcome,
        ...(result.id === undefined ? {} : { id: result.id }),
        ...(result.code === undefined ? {} : { code: result.code }),
      });
      line(result.outcome, result.code);
      if (result.outcome === "delivered" || result.outcome === "sent") count(name, "delivered");
    };

    const tag = (frame: TagFrame): void => {
      if (conversations === undefined || subscriptions === undefined) return;
      const answer = (outcome: "ok" | "full" | "invalid" | "unknown" | "refused", code?: "repo"): void => {
        supervisor.send({ kind: "result", ref: frame.ref, outcome, ...(code === undefined ? {} : { code }) });
      };
      if ("session" in frame) {
        if (!subscriptions.has(name, frame.session)) return answer("unknown");
        // A live session holding the conversation must be in scope; a subscription was made only from inside it.
        const live = deps.feed
          .current()
          .find(
            (each) => each.session?.id === frame.session && each.session.verified && each.session.conflict !== true,
          );
        if (live !== undefined && !targetInScope({ task: live.task?.id ?? null, key: live.key })) {
          return answer("refused", "repo");
        }
        return answer(conversations.setAdapterTag(name, { conversation: frame.session }, frame.key, frame.value));
      }
      if (launchedAt(frame.task) === undefined) return answer("unknown");
      if (!targetInScope({ task: frame.task, key: null })) return answer("refused", "repo");
      return answer(conversations.setAdapterTag(name, { task: frame.task }, frame.key, frame.value));
    };
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

  // A verified, unconflicted session seen is its conversation live: it keeps its subscriptions past the idle prune.
  if (subscriptions !== undefined) {
    unlisten.push(
      deps.feed.listen((frame) => {
        const claim = frame.kind === "session" ? frame.session.session : undefined;
        if (claim?.verified === true && claim.conflict !== true) subscriptions.touch(claim.id);
      }),
    );
  }

  const outlet: AdapterOutlet = {
    message: async (name, m): Promise<AdapterOutletAnswer> => {
      const supervisor = supervisors.get(name);
      const inScope = scopes.get(name);
      const line = (outcome: AdapterMessageOutcome, subscribed: boolean): void =>
        audited(deps.audit.message(name, { from: m.task, kind: m.kind, bytes: m.bytes, outcome, subscribed }));
      // An adapter whose hello did not ask for messages takes none: no such address, as for a name not configured.
      const wants = supervisor?.wants();
      if (
        supervisor === undefined ||
        inScope === undefined ||
        subscriptions === undefined ||
        (wants !== null && wants !== undefined && !wants.includes("messages"))
      ) {
        line("unknown", false);
        return { ok: false, code: "unknown" };
      }
      if (!inScope({ task: m.task, key: m.key })) {
        line("refused", false);
        return { ok: false, code: "refused" };
      }
      const conversation = m.conversation;
      if (conversation !== null && m.leave) {
        subscriptions.leave(name, conversation);
        conversations?.clearAdapterTags(name, conversation);
      }
      // A reply by handle subscribes nothing, but says whether the conversation already is.
      const subscribed = conversation !== null && !m.leave && (m.subscribe || subscriptions.has(name, conversation));
      const frame: MessageOutFrame = {
        kind: "message",
        id: m.id,
        messageKind: m.kind,
        text: m.text,
        from: {
          key: m.key,
          ...(subscribed && conversation !== null ? { session: conversation } : {}),
          ...(m.task === null ? {} : { task: m.task }),
          ...(m.title === null ? {} : { title: m.title }),
        },
        ...(m.inReplyTo === undefined ? {} : { inReplyTo: m.inReplyTo }),
        subscribed,
        ...(m.leave ? { leave: true as const } : {}),
      };
      if (Buffer.byteLength(encodeDaemonFrame(frame), "utf8") > ADAPTER_LINE_MAX) {
        line("too_long", false);
        return { ok: false, code: "too_long" };
      }
      if (!supervisor.send(frame)) {
        line("ended", false);
        return { ok: false, code: "ended" };
      }
      if (subscribed && m.subscribe && conversation !== null) subscriptions.add(name, conversation);
      line("delivered", subscribed);
      count(name, "messages");
      return subscribed && conversation !== null
        ? { ok: true, subscribed: true, session: conversation }
        : { ok: true, subscribed: false };
    },
    refused: (name, refusal) => {
      audited(deps.audit.message(name, { ...refusal, subscribed: false }));
    },
  };
  messages?.setAdapters(outlet);

  return {
    start: (): void => {
      if (deps.held()) return;
      for (const supervisor of supervisors.values()) supervisor.start();
    },
    state: (name) => supervisors.get(name)?.state(),
    view: () =>
      Object.fromEntries(
        [...supervisors].map(([name, supervisor]) => [
          name,
          {
            ...supervisor.info(),
            ...(counts.get(name) ?? { delivered: 0, messages: 0, restarts: 0 }),
            fingerprint: fingerprints.get(name) ?? "",
          },
        ]),
      ),
    restart: (names) => {
      const acted = names.filter((name) => supervisors.has(name));
      for (const name of acted) {
        supervisors.get(name)?.restart();
        count(name, "restarts");
      }
      return acted;
    },
    stop: async (): Promise<void> => {
      messages?.setAdapters(null);
      for (const each of unlisten) each();
      await Promise.all([...supervisors.values()].map((supervisor) => supervisor.stop()));
    },
  };
}
