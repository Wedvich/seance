import { importPsk, toBase64 } from "@seance/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  accountRecord,
  BATCH_STRATEGY,
  QUEUE_MAX_TASKS,
  RelayClient,
  RequestFailure,
  TASK_REQUEST_LIMITS,
  TASK_SPEC_LIMITS,
  withReportInstruction,
  type Decision,
  type DiscardReply,
  type DiscardRequest,
  type ExclaveInfo,
  type Machine,
  type MetricsReply,
  type MetricsRequest,
  type MetricsSeries,
  type PauseReply,
  type PauseRequest,
  type QueueChanged,
  type QueueReply,
  type QueueRequest,
  type RelayState,
  type ResumeRequest,
  type RoutePreviewReply,
  type StoreRefusal,
  type Task,
  type TaskCreated,
  type TaskLookup,
  type TaskReply,
  type TaskRequest,
} from "@seance/shared";
import { DEFAULT_FORM } from "../src/state.ts";
import { deriveQueue } from "../src/queue-view.ts";
import { deriveView } from "../src/view.ts";
import { describeVerdict } from "../src/verdict-view.ts";
import { PREVIEW_DEBOUNCE_MS, PREVIEW_RETRY_MS, QUEUE_POLL_MS, QUEUE_POLLS } from "../src/scheduler-store.ts";
import { Store, UNDO_WINDOW_MS } from "../src/store.ts";
import { fakeHistory, installBrowserGlobals } from "./stubs.ts";

installBrowserGlobals();

let key: CryptoKey;

beforeAll(async () => {
  key = await importPsk(toBase64(new Uint8Array(32).fill(3)));
});

/** Never started, so nothing dials: the store is the subject here, not the transport. */
function idleClient(): RelayClient {
  return new RelayClient({ url: "ws://127.0.0.1:1/app", token: "unused", key });
}

describe("store notifications", () => {
  // attach() re-reads the relay state the constructor already stored, which on
  // every mount is the identical object — one render for nothing, and one
  // needless re-arm of main.tsx's persist debounce.
  test("attaching to an unchanged client notifies nobody", () => {
    const store = new Store(idleClient());
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    const before = store.getState();
    const detach = store.attach();
    detach();

    expect(notifications).toBe(0);
    expect(store.getState()).toBe(before);
  });

  test("a patch that does change something still notifies", () => {
    const store = new Store(idleClient());
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.setPrompt("port the pane");

    expect(notifications).toBe(1);
    expect(store.getState().form.prompt).toBe("port the pane");
  });
});

/**
 * The six-second window is real time, which no test should wait out. setTimeout
 * is a host boundary like `document` and `history`, so it is stubbed rather than
 * injected: the callback is captured and fired by hand.
 */
function captureUndoTimer(): { fire: () => void; armed: () => boolean; restore: () => void } {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let pending: (() => void) | null = null;

  // defineProperty like installBrowserGlobals: assigning over the overloaded
  // globals would need a cast to type a stub this narrow.
  Object.defineProperty(globalThis, "setTimeout", {
    value: (callback: () => void, ms: number) => {
      if (ms !== UNDO_WINDOW_MS) return realSet(callback, ms);
      pending = callback;
      return 0;
    },
    configurable: true,
  });
  // The undo window is the only timer these tests put in flight, so cancelling
  // anything means cancelling that one.
  Object.defineProperty(globalThis, "clearTimeout", {
    value: (): void => {
      pending = null;
    },
    configurable: true,
  });

  return {
    fire: () => {
      const callback = pending;
      pending = null;
      callback?.();
    },
    armed: () => pending !== null,
    restore: () => {
      Object.defineProperty(globalThis, "setTimeout", { value: realSet, configurable: true });
      Object.defineProperty(globalThis, "clearTimeout", { value: realClear, configurable: true });
    },
  };
}

describe("clearing the prompt", () => {
  let timer: ReturnType<typeof captureUndoTimer>;

  beforeEach(() => {
    timer = captureUndoTimer();
  });

  afterEach(() => timer.restore());

  test("clearing empties the field and stashes what it held", () => {
    const store = new Store(idleClient(), { ...DEFAULT_FORM, prompt: "port the pane" });

    store.clearPrompt();

    expect(store.getState().form.prompt).toBe("");
    expect(store.getState().promptUndo).toBe("port the pane");
  });

  test("undo puts the text back and retires the offer", () => {
    const store = new Store(idleClient(), { ...DEFAULT_FORM, prompt: "port the pane" });
    store.clearPrompt();

    store.undoClear();

    expect(store.getState().form.prompt).toBe("port the pane");
    expect(store.getState().promptUndo).toBeNull();
    expect(timer.armed()).toBe(false);
  });

  test("the offer expires when the window runs out", () => {
    const store = new Store(idleClient(), { ...DEFAULT_FORM, prompt: "port the pane" });
    store.clearPrompt();

    timer.fire();

    expect(store.getState().promptUndo).toBeNull();
    // Nothing to put back: undo after the window is a no-op, not an empty restore.
    store.undoClear();
    expect(store.getState().form.prompt).toBe("");
  });

  test("typing drops the offer", () => {
    const store = new Store(idleClient(), { ...DEFAULT_FORM, prompt: "port the pane" });
    store.clearPrompt();

    store.setPrompt("p");

    expect(store.getState().promptUndo).toBeNull();
    expect(timer.armed()).toBe(false);
  });

  test("clearing an empty prompt offers nothing to undo", () => {
    const store = new Store(idleClient());
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.clearPrompt();

    expect(store.getState().promptUndo).toBeNull();
    expect(notifications).toBe(0);
  });

  test("detaching cancels a pending expiry", () => {
    const store = new Store(idleClient(), { ...DEFAULT_FORM, prompt: "port the pane" });
    const detach = store.attach();
    store.clearPrompt();

    detach();

    expect(timer.armed()).toBe(false);
  });
});

describe("layers and history", () => {
  let fake: ReturnType<typeof fakeHistory>;

  afterEach(() => fake.restore());

  test("stacked layers record their depth and back closes them one at a time", () => {
    fake = fakeHistory();
    const store = new Store(idleClient());

    store.openSettings();
    store.openSheet("model");
    expect(fake.entries()).toMatchObject([null, { seance: "layer", depth: 1 }, { seance: "layer", depth: 2 }]);

    store.dismissLayer();
    fake.settle(store);
    expect(store.getState().sheet).toBeNull();
    expect(store.getState().settings).toBe(true);

    store.dismissLayer();
    fake.settle(store);
    expect(store.getState().settings).toBe(false);
    expect(fake.index()).toBe(0);
  });

  test("machines is one layer over the form: back returns to the form and drops its chart", async () => {
    fake = fakeHistory();
    const store = new Store(idleClient());

    store.openMachines();
    // An idle client has no socket, so the chart settles on its failure line.
    await store.showHistory({ kind: "machine", deviceId: "dev-1" }, "24h");
    expect(store.getState().history?.result.kind).toBe("failed");
    expect(fake.entries()).toMatchObject([null, { depth: 1 }]);

    store.dismissLayer();
    fake.settle(store);
    expect(store.getState()).toMatchObject({ machines: false, settings: false, history: null });
    expect(fake.index()).toBe(0);
  });

  test("a chart closed before its answer stays closed", async () => {
    fake = fakeHistory();
    const store = new Store(idleClient());

    const answered = store.showHistory({ kind: "machine", deviceId: "dev-1" }, "6h");
    expect(store.getState().history).toMatchObject({ range: "6h", result: { kind: "loading" } });
    // 6h on the raw tier is exactly the per-request point cap.
    const asked = store.getState().history;
    expect(asked === null ? null : (asked.to - asked.from) / asked.step + 1).toBe(720);
    store.hideHistory();
    await answered;

    expect(store.getState().history).toBeNull();
  });

  test("an account chart asks for its account's series, and still narrows a reply that ignored the ask", async () => {
    fake = fakeHistory();
    const seen: MetricsRequest[] = [];
    // A daemon that predates `labels`: every exclave's quota comes back whatever was asked.
    const client = new (class extends RelayClient {
      override async metrics(_deviceId: string, request: MetricsRequest): Promise<MetricsReply | null> {
        seen.push(request);
        const quota = (account: string, value: number): MetricsSeries => ({
          metric: "quota_5h_pct",
          labels: { machine: "mac", exclave: account, account },
          points: [[request.to, value]],
        });
        return { series: [quota("acct-a", 40), quota("acct-b", 90)] };
      }
    })({ url: "ws://127.0.0.1:1/app", token: "unused", key });
    const store = new Store(client);

    await store.showHistory({ kind: "account", accountId: "acct-a", deviceId: "dev-1" }, "30d");
    expect(seen[0]?.labels).toEqual({ account: "acct-a" });
    const result = store.getState().history?.result;
    expect(result?.kind === "ok" ? result.series.map((s) => s.points[0]?.[1]) : result).toEqual([40]);

    // A machine chart is the daemon's own load: no matcher.
    await store.showHistory({ kind: "machine", deviceId: "dev-1" }, "6h");
    expect(seen[1]?.labels).toBeUndefined();
  });

  test("a chart opened without a range keeps the last one picked, across targets and a close", async () => {
    fake = fakeHistory();
    const store = new Store(idleClient());

    await store.showHistory({ kind: "machine", deviceId: "dev-1" });
    expect(store.getState().history?.range).toBe("24h");

    await store.showHistory({ kind: "machine", deviceId: "dev-1" }, "6h");
    store.hideHistory();
    await store.showHistory({ kind: "machine", deviceId: "dev-2" });
    expect(store.getState().history?.range).toBe("6h");
  });

  test("a sheet already open is replaced without a second entry", () => {
    fake = fakeHistory();
    const store = new Store(idleClient());

    store.openSheet("model");
    store.openSheet("effort");

    expect(fake.entries()).toHaveLength(2);
    store.dismissLayer();
    fake.settle(store);
    expect(store.getState().sheet).toBeNull();
    expect(fake.index()).toBe(0);
  });

  // A reload with settings open (saving credentials, a service worker update)
  // resumes on its entry with nothing showing; back from there must be the OS's.
  test("launching on an entry whose layers are gone steps back to the base", () => {
    fake = fakeHistory([null, { seance: "layer", depth: 1 }, { seance: "layer", depth: 2 }]);
    const store = new Store(idleClient());

    const detach = store.attach();
    fake.settle(store);
    detach();

    expect(fake.index()).toBe(0);
  });

  test("entries from before depth was recorded are skipped one per popstate", () => {
    fake = fakeHistory([null, { seance: "layer" }, { seance: "layer" }, { seance: "layer" }]);
    const store = new Store(idleClient());

    const detach = store.attach();
    fake.settle(store);
    detach();

    expect(fake.index()).toBe(0);
  });

  // Opened before the launch-time skip ran: the sheet's own depth is 1, the same
  // as the stale entry under it, so only the owner tells them apart.
  test("back onto a stale entry under a live layer skips past it", () => {
    fake = fakeHistory([null, { seance: "layer", depth: 1 }]);
    const store = new Store(idleClient());

    store.openSheet("model");
    store.dismissLayer();
    fake.settle(store);

    expect(store.getState().sheet).toBeNull();
    expect(fake.index()).toBe(0);
  });

  // Forward can't reopen the layer an entry was pushed for, so it steps back off
  // it; left in place, the next layer's back would land on it and close nothing.
  test("forward onto a closed layer's entry steps back, and the next back still closes", () => {
    fake = fakeHistory();
    const store = new Store(idleClient());

    store.openSettings();
    store.dismissLayer();
    fake.settle(store);
    fake.forward();
    fake.settle(store);
    expect(fake.index()).toBe(0);

    store.openSettings();
    store.dismissLayer();
    fake.settle(store);
    expect(store.getState().settings).toBe(false);
    expect(fake.index()).toBe(0);
  });

  test("picking a machine closes the sheet without touching settings beneath it", () => {
    fake = fakeHistory();
    const store = new Store(idleClient());

    store.openSettings();
    store.openSheet("machine");
    store.pickMachine("m-1");
    fake.settle(store);

    expect(store.getState().sheet).toBeNull();
    expect(store.getState().settings).toBe(true);
    expect(fake.index()).toBe(1);
  });
});

