import { importPsk, toBase64 } from "@seance/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  RelayClient,
  RequestFailure,
  type Decision,
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
  type TaskReply,
  type TaskRequest,
} from "@seance/shared";
import { DEFAULT_FORM } from "../src/state.ts";
import { deriveView } from "../src/view.ts";
import {
  PREVIEW_DEBOUNCE_MS,
  PREVIEW_RETRY_MS,
  QUEUE_POLL_MS,
  QUEUE_POLLS,
  Store,
  UNDO_WINDOW_MS,
} from "../src/store.ts";
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

  test("machines stacks over settings: back returns to settings and drops its chart", async () => {
    fake = fakeHistory();
    const store = new Store(idleClient());

    store.openSettings();
    store.openMachines();
    // An idle client has no socket, so the chart settles on its failure line.
    await store.showHistory({ kind: "machine", deviceId: "dev-1" }, "24h");
    expect(store.getState().history?.result.kind).toBe("failed");
    expect(fake.entries()).toMatchObject([null, { depth: 1 }, { depth: 2 }]);

    store.dismissLayer();
    fake.settle(store);
    expect(store.getState()).toMatchObject({ machines: false, settings: true, history: null });
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
    store.selectMachine("m-1");
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
  onPause: (request: PauseRequest) => Promise<PauseReply | null> = async () => ({
    holds: [{ until: "resume", at: 5 }],
  });
  onResume: (request: ResumeRequest) => Promise<PauseReply | null> = async () => ({ holds: [] });
  readonly nudgeListeners = new Set<(change: QueueChanged) => void>();

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

  override cancel(taskId: string): Promise<TaskReply | null> {
    return this.onCancel(taskId);
  }

  override markDone(taskId: string): Promise<TaskReply | null> {
    return this.onMarkDone(taskId);
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
    store.selectAuto();
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
    store.selectAuto();
    store.selectMachine("dev-b");
    late.resolve({ decision: DECISION });
    await drain();
    expect(store.getState().preview).toBeNull();
    expect(store.getState().form.auto).toBe(false);
  });

  test("a presence or repo change asks the preview again once its burst settles; a status beat does not", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, auto: true });
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
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
    await store.spawn();
    const verdict = store.getState().verdict;
    expect(verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: true, retry: { id: client.creates[0]?.id } });
    expect(store.getState().form.prompt).toBe("fix it");
    expect(verdict?.kind === "unqueued" && verdict.message).toContain("the relay did not answer");

    // The store had it after all: the same id answers version_conflict, which the client reports as queued.
    client.onCreate = async () => ({ ok: true, landedEarlier: true });
    if (verdict?.kind !== "unqueued") throw new Error("expected unqueued");
    await store.retryEnqueue(verdict);
    expect(client.creates).toHaveLength(2);
    expect(client.creates[1]).toBe(client.creates[0]);
    expect(store.getState().verdict).toMatchObject({ kind: "queued", task: { id: client.creates[0]?.id } });
    expect(store.getState().form.prompt).toBe("");
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
      const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
      // oxlint-disable-next-line no-await-in-loop -- one store each
      await store.spawn();
      expect(store.getState().verdict).toMatchObject({ kind: "unqueued", mayHaveLanded, retry: expect.anything() });
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
      const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
      // oxlint-disable-next-line no-await-in-loop -- one store each
      await store.spawn();
      const verdict = store.getState().verdict;
      expect(verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: false });
      expect(verdict !== null && "retry" in verdict).toBe(retry);
      expect(store.getState().form.prompt).toBe("fix it");
    }
  });

  test("a store answer this build cannot read may have landed, and can be re-put", async () => {
    const client = new ScriptedClient();
    client.onCreate = async () => null;
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
    await store.spawn();
    expect(store.getState().verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: true, retry: expect.anything() });
  });

  test("a created task becomes the queued verdict as the app's own copy, and the prompt clears", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
    await store.spawn();
    const created = firstCreate(client);
    expect(created).toMatchObject({ state: "queued", spec: { repo: ORIGIN, prompt: "fix it" } });
    expect(store.getState().verdict).toEqual({ kind: "queued", task: created });
    expect(store.getState().form.prompt).toBe("");
    expect(timers.armed(QUEUE_POLL_MS)).toBe(1);
  });

  test("following stops once the task is running", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
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
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
    await store.spawn();
    client.onQueue = async () => ({ ok: false, code: "invalid_request", message: "?" });
    timers.fire(QUEUE_POLL_MS);
    await until(() => followEnd(store) !== undefined, "following to stop");
    expect(store.getState().verdict).toMatchObject({ kind: "queued", follow: { kind: "refused" } });
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);
  });

  test("a leader that answers without the task is a missed poll, never a verdict that it is gone", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
    await store.spawn();
    client.onQueue = async () => ({ tasks: [], at: 2 });
    timers.fire(QUEUE_POLL_MS);
    await until(() => client.queueRequests.length === 1, "the read");
    await until(() => timers.armed(QUEUE_POLL_MS) === 1, "the next poll armed");
    expect(followEnd(store)).toBeUndefined();
  });

  test("missed polls keep what was shown and ask again; out of polls, it says what it last knew may be stale", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
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
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
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
    const store = new Store(client, { ...DEFAULT_FORM, auto: true });
    store.selectAuto();
    await until(() => store.getState().preview?.kind === "failed", "the preview to fail");
    expect(store.getState().preview).toMatchObject({
      kind: "failed",
      message: expect.stringMatching(/no scheduler/iu),
    });
  });

  test("a queue-changed naming the followed task reads it without spending a poll; one naming another does not", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
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
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
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
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
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
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
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
    expect(store.getState().queueView).toEqual({ kind: "ok", tasks: [waiting, running], holds: [], at: 1 });

    store.dismissLayer();
    fake.settle(store);
    expect(store.getState().queue).toBe(false);
    expect(fake.index()).toBe(0);
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

  test("a reply to a read that was since replaced is dropped", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const late = Promise.withResolvers<QueueReply | null>();
    client.onQueue = () => late.promise;
    const first = store.refreshQueue();
    client.onQueue = async () => ({ tasks: [], holds: [], at: 9 });
    await store.refreshQueue();
    late.resolve({ tasks: [waiting], holds: [], at: 1 });
    await first;
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
    expect(store.getState().queueNotice).toContain("refresh to see whether it landed");

    // The next action clears the last one's notice.
    client.onCancel = async () => ({ task: { ...waiting, state: "cancelled" } });
    await store.cancelTask("w-1");
    expect(store.getState().queueNotice).toBeNull();
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

  test("a reconnect while a queued verdict waits reads that task once, spending no poll", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    const created = firstCreate(client);
    client.emit({ status: "retrying" });
    client.emit({ status: "open" });
    await until(() => client.queueRequests.some((r) => r.tasks !== undefined), "the read");
    expect(client.queueRequests.filter((r) => r.tasks !== undefined)).toEqual([{ tasks: [created.id] }]);
    detach();
  });

  test("a named nudge while a whole read is in flight is upgraded to whole, never superseding it with less", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const whole = Promise.withResolvers<QueueReply | null>();
    client.onQueue = () => whole.promise;
    const first = store.refreshQueue();
    const requests: unknown[] = [];
    const answer = { tasks: [waiting, running, { ...running, id: "r-2" }], holds: [], at: 7 };
    client.onQueue = async (request) => {
      requests.push(request);
      return answer;
    };
    const second = store.refreshQueue(["w-1"], true);
    await second;
    expect(requests).toEqual([{}]);
    expect(store.getState().queueView).toMatchObject({ kind: "ok", at: 7 });
    // The superseded whole read's late reply changes nothing.
    whole.resolve({ tasks: [], holds: [], at: 1 });
    await first;
    expect(store.getState().queueView).toMatchObject({ kind: "ok", at: 7 });
  });

  test("two named reads in flight ask for the union of their ids, so neither's ids are lost", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const late = Promise.withResolvers<QueueReply | null>();
    client.onQueue = () => late.promise;
    const first = store.refreshQueue(["w-1"], true);
    const asked: unknown[] = [];
    const moved: Task = { ...waiting, state: "running" };
    const moved2: Task = { ...running, state: "done" };
    client.onQueue = async (request) => {
      asked.push(request);
      return { tasks: [moved, moved2], holds: [], at: 4 };
    };
    await store.refreshQueue(["r-1"], true);
    expect(asked).toEqual([{ tasks: ["w-1", "r-1"] }]);
    late.resolve({ tasks: [], holds: [], at: 1 });
    await first;
    expect(store.getState().queueView).toEqual({ kind: "ok", tasks: [moved, moved2], holds: [], at: 4 });
  });

  test("a named id the leader no longer lists is dropped from the screen, one it was not asked about is kept", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    client.onQueue = async () => ({ tasks: [running], holds: [], at: 3 });
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