/**
 * A client whose scheduler answers are the test's: registry state it sets, and
 * `route-preview`, the store put, `queue` and the queue actions answered by
 * scripts, `queue-changed` nudges emitted on demand. The relay is a
 * network boundary; the real client meets the real relay in client.test.ts.
 */
class ScriptedClient extends RelayClient {
  relay: RelayState;
  readonly listeners = new Set<() => void>();
  readonly previews: TaskRequest[] = [];
  onPreview: () => Promise<RoutePreviewReply | null> = async () => ({ decision: DECISION });
  /** Every task a create was handed, in order: a retry shows up as the same task again. */
  readonly creates: Task[] = [];
  onCreate: (task: Task) => Promise<TaskCreated | StoreRefusal | null> = async () => ({
    ok: true,
    landedEarlier: false,
  });
  readonly queueRequests: QueueRequest[] = [];
  onQueue: (request: QueueRequest) => Promise<QueueReply | null> = async () => ({ tasks: [QUEUED], at: 1 });
  onCancel: (taskId: string) => Promise<TaskReply | null> = async (id) => ({
    task: { ...QUEUED, id, state: "cancelled" },
  });
  onMarkDone: (taskId: string) => Promise<TaskReply | null> = async (id) => ({
    task: { ...QUEUED, id, state: "done", doneBy: "manual" },
  });
  readonly runNows: string[] = [];
  onRunNow: (taskId: string) => Promise<TaskReply | null> = async (id) => ({
    task: { ...QUEUED, id, state: "reserved" },
  });
  onPause: (request: PauseRequest) => Promise<PauseReply | null> = async () => ({
    holds: [{ until: "resume", at: 5 }],
  });
  onResume: (request: ResumeRequest) => Promise<PauseReply | null> = async () => ({ holds: [] });
  readonly nudgeListeners = new Set<(change: QueueChanged) => void>();
  readonly getTasks: string[] = [];
  readonly discards: DiscardRequest[] = [];
  onDiscard: (request: DiscardRequest) => Promise<DiscardReply | null> = async ({ taskId }) => ({ taskId });
  /** The store's own answer for one task: by default it holds whatever is asked about. */
  onGetTask: (taskId: string) => Promise<TaskLookup | StoreRefusal | null> = async (id) => ({
    ok: true,
    task: { version: 1, task: { ...QUEUED, id } },
  });

  constructor(relay: Partial<RelayState> = {}) {
    super({ url: "ws://127.0.0.1:1/app", token: "unused", key });
    this.relay = { ...LEADING_RELAY, ...relay };
  }

  override getState = (): RelayState => this.relay;

  override subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  override reconnect(): void {}

  emit(next: Partial<RelayState>): void {
    this.relay = { ...this.relay, ...next };
    for (const listener of this.listeners) listener();
  }

  override routePreview(request: TaskRequest): Promise<RoutePreviewReply | null> {
    this.previews.push(request);
    return this.onPreview();
  }

  override createTask(task: Task): Promise<TaskCreated | StoreRefusal | null> {
    this.creates.push(task);
    return this.onCreate(task);
  }

  override queue(request: QueueRequest = {}): Promise<QueueReply | null> {
    this.queueRequests.push(request);
    return this.onQueue(request);
  }

  override discard(request: DiscardRequest): Promise<DiscardReply | null> {
    this.discards.push(request);
    return this.onDiscard(request);
  }

  override getTask(taskId: string): Promise<TaskLookup | StoreRefusal | null> {
    this.getTasks.push(taskId);
    return this.onGetTask(taskId);
  }

  override cancel(taskId: string): Promise<TaskReply | null> {
    return this.onCancel(taskId);
  }

  override markDone(taskId: string): Promise<TaskReply | null> {
    return this.onMarkDone(taskId);
  }

  override runNow(taskId: string): Promise<TaskReply | null> {
    this.runNows.push(taskId);
    return this.onRunNow(taskId);
  }

  override pause(request: PauseRequest): Promise<PauseReply | null> {
    return this.onPause(request);
  }

  override resume(request: ResumeRequest = {}): Promise<PauseReply | null> {
    return this.onResume(request);
  }

  override onQueueChanged(listener: (change: QueueChanged) => void): () => void {
    this.nudgeListeners.add(listener);
    return () => this.nudgeListeners.delete(listener);
  }

  nudge(change: QueueChanged): void {
    for (const listener of this.nudgeListeners) listener(change);
  }
}

const ORIGIN = "github.com/acme/app";

function autoMachine(deviceId: string, fields: Partial<Machine> = {}): Machine {
  return {
    deviceId,
    name: deviceId,
    platform: "linux",
    repos: [{ name: "app", path: `/r/${deviceId}/app`, defaultBranch: "main", origin: ORIGIN }],
    scannedAt: 1,
    lastSeen: 1,
    connected: true,
    ...fields,
  };
}

const LEADING_RELAY: RelayState = {
  status: "open",
  rejection: null,
  machines: [autoMachine("dev-a"), autoMachine("dev-b")],
  registrySize: 2,
  ignored: 0,
  unbound: 0,
  skewed: 0,
  settling: false,
  registrySettled: true,
  fleetQuota: [],
  scheduler: { kind: "ready", deviceId: "dev-a", term: 1 },
};

const DECISION: Decision = { at: 1, chosen: null, candidates: [] };
const QUEUED: Task = {
  id: "t-1",
  spec: { repo: ORIGIN, mode: "worktree", prompt: "fix it" },
  state: "ready",
  createdAt: 1,
};

/**
 * Every timer the store arms, held until the test fires it by delay — the
 * preview's retry and debounce, the follow loop's polls — so nothing here waits
 * on the clock. A host boundary, stubbed as `captureUndoTimer` stubs it.
 */
function captureTimers(): { fire: (ms: number) => void; armed: (ms: number) => number; restore: () => void } {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let next = 1;
  const pending = new Map<number, { readonly ms: number; readonly callback: () => void }>();
  Object.defineProperty(globalThis, "setTimeout", {
    value: (callback: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { ms, callback });
      return id;
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    value: (id: number): void => {
      pending.delete(id);
    },
    configurable: true,
  });
  return {
    fire: (ms) => {
      for (const [id, timer] of [...pending]) {
        if (timer.ms !== ms) continue;
        pending.delete(id);
        timer.callback();
      }
    },
    armed: (ms) => [...pending.values()].filter((timer) => timer.ms === ms).length,
    restore: () => {
      Object.defineProperty(globalThis, "setTimeout", { value: realSet, configurable: true });
      Object.defineProperty(globalThis, "clearTimeout", { value: realClear, configurable: true });
    },
  };
}

/** Lets the scripted replies' promise chains run, until `ready` holds. */
async function until(ready: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (ready()) return;
    // oxlint-disable-next-line no-await-in-loop -- a poll over microtasks
    await Promise.resolve();
  }
  throw new Error(`never: ${what}`);
}

/** Lets pending microtasks run, before an assertion that nothing more happened. */
async function drain(): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- as above
    await Promise.resolve();
  }
}

/** The one task a test's store put, which the client double kept. */
function firstCreate(client: ScriptedClient): Task {
  const task = client.creates[0];
  if (task === undefined) throw new Error("nothing created");
  return task;
}

/** A queued verdict on screen and the same task as a row on the open Queue screen. */
async function followedAndListed(client: ScriptedClient): Promise<{ store: Store; created: Task }> {
  const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
  await store.spawn();
  const created = firstCreate(client);
  client.onQueue = async () => ({ tasks: [created], holds: [], at: 1 });
  store.openQueue();
  await until(() => store.getState().queueView?.kind === "ok", "the queue read");
  return { store, created };
}

function listsRow(store: Store, taskId: string): boolean {
  const view = store.getState().queueView;
  return view?.kind === "ok" && view.tasks.some((t) => t.id === taskId);
}

function queuedState(store: Store): string | undefined {
  const verdict = store.getState().verdict;
  return verdict?.kind === "queued" ? verdict.task.state : undefined;
}

function followEnd(store: Store): unknown {
  const verdict = store.getState().verdict;
  return verdict?.kind === "queued" ? verdict.follow : undefined;
}

describe("auto's error paths", () => {
  let timers: ReturnType<typeof captureTimers>;

  beforeEach(() => {
    timers = captureTimers();
  });

  afterEach(() => timers.restore());

  test("a preview answered not_ready keeps loading and asks again, then shows the decision", async () => {
    const client = new ScriptedClient();
    client.onPreview = async () => ({ ok: false, code: "not_ready", message: "taking over" });
    const store = new Store(client);
    store.pickMachine(null);
    await until(() => timers.armed(PREVIEW_RETRY_MS) === 1, "the retry armed");
    expect(store.getState().preview).toMatchObject({ kind: "loading" });

    client.onPreview = async () => ({ decision: DECISION });
    timers.fire(PREVIEW_RETRY_MS);
    await until(() => store.getState().preview?.kind === "ok", "the decision shown");
    expect(client.previews).toHaveLength(2);
  });

  test("a preview that answers after a machine was picked is dropped", async () => {
    const client = new ScriptedClient();
    const late = Promise.withResolvers<RoutePreviewReply | null>();
    client.onPreview = () => late.promise;
    const store = new Store(client);
    store.pickMachine(null);
    store.pickMachine("dev-b");
    late.resolve({ decision: DECISION });
    await drain();
    expect(store.getState().preview).toBeNull();
    expect(store.getState().form.machine).toBe("dev-b");
  });

  test("a re-ask keeps the last decision on screen until its answer lands", async () => {
    const client = new ScriptedClient();
    client.onPreview = async () => ({ decision: DECISION });
    const store = new Store(client);
    store.pickMachine(null);
    await until(() => store.getState().preview?.kind === "ok", "the first preview");

    const late = Promise.withResolvers<RoutePreviewReply | null>();
    client.onPreview = () => late.promise;
    void store.refreshPreview();
    expect(store.getState().preview).toMatchObject({ kind: "loading", previous: DECISION });

    late.resolve({ ok: false, code: "not_leader", message: "moved" });
    await until(() => store.getState().preview?.kind === "failed", "the answer replaces it");
  });

  test("a presence or repo change asks the preview again once its burst settles; a status beat does not", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM });
    const detach = store.attach();
    await until(() => store.getState().preview?.kind === "ok", "the first preview");
    expect(client.previews).toHaveLength(1);

    // Same presence and repos: nothing to ask.
    client.emit({ machines: client.relay.machines.map((m) => ({ ...m, lastSeen: 2 })) });
    expect(timers.armed(PREVIEW_DEBOUNCE_MS)).toBe(0);

    client.emit({ machines: [autoMachine("dev-a"), autoMachine("dev-b", { connected: false })] });
    client.emit({ machines: [autoMachine("dev-a")] });
    expect(timers.armed(PREVIEW_DEBOUNCE_MS)).toBe(1);
    timers.fire(PREVIEW_DEBOUNCE_MS);
    await until(() => client.previews.length === 2, "the second preview");
    detach();
  });

  test("a create that times out keeps the prompt, says it may have queued, and a retry re-puts the same task", async () => {
    const client = new ScriptedClient();
    client.onCreate = async () => {
      throw new RequestFailure("timeout", "store-put timed out after 10000ms", "relay");
    };
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.spawn();
    const verdict = store.getState().verdict;
    expect(verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: true, retry: { id: client.creates[0]?.id } });
    expect(store.getState().form.prompt).toBe("fix it");
    expect(verdict?.kind === "unqueued" && verdict.message).toBe("The relay did not answer in time.");

    // The store had it after all: the same id answers version_conflict, which the client reports as queued.
    client.onCreate = async () => ({ ok: true, landedEarlier: true });
    if (verdict?.kind !== "unqueued") throw new Error("expected unqueued");
    await store.retryEnqueue(verdict);
    expect(client.creates).toHaveLength(2);
    expect(client.creates[1]).toBe(client.creates[0]);
    expect(store.getState().verdict).toMatchObject({ kind: "queued", task: { id: client.creates[0]?.id } });
    expect(store.getState().form.prompt).toBe("");
  });

  // A dismissal's back is delivered later, so a retry that went back would close whichever verdict had landed by then.
  test("a retry's verdict survives the history the failed one left", async () => {
    const fake = fakeHistory();
    try {
      const client = new ScriptedClient();
      client.onCreate = async () => {
        throw new RequestFailure("timeout", "store-put timed out after 10000ms", "relay");
      };
      const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
      await store.spawn();
      const failed = store.getState().verdict;
      if (failed?.kind !== "unqueued") throw new Error("expected unqueued");
      fake.settle(store);

      store.retrySpawn(failed);
      await until(() => client.creates.length === 2, "the retry put");
      await until(() => store.getState().verdict?.kind === "unqueued", "the retried verdict shown");
      fake.settle(store);

      expect(store.getState().verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: true });
      // The retried verdict took over the failed one's entry: one layer, one back.
      expect(fake.entries()).toHaveLength(2);
      store.dismissLayer();
      fake.settle(store);
      expect(store.getState().verdict).toBeNull();
      expect(fake.index()).toBe(0);
    } finally {
      fake.restore();
    }
  });

  test("a create that never left is not queued; one dropped after the send may be; both can be retried", async () => {
    for (const [reason, mayHaveLanded] of [
      ["disconnected", false],
      ["dropped", true],
    ] as const) {
      const client = new ScriptedClient();
      client.onCreate = async () => {
        throw new RequestFailure(reason, "the relay socket closed", "relay");
      };
      const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
      // oxlint-disable-next-line no-await-in-loop -- one store each
      await store.spawn();
      expect(store.getState().verdict).toMatchObject({ kind: "unqueued", mayHaveLanded, retry: expect.anything() });
    }
  });

  test("a create whose answer was lost says once, in closed sentences, that it may have queued", async () => {
    for (const [reason, message] of [
      ["timeout", "store-put timed out after 10000ms"],
      ["dropped", "the relay socket was replaced"],
    ] as const) {
      const client = new ScriptedClient();
      client.onCreate = async () => {
        throw new RequestFailure(reason, message, "relay");
      };
      const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
      // oxlint-disable-next-line no-await-in-loop -- one store each
      await store.spawn();
      const verdict = store.getState().verdict;
      if (verdict === null) throw new Error("no verdict");
      const { body } = describeVerdict(verdict, [], {}, 0, null);
      expect(body.match(/may have/gu)).toHaveLength(1);
      expect(body).not.toContain("store-put");
      expect(body).toMatch(/^[A-Z].*\.$/u);
      // A sentence that runs into the next one unclosed: "…anyway It may…".
      expect(body).not.toMatch(/[a-z] [A-Z]/u);
    }
  });

  test("a store refusal is worded without 'may have queued'; only a full store or a busy minute offers a retry", async () => {
    for (const [code, retry] of [
      ["store_full", true],
      ["rate_limited", true],
      ["too_large", false],
      ["invalid_request", false],
    ] as const) {
      const client = new ScriptedClient();
      client.onCreate = async () => ({ ok: false, code });
      const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
      // oxlint-disable-next-line no-await-in-loop -- one store each
      await store.spawn();
      const verdict = store.getState().verdict;
      expect(verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: false });
      expect(verdict !== null && "retry" in verdict).toBe(retry);
      expect(store.getState().form.prompt).toBe("fix it");
    }
  });

  test("a full store names the unreadable records the last queue read listed; with none it reads as before", async () => {
    for (const [count, says] of [
      [3, "3 of its records cannot be read"],
      [0, "prunes finished tasks"],
    ] as const) {
      const client = new ScriptedClient();
      const listed = Array.from({ length: count }, (_, i) => ({ taskId: `j-${i}`, version: 1, reason: "unopenable" }));
      client.onQueue = async () => ({ tasks: [], holds: [], unreadable: listed, at: 1 });
      client.onCreate = async () => ({ ok: false, code: "store_full" });
      const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
      // oxlint-disable-next-line no-await-in-loop -- one store each
      await store.refreshQueue();
      // oxlint-disable-next-line no-await-in-loop -- as above
      await store.spawn();
      const verdict = store.getState().verdict;
      expect(verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: false, retry: expect.anything() });
      const message = verdict?.kind === "unqueued" ? verdict.message : "";
      expect(message).toContain(says);
      expect(message.endsWith("Clear them on the Queue screen, then try again.")).toBe(count > 0);
    }
  });

  test("a store answer this build cannot read may have landed, and can be re-put", async () => {
    const client = new ScriptedClient();
    client.onCreate = async () => null;
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.spawn();
    expect(store.getState().verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: true, retry: expect.anything() });
  });

  test("a created task becomes the queued verdict as the app's own copy, and the prompt clears", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.spawn();
    const created = firstCreate(client);
    expect(created).toMatchObject({ state: "queued", spec: { repo: ORIGIN, prompt: "fix it" } });
    expect(store.getState().verdict).toEqual({ kind: "queued", task: created });
    expect(store.getState().form.prompt).toBe("");
    expect(timers.armed(QUEUE_POLL_MS)).toBe(1);
  });

  test("following stops once the task is running", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.spawn();
    const created = firstCreate(client);
    expect(store.getState().verdict).toMatchObject({ kind: "queued", task: { state: "queued" } });

    const running: Task = { ...created, state: "running" };
    client.onQueue = async () => ({ tasks: [running], at: 2 });
    timers.fire(QUEUE_POLL_MS);
    await until(() => {
      const verdict = store.getState().verdict;
      return verdict?.kind === "queued" && verdict.task.state === "running";
    }, "the running task shown");
    await drain();
    expect(store.getState().verdict).toEqual({ kind: "queued", task: running });
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);
    // The read asked for this task only.
    expect(client.queueRequests.at(-1)).toEqual({ tasks: [created.id] });
  });

  test("following stops and says so when the leader refuses the read", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.spawn();
    client.onQueue = async () => ({ ok: false, code: "invalid_request", message: "?" });
    timers.fire(QUEUE_POLL_MS);
    await until(() => followEnd(store) !== undefined, "following to stop");
    expect(store.getState().verdict).toMatchObject({ kind: "queued", follow: { kind: "refused" } });
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);
  });

  test("a task the leader answers without but the store holds stays on both surfaces, followed under an accurate label", async () => {
    const client = new ScriptedClient();
    const { store, created } = await followedAndListed(client);
    const detach = store.attach();
    await drain();
    client.onQueue = async () => ({ tasks: [], holds: [], at: 2 });

    client.nudge({ at: 2, tasks: [created.id] });
    await until(() => client.getTasks.length >= 2, "both surfaces asked the store");
    await drain();
    expect(listsRow(store, created.id)).toBe(true);
    expect(followEnd(store)).toBeUndefined();

    // Answered every time, so out of polls it never claims the scheduler stopped answering.
    const rearmed = (): boolean => timers.armed(QUEUE_POLL_MS) === 1;
    for (let poll = 1; poll < QUEUE_POLLS; poll += 1) {
      timers.fire(QUEUE_POLL_MS);
      // oxlint-disable-next-line no-await-in-loop -- each poll follows the one before
      await until(rearmed, "the next poll armed");
    }
    timers.fire(QUEUE_POLL_MS);
    await until(() => followEnd(store) !== undefined, "following to give up");
    expect(followEnd(store)).toEqual({ kind: "unlisted" });
    const verdict = store.getState().verdict;
    if (verdict === null) throw new Error("no verdict");
    const { body } = describeVerdict(verdict, [], {}, 0, null);
    expect(body).toContain("still in the queue");
    expect(body).not.toContain("stopped answering");
    detach();
  });

  test("a task the leader answers without and the store no longer holds leaves both surfaces", async () => {
    const client = new ScriptedClient();
    const { store, created } = await followedAndListed(client);
    const detach = store.attach();
    await drain();
    client.onQueue = async () => ({ tasks: [], holds: [], at: 2 });
    client.onGetTask = async () => ({ ok: true, task: null });

    client.nudge({ at: 2, tasks: [created.id] });
    await until(() => followEnd(store) !== undefined && !listsRow(store, created.id), "both surfaces to let go");
    expect(followEnd(store)).toEqual({ kind: "gone" });
    // Final on a nudge's read too: the poll waiting behind it is disarmed.
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);
    const verdict = store.getState().verdict;
    if (verdict === null) throw new Error("no verdict");
    expect(describeVerdict(verdict, [], {}, 0, null).body).toEndWith("no longer in the queue.");
    detach();
  });

  test("a task the leader answers without, when the store cannot say, is a missed poll and keeps its row", async () => {
    const client = new ScriptedClient();
    const { store, created } = await followedAndListed(client);
    client.onQueue = async () => ({ tasks: [], holds: [], at: 2 });
    client.onGetTask = async () => {
      throw new RequestFailure("timeout", "store-get timed out", "relay");
    };
    await store.refreshQueue([created.id], true);
    expect(listsRow(store, created.id)).toBe(true);

    const rearmed = (): boolean => timers.armed(QUEUE_POLL_MS) === 1;
    for (let poll = 1; poll < QUEUE_POLLS; poll += 1) {
      timers.fire(QUEUE_POLL_MS);
      // oxlint-disable-next-line no-await-in-loop -- each poll follows the one before
      await until(rearmed, "the next poll armed");
    }
    timers.fire(QUEUE_POLL_MS);
    await until(() => followEnd(store) !== undefined, "following to give up");
    expect(followEnd(store)).toEqual({ kind: "unanswered" });
  });

  test("missed polls keep what was shown and ask again; out of polls, it says what it last knew may be stale", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.spawn();
    const created = firstCreate(client);
    client.onQueue = async () => {
      throw new RequestFailure("timeout", "queue timed out");
    };
    const rearmed = (): boolean => timers.armed(QUEUE_POLL_MS) === 1;
    for (let poll = 1; poll < QUEUE_POLLS; poll += 1) {
      expect(rearmed()).toBe(true);
      timers.fire(QUEUE_POLL_MS);
      // oxlint-disable-next-line no-await-in-loop -- each poll follows the one before
      await until(rearmed, "the next poll armed");
    }
    timers.fire(QUEUE_POLL_MS);
    await until(() => followEnd(store) !== undefined, "following to give up");
    expect(store.getState().verdict).toEqual({ kind: "queued", task: created, follow: { kind: "unanswered" } });
  });

  test("with no leader the task still queues, the follow waits without spending polls, and a leader's arrival places it", async () => {
    const client = new ScriptedClient({ scheduler: { kind: "none" } });
    client.onQueue = async () => {
      throw new RequestFailure("no_leader", "no scheduler is leading");
    };
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.spawn();
    expect(store.getState().verdict).toMatchObject({ kind: "queued" });
    expect(client.creates).toHaveLength(1);

    // More polls than the budget: none of them counted, so it never gives up.
    const nextArmed = (): boolean => timers.armed(QUEUE_POLL_MS) === 1;
    for (let poll = 0; poll < QUEUE_POLLS + 3; poll += 1) {
      timers.fire(QUEUE_POLL_MS);
      // oxlint-disable-next-line no-await-in-loop -- each poll follows the one before
      await until(nextArmed, "the next poll armed");
    }
    expect(followEnd(store)).toBeUndefined();

    const placed: Task = { ...firstCreate(client), state: "running" };
    client.onQueue = async () => ({ tasks: [placed], at: 3 });
    timers.fire(QUEUE_POLL_MS);
    await until(() => queuedState(store) === "running", "placed");
  });

  test("the preview still says there is no leader, though queueing needs none", async () => {
    const client = new ScriptedClient({ scheduler: { kind: "none" } });
    client.onPreview = async () => {
      throw new RequestFailure("no_leader", "no scheduler is leading");
    };
    const store = new Store(client, { ...DEFAULT_FORM });
    store.pickMachine(null);
    await until(() => store.getState().preview?.kind === "failed", "the preview to fail");
    expect(store.getState().preview).toMatchObject({
      kind: "failed",
      message: expect.stringMatching(/no scheduler/iu),
    });
  });

  test("a queue-changed naming the followed task reads it without spending a poll; one naming another does not", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    const created = firstCreate(client);

    client.nudge({ at: 2, tasks: ["someone-else"] });
    await drain();
    // The queue list may be re-read for the chip; the followed task is not.
    expect(client.queueRequests.filter((r) => r.tasks?.includes(created.id))).toEqual([]);

    const running: Task = { ...created, state: "running" };
    client.onQueue = async () => ({ tasks: [running], at: 3 });
    client.nudge({ at: 3, tasks: [created.id] });
    await until(() => queuedState(store) === "running", "placed");
    expect(client.queueRequests).toContainEqual({ tasks: [created.id] });
    // Settled by the nudge: the poll that was waiting is gone.
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);
    detach();
  });

  test("a nudge with no ids reads the followed task too, and spends nothing when the read misses", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    client.onQueue = async () => {
      throw new RequestFailure("timeout", "queue timed out");
    };
    client.nudge({ at: 2 });
    await until(() => client.queueRequests.length > 1, "the read");
    await drain();
    expect(followEnd(store)).toBeUndefined();
    expect(timers.armed(QUEUE_POLL_MS)).toBe(1);
    detach();
  });

  test("a slow poll answered after a newer read settled the verdict does not walk it back", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    const created = firstCreate(client);
    await drain();

    const slow = Promise.withResolvers<QueueReply | null>();
    client.onQueue = () => slow.promise;
    timers.fire(QUEUE_POLL_MS);
    await until(() => client.queueRequests.some((r) => r.tasks?.[0] === created.id), "the poll's read");

    const running: Task = { ...created, state: "running" };
    client.onQueue = async () => ({ tasks: [running], at: 3 });
    client.nudge({ at: 3, tasks: [created.id] });
    await until(() => queuedState(store) === "running", "placed");

    slow.resolve({ tasks: [created], at: 2 });
    await drain();
    expect(store.getState().verdict).toEqual({ kind: "queued", task: running });
    // No restarted follow either.
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);
    detach();
  });

  test("a poll answered after a newer unsettled read is dropped, and its follow carries on", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    const created = firstCreate(client);
    await drain();

    const slow = Promise.withResolvers<QueueReply | null>();
    client.onQueue = () => slow.promise;
    timers.fire(QUEUE_POLL_MS);
    await until(() => client.queueRequests.some((r) => r.tasks?.[0] === created.id), "the poll's read");

    const ready: Task = { ...created, state: "ready" };
    client.onQueue = async () => ({ tasks: [ready], at: 3 });
    client.nudge({ at: 3, tasks: [created.id] });
    await until(() => queuedState(store) === "ready", "the newer read");

    slow.resolve({ tasks: [created], at: 2 });
    await drain();
    expect(queuedState(store)).toBe("ready");
    expect(timers.armed(QUEUE_POLL_MS)).toBe(1);
    detach();
  });
});

describe("the queue screen", () => {
  let timers: ReturnType<typeof captureTimers>;
  let fake: ReturnType<typeof fakeHistory>;

  beforeEach(() => {
    timers = captureTimers();
    fake = fakeHistory();
  });

  afterEach(() => {
    timers.restore();
    fake.restore();
  });

  const waiting: Task = { ...QUEUED, id: "w-1", state: "ready" };
  const running: Task = { ...QUEUED, id: "r-1", state: "running" };

  function loaded(client: ScriptedClient): Promise<Store> {
    client.onQueue = async () => ({ tasks: [waiting, running], holds: [], at: 1 });
    const store = new Store(client);
    store.openQueue();
    return until(() => store.getState().queueView?.kind === "ok", "the queue read").then(() => store);
  }

  test("opening reads the whole queue and the layer is closed by back", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    expect(client.queueRequests).toEqual([{}]);
    expect(store.getState().queue).toBe(true);
    expect(store.getState().queueView).toEqual({
      kind: "ok",
      tasks: [waiting, running],
      holds: [],
      unreadable: [],
      skew: expect.any(Number),
      at: 1,
    });

    store.dismissLayer();
    fake.settle(store);
    expect(store.getState().queue).toBe(false);
    expect(fake.index()).toBe(0);
  });

  test("as a desktop column the queue is read without opening, never becomes a layer, and shows its failures", async () => {
    const client = new ScriptedClient();
    client.onQueue = async () => ({ tasks: [waiting], holds: [], at: 1 });
    const store = new Store(client);
    store.setWide(true);
    await until(() => store.getState().queueView?.kind === "ok", "the column's read");

    // The verdict's queue button asks again rather than stacking an invisible layer.
    client.onQueue = async () => ({ ok: false, code: "not_ready", message: "taking over" });
    store.openQueue();
    expect(store.getState().queue).toBe(false);
    expect(fake.entries()).toHaveLength(1);
    // On screen, so the refusal is told — not dropped as a read nobody sees.
    await until(() => store.getState().queueNotice !== null, "the refusal");
    expect(client.queueRequests).toHaveLength(2);
  });

  test("a leader that answers with a refusal fails the screen; one with no leader says so", async () => {
    const client = new ScriptedClient();
    client.onQueue = async () => ({ ok: false, code: "not_ready", message: "taking over" });
    const store = new Store(client);
    store.openQueue();
    await until(() => store.getState().queueView?.kind === "failed", "the failure");

    const none = new ScriptedClient({ scheduler: { kind: "none" } });
    none.onQueue = async () => {
      throw new RequestFailure("no_leader", "no scheduler is leading");
    };
    const lone = new Store(none);
    lone.openQueue();
    await until(() => lone.getState().queueView?.kind === "failed", "no leader");
    expect(lone.getState().queueView).toMatchObject({ message: expect.stringMatching(/no scheduler/iu) });
    // No fallback to listing the relay's store: nothing is asked of it.
    expect(none.queueRequests).toHaveLength(1);
  });

  test("a queue-changed naming ids merges only those, and replaces the holds", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const detach = store.attach();
    // Attaching reads the whole queue once; the nudge below is a read of its own.
    await drain();
    const done: Task = { ...waiting, state: "running" };
    client.onQueue = async (request) => {
      expect(request).toEqual({ tasks: ["w-1"] });
      return { tasks: [done], holds: [{ until: "resume", at: 9 }], at: 2 };
    };
    client.nudge({ at: 2, tasks: ["w-1"] });
    await until(() => {
      const view = store.getState().queueView;
      return view?.kind === "ok" && view.holds.length === 1;
    }, "the merge");
    expect(store.getState().queueView).toEqual({
      kind: "ok",
      tasks: [done, running],
      holds: [{ until: "resume", at: 9 }],
      unreadable: [],
      skew: expect.any(Number),
      at: 2,
    });

    // No ids: the whole queue again.
    client.onQueue = async (request) => {
      expect(request).toEqual({});
      return { tasks: [done], holds: [], at: 3 };
    };
    client.nudge({ at: 3 });
    await until(() => {
      const view = store.getState().queueView;
      return view?.kind === "ok" && view.tasks.length === 1;
    }, "the whole read");
    detach();
  });

  test("a read that fails keeps the list that was shown and says so in the notice", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    client.onQueue = async () => ({ ok: false, code: "not_ready", message: "taking over" });
    await store.refreshQueue();
    expect(store.getState().queueView).toMatchObject({ kind: "ok" });
    expect(store.getState().queueNotice).toContain("taking over");
    client.onQueue = async () => ({ tasks: [waiting], holds: [], at: 5 });
    await store.refreshQueue();
    expect(store.getState().queueNotice).toBeNull();
  });

  test("an ask made while a read is out waits for it, then reads once more: reads are single-flight", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const late = Promise.withResolvers<QueueReply | null>();
    client.onQueue = () => late.promise;
    const before = client.queueRequests.length;
    const first = store.refreshQueue();
    client.onQueue = async () => ({ tasks: [], holds: [], at: 9 });
    const second = store.refreshQueue();
    await drain();
    expect(client.queueRequests).toHaveLength(before + 1);
    late.resolve({ tasks: [waiting], holds: [], at: 1 });
    await Promise.all([first, second]);
    expect(client.queueRequests).toHaveLength(before + 2);
    expect(store.getState().queueView).toMatchObject({ kind: "ok", tasks: [], at: 9 });
  });

  test("cancel and mark done merge the task as it now stands; a refusal is the notice, a lost answer says to refresh", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);

    await store.cancelTask("w-1");
    expect(store.getState().queueView).toMatchObject({
      tasks: [{ id: "w-1", state: "cancelled" }, { id: "r-1" }],
    });
    expect(store.getState().taskAction).toBeNull();

    client.onMarkDone = async () => ({ task: { ...running, state: "done", doneBy: "manual" } });
    await store.markDone("r-1");
    expect(store.getState().queueView).toMatchObject({ tasks: [{}, { id: "r-1", state: "done", doneBy: "manual" }] });

    client.onMarkDone = async () => ({ ok: false, code: "dispatching", message: "in flight" });
    await store.markDone("w-1");
    expect(store.getState().queueNotice).toContain("starting");

    client.onCancel = async () => {
      throw new RequestFailure("timeout", "cancel timed out");
    };
    await store.cancelTask("w-1");
    expect(store.getState().queueNotice).toBe(
      "Cancel timed out — the machine may be asleep, or the request may have landed anyway. Refresh to see whether it did.",
    );

    client.onCancel = async () => ({ ok: false, code: "internal_error", message: "boom" });
    await store.cancelTask("w-1");
    expect(store.getState().queueNotice).toBe(
      "The scheduler hit an error. It may have landed anyway. Refresh to see whether it did.",
    );

    // The next action clears the last one's notice.
    client.onCancel = async () => ({ task: { ...waiting, state: "cancelled" } });
    await store.cancelTask("w-1");
    expect(store.getState().queueNotice).toBeNull();
  });

  test("run now asks the leader for that task and merges it as reserved; a refusal is the notice", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);

    await store.runNow("w-1");
    expect(client.runNows).toEqual(["w-1"]);
    expect(store.getState().queueView).toMatchObject({ tasks: [{ id: "w-1", state: "reserved" }, { id: "r-1" }] });
    expect(store.getState().taskAction).toBeNull();

    client.onRunNow = async () => ({ ok: false, code: "unplaceable", message: "held" });
    await store.runNow("w-1");
    expect(store.getState().queueNotice).toBe(
      "Something besides the concurrency caps keeps it from every machine — see why it waits.",
    );
  });

  describe("continueTask", () => {
    const at = { deviceId: "dev-a", exclave: "default", clone: "app" };
    const failed: Task = {
      id: "f-1",
      spec: {
        repo: ORIGIN,
        mode: "worktree",
        prompt: "fix it",
        title: "fix-it",
        model: "opus",
        pin: { deviceId: "dev-b" },
      },
      state: "failed",
      failure: { code: "session_failed", message: "the session ended with exit 137" },
      assignment: { ...at, window: "fix-it" },
      createdAt: 1,
    };

    async function withFailed(client: ScriptedClient): Promise<Store> {
      client.onQueue = async () => ({ tasks: [failed], holds: [], at: 1 });
      const store = new Store(client);
      store.openQueue();
      await until(() => store.getState().queueView?.kind === "ok", "the queue read");
      return store;
    }

    const capable = (): ScriptedClient =>
      new ScriptedClient({
        machines: [
          autoMachine("dev-a", { capabilities: [CAPABILITIES.continueTask] }),
          autoMachine("dev-b", { capabilities: [CAPABILITIES.continueTask] }),
        ],
      });

    test("writes a continue task aimed at the exact clone, as the PWA's, and lists it at once", async () => {
      const client = capable();
      const store = await withFailed(client);
      await store.continueTask("f-1");

      expect(client.creates).toHaveLength(1);
      const [created] = client.creates;
      expect(created?.spec).toEqual({
        repo: ORIGIN,
        mode: "continue",
        title: "fix-it",
        model: "opus",
        continues: { task: "f-1", at },
        client: "pwa",
      });
      expect(created?.state).toBe("queued");
      expect(store.getState().queueNotice).toBeNull();
      expect(store.getState().taskAction).toBeNull();
      const view = store.getState().queueView;
      expect(view?.kind === "ok" ? view.tasks.map((t) => t.id) : []).toEqual([String(created?.id), "f-1"]);
    });

    test("an answer that never came says it may have landed; a refusal says nothing was stored", async () => {
      const client = capable();
      const store = await withFailed(client);
      client.onCreate = async () => null;
      await store.continueTask("f-1");
      expect(store.getState().queueNotice).toContain("Couldn't read the relay's answer");
      expect(store.getState().queueNotice).toContain("It may have landed anyway.");

      client.onCreate = async () => ({ ok: false, code: "store_full", message: "full" });
      await store.continueTask("f-1");
      expect(store.getState().queueNotice).not.toContain("may have landed");
      expect(store.getState().queueNotice).toContain("full");
      const view = store.getState().queueView;
      expect(view?.kind === "ok" && view.tasks).toEqual([failed]);
    });

    test("writes nothing for a task the list no longer holds, or one the offer refuses", async () => {
      const client = capable();
      const store = await withFailed(client);
      await store.continueTask("gone");
      expect(store.getState().queueNotice).toBe("That task is no longer listed.");

      // dev-b leads and can, but the machine it ran on (dev-a) cannot.
      const detach = store.attach();
      client.emit({
        machines: [autoMachine("dev-a"), autoMachine("dev-b", { capabilities: [CAPABILITIES.continueTask] })],
        scheduler: { kind: "ready", deviceId: "dev-b", term: 1 },
      });
      await store.continueTask("f-1");
      detach();
      expect(store.getState().queueNotice).toContain("can't continue a session yet");
      expect(client.creates).toEqual([]);
    });

    test("checks the leader at the tap, not only when the button was drawn", async () => {
      const client = capable();
      const store = await withFailed(client);
      const detach = store.attach();
      // The leader changed to one that cannot take a continue task (or went away) after the row was drawn.
      client.emit({
        machines: [autoMachine("dev-a", { capabilities: [CAPABILITIES.continueTask] }), autoMachine("dev-b")],
        scheduler: { kind: "ready", deviceId: "dev-b", term: 2 },
      });
      await store.continueTask("f-1");
      expect(store.getState().queueNotice).toContain("No verified scheduler");
      client.emit({ scheduler: { kind: "none" } });
      await store.continueTask("f-1");
      detach();
      expect(store.getState().queueNotice).toContain("No verified scheduler");
      expect(client.creates).toEqual([]);
      expect(store.getState().taskAction).toBeNull();
    });

    test("writes nothing for a task something already continues", async () => {
      const client = capable();
      const continuation: Task = {
        id: "c-1",
        spec: { repo: ORIGIN, mode: "continue", continues: { task: "f-1", at } },
        state: "needs-input",
        createdAt: 2,
      };
      client.onQueue = async () => ({ tasks: [failed, continuation], holds: [], at: 1 });
      const store = new Store(client);
      store.openQueue();
      await until(() => store.getState().queueView?.kind === "ok", "the queue read");
      await store.continueTask("f-1");
      expect(store.getState().queueNotice).toContain("already underway");
      expect(client.creates).toEqual([]);
    });
  });

  test("pause and resume replace the holds with the leader's answer, and a refusal is the notice", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const requests: unknown[] = [];
    client.onPause = async (request) => {
      requests.push(request);
      return { holds: [{ until: "resume", at: 5 }] };
    };
    await store.pauseQueue();
    expect(store.getState().queueView).toMatchObject({ holds: [{ until: "resume", at: 5 }] });
    expect(requests).toEqual([{ until: "resume" }]);

    const resumed: unknown[] = [];
    client.onResume = async (request) => {
      resumed.push(request);
      return { holds: [] };
    };
    await store.resumeQueue("acct");
    await store.resumeQueue();
    expect(resumed).toEqual([{ account: "acct" }, {}]);
    expect(store.getState().queueView).toMatchObject({ holds: [] });
    expect(store.getState().pausing).toBe(false);

    client.onPause = async () => ({ ok: false, code: "not_ready", message: "taking over" });
    await store.pauseQueue();
    expect(store.getState().queueNotice).toContain("taking over");
  });

  test("a hold changing asks the preview again: at once for our own, after the quiet for a read's", async () => {
    const client = new ScriptedClient();
    client.onPreview = async () => ({ decision: DECISION });
    const store = await loaded(client);
    store.pickMachine(null);
    await until(() => store.getState().preview?.kind === "ok", "the first preview");
    client.previews.length = 0;

    client.onPause = async () => ({ holds: [{ until: "resume", at: 5 }] });
    await store.pauseQueue();
    expect(client.previews).toHaveLength(1);
    client.onResume = async () => ({ holds: [] });
    await store.resumeQueue();
    expect(client.previews).toHaveLength(2);

    // The same holds read back ask nothing; another device's pause does.
    await store.refreshQueue();
    expect(timers.armed(PREVIEW_DEBOUNCE_MS)).toBe(0);
    client.onQueue = async () => ({ tasks: [waiting, running], holds: [{ until: "resume", at: 9 }], at: 2 });
    await store.refreshQueue();
    expect(timers.armed(PREVIEW_DEBOUNCE_MS)).toBe(1);
    timers.fire(PREVIEW_DEBOUNCE_MS);
    await until(() => client.previews.length === 3, "the preview under the new hold");

    // A failed pause changed nothing to ask about.
    client.onPause = async () => ({ ok: false, code: "not_ready", message: "taking over" });
    await store.pauseQueue();
    expect(client.previews).toHaveLength(3);
  });

  test("a re-dialed socket reads the whole queue again, and a followed task once", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const detach = store.attach();
    client.queueRequests.length = 0;

    client.emit({ status: "retrying" });
    client.emit({ status: "open" });
    await until(() => client.queueRequests.some((r) => r.tasks === undefined), "the whole read");
    expect(client.queueRequests).toEqual([{}]);
    detach();
  });

  test("a new leader makes an open screen read again", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const detach = store.attach();
    client.queueRequests.length = 0;
    client.emit({ scheduler: { kind: "ready", deviceId: "dev-b", term: 2 } });
    await until(() => client.queueRequests.length === 1, "the read under the new leader");
    detach();
  });

  test("a takeover is read once its leader verifies, never while the new term is still unverified", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const detach = store.attach();
    client.queueRequests.length = 0;
    client.emit({ scheduler: { kind: "unverified", deviceId: "dev-a", term: 2 } });
    await drain();
    expect(client.queueRequests).toEqual([]);
    expect(store.getState().queueNotice).toBeNull();
    client.emit({ scheduler: { kind: "ready", deviceId: "dev-a", term: 2 } });
    await until(() => client.queueRequests.length === 1, "the read under the verified term");
    detach();
  });

  test("a re-dial that comes back unverified reads the whole queue once the leader verifies, even under the same term", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const detach = store.attach();
    client.queueRequests.length = 0;
    client.emit({ status: "retrying" });
    client.emit({ status: "open", scheduler: { kind: "unverified", deviceId: "dev-a", term: 1 } });
    await drain();
    expect(client.queueRequests).toEqual([]);
    client.emit({ scheduler: { kind: "ready", deviceId: "dev-a", term: 1 } });
    await until(() => client.queueRequests.length === 1, "the catch-up read");
    expect(client.queueRequests).toEqual([{}]);
    detach();
  });

  test("a nudge's read that lands clears a notice a read left (an action's stays: see above)", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    client.onQueue = async () => {
      throw new RequestFailure("leader_unverified", "unverified");
    };
    await store.refreshQueue(undefined, true);
    expect(store.getState().queueNotice).toMatch(/does not open with this key/u);
    client.onQueue = async () => ({ tasks: [waiting], holds: [], at: 8 });
    await store.refreshQueue(["w-1"], true);
    expect(store.getState().queueNotice).toBeNull();
  });

  test("a nudge naming the followed task asks the leader once: the queue read it set off updates the verdict too", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    const created = firstCreate(client);
    await drain();
    const before = client.queueRequests.length;
    const placed: Task = { ...created, state: "running" };
    client.onQueue = async () => ({ tasks: [placed], holds: [], at: 3 });
    client.nudge({ at: 3, tasks: [created.id] });
    await until(() => queuedState(store) === "running", "placed");
    await drain();
    expect(client.queueRequests.length - before).toBe(1);
    detach();
  });

  test("a reconnect while a queued verdict waits reads that task once, spending no poll", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    const created = firstCreate(client);
    client.emit({ status: "retrying" });
    client.emit({ status: "open" });
    await until(() => client.queueRequests.some((r) => r.tasks !== undefined), "the read");
    expect(client.queueRequests.filter((r) => r.tasks !== undefined)).toEqual([{ tasks: [created.id] }]);
    detach();
  });

  test("named nudges while a read is out fold into one trailing read of their union, whole past the leader's cap", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const late = Promise.withResolvers<QueueReply | null>();
    client.onQueue = () => late.promise;
    const first = store.refreshQueue();
    const asked: unknown[] = [];
    const moved: Task = { ...waiting, state: "running" };
    const moved2: Task = { ...running, state: "done" };
    client.onQueue = async (request) => {
      asked.push(request);
      return { tasks: [moved, moved2], holds: [], at: 4 };
    };
    void store.refreshQueue(["w-1"], true);
    const last = store.refreshQueue(["r-1"], true);
    late.resolve({ tasks: [], holds: [], at: 1 });
    await Promise.all([first, last]);
    expect(asked).toEqual([{ tasks: ["w-1", "r-1"] }]);
    expect(store.getState().queueView).toEqual({
      kind: "ok",
      tasks: [moved, moved2],
      holds: [],
      unreadable: [],
      skew: expect.any(Number),
      at: 4,
    });

    const many = Array.from({ length: QUEUE_MAX_TASKS }, (_, i) => `m-${i}`);
    const stuck = Promise.withResolvers<QueueReply | null>();
    client.onQueue = () => stuck.promise;
    const third = store.refreshQueue(many, true);
    asked.length = 0;
    client.onQueue = async (request) => {
      asked.push(request);
      return { tasks: [], holds: [], at: 5 };
    };
    void store.refreshQueue(many.slice(0, 11), true);
    void store.refreshQueue(many.slice(11).concat(["extra", "extra-2"]), true);
    stuck.resolve({ tasks: [], holds: [], at: 4 });
    await third;
    expect(asked).toEqual([{}]);
  });

  test("a person's refresh folded into a nudge read keeps its notice behaviour, and a nudge read leaves an action's notice up", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    client.onMarkDone = async () => ({ ok: false, code: "dispatching", message: "in flight" });
    await store.markDone("w-1");
    expect(store.getState().queueNotice).toContain("starting");

    const late = Promise.withResolvers<QueueReply | null>();
    client.onQueue = () => late.promise;
    const nudge = store.refreshQueue(["w-1"], true);
    client.onQueue = async () => ({ ok: false, code: "not_ready", message: "taking over" });
    const person = store.refreshQueue();
    late.resolve({ tasks: [waiting], holds: [], at: 6 });
    await Promise.all([nudge, person]);
    expect(store.getState().queueNotice).toContain("taking over");

    store.dismissLayer();
    await store.markDone("w-1");
    client.onQueue = async () => ({ tasks: [waiting], holds: [], at: 7 });
    await store.refreshQueue(["w-1"], true);
    expect(store.getState().queueNotice).toContain("starting");
    await store.refreshQueue();
    expect(store.getState().queueNotice).toBeNull();
  });

  test("a read that fails with the screen closed leaves no loading view behind", async () => {
    const client = new ScriptedClient();
    client.onQueue = async () => {
      throw new RequestFailure("timeout", "queue timed out");
    };
    const store = new Store(client);
    store.openQueue();
    store.dismissLayer();
    fake.settle(store);
    await drain();
    expect(store.getState().queue).toBe(false);
    expect(store.getState().queueView?.kind).not.toBe("loading");
  });

  test("a nudge while the tab is hidden reads nothing: showing it again re-dials, and the reopen reads", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const detach = store.attach();
    await drain();
    const asked = client.queueRequests.length;
    document.visibilityState = "hidden";
    try {
      client.nudge({ at: 2, tasks: ["w-1"] });
      client.nudge({ at: 3 });
      await drain();
      expect(client.queueRequests).toHaveLength(asked);
    } finally {
      document.visibilityState = "visible";
    }
    detach();
  });

  const junk = { taskId: "j-1", version: 1, reason: "unopenable" };
  const old = { taskId: "j-2", version: 4, reason: "malformed" };

  test("unreadable records come with the queue; clearing discards each at its version, then reads the whole queue", async () => {
    const client = new ScriptedClient();
    client.onQueue = async () => ({ tasks: [waiting], holds: [], unreadable: [junk, old], at: 1 });
    const store = new Store(client);
    store.openQueue();
    await until(() => store.getState().queueView?.kind === "ok", "the queue read");
    expect(deriveQueue(store.getState(), Date.now()).unreadable).toStartWith("2 unreadable records hold queue slots");

    // One already gone by the time it is asked for is what was asked for.
    client.onDiscard = async ({ taskId }) =>
      taskId === "j-2" ? { ok: false, code: "task_not_found", message: "gone" } : { taskId };
    client.onQueue = async () => ({ tasks: [waiting], holds: [], at: 2 });
    await store.discardUnreadable();
    expect(client.discards).toEqual([
      { taskId: "j-1", version: 1 },
      { taskId: "j-2", version: 4 },
    ]);
    expect(client.queueRequests.at(-1)).toEqual({});
    expect(store.getState().queueNotice).toBeNull();
    expect(store.getState().discarding).toBe(false);
    expect(deriveQueue(store.getState(), Date.now()).unreadable).toBeNull();
  });

  test("a discard refused because the record changed stops there and says so; the re-read shows what is left", async () => {
    const client = new ScriptedClient();
    client.onQueue = async () => ({ tasks: [], holds: [], unreadable: [junk, old], at: 1 });
    const store = new Store(client);
    store.openQueue();
    await until(() => store.getState().queueView?.kind === "ok", "the queue read");

    client.onDiscard = async () => ({ ok: false, code: "conflict", message: "moved" });
    client.onQueue = async () => ({ tasks: [], holds: [], unreadable: [{ ...junk, version: 2 }, old], at: 2 });
    await store.discardUnreadable();
    expect(client.discards).toHaveLength(1);
    expect(store.getState().queueNotice).toBe("The task changed while this was on its way; try again.");
    expect(store.getState().queueView).toMatchObject({ unreadable: [{ taskId: "j-1", version: 2 }, old] });
  });

  test("a named id gone from the store is dropped from the screen, one the leader was not asked about is kept", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    client.onQueue = async () => ({ tasks: [running], holds: [], at: 3 });
    client.onGetTask = async () => ({ ok: true, task: null });
    await store.refreshQueue(["w-1"], true);
    expect(store.getState().queueView).toMatchObject({ kind: "ok", tasks: [{ id: "r-1" }] });
  });

  test("a nudge-driven read answered not_ready is ignored; one the person asked for is worded", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    client.onQueue = async () => ({ ok: false, code: "not_ready", message: "taking over" });
    await store.refreshQueue(["w-1"], true);
    expect(store.getState().queueNotice).toBeNull();
    await store.refreshQueue();
    expect(store.getState().queueNotice).toContain("taking over");
  });

  test("with the screen closed a verified leader's nudge still keeps the Queue chip's attention dot current", async () => {
    const client = new ScriptedClient();
    const stuck: Task = { ...running, id: "s-1", state: "needs-input", escalated: true };
    client.onQueue = async () => ({ tasks: [running], holds: [], at: 1 });
    const store = new Store(client);
    const detach = store.attach();
    await until(() => store.getState().queueView?.kind === "ok", "the read on attach");
    expect(store.getState().queue).toBe(false);
    expect(deriveView(store.getState(), Date.now()).queueAttention).toBe(false);

    client.onQueue = async () => ({ tasks: [stuck, running], holds: [], at: 2 });
    client.nudge({ at: 2, tasks: ["s-1"] });
    await until(() => deriveView(store.getState(), Date.now()).queueAttention, "the dot");

    // A failed background read says nothing on a screen nobody is looking at.
    client.onQueue = async () => {
      throw new RequestFailure("timeout", "queue timed out");
    };
    client.nudge({ at: 3 });
    await drain();
    expect(store.getState().queueNotice).toBeNull();
    expect(deriveView(store.getState(), Date.now()).queueAttention).toBe(true);
    detach();
  });

  test("with no verified leader and the screen closed, nothing is read", async () => {
    const client = new ScriptedClient({ scheduler: { kind: "none" } });
    const store = new Store(client);
    const detach = store.attach();
    client.nudge({ at: 2 });
    await drain();
    expect(client.queueRequests).toEqual([]);
    detach();
  });
});

describe("pinning a task", () => {
  const home = (id: string, accountId: string | null): ExclaveInfo => ({
    id,
    authOk: accountId !== null,
    accountId,
    email: `${id}@acme.dev`,
    extraUsageEnabled: null,
    skills: [],
  });
  const clone = (exclave: string): Machine["repos"] => [
    { name: "app", path: "/r/app", defaultBranch: "main", origin: ORIGIN, exclave },
  ];
  /** dev-a leads and advertises the account pin; dev-b is signed in to another account. */
  const pinning = (capabilities: string[] = [CAPABILITIES.pinAccount]): ScriptedClient =>
    new ScriptedClient({
      machines: [
        autoMachine("dev-a", { capabilities, exclaves: [home("work", "acct-w")], repos: clone("work") }),
        autoMachine("dev-b", { exclaves: [home("home", "acct-h")], repos: clone("home") }),
      ],
    });
  const form = { ...DEFAULT_FORM, prompt: "fix it" };

  test("a plain form writes no pin", async () => {
    const client = pinning();
    await new Store(client, form).spawn();
    expect(firstCreate(client).spec).not.toHaveProperty("pin");
  });

  test("a machine pin and an account pin go into the spec as ids, and nothing else", async () => {
    const client = pinning();
    await new Store(client, { ...form, machine: "dev-b" }).spawn();
    expect(firstCreate(client).spec.pin).toEqual({ deviceId: "dev-b" });

    const both = pinning();
    await new Store(both, { ...form, machine: "dev-a", account: "acct-w" }).spawn();
    expect(firstCreate(both).spec.pin).toEqual({ deviceId: "dev-a", account: "acct-w" });
  });

  test("an account's name and email stay out of the spec: the pin carries the id", async () => {
    const client = pinning();
    Object.defineProperty(client, "accountsNamed", { value: true });
    client.accountStoreKey = async () => "account:k-w";
    client.getAccountRecord = async (recordKey) => ({ ok: true, key: recordKey, version: 0, entry: null });
    client.putAccountAlias = async (accountId, name, version) => {
      const record = accountRecord(accountId, name, version + 1);
      if (record === null) throw new Error("bad record");
      return { ok: true, key: "account:k-w", record };
    };
    const store = new Store(client, { ...form, account: "acct-w" });
    expect(await store.renameAccount("acct-w", "Secret Name")).toBe(true);
    // Both names are display state, so a leak into the spec would be a copy of what the form shows.
    expect(store.getState().accounts.aliases).toEqual({ "acct-w": "Secret Name" });
    expect(deriveView(store.getState(), Date.now()).accountTile.value).toBe("Secret Name");

    await store.spawn();
    const sealed = JSON.stringify(firstCreate(client).spec);
    expect(sealed).toContain("acct-w");
    expect(sealed).not.toContain("Secret Name");
    expect(sealed).not.toContain("work@acme.dev");
  });

  test("an account pin the leader can't take is refused before anything is written", async () => {
    const client = pinning([]);
    const store = new Store(client, { ...form, account: "acct-w" });
    await store.spawn();
    expect(client.creates).toEqual([]);
    expect(store.getState().verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: false });
    const { verdict } = store.getState();
    if (verdict === null) throw new Error("no verdict");
    expect(describeVerdict(verdict, [], {}, 0, null).body).toContain("update seanced");
  });

  test("an account no machine is signed in to is refused, and the form keeps its pin", async () => {
    const client = pinning();
    const store = new Store(client, { ...form, account: "acct-gone" });
    await store.spawn();
    expect(client.creates).toEqual([]);
    expect(store.getState().verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: false });
    expect(store.getState().form.account).toBe("acct-gone");
  });

  test("a machine that leaves the registry resets the machine pick and keeps the account", () => {
    const client = pinning();
    const store = new Store(client, { ...form, machine: "dev-b", account: "acct-w" });
    const detach = store.attach();
    client.emit({ machines: client.relay.machines.filter((m) => m.deviceId !== "dev-b") });
    expect(store.getState().form).toMatchObject({ machine: null, account: "acct-w" });
    detach();
  });

  test("picking either side drops a repo the new scope doesn't hold, and never touches the other pick", () => {
    const client = pinning();
    const store = new Store(client, { ...form, repo: ORIGIN, machine: "dev-b" });
    store.pickAccount("acct-w");
    // acct-w is signed in on dev-a only, so dev-b's clone is out of scope for the pair.
    expect(store.getState().form).toMatchObject({ repo: null, machine: "dev-b", account: "acct-w" });
    store.pickAccount(null);
    store.pickMachine(null);
    expect(store.getState().form).toMatchObject({ machine: null, account: null });
  });
});

describe("authoring a task from the auto form", () => {
  let timers: ReturnType<typeof captureTimers>;
  let fake: ReturnType<typeof fakeHistory>;

  beforeEach(() => {
    timers = captureTimers();
    fake = fakeHistory();
  });

  afterEach(() => {
    timers.restore();
    fake.restore();
  });

  /** A leader that advertises the done report, as a seanced of this version does. */
  const reporting = (): ScriptedClient =>
    new ScriptedClient({
      machines: [autoMachine("dev-a", { capabilities: [CAPABILITIES.reportedDone] }), autoMachine("dev-b")],
    });
  const BATCH = { id: "b-1", next: 1 } as const;
  const form = { ...DEFAULT_FORM, prompt: "fix it" };

  test("deps, batch and Linear go into the spec, with no `until` unless it was changed, and then reset or advance", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, {
      ...form,
      after: [{ task: "base", after: "merged" }],
      batch: BATCH,
      linearIssue: " ENG-7 ",
    });
    await store.spawn();

    expect(firstCreate(client).spec).toMatchObject({
      client: "pwa",
      prompt: "fix it",
      deps: [{ task: "base", after: "merged" }],
      batch: { id: "b-1", index: 1, strategy: BATCH_STRATEGY },
      linear: { issue: "ENG-7" },
    });
    expect(firstCreate(client).spec).not.toHaveProperty("until");
    // What belongs to the task just stored is cleared; the batch stays open, one further on.
    expect(store.getState().form).toMatchObject({
      after: [],
      until: "merged",
      linearIssue: "",
      batch: { ...BATCH, next: 2 },
    });
  });

  test("a plain form writes none of the authoring fields", async () => {
    const client = new ScriptedClient();
    await new Store(client, form).spawn();
    for (const field of ["deps", "batch", "until", "linear"])
      expect(firstCreate(client).spec).not.toHaveProperty(field);
  });

  test("a retry after an unreadable answer re-puts the same member and moves the counter once", async () => {
    const client = new ScriptedClient();
    client.onCreate = async () => null;
    const store = new Store(client, { ...form, batch: { ...BATCH, next: 3 } });
    await store.spawn();
    const verdict = store.getState().verdict;
    if (verdict?.kind !== "unqueued") throw new Error("expected unqueued");
    expect(store.getState().form.batch?.next).toBe(3);

    client.onCreate = async () => ({ ok: true, landedEarlier: true });
    await store.retryEnqueue(verdict);
    expect(client.creates).toHaveLength(2);
    expect(client.creates[1]?.spec.batch?.index).toBe(3);
    expect(store.getState().form.batch?.next).toBe(4);
  });

  test("settling on the done report appends the instruction, writes `until`, and resets to merged", async () => {
    const client = reporting();
    const store = new Store(client, { ...form, until: "reported" });
    await store.spawn();
    expect(firstCreate(client).spec).toMatchObject({ until: "reported", prompt: withReportInstruction("fix it") });
    expect(store.getState().form.until).toBe("merged");
    expect(store.getState().form.prompt).toBe("");
  });

  test("a leader that does not advertise the report is refused client-side, for `until` and for a done edge", async () => {
    for (const change of [{ until: "reported" }, { after: [{ task: "base", after: "done" }] }] as const) {
      const client = new ScriptedClient();
      const store = new Store(client, { ...form, ...change });
      await store.spawn();
      expect(client.creates).toHaveLength(0);
      expect(store.getState().verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: false });
      expect(store.getState().form.prompt).toBe("fix it");
    }
    // The same edge at "opened" is understood by any leader.
    const client = new ScriptedClient();
    await new Store(client, { ...form, after: [{ task: "base", after: "opened" }] }).spawn();
    expect(client.creates).toHaveLength(1);
  });

  test("settling on the report needs a prompt to carry the instruction, and room for it", async () => {
    const empty = reporting();
    const bare = new Store(empty, { ...form, prompt: "  ", until: "reported" });
    await bare.spawn();
    expect(empty.creates).toHaveLength(0);
    expect(bare.getState().verdict).toMatchObject({ kind: "unqueued" });

    const full = reporting();
    // Fits on its own; the appended instruction is what pushes it over.
    const prompt = "x".repeat(TASK_REQUEST_LIMITS.prompt - 1);
    const long = new Store(full, { ...form, prompt, until: "reported" });
    await long.spawn();
    expect(full.creates).toHaveLength(0);
    expect(long.getState().verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: false });
    expect(long.getState().form.prompt).toBe(prompt);
  });

  test("a batch with no index left is refused", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...form, batch: { ...BATCH, next: TASK_SPEC_LIMITS.batchIndex + 1 } });
    await store.spawn();
    expect(client.creates).toHaveLength(0);
    expect(store.getState().verdict).toMatchObject({ kind: "unqueued", message: expect.stringContaining("full") });
  });

  test("an edge on a task replaces the one held, and sixteen is the most", () => {
    const store = new Store(new ScriptedClient(), form);
    store.addAfter("a", "opened");
    store.addAfter("a", "merged");
    expect(store.getState().form.after).toEqual([{ task: "a", after: "merged" }]);
    for (let i = 0; i < 20; i += 1) store.addAfter(`t-${i}`, "opened");
    expect(store.getState().form.after).toHaveLength(TASK_SPEC_LIMITS.deps);
    // Full, a held edge can still change.
    store.addAfter("a", "opened");
    expect(store.getState().form.after.find((dep) => dep.task === "a")?.after).toBe("opened");
    store.removeAfter("a");
    expect(store.getState().form.after.some((dep) => dep.task === "a")).toBe(false);
  });

  test("starting a batch while one is open keeps its id and counter; after End batch a start is a new batch", () => {
    const store = new Store(new ScriptedClient(), form);
    const start = (): void => {
      store.openSheet("batch");
      store.startBatch();
      fake.settle(store);
    };
    start();
    const first = store.getState().form.batch;
    expect(first).toMatchObject({ next: 1 });
    expect(store.getState().sheet).toBeNull();

    start();
    expect(store.getState().form.batch).toBe(first);

    store.openSheet("batch");
    store.endBatch();
    fake.settle(store);
    expect(store.getState().form.batch).toBeNull();
    expect(store.getState().sheet).toBeNull();

    start();
    expect(store.getState().form.batch?.id).not.toBe(first?.id);
  });

  test("the Linear issue is clamped to what a spec takes", () => {
    const store = new Store(new ScriptedClient(), form);
    store.setLinearIssue("E".repeat(200));
    expect(store.getState().form.linearIssue).toHaveLength(TASK_SPEC_LIMITS.linearIssue);
  });

  test("opening the After sheet reads the queue; other sheets do not", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, form);
    store.openSheet("batch");
    await drain();
    expect(client.queueRequests).toHaveLength(0);
    store.openSheet("after");
    await until(() => store.getState().queueView?.kind === "ok", "the queue read");
    expect(client.queueRequests).toHaveLength(1);
  });

  test("following up from the queue closes it and its verdict, and lands on the auto form waiting on that task", async () => {
    const client = new ScriptedClient();
    const { store, created } = await followedAndListed(client);
    expect(store.getState().queue).toBe(true);
    expect(fake.index()).toBe(2);

    store.followUp("base");
    fake.settle(store);
    expect(fake.index()).toBe(0);
    expect(store.getState()).toMatchObject({ queue: false, verdict: null, queueNotice: null });
    expect(store.getState().form).toMatchObject({ after: [{ task: "base", after: "opened" }] });
    expect(created.id).not.toBe("base");
  });

  test("following up where the queue is a column pops nothing, and where the relay is not connected does nothing", () => {
    const wide = new Store(new ScriptedClient(), { ...DEFAULT_FORM, prompt: "keep" });
    wide.setWide(true);
    wide.followUp("base");
    expect(fake.index()).toBe(0);
    expect(wide.getState().form).toMatchObject({
      prompt: "keep",
      after: [{ task: "base", after: "opened" }],
    });

    const away = new Store(new ScriptedClient({ status: "retrying" }), DEFAULT_FORM);
    away.followUp("base");
    expect(away.getState().form).toEqual(DEFAULT_FORM);
  });

  test("a follow-up resets both pickers to auto, and keeps the rest of the form", () => {
    const store = new Store(new ScriptedClient(), {
      ...DEFAULT_FORM,
      prompt: "keep",
      machine: "dev-b",
      account: "acct-w",
    });
    store.followUp("base");
    expect(store.getState().form).toMatchObject({
      machine: null,
      account: null,
      prompt: "keep",
      after: [{ task: "base", after: "opened" }],
    });
  });
});
