import { importPsk, toBase64 } from "@seance/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  ATTACHMENT_LIMITS,
  CAPABILITIES,
  accountRecord,
  QUEUE_MAX_TASKS,
  RelayClient,
  RequestFailure,
  TASK_REQUEST_LIMITS,
  TASK_SPEC_LIMITS,
  withReportInstruction,
  type Decision,
  type AttachmentRefusal,
  type AttachmentUploaded,
  type DiscardReply,
  type DiscardRequest,
  type ExclaveInfo,
  type Machine,
  type MetricsReply,
  type MetricsRequest,
  type MetricsSeries,
  type PassReply,
  type PauseReply,
  type PauseRequest,
  type QueueChanged,
  type QueueReply,
  type QueueRequest,
  type RelayState,
  type ResumeOutcome,
  type ResumeRequest,
  type RoutePreviewReply,
  type StoreRefusal,
  type AutonomyLevel,
  type Task,
  type TaskCreated,
  type TaskLookup,
  type TaskReply,
  type TaskRequest,
  type UploadOptions,
} from "@seance/shared";
import { openDeepLink } from "../src/deep-link.ts";
import { DEFAULT_FORM, HELD_MAX, HELD_MAX_AGE_MS, WORKTREE_REPOS_MAX, type HeldTask } from "../src/state.ts";
import { deriveQueue } from "../src/queue-view.ts";
import { deriveView } from "../src/view.ts";
import { describeVerdict } from "../src/verdict-view.ts";
import { PREVIEW_DEBOUNCE_MS, PREVIEW_RETRY_MS, QUEUE_POLL_MS, QUEUE_POLLS } from "../src/scheduler-store.ts";
import { Store, UNDO_WINDOW_MS } from "../src/store.ts";
import { VERIFY_WAIT_MS } from "../src/upload-queue.ts";
import { fakeHistory, installBrowserGlobals, setVisibility } from "./stubs.ts";

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
  readonly passes: string[] = [];
  onPass: (taskId: string) => Promise<PassReply | null> = async (id) => ({
    task: { ...QUEUED, id, state: "superseded", successor: "t-next" },
    successorId: "t-next",
    successor: null,
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

  /** The hidden time each tab resume reported. */
  readonly shownAfter: number[] = [];
  /** What a tab resume's probe finds: by default the socket answered. */
  onShown: () => Promise<ResumeOutcome> = async () => "live";

  override reconnectIfStale(hiddenMs: number): Promise<ResumeOutcome> {
    this.shownAfter.push(hiddenMs);
    return this.onShown();
  }

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

  /** Every upload's plaintext, in order: a retry shows only the files that hadn't stored. */
  readonly uploads: Uint8Array[] = [];
  /** Each upload's options, in the same order: the store's abort signal and progress callback. */
  readonly uploadOpts: UploadOptions[] = [];
  onUpload: (bytes: Uint8Array, opts: UploadOptions) => Promise<AttachmentUploaded | AttachmentRefusal> = async () => ({
    ok: true,
    id: crypto.randomUUID(),
    hash: "h".repeat(43),
  });

  override uploadAttachment(
    bytes: Uint8Array<ArrayBuffer>,
    opts: UploadOptions = {},
  ): Promise<AttachmentUploaded | AttachmentRefusal> {
    this.uploads.push(bytes);
    this.uploadOpts.push(opts);
    return this.onUpload(bytes, opts);
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

  override pass(taskId: string): Promise<PassReply | null> {
    this.passes.push(taskId);
    return this.onPass(taskId);
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
function captureTimers(): {
  fire: (ms: number) => void;
  armed: (ms: number) => number;
  /** The delays of the timers pending, for one whose delay depends on the clock. */
  delays: () => number[];
  restore: () => void;
} {
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
    delays: () => [...pending.values()].map((timer) => timer.ms),
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

describe("the autonomy level", () => {
  let timers: ReturnType<typeof captureTimers>;

  beforeEach(() => {
    timers = captureTimers();
  });

  afterEach(() => timers.restore());

  async function queuedAt(level: AutonomyLevel | null): Promise<{ store: Store; task: Task }> {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    if (level !== null) store.setAutonomy(level);
    await store.spawn();
    return { store, task: firstCreate(client) };
  }

  test("checkpoint, the default, writes neither field: the record is what it was before levels", async () => {
    for (const level of [null, "checkpoint"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one store per level, in turn
      const { task } = await queuedAt(level);
      expect(task.spec).not.toHaveProperty("autonomy");
      expect(task.spec).not.toHaveProperty("plan");
    }
  });

  test("steer travels with plan: true, so an older leader still dispatches plan mode", async () => {
    const { task } = await queuedAt("steer");
    expect(task.spec).toMatchObject({ autonomy: "steer", plan: true });
  });

  test("auto is written alone", async () => {
    const { task } = await queuedAt("auto");
    expect(task.spec.autonomy).toBe("auto");
    expect(task.spec).not.toHaveProperty("plan");
  });

  test("is never on the persisted form, and goes back to checkpoint once a task is queued", async () => {
    const { store } = await queuedAt("auto");
    expect(store.getState().autonomy).toBe("checkpoint");
    expect(store.getState().form).not.toHaveProperty("autonomy");
  });

  test("goes back to checkpoint when a task is held too", async () => {
    const client = new ScriptedClient({ status: "retrying", registrySettled: false });
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    store.attach();
    store.setAutonomy("steer");
    await store.spawn();
    expect(store.getState().held[0]?.task.spec).toMatchObject({ autonomy: "steer", plan: true });
    expect(store.getState().autonomy).toBe("checkpoint");
  });

  test("a refused submit keeps the level for the next try", async () => {
    const client = new ScriptedClient();
    client.onCreate = async () => ({ ok: false, code: "store_full", message: "full" });
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    store.setAutonomy("auto");
    await store.spawn();
    expect(store.getState().verdict?.kind).toBe("unqueued");
    expect(store.getState().autonomy).toBe("auto");
  });
});

describe("holding a task while the relay is down", () => {
  let timers: ReturnType<typeof captureTimers>;

  beforeEach(() => {
    // The follow loop a landed task starts polls on timers; held here so nothing runs on the clock.
    timers = captureTimers();
  });

  afterEach(() => timers.restore());

  /** A socket that dropped after its registry: the machines are still known. */
  const DOWN: Partial<RelayState> = { status: "retrying", registrySettled: false };

  function attached(client: ScriptedClient, held: readonly HeldTask[] = []): Store {
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" }, held);
    store.attach();
    return store;
  }

  function reconnect(client: ScriptedClient): void {
    client.emit({ status: "retrying", registrySettled: false });
    client.emit({ status: "open", registrySettled: true });
  }

  function heldTask(store: Store, index = 0): Task {
    const entry = store.getState().held[index];
    if (entry === undefined) throw new Error(`nothing held at ${index}`);
    return entry.task;
  }

  test("is kept on the phone with the form cleared, and nothing is sent", async () => {
    const client = new ScriptedClient(DOWN);
    const store = attached(client);
    await store.spawn();

    const task = heldTask(store);
    expect(client.creates).toEqual([]);
    expect(task.spec.prompt).toBe("fix it");
    expect(store.getState().verdict).toEqual({ kind: "held", task });
    expect(store.getState().form.prompt).toBe("");
  });

  test("is sent once the next registry settles, and its verdict follows it as queued", async () => {
    const client = new ScriptedClient(DOWN);
    const store = attached(client);
    await store.spawn();
    const task = heldTask(store);

    // Open is not enough: the leader's capabilities come with the registry.
    client.emit({ status: "open", registrySettled: false });
    await drain();
    expect(client.creates).toEqual([]);

    client.emit({ registrySettled: true });
    await until(() => store.getState().held.length === 0, "the held task sent");
    expect(client.creates).toEqual([task]);
    expect(store.getState().verdict).toEqual({ kind: "queued", task });
  });

  test("with no registry seen yet, nothing is held", async () => {
    const client = new ScriptedClient({ ...DOWN, machines: [], registrySize: 0 });
    const store = attached(client);
    await store.spawn();

    expect(store.getState().held).toEqual([]);
    expect(store.getState().verdict).toBeNull();
    expect(store.getState().form.prompt).toBe("fix it");
  });

  // The id is minted at the tap, so the resend is the same create, and `landedEarlier` means it is stored.
  test("a send whose answer never came stays held, is not resent on that socket, and goes again on the next", async () => {
    const client = new ScriptedClient(DOWN);
    const store = attached(client);
    await store.spawn();
    const { id } = heldTask(store);
    client.onCreate = async () => {
      throw new RequestFailure("timeout", "the relay did not answer");
    };

    client.emit({ status: "open", registrySettled: true });
    await until(() => client.creates.length === 1 && store.getState().held[0]?.sending === false, "the first send");
    expect(store.getState().held[0]?.failure).toBeNull();

    // Any later relay change on the same socket, a status beat say, sends nothing.
    client.emit({ fleetQuota: [] });
    await drain();
    expect(client.creates).toHaveLength(1);

    client.onCreate = async () => ({ ok: true, landedEarlier: true });
    reconnect(client);
    await until(() => store.getState().held.length === 0, "the resend");
    expect(client.creates.map((task) => task.id)).toEqual([id, id]);
  });

  test("a refused send fails it in place with the reason, and a retry sends it again", async () => {
    const client = new ScriptedClient(DOWN);
    const store = attached(client);
    await store.spawn();
    client.onCreate = async () => ({ ok: false, code: "rate_limited" });

    client.emit({ status: "open", registrySettled: true });
    await until(() => store.getState().held[0]?.failure !== null, "the refusal");
    const verdict = store.getState().verdict;
    expect(verdict?.kind === "unqueued" && verdict.message.includes("kept on this phone")).toBe(true);

    // A failed one is not sent again by itself, not even on a new socket.
    reconnect(client);
    await drain();
    expect(client.creates).toHaveLength(1);

    client.onCreate = async () => ({ ok: true, landedEarlier: false });
    store.retryHeld(heldTask(store).id);
    await until(() => store.getState().held.length === 0, "the retried send");
    expect(client.creates).toHaveLength(2);
  });

  test("one that settles on a done report is checked against the leader when sent, not when held", async () => {
    const client = new ScriptedClient(DOWN);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it", until: "reported" });
    store.attach();
    await store.spawn();
    expect(store.getState().held).toHaveLength(1);

    // dev-a leads without advertising `reportedDone`.
    client.emit({ status: "open", registrySettled: true });
    await until(() => store.getState().held[0]?.failure !== null, "the send-time check");
    expect(store.getState().held[0]?.failure).toContain("doesn't take tasks that settle on a done report");
    expect(client.creates).toEqual([]);

    client.emit({
      machines: [autoMachine("dev-a", { capabilities: [CAPABILITIES.reportedDone] }), autoMachine("dev-b")],
    });
    store.retryHeld(heldTask(store).id);
    await until(() => store.getState().held.length === 0, "the send once the leader takes it");
    expect(client.creates[0]?.spec.until).toBe("reported");
  });

  // An asleep or not-yet-verified leader says nothing about what it takes: failing then would need a manual retry.
  test("one needing the leader waits, unfailed, for a verified one, and others go past it", async () => {
    const client = new ScriptedClient(DOWN);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it", until: "reported" });
    store.attach();
    await store.spawn();
    store.setPrompt("plain");
    store.setUntil("merged");
    await store.spawn();
    const [reported, plain] = [heldTask(store, 0), heldTask(store, 1)];

    const leader = client.getState().scheduler;
    client.emit({
      status: "open",
      registrySettled: true,
      scheduler: { kind: "none" },
      machines: [autoMachine("dev-a", { capabilities: [CAPABILITIES.reportedDone] }), autoMachine("dev-b")],
    });
    await until(() => client.creates.length === 1, "the plain task sent");
    await drain();
    expect(client.creates).toEqual([plain]);
    expect(store.getState().held).toEqual([{ task: reported, failure: null, sending: false }]);
    expect(deriveView(store.getState(), 0).held[0]?.status).toBe("Waiting for the scheduler's leader");

    client.emit({ scheduler: leader });
    await until(() => store.getState().held.length === 0, "the send once a leader is verified");
    expect(client.creates).toEqual([plain, reported]);
  });

  // Holding rides out a dropped connection; a task left far longer is no longer what anyone wants.
  test("one held past the age limit, failed or waiting, is dropped unsent and named until dismissed", async () => {
    const client = new ScriptedClient(DOWN);
    const old = Date.now() - HELD_MAX_AGE_MS - 1;
    const stale = { ...QUEUED, id: "t-stale", state: "queued" as const, createdAt: old };
    const failed = {
      ...QUEUED,
      id: "t-failed",
      state: "queued" as const,
      createdAt: old,
      spec: { ...QUEUED.spec, prompt: "the refused one" },
    };
    const store = attached(client, [
      { task: stale, failure: null, sending: false },
      { task: failed, failure: "Refused.", sending: false },
    ]);
    expect(store.getState().held).toEqual([]);
    expect(deriveView(store.getState(), 0).heldDropped).toBe(
      "Dropped 2 tasks held over a day: fix it, the refused one",
    );

    await store.spawn();
    const fresh = heldTask(store);
    client.emit({ status: "open", registrySettled: true });
    await until(() => store.getState().held.length === 0, "the held list emptied");
    expect(client.creates).toEqual([fresh]);

    store.dismissHeldDropped();
    expect(deriveView(store.getState(), 0).heldDropped).toBeNull();
  });

  test("a list another tab wrote replaces this one's, keeping a send that is out", async () => {
    const client = new ScriptedClient(DOWN);
    const store = attached(client);
    await store.spawn();
    const mine = heldTask(store);
    client.onCreate = () => new Promise(() => {});
    client.emit({ status: "open", registrySettled: true });
    await until(() => store.getState().held[0]?.sending === true, "the send out");

    const theirs = { ...QUEUED, id: "t-theirs", state: "queued" as const, createdAt: Date.now() };
    store.adoptHeld([{ task: theirs, failure: null, sending: false }]);
    // Oldest first, wherever each came from: `mine` was held before `theirs` was made.
    expect(store.getState().held).toEqual([
      { task: mine, failure: null, sending: true },
      { task: theirs, failure: null, sending: false },
    ]);
  });

  // This tab can't tell a discard from another tab's send or an age-out, so it claims none of them.
  test("its held verdict closes once the task leaves without landing here, whatever took it", async () => {
    const fake = fakeHistory();
    try {
      const client = new ScriptedClient(DOWN);
      const store = attached(client);
      await store.spawn();
      expect(store.getState().verdict?.kind).toBe("held");
      store.discardHeld(heldTask(store).id);
      fake.settle(store);
      expect(store.getState().verdict).toBeNull();

      store.setPrompt("again");
      await store.spawn();
      expect(store.getState().verdict?.kind).toBe("held");
      store.adoptHeld([]);
      fake.settle(store);
      expect(store.getState().verdict).toBeNull();
      expect(fake.index()).toBe(0);
    } finally {
      fake.restore();
    }
  });

  // Holding would say "not connected" a moment before sending anyway.
  test("a tap while a re-dial settles waits as Queuing…, then queues if it reconnected", async () => {
    const client = new ScriptedClient({ status: "connecting", settling: true, registrySettled: false });
    const store = attached(client);
    const tap = store.spawn();
    await drain();
    expect(store.getState().held).toEqual([]);
    expect(deriveView(store.getState(), 0).button).toMatchObject({ label: "Queuing…", busy: true });

    client.emit({ status: "open", settling: false, registrySettled: false });
    await drain();
    expect(client.creates).toEqual([]);
    client.emit({ registrySettled: true });
    await tap;
    expect(client.creates.map((task) => task.spec.prompt)).toEqual(["fix it"]);
    expect(store.getState().held).toEqual([]);
    expect(store.getState().verdict?.kind).toBe("queued");
  });

  test("a tap while a re-dial settles is held once the settle window ends without a socket", async () => {
    const client = new ScriptedClient({ status: "connecting", settling: true, registrySettled: false });
    const store = attached(client);
    const tap = store.spawn();
    await drain();
    client.emit({ status: "retrying", settling: false });
    await tap;
    expect(client.creates).toEqual([]);
    expect(store.getState().held).toHaveLength(1);
    expect(store.getState().verdict?.kind).toBe("held");
  });

  test("an unchanged list from another tab notifies nothing", async () => {
    const client = new ScriptedClient(DOWN);
    const store = attached(client);
    await store.spawn();
    const before = store.getState().held;
    let notified = 0;
    store.subscribe(() => notified++);
    store.adoptHeld(before.map((entry) => ({ ...entry })));
    expect(store.getState().held).toBe(before);
    expect(notified).toBe(0);
  });

  // The writer may have held it on a dead socket of its own; this tab's socket is up and sends it.
  test("a task adopted from another tab is sent while this one is connected", async () => {
    const client = new ScriptedClient(DOWN);
    const store = attached(client);
    client.emit({ status: "open", registrySettled: true });
    await drain();

    const theirs = { ...QUEUED, id: "t-theirs", state: "queued" as const, createdAt: Date.now() };
    store.adoptHeld([{ task: theirs, failure: null, sending: false }]);
    await until(() => store.getState().held.length === 0, "the adopted task sent");
    expect(client.creates).toEqual([theirs]);
  });

  // A run-now sent whenever the app next reconnects would skip the caps at a moment nobody chose.
  test("Start now with the relay down is a plain queue", async () => {
    const client = new ScriptedClient(DOWN);
    const store = attached(client);
    await store.startNow();
    client.emit({ status: "open", registrySettled: true });
    await until(() => store.getState().held.length === 0, "the held task sent");
    await drain();
    expect(client.runNows).toEqual([]);
  });

  test("go out oldest first, one at a time", async () => {
    const client = new ScriptedClient(DOWN);
    const store = attached(client);
    await store.spawn();
    store.setPrompt("and the next");
    await store.spawn();
    const [first, second] = [heldTask(store, 0), heldTask(store, 1)];

    let answer: (reply: TaskCreated) => void = () => {};
    client.onCreate = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    client.emit({ status: "open", registrySettled: true });
    await until(() => client.creates.length === 1, "the first send");
    await drain();
    expect(client.creates).toEqual([first]);

    answer({ ok: true, landedEarlier: false });
    await until(() => client.creates.length === 2, "the second send");
    expect(client.creates).toEqual([first, second]);
  });

  test("past the cap another is refused; discard frees a slot, but never takes back one being sent", async () => {
    const client = new ScriptedClient(DOWN);
    const held = Array.from({ length: HELD_MAX }, (_, i) => ({
      task: { ...QUEUED, id: `t-held-${i}`, state: "queued" as const, createdAt: Date.now() },
      failure: null,
      sending: false,
    }));
    const store = attached(client, held);
    await store.spawn();
    expect(store.getState().held).toHaveLength(HELD_MAX);
    expect(store.getState().verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: false });
    expect(store.getState().form.prompt).toBe("fix it");

    store.discardHeld("t-held-9");
    expect(store.getState().held).toHaveLength(HELD_MAX - 1);

    client.onCreate = () => new Promise(() => {});
    client.emit({ status: "open", registrySettled: true });
    await until(() => store.getState().held[0]?.sending === true, "the first send out");
    store.discardHeld("t-held-0");
    expect(store.getState().held[0]?.task.id).toBe("t-held-0");
  });
});

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

  test("with no leader the task still queues, the follow stops polling without spending a poll, and a leader's arrival reads it at once", async () => {
    const client = new ScriptedClient({ scheduler: { kind: "none" } });
    client.onQueue = async () => {
      throw new RequestFailure("no_leader", "no scheduler is leading");
    };
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    expect(store.getState().verdict).toMatchObject({ kind: "queued" });
    expect(client.creates).toHaveLength(1);

    timers.fire(QUEUE_POLL_MS);
    await until(() => client.queueRequests.length === 1, "the first poll");
    await drain();
    // Nothing would hear another read until a leader leads, so none is armed.
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);
    expect(followEnd(store)).toBeUndefined();

    const placed: Task = { ...firstCreate(client), state: "ready" };
    client.onQueue = async () => ({ tasks: [placed], at: 3 });
    client.emit({ scheduler: { kind: "ready", deviceId: "dev-a", term: 1 } });
    await until(() => queuedState(store) === "ready", "read once a leader leads");
    // The waiting read spent nothing, nor did the arrival's: the chain re-arms on the whole budget.
    expect(timers.armed(QUEUE_POLL_MS)).toBe(1);
    const rearmed = (): boolean => timers.armed(QUEUE_POLL_MS) === 1;
    for (let poll = 1; poll < QUEUE_POLLS; poll += 1) {
      timers.fire(QUEUE_POLL_MS);
      // oxlint-disable-next-line no-await-in-loop -- each poll follows the one before
      await until(rearmed, "the next poll armed");
    }
    timers.fire(QUEUE_POLL_MS);
    await until(() => followEnd(store) !== undefined, "the budget spent");
    detach();
  });

  test("a leader that verifies while the leaderless read is out keeps the follow polling", async () => {
    const client = new ScriptedClient({ scheduler: { kind: "none" } });
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    client.onQueue = async () => {
      client.emit({ scheduler: { kind: "ready", deviceId: "dev-a", term: 1 } });
      throw new RequestFailure("no_leader", "no scheduler is leading");
    };
    timers.fire(QUEUE_POLL_MS);
    await until(() => timers.armed(QUEUE_POLL_MS) === 1, "the next poll armed");
    detach();
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

  test("a nudge naming the followed task while the tab is hidden is read once it shows on a live socket", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    const created = firstCreate(client);
    await drain();
    const asked = client.queueRequests.length;
    const running: Task = { ...created, state: "running" };
    client.onQueue = async () => ({ tasks: [running], at: 3 });
    try {
      setVisibility("hidden");
      client.nudge({ at: 3, tasks: [created.id] });
      await drain();
      expect(client.queueRequests).toHaveLength(asked);
    } finally {
      setVisibility("visible");
    }
    await until(() => queuedState(store) === "running", "read on showing");
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

  test("a leader the relay calls offline while the scheduler reads ready spends polls, so the follow ends", async () => {
    const client = new ScriptedClient();
    client.onQueue = async () => {
      throw new RequestFailure("no_leader", "the relay has no leader to route to");
    };
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    for (let n = 0; n < QUEUE_POLLS; n += 1) {
      timers.fire(QUEUE_POLL_MS);
      // oxlint-disable-next-line no-await-in-loop -- one poll at a time
      await drain();
    }
    expect(followEnd(store)).toBeDefined();
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);
    detach();
  });

  test("a last poll that finds the leader gone parks the follow rather than ending it", async () => {
    const client = new ScriptedClient();
    client.onQueue = async () => {
      throw new RequestFailure("no_leader", "the relay has no leader to route to");
    };
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    const created = firstCreate(client);
    for (let n = 1; n < QUEUE_POLLS; n += 1) {
      timers.fire(QUEUE_POLL_MS);
      // oxlint-disable-next-line no-await-in-loop -- one poll at a time
      await drain();
    }
    // The leader is lost while the last poll is out: its leaderless answer is no longer the relay's `offline`.
    client.onQueue = async () => {
      client.emit({ scheduler: { kind: "none" } });
      throw new RequestFailure("no_leader", "no scheduler is leading");
    };
    timers.fire(QUEUE_POLL_MS);
    await drain();
    expect(followEnd(store)).toBeUndefined();
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);

    client.onQueue = async () => ({ tasks: [{ ...created, state: "ready" }], at: 3 });
    client.emit({ scheduler: { kind: "ready", deviceId: "dev-a", term: 1 } });
    await until(() => queuedState(store) === "ready", "the parked last poll read on the leader's arrival");
    detach();
  });

  test("a followed task nudged while hidden with no leader is not read on the leader's arrival once another is followed", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    const created = firstCreate(client);
    await drain();
    client.emit({ scheduler: { kind: "none" } });
    try {
      setVisibility("hidden");
      client.nudge({ at: 3, tasks: [created.id] });
      await drain();
    } finally {
      setVisibility("visible");
    }
    await drain();

    await store.spawn();
    await drain();
    const followReads = (): number => client.queueRequests.filter((r) => r.tasks !== undefined).length;
    const asked = followReads();
    client.emit({ scheduler: { kind: "ready", deviceId: "dev-a", term: 1 } });
    await drain();
    // The owed read belonged to the first task; the second's chain is on its own timer.
    expect(followReads()).toBe(asked);
    detach();
  });

  test("a leader arriving at a parked follow after a reopen reads the followed task once and re-arms the chain", async () => {
    const client = new ScriptedClient({ scheduler: { kind: "none" } });
    client.onQueue = async () => {
      throw new RequestFailure("no_leader", "no scheduler is leading");
    };
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    const created = firstCreate(client);
    timers.fire(QUEUE_POLL_MS);
    await until(() => client.queueRequests.length === 1, "the leaderless poll");
    await drain();
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);

    client.onQueue = async () => ({ tasks: [created], at: 3 });
    client.emit({ status: "retrying" });
    client.emit({ status: "open", scheduler: { kind: "ready", deviceId: "dev-a", term: 1 } });
    await until(() => client.queueRequests.length === 2, "the arrival's read");
    await drain();
    expect(client.queueRequests).toHaveLength(2);
    expect(timers.armed(QUEUE_POLL_MS)).toBe(1);
    detach();
  });

  test("a nudge for the followed task shown with no verified leader is read once one verifies", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.spawn();
    const created = firstCreate(client);
    await drain();
    client.emit({ scheduler: { kind: "none" } });
    const asked = client.queueRequests.length;
    try {
      setVisibility("hidden");
      client.nudge({ at: 3, tasks: [created.id] });
      await drain();
    } finally {
      setVisibility("visible");
    }
    await drain();
    // Refused unsent would have recorded nothing: no read goes out while nobody can answer.
    expect(client.queueRequests).toHaveLength(asked);

    const running: Task = { ...created, state: "running" };
    client.onQueue = async () => ({ tasks: [running], at: 4 });
    client.emit({ scheduler: { kind: "ready", deviceId: "dev-a", term: 1 } });
    await until(() => queuedState(store) === "running", "the nudged task read on the leader's arrival");
    detach();
  });
});

describe("start now", () => {
  let timers: ReturnType<typeof captureTimers>;

  beforeEach(() => {
    timers = captureTimers();
  });

  afterEach(() => timers.restore());

  /** A fleet whose verified leader advertises run-now. */
  function capable(): ScriptedClient {
    return new ScriptedClient({
      machines: [autoMachine("dev-a", { capabilities: [CAPABILITIES.runNow] }), autoMachine("dev-b")],
    });
  }

  const reserved = (task: Task): Task => ({
    ...task,
    state: "reserved",
    reservation: { deviceId: "dev-a", exclave: "default", clone: "app", expiresAt: 9 },
  });

  /** One follow poll answered with `task`, run to the end of its chain. */
  async function poll(client: ScriptedClient, task: Task): Promise<void> {
    client.onQueue = async () => ({ tasks: [task], at: 2 });
    const asked = client.queueRequests.length;
    timers.fire(QUEUE_POLL_MS);
    await until(() => client.queueRequests.length > asked, "the poll");
    await drain();
  }

  test("queues as Queue does, then sends run-now once, on the first read that shows the task ready", async () => {
    const client = capable();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const created = firstCreate(client);
    expect(created).toMatchObject({ state: "queued", spec: { repo: ORIGIN, prompt: "fix it" } });
    expect(store.getState().verdict).toEqual({ kind: "queued", task: created });
    // Not admitted yet: run-now would be refused not_waiting, so nothing goes with the create.
    expect(client.runNows).toEqual([]);

    await poll(client, { ...created, state: "queued" });
    expect(client.runNows).toEqual([]);

    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toEqual([created.id]);
    await until(() => queuedState(store) === "reserved", "the reply shown");
    expect(store.getState().startNowRefusal).toBeNull();

    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toEqual([created.id]);
  });

  test("waits through blocked, and is never sent once a pass placed the task on its own", async () => {
    const client = capable();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const created = firstCreate(client);

    await poll(client, { ...created, state: "blocked" });
    await poll(client, reserved(created));
    expect(queuedState(store)).toBe("reserved");
    // Back to ready (a reservation that lapsed): the intent went with the placement.
    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toEqual([]);
  });

  test("Queue never sends run-now, and a new enqueue drops a Start now still waiting", async () => {
    const client = capable();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const first = firstCreate(client);
    store.setPrompt("and this");
    await store.spawn();
    const second = client.creates[1];
    if (second === undefined) throw new Error("second create missing");

    // The first task shows ready too: were its intent still held, something would read and send for it.
    client.onQueue = async () => ({
      tasks: [
        { ...first, state: "ready" },
        { ...second, state: "ready" },
      ],
      at: 2,
    });
    timers.fire(QUEUE_POLL_MS);
    await drain();
    expect(queuedState(store)).toBe("ready");
    expect(client.runNows).toEqual([]);
  });

  test("a refusal says why on the queued verdict, and is gone once the task moves past waiting", async () => {
    const client = capable();
    client.onRunNow = async () => ({ ok: false, code: "unplaceable", message: "held" });
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.startNow();
    const created = firstCreate(client);

    client.onQueue = async () => ({ tasks: [{ ...created, state: "ready" }], at: 2 });
    client.nudge({ at: 2, tasks: [created.id] });
    await until(() => store.getState().startNowRefusal !== null, "the refusal");
    const message = "Something besides the concurrency caps keeps it from every machine — see why it waits.";
    expect(store.getState().startNowRefusal).toEqual({ taskId: created.id, message });
    expect(queuedState(store)).toBe("ready");
    const verdict = store.getState().verdict;
    if (verdict === null) throw new Error("verdict missing");
    const body = describeVerdict(verdict, [], {}, 1, null, store.getState().startNowRefusal).body;
    expect(body).toEndWith(`Couldn't start it at once: ${message}`);
    // Nothing queues the Queue screen's notice for it: the verdict is where it was asked.
    expect(store.getState().queueNotice).toBeNull();

    // A reservation that lapses back to ready must not bring the note back.
    await poll(client, reserved(created));
    expect(store.getState().startNowRefusal).toBeNull();
    detach();
  });

  test("a run-now that throws shows the transport failure on the verdict", async () => {
    const client = capable();
    client.onRunNow = async () => {
      throw new RequestFailure("dropped", "socket closed", "relay");
    };
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const created = firstCreate(client);
    await poll(client, { ...created, state: "ready" });
    await until(() => store.getState().startNowRefusal !== null, "the refusal");
    expect(store.getState().startNowRefusal?.message).toContain("Refresh to see whether it did.");
  });

  test("a create whose answer was lost keeps the Start now for its retry", async () => {
    const client = capable();
    client.onCreate = async () => {
      throw new RequestFailure("timeout", "store-put timed out after 10000ms", "relay");
    };
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const verdict = store.getState().verdict;
    if (verdict?.kind !== "unqueued") throw new Error("expected unqueued");
    expect(verdict.runNow).toBe(true);

    client.onCreate = async () => ({ ok: true, landedEarlier: true });
    await store.retryEnqueue(verdict);
    await poll(client, { ...firstCreate(client), state: "ready" });
    expect(client.runNows).toEqual([firstCreate(client).id]);
  });

  test("a verdict left before the task is ready still sends, and a refusal lands on the Queue notice", async () => {
    const client = capable();
    client.onRunNow = async () => ({ ok: false, code: "unplaceable", message: "held" });
    const fake = fakeHistory();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const created = firstCreate(client);
    store.startAnother();
    fake.settle(store);
    fake.restore();
    expect(store.getState().verdict).toBeNull();

    client.onQueue = async () => ({ tasks: [{ ...created, state: "ready" }], at: 2 });
    timers.fire(QUEUE_POLL_MS);
    await until(() => client.runNows.length > 0, "the run-now");
    await until(() => store.getState().queueNotice !== null, "the notice");
    expect(client.runNows).toEqual([created.id]);
    expect(store.getState().queueNotice).toStartWith(`Couldn't start "fix it" at once:`);
    expect(store.getState().queueNotice).toContain("see why it waits");
    expect(store.getState().startNowRefusal).toBeNull();

    // Opening the Queue screen reads it whole; that read must not take the note down before it is seen.
    const notice = store.getState().queueNotice;
    client.onQueue = async () => ({ tasks: [{ ...created, state: "ready" }], holds: [], at: 3 });
    store.openQueue();
    await until(() => store.getState().queueView?.kind === "ok", "the queue read");
    expect(store.getState().queueNotice).toBe(notice);
    await store.refreshQueue();
    expect(store.getState().queueNotice).toBeNull();
  });

  test("an answer that comes after the verdict moved to another task shows nowhere", async () => {
    const client = capable();
    const slow = Promise.withResolvers<TaskReply | null>();
    client.onRunNow = () => slow.promise;
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const created = firstCreate(client);
    await poll(client, { ...created, state: "ready" });
    await until(() => client.runNows.length > 0, "the run-now");

    store.setPrompt("and this");
    await store.spawn();
    slow.resolve({ ok: false, code: "unplaceable", message: "held" });
    await drain();
    expect(store.getState().startNowRefusal).toBeNull();
    expect(store.getState().queueNotice).toBeNull();
  });

  test("dispatching (a pass placing it) or finished (a cancel or end): no note, one read, and the follow goes on", async () => {
    for (const code of ["dispatching", "finished"] as const) {
      const client = capable();
      const answer = Promise.withResolvers<TaskReply | null>();
      client.onRunNow = () => answer.promise;
      const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
      // oxlint-disable-next-line no-await-in-loop -- one store at a time
      await store.startNow();
      const created = firstCreate(client);
      // oxlint-disable-next-line no-await-in-loop -- as above
      await poll(client, { ...created, state: "ready" });
      expect(client.runNows).toHaveLength(1);

      const asked = client.queueRequests.length;
      const armed = timers.armed(QUEUE_POLL_MS);
      answer.resolve({ ok: false, code, message: "x" });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await drain();
      // Before any read could show it reserved: the answer alone says nothing to the person.
      expect(store.getState().startNowRefusal).toBeNull();
      expect(store.getState().queueNotice).toBeNull();
      expect(client.queueRequests.length).toBe(asked + 1);
      expect(timers.armed(QUEUE_POLL_MS)).toBe(armed);

      // oxlint-disable-next-line no-await-in-loop -- as above
      await poll(client, reserved(created));
      expect(queuedState(store)).toBe("reserved");
      expect(client.runNows).toHaveLength(1);
    }
  });

  test("not_waiting keeps the intent reading: a later ready asks again, and never more than twice", async () => {
    const client = capable();
    client.onRunNow = async () => ({ ok: false, code: "not_waiting", message: "x" });
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const created = firstCreate(client);

    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toHaveLength(1);
    await poll(client, { ...created, state: "queued" });
    expect(client.runNows).toHaveLength(1);
    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toHaveLength(2);
    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toHaveLength(2);
    expect(store.getState().startNowRefusal).toBeNull();
    expect(store.getState().queueNotice).toBeNull();
  });

  test("a long stretch with no leader spends no reads, and the ready after it still sends", async () => {
    const client = capable();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.startNow();
    const created = firstCreate(client);
    client.emit({ scheduler: { kind: "none" } });
    client.onQueue = async () => {
      throw new RequestFailure("no_leader", "no scheduler is leading");
    };
    for (let n = 0; n < QUEUE_POLLS * 2; n += 1) {
      timers.fire(QUEUE_POLL_MS);
      // oxlint-disable-next-line no-await-in-loop -- one poll at a time
      await drain();
    }
    client.onQueue = async () => ({ tasks: [{ ...created, state: "ready" }], at: 2 });
    client.emit({ scheduler: { kind: "ready", deviceId: "dev-a", term: 1 } });
    await until(() => client.runNows.length === 1, "the run-now");
    expect(client.runNows).toEqual([created.id]);
    detach();
  });

  test("reads that reach a leader spend the budget: once spent, the intent lapses unsent and silent", async () => {
    const client = capable();
    const fake = fakeHistory();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const created = firstCreate(client);
    // Dismissed, so only the intent's own chain reads.
    store.startAnother();
    fake.settle(store);
    fake.restore();
    for (let n = 0; n < QUEUE_POLLS; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one poll at a time
      await poll(client, { ...created, state: "queued" });
    }
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);
    client.nudge({ at: 3, tasks: [created.id] });
    await drain();
    expect(client.runNows).toEqual([]);
    expect(store.getState().queueNotice).toBeNull();
  });

  test("a second Start now while one is waiting replaces it", async () => {
    const client = capable();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const first = firstCreate(client);
    store.setPrompt("and this");
    await store.startNow();
    const second = client.creates[1];
    if (second === undefined) throw new Error("second create missing");

    client.onQueue = async () => ({
      tasks: [
        { ...first, state: "ready" },
        { ...second, state: "ready" },
      ],
      at: 2,
    });
    timers.fire(QUEUE_POLL_MS);
    await until(() => client.runNows.length > 0, "the run-now");
    await drain();
    expect(client.runNows).toEqual([second.id]);
  });

  test("a run-now refused unsent for want of a leader is asked once more, then says so", async () => {
    const client = capable();
    client.onRunNow = async () => {
      throw new RequestFailure("no_leader", "no scheduler is leading");
    };
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const created = firstCreate(client);
    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toHaveLength(1);
    expect(store.getState().startNowRefusal).toBeNull();

    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toHaveLength(2);
    expect(store.getState().startNowRefusal?.message).toBeDefined();
    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toHaveLength(2);
  });

  test("a busy answer after the follow ran out still gets its one more ask", async () => {
    const client = capable();
    const busy = Promise.withResolvers<TaskReply | null>();
    client.onRunNow = () => busy.promise;
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const created = firstCreate(client);
    for (let n = 0; n < QUEUE_POLLS; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one poll at a time
      await poll(client, { ...created, state: "ready" });
    }
    expect(followEnd(store)).toBeDefined();
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);

    busy.resolve({ ok: false, code: "conflict", message: "x" });
    await drain();
    expect(timers.armed(QUEUE_POLL_MS)).toBe(1);
    client.onRunNow = async (id) => ({ task: reserved({ ...created, id }) });
    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toHaveLength(2);
    expect(queuedState(store)).toBe("reserved");
    expect(store.getState().startNowRefusal).toBeNull();
  });

  test("a ready sighting under an unverified leader holds the ask, not the intent", async () => {
    const client = capable();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.startNow();
    const created = firstCreate(client);
    client.emit({ scheduler: { kind: "unverified", deviceId: "dev-a", term: 2 } });
    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toEqual([]);
    expect(store.getState().startNowRefusal).toBeNull();

    client.emit({ scheduler: { kind: "ready", deviceId: "dev-a", term: 2 } });
    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toEqual([created.id]);
    detach();
  });

  test("with no leader the Start now stops reading too, and asks on the first ready sighting once one leads", async () => {
    const client = capable();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.startNow();
    const created = firstCreate(client);
    client.emit({ scheduler: { kind: "none" } });
    client.onQueue = async () => {
      throw new RequestFailure("no_leader", "no scheduler is leading");
    };
    const asked = client.queueRequests.length;
    // The follow's poll and the intent's read both come due, and both find nobody to ask.
    timers.fire(QUEUE_POLL_MS);
    await until(() => client.queueRequests.length === asked + 2, "both reads");
    await drain();
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);

    client.onQueue = async () => ({ tasks: [{ ...created, state: "ready" }], at: 2 });
    client.emit({ scheduler: { kind: "ready", deviceId: "dev-a", term: 3 } });
    await until(() => client.runNows.length === 1, "the run-now once a leader leads");
    expect(client.runNows).toEqual([created.id]);
    detach();
  });

  test("a Start now whose last read finds the leader gone is parked, not forgotten, and asks once a leader leads", async () => {
    const client = capable();
    client.onQueue = async () => {
      throw new RequestFailure("no_leader", "the relay has no leader to route to");
    };
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.startNow();
    const created = firstCreate(client);
    for (let n = 1; n < QUEUE_POLLS; n += 1) {
      timers.fire(QUEUE_POLL_MS);
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      await drain();
    }
    client.onQueue = async () => {
      client.emit({ scheduler: { kind: "none" } });
      throw new RequestFailure("no_leader", "no scheduler is leading");
    };
    timers.fire(QUEUE_POLL_MS);
    await drain();
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);

    client.onQueue = async () => ({ tasks: [{ ...created, state: "ready" }], at: 2 });
    client.emit({ scheduler: { kind: "ready", deviceId: "dev-a", term: 3 } });
    await until(() => client.runNows.length === 1, "the run-now once a leader leads");
    expect(client.runNows).toEqual([created.id]);
    detach();
  });

  test("a follow that stops on a refused read leaves the run-now out to answer on the verdict", async () => {
    const client = capable();
    const answer = Promise.withResolvers<TaskReply | null>();
    client.onRunNow = () => answer.promise;
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const created = firstCreate(client);
    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toHaveLength(1);

    client.onQueue = async () => ({ ok: false, code: "not_leader", message: "x" });
    timers.fire(QUEUE_POLL_MS);
    await drain();
    expect(followEnd(store)).toMatchObject({ kind: "refused" });

    answer.resolve({ ok: false, code: "unplaceable", message: "held" });
    await until(() => store.getState().startNowRefusal !== null, "the refusal");
    expect(store.getState().startNowRefusal?.taskId).toBe(created.id);
  });

  test("detaching ends the intent: no timer stays armed, and a late answer arms none", async () => {
    const client = capable();
    const answer = Promise.withResolvers<TaskReply | null>();
    client.onRunNow = () => answer.promise;
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.startNow();
    const created = firstCreate(client);
    await poll(client, { ...created, state: "ready" });
    detach();
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);

    answer.resolve({ ok: false, code: "conflict", message: "x" });
    await drain();
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);
    expect(store.getState().startNowRefusal).toBeNull();
  });

  test("a busy leader gets one more ask on the next ready sighting, then the note points at Start now", async () => {
    const client = capable();
    client.onRunNow = async () => ({ ok: false, code: "conflict", message: "x" });
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const created = firstCreate(client);
    await poll(client, { ...created, state: "ready" });
    await drain();
    expect(client.runNows).toHaveLength(1);
    expect(store.getState().startNowRefusal).toBeNull();

    await poll(client, { ...created, state: "ready" });
    await until(() => store.getState().startNowRefusal !== null, "the note");
    expect(client.runNows).toHaveLength(2);
    expect(store.getState().startNowRefusal?.message).toContain("Start now on the Queue screen");

    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toHaveLength(2);
  });

  test("a leader that stopped advertising run-now is told so, and nothing is sent", async () => {
    const client = capable();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.startNow();
    const created = firstCreate(client);
    client.emit({ machines: [autoMachine("dev-a"), autoMachine("dev-b")] });
    await poll(client, { ...created, state: "ready" });
    expect(client.runNows).toEqual([]);
    expect(store.getState().startNowRefusal?.message).toBe(
      "This leader can't start tasks past the queue; it stays queued.",
    );
    detach();
  });

  test("a reply after the follow ran out restarts it, so the verdict goes on to running", async () => {
    const client = capable();
    const slow = Promise.withResolvers<TaskReply | null>();
    client.onRunNow = () => slow.promise;
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    await store.startNow();
    const created = firstCreate(client);
    for (let n = 0; n < QUEUE_POLLS; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one poll at a time
      await poll(client, { ...created, state: "ready" });
    }
    expect(followEnd(store)).toBeDefined();
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);

    slow.resolve({ task: reserved(created) });
    await until(() => queuedState(store) === "reserved", "the reply");
    expect(timers.armed(QUEUE_POLL_MS)).toBe(1);
    await poll(client, { ...created, state: "running" });
    expect(queuedState(store)).toBe("running");
  });

  test("a whole-queue read out before the run-now reply cannot walk the verdict back to ready", async () => {
    const client = capable();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix it" });
    const detach = store.attach();
    await store.startNow();
    const created = firstCreate(client);
    client.onQueue = async () => ({ tasks: [created], holds: [], at: 1 });
    store.openQueue();
    await until(() => store.getState().queueView?.kind === "ok", "the queue read");

    const slowRun = Promise.withResolvers<TaskReply | null>();
    client.onRunNow = () => slowRun.promise;
    await poll(client, { ...created, state: "ready" });
    await until(() => client.runNows.length > 0, "the run-now");

    const slowRead = Promise.withResolvers<QueueReply | null>();
    client.onQueue = () => slowRead.promise;
    client.nudge({ at: 3, tasks: [created.id] });
    await drain();
    slowRun.resolve({ task: reserved(created) });
    await until(() => queuedState(store) === "reserved", "the reply");

    slowRead.resolve({ tasks: [{ ...created, state: "ready" }], holds: [], at: 2 });
    await drain();
    expect(queuedState(store)).toBe("reserved");
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
      idle: [],
      skew: expect.any(Number),
      at: 1,
    });

    store.dismissLayer();
    fake.settle(store);
    expect(store.getState().queue).toBe(false);
    expect(fake.index()).toBe(0);
  });

  describe("a notification's link", () => {
    const outside: Task = { ...QUEUED, id: "old-1", state: "needs-input" };

    test("reads its task by name, so one outside the default listing is listed", async () => {
      const client = new ScriptedClient();
      client.onQueue = async (request) =>
        request.tasks === undefined ? { tasks: [waiting], holds: [], at: 1 } : { tasks: [outside], holds: [], at: 2 };
      const store = new Store(client);
      openDeepLink(store, { to: "task", taskId: outside.id });
      await until(() => {
        const view = store.getState().queueView;
        return view?.kind === "ok" && view.tasks.some((t) => t.id === outside.id);
      }, "the named task listed");
      expect(client.queueRequests).toEqual([{}, { tasks: [outside.id] }]);
      expect(store.getState()).toMatchObject({ queue: true, focusedTask: outside.id });
    });

    test("its focus outlives every read and re-render until the row is acted on, and closing the screen drops it", async () => {
      const client = new ScriptedClient();
      const store = new Store(client);
      // A task nobody lists (pruned since): its row never arrives, so nothing acts on the focus.
      openDeepLink(store, { to: "task", taskId: "ghost-1" });
      await until(() => store.getState().queueView?.kind === "ok", "the queue read");
      await drain();
      // State patches of every other kind, as any App re-render's worth of them: the focus stays.
      await store.refreshQueue();
      store.openSettings();
      store.dismissLayer();
      fake.settle(store);
      expect(store.getState()).toMatchObject({ queue: true, focusedTask: "ghost-1" });

      store.dismissLayer();
      fake.settle(store);
      expect(store.getState()).toMatchObject({ queue: false, focusedTask: null });
    });
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
      idle: [],
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

  test("dismissing the notice drops only the notice, and a later read leaves it gone", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    client.onQueue = async () => ({ ok: false, code: "not_ready", message: "taking over" });
    await store.refreshQueue();
    expect(store.getState().queueNotice).toContain("taking over");

    store.dismissQueueNotice();
    expect(store.getState().queueNotice).toBeNull();
    expect(store.getState().queueView).toMatchObject({ kind: "ok" });
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

  describe("passTask", () => {
    const at = { deviceId: "dev-a", exclave: "default", clone: "app" };
    const live: Task = {
      id: "r-1",
      spec: { repo: ORIGIN, mode: "worktree", prompt: "fix it", title: "fix-it" },
      state: "running",
      assignment: { ...at, window: "fix-it" },
      createdAt: 1,
    };
    const successor: Task = {
      id: "t-next",
      spec: {
        repo: ORIGIN,
        mode: "worktree",
        succeeds: { task: "r-1", account: "acct", at, trigger: "manual" },
      },
      state: "blocked",
      createdAt: 2,
    };

    /** The leader (dev-a) and the machine the task runs on (also dev-a) advertise `successor` unless held back. */
    const capable = (capabilities: readonly string[] = [CAPABILITIES.successor]): ScriptedClient =>
      new ScriptedClient({
        machines: [autoMachine("dev-a", { capabilities: [...capabilities] }), autoMachine("dev-b")],
      });

    async function withRunning(client: ScriptedClient): Promise<Store> {
      client.onQueue = async () => ({ tasks: [live], holds: [], at: 1 });
      const store = new Store(client);
      store.openQueue();
      await until(() => store.getState().queueView?.kind === "ok", "the queue read");
      return store;
    }

    test("sends one pass, and lists the task as it now stands and the successor at once", async () => {
      const client = capable();
      client.onPass = async (id) => ({
        task: { ...live, id, state: "superseded", successor: "t-next" },
        successorId: "t-next",
        successor,
      });
      const store = await withRunning(client);
      await store.passTask("r-1");
      expect(client.passes).toEqual(["r-1"]);
      expect(store.getState().queueNotice).toBeNull();
      expect(store.getState().taskAction).toBeNull();
      const view = store.getState().queueView;
      const listed = view?.kind === "ok" ? view.tasks : [];
      expect(listed.map((t) => [t.id, t.state])).toEqual([
        ["t-next", "blocked"],
        ["r-1", "superseded"],
      ]);
    });

    test("writes nothing for a task the list no longer holds, or one the offer refuses, or a leader that cannot", async () => {
      const client = capable();
      const store = await withRunning(client);
      await store.passTask("gone");
      expect(store.getState().queueNotice).toBe("That task is no longer listed.");
      const old = capable([]);
      const oldStore = await withRunning(old);
      await oldStore.passTask("r-1");
      expect(oldStore.getState().queueNotice).toContain("No verified scheduler that can pass a task to a successor");
      const asking = capable();
      asking.onQueue = async () => ({ tasks: [{ ...live, state: "needs-input" }], holds: [], at: 1 });
      const waitingStore = new Store(asking);
      waitingStore.openQueue();
      await until(() => waitingStore.getState().queueView?.kind === "ok", "the queue read");
      await waitingStore.passTask("r-1");
      expect(waitingStore.getState().queueNotice).toContain("waiting for you");
      expect([client.passes, old.passes, asking.passes]).toEqual([[], [], []]);
    });

    test("a refusal is worded; a lost answer or a crashed reply says it may have landed", async () => {
      const client = capable();
      const store = await withRunning(client);
      client.onPass = async () => ({ ok: false, code: "dirty_worktree", message: "m" });
      await store.passTask("r-1");
      expect(store.getState().queueNotice).toContain("uncommitted");
      expect(store.getState().queueNotice).not.toContain("may have landed");
      client.onPass = async () => null;
      await store.passTask("r-1");
      expect(store.getState().queueNotice).toContain("It may have landed anyway.");
      client.onPass = async () => ({ ok: false, code: "too_large", message: "m" });
      await store.passTask("r-1");
      expect(store.getState().queueNotice).toContain("It may have landed anyway.");
      client.onPass = async () => {
        throw new RequestFailure("timeout", "no reply");
      };
      await store.passTask("r-1");
      expect(store.getState().queueNotice).toContain("Refresh to see whether it did.");
      expect(store.getState().taskAction).toBeNull();
    });
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
          autoMachine("dev-a", { capabilities: [CAPABILITIES.continueTask, CAPABILITIES.continueSession] }),
          autoMachine("dev-b", { capabilities: [CAPABILITIES.continueTask, CAPABILITIES.continueSession] }),
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

    test("carries the task's requires only to a leader that routes on traits, and writes nothing to one that does not", async () => {
      const requiring: Task = { ...failed, spec: { ...failed.spec, requires: ["atlas"] } };
      const withTraits = (leader: readonly string[]): ScriptedClient => {
        const client = new ScriptedClient({
          machines: [
            autoMachine("dev-a", {
              capabilities: [CAPABILITIES.continueTask, CAPABILITIES.continueSession, ...leader],
            }),
            autoMachine("dev-b", { capabilities: [CAPABILITIES.continueTask, CAPABILITIES.continueSession] }),
          ],
        });
        client.onQueue = async () => ({ tasks: [requiring], holds: [], at: 1 });
        return client;
      };
      const open = async (client: ScriptedClient): Promise<Store> => {
        const store = new Store(client);
        store.openQueue();
        await until(() => store.getState().queueView?.kind === "ok", "the queue read");
        return store;
      };

      const old = withTraits([]);
      const oldStore = await open(old);
      await oldStore.continueTask("f-1");
      expect(old.creates).toEqual([]);
      expect(oldStore.getState().queueNotice).toContain("can't route on traits");

      const current = withTraits([CAPABILITIES.traits]);
      await (await open(current)).continueTask("f-1");
      expect(current.creates[0]?.spec).toMatchObject({ mode: "continue", requires: ["atlas"] });
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
        machines: [
          autoMachine("dev-a"),
          autoMachine("dev-b", { capabilities: [CAPABILITIES.continueTask, CAPABILITIES.continueSession] }),
        ],
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
        machines: [
          autoMachine("dev-a", { capabilities: [CAPABILITIES.continueTask, CAPABILITIES.continueSession] }),
          autoMachine("dev-b"),
        ],
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

    describe("an awaiting-merge task whose PR is blocked", () => {
      const prUrl = "https://github.com/acme/app/pull/7";
      const stuck = (): Task => ({
        id: "w-1",
        spec: { repo: ORIGIN, mode: "worktree", prompt: "fix it", title: "fix-it", model: "opus" },
        state: "awaiting-merge",
        assignment: { ...at, window: "fix-it" },
        createdAt: Date.now() - 1_000,
        prUrl,
        pr: { state: "open", required: "failing", failing: ["test (ubuntu)"], merge: "blocked", at: Date.now() },
      });
      const caps = [CAPABILITIES.continueTask, CAPABILITIES.continueSession, CAPABILITIES.continueHandoff];

      async function withStuck(client: ScriptedClient, task: Task): Promise<Store> {
        client.onQueue = async () => ({ tasks: [task], holds: [], at: 1 });
        const store = new Store(client);
        store.openQueue();
        await until(() => store.getState().queueView?.kind === "ok", "the queue read");
        return store;
      }

      test("writes a continue task resuming the leader's pointer, with the fixed brief as its prompt", async () => {
        const client = new ScriptedClient({ machines: [autoMachine("dev-a", { capabilities: caps })] });
        const store = await withStuck(client, {
          ...stuck(),
          continuedBy: { task: "c-0", createdAt: Date.now() - 500 },
        });
        await store.continueTask("w-1");
        expect(store.getState().queueNotice).toBeNull();
        expect(client.creates).toHaveLength(1);
        const spec = client.creates[0]?.spec;
        expect(spec).toMatchObject({ mode: "continue", model: "opus", continues: { task: "c-0", at }, client: "pwa" });
        expect(spec?.prompt).toContain(prUrl);
        expect(spec?.prompt).toContain("test (ubuntu)");
      });

      test("without a pointer it resumes the task itself", async () => {
        const client = new ScriptedClient({ machines: [autoMachine("dev-a", { capabilities: caps })] });
        const store = await withStuck(client, stuck());
        await store.continueTask("w-1");
        expect(client.creates[0]?.spec).toMatchObject({ continues: { task: "w-1", at } });
      });

      test("a leader that does not advertise continueHandoff is never asked", async () => {
        const client = new ScriptedClient({
          machines: [autoMachine("dev-a", { capabilities: [CAPABILITIES.continueTask, CAPABILITIES.continueSession] })],
        });
        const store = await withStuck(client, stuck());
        await store.continueTask("w-1");
        expect(client.creates).toEqual([]);
        expect(store.getState().queueNotice).not.toBeNull();
      });
    });

    test("a second tap while the first continuation waits writes nothing and names the first", async () => {
      const client = capable();
      const store = await withFailed(client);
      await store.continueTask("f-1");
      await store.continueTask("f-1");
      expect(client.creates).toHaveLength(1);
      expect(store.getState().queueNotice).toContain(`Already continuing as task ${client.creates[0]?.id}`);
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
      idle: [],
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

  test("a nudge while the tab is hidden reads nothing; showing it on a live socket reads the whole queue once", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const detach = store.attach();
    await drain();
    const asked = client.queueRequests.length;
    try {
      setVisibility("hidden");
      client.nudge({ at: 2, tasks: ["w-1"] });
      client.nudge({ at: 3 });
      await drain();
      expect(client.queueRequests).toHaveLength(asked);
    } finally {
      setVisibility("visible");
    }
    await until(() => client.queueRequests.length === asked + 1, "the catch-up read");
    expect(client.queueRequests.at(-1)).toEqual({});
    expect(client.shownAfter).toHaveLength(1);
    expect(client.shownAfter[0]).toBeLessThan(Infinity);

    // Caught up: showing it again with nothing missed reads nothing more.
    setVisibility("hidden");
    setVisibility("visible");
    await drain();
    expect(client.queueRequests).toHaveLength(asked + 1);
    detach();
  });

  test("a resume that re-dials leaves the catch-up to the reopen; a tab never seen hidden counts as hidden long", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const detach = store.attach();
    await drain();
    const asked = client.queueRequests.length;
    setVisibility("visible");
    await drain();
    expect(client.shownAfter).toEqual([Infinity]);

    client.onShown = async () => "redialed";
    setVisibility("hidden");
    client.nudge({ at: 2 });
    setVisibility("visible");
    await drain();
    expect(client.queueRequests).toHaveLength(asked);
    // The reopen reads it whole, as it does after any drop.
    client.emit({ status: "retrying" });
    client.emit({ status: "open" });
    await until(() => client.queueRequests.length === asked + 1, "the reopen's read");
    detach();
  });

  test("a tab hidden again before its resume's pong keeps what it missed for the next show", async () => {
    const client = new ScriptedClient();
    const store = await loaded(client);
    const detach = store.attach();
    await drain();
    const asked = client.queueRequests.length;
    const pong = Promise.withResolvers<ResumeOutcome>();
    client.onShown = () => pong.promise;
    setVisibility("hidden");
    client.nudge({ at: 2 });
    setVisibility("visible");
    setVisibility("hidden");
    pong.resolve("live");
    await drain();
    expect(client.queueRequests).toHaveLength(asked);

    client.onShown = async () => "live";
    setVisibility("visible");
    await until(() => client.queueRequests.length === asked + 1, "the catch-up on the next show");
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

describe("the screen debounce's reveal", () => {
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

  const settling = (since: number): Task => ({ ...QUEUED, id: "s-1", state: "needs-input", needsInputSince: since });
  const revealDelay = (): number | undefined => timers.delays().find((ms) => ms > 15_000 && ms < 25_000);

  async function open(client: ScriptedClient, tasks: readonly Task[], at: number): Promise<Store> {
    client.onQueue = async () => ({ tasks, holds: [], at });
    const store = new Store(client);
    store.openQueue();
    await until(() => store.getState().queueView?.kind === "ok", "the queue read");
    return store;
  }

  test("a settling task arms one timer for its crossing, which notifies subscribers with no other change", async () => {
    // 10 s into the stay on the leader's clock: 20 s (+ slack) to go, whatever the device's.
    const store = await open(new ScriptedClient(), [settling(1_000_000)], 1_010_000);
    expect(revealDelay()).toBeGreaterThan(19_000);
    expect(revealDelay()).toBeLessThan(21_000);
    const before = store.getState().queueView;
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    const delay = revealDelay();
    if (delay === undefined) throw new Error("no timer");
    timers.fire(delay);
    expect(notified).toBe(1);
    const after = store.getState().queueView;
    expect(after).not.toBe(before);
    expect(after).toEqual(before);
    // The point of waking them: at that time the task is under Needs you, and a moment before it is not.
    const titlesAt = (now: number): string[] =>
      deriveQueue(store.getState(), now).sections.map((section) => section.title);
    expect(titlesAt(Date.now() + delay - 1_000)).toEqual(["Running"]);
    expect(titlesAt(Date.now() + delay)).toEqual(["Needs you"]);
  });

  test("a newer reply re-arms it rather than stacking a second", async () => {
    const client = new ScriptedClient();
    const store = await open(client, [settling(1_000_000)], 1_010_000);
    client.onQueue = async () => ({ tasks: [settling(1_000_000)], holds: [], at: 1_015_000 });
    await store.refreshQueue();
    expect(timers.delays().filter((ms) => ms > 10_000 && ms < 25_000)).toHaveLength(1);
  });

  test("nothing settling arms nothing", async () => {
    const client = new ScriptedClient();
    await open(client, [{ ...QUEUED, id: "r-1", state: "running" }, settling(1_000_000 - 60_000)], 1_010_000);
    expect(revealDelay()).toBeUndefined();
    const question: Task = { ...settling(1_000_000), inputReason: "question" };
    await open(client, [question], 1_010_000);
    expect(revealDelay()).toBeUndefined();
  });
});

describe("requiring traits", () => {
  const exclave = (id: string, traits: readonly string[]): ExclaveInfo => ({
    id,
    authOk: true,
    accountId: `acct-${id}`,
    email: `${id}@acme.dev`,
    extraUsageEnabled: null,
    skills: [],
    traits,
  });
  const clones = (exclaveId: string): Machine["repos"] => [
    { name: "app", path: "/r/app", defaultBranch: "main", origin: ORIGIN, exclave: exclaveId },
  ];
  /** dev-a leads and has atlas on its one exclave; dev-b has gpu. */
  const tracing = (capabilities: string[] = [CAPABILITIES.traits]): ScriptedClient =>
    new ScriptedClient({
      machines: [
        autoMachine("dev-a", { capabilities, exclaves: [exclave("a", ["atlas"])], repos: clones("a") }),
        autoMachine("dev-b", { exclaves: [exclave("b", ["gpu"])], repos: clones("b") }),
      ],
    });
  const form = { ...DEFAULT_FORM, prompt: "fix it" };

  test("a plain form writes no requires; a required one is written as named, then cleared with the task", async () => {
    const plain = tracing();
    await new Store(plain, form).spawn();
    expect(firstCreate(plain).spec).not.toHaveProperty("requires");

    const client = tracing();
    const store = new Store(client, { ...form, requires: ["atlas"] });
    await store.spawn();
    expect(firstCreate(client).spec.requires).toEqual(["atlas"]);
    expect(store.getState().form.requires).toEqual([]);
  });

  test("a leader that does not advertise traits is refused before anything is written, and the form keeps them", async () => {
    const client = tracing([]);
    const store = new Store(client, { ...form, requires: ["atlas"] });
    await store.spawn();
    expect(client.creates).toEqual([]);
    expect(store.getState().verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: false });
    expect(store.getState().form.requires).toEqual(["atlas"]);
  });

  test("a name no machine declares is refused with the ones that exist", async () => {
    const client = tracing();
    const store = new Store(client, { ...form, requires: ["atlsa"] });
    await store.spawn();
    expect(client.creates).toEqual([]);
    const { verdict } = store.getState();
    if (verdict === null) throw new Error("no verdict");
    expect(describeVerdict(verdict, [], {}, 0, null).body).toContain(
      "no machine declares the trait atlsa — known: atlas, gpu",
    );
  });

  test("traits no reachable exclave carries together could never place, and are refused", async () => {
    const client = tracing();
    const split = new Store(client, { ...form, requires: ["atlas", "gpu"] });
    await split.spawn();
    expect(client.creates).toEqual([]);
    const { verdict } = split.getState();
    if (verdict === null) throw new Error("no verdict");
    expect(describeVerdict(verdict, [], {}, 0, null).body).toContain("no exclave this task can reach carries");

    const pinned = tracing();
    const pinnedStore = new Store(pinned, { ...form, machine: "dev-b", requires: ["atlas"] });
    await pinnedStore.spawn();
    expect(pinned.creates).toEqual([]);
    const pinnedVerdict = pinnedStore.getState().verdict;
    if (pinnedVerdict === null) throw new Error("no verdict");
    // The reachability check fired, not the pin, repo or gate checks: it names the holder as pinned elsewhere.
    expect(describeVerdict(pinnedVerdict, [], {}, 0, null).body).toContain("atlas is on");
    expect(describeVerdict(pinnedVerdict, [], {}, 0, null).body).toContain("(pinned elsewhere)");
    // Pinned to the machine that has it, it places.
    const ok = tracing();
    await new Store(ok, { ...form, machine: "dev-a", requires: ["atlas"] }).spawn();
    expect(firstCreate(ok).spec).toMatchObject({ pin: { deviceId: "dev-a" }, requires: ["atlas"] });
  });

  test("a held task is checked against the leader when sent, not when held", async () => {
    const old = tracing([]);
    old.emit({ status: "retrying", registrySettled: false });
    const store = new Store(old, { ...form, requires: ["atlas"] });
    store.attach();
    await store.spawn();
    expect(store.getState().held).toHaveLength(1);
    old.emit({ status: "open", registrySettled: true });
    await until(() => store.getState().held[0]?.failure !== null, "the send-time check");
    expect(store.getState().held[0]?.failure).toContain("can't route on traits");
    expect(old.creates).toEqual([]);

    const current = tracing();
    current.emit({ status: "retrying", registrySettled: false });
    const sent = new Store(current, { ...form, requires: ["atlas"] });
    sent.attach();
    await sent.spawn();
    current.emit({ status: "open", registrySettled: true });
    await until(() => current.creates.length === 1, "the held send");
    expect(firstCreate(current).spec.requires).toEqual(["atlas"]);
  });

  test("ticking a trait toggles it, at most four, and re-asks the preview with it only for a leader that takes it", async () => {
    const client = tracing();
    const store = new Store(client, form);
    store.toggleRequires("atlas");
    await until(() => client.previews.some((request) => "requires" in request), "a preview carrying requires");
    expect(client.previews.at(-1)).toMatchObject({ requires: ["atlas"] });
    store.toggleRequires("atlas");
    expect(store.getState().form.requires).toEqual([]);
    for (const trait of ["a", "b", "c", "d", "e"]) store.toggleRequires(trait);
    expect(store.getState().form.requires).toEqual(["a", "b", "c", "d"]);

    const old = tracing([]);
    const older = new Store(old, form);
    older.toggleRequires("atlas");
    await drain();
    expect(old.previews.every((request) => !("requires" in request))).toBe(true);
  });

  test("the tile appears only when the fleet declares a trait or the form holds one, and picking is off for an old leader", () => {
    const none = new Store(new ScriptedClient(), form);
    expect(deriveView(none.getState(), 0).requiresTile).toBeNull();

    const current = new Store(tracing(), form);
    const view = deriveView(current.getState(), 0);
    expect(view.requiresTile).toMatchObject({ label: "REQUIRES", value: "Any" });
    expect(view.requires.choices).toEqual([
      { name: "atlas", holders: "dev-a", selected: false, disabled: false },
      { name: "gpu", holders: "dev-b", selected: false, disabled: false },
    ]);

    const old = new Store(tracing([]), { ...form, requires: ["atlas"] });
    const oldView = deriveView(old.getState(), 0);
    expect(oldView.requires.note).toContain("can't route on traits");
    // A held pick can still be unticked; a new one cannot be added.
    expect(oldView.requires.choices.map((c) => [c.name, c.selected, c.disabled])).toEqual([
      ["atlas", true, false],
      ["gpu", false, true],
    ]);

    const stale = new Store(tracing(), { ...form, requires: ["gone"] });
    expect(deriveView(stale.getState(), 0).requires.choices[0]).toEqual({
      name: "gone",
      holders: "no machine declares it",
      selected: true,
      disabled: false,
    });
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

  test("an account pin with the relay down is held, and checked against the leader when sent", async () => {
    const client = pinning([]);
    client.emit({ status: "retrying", registrySettled: false });
    const store = new Store(client, { ...form, account: "acct-w" });
    store.attach();
    await store.spawn();
    expect(store.getState().held).toHaveLength(1);

    client.emit({ status: "open", registrySettled: true });
    await until(() => store.getState().held[0]?.failure !== null, "the send-time check");
    expect(store.getState().held[0]?.failure).toContain("doesn't take account pins");
    expect(client.creates).toEqual([]);
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
  const form = { ...DEFAULT_FORM, prompt: "fix it" };

  test("deps go into the spec, with no `until` unless it was changed, and then reset", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, {
      ...form,
      after: [{ task: "base", after: "merged" }],
    });
    await store.spawn();

    expect(firstCreate(client).spec).toMatchObject({
      client: "pwa",
      prompt: "fix it",
      deps: [{ task: "base", after: "merged" }],
    });
    expect(firstCreate(client).spec).not.toHaveProperty("until");
    // What belongs to the task just stored is cleared.
    expect(store.getState().form).toMatchObject({ after: [], until: "merged" });
  });

  test("a plain form writes none of the authoring fields", async () => {
    const client = new ScriptedClient();
    await new Store(client, form).spawn();
    for (const field of ["deps", "batch", "until", "linear"])
      expect(firstCreate(client).spec).not.toHaveProperty(field);
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

  test("opening the After sheet reads the queue; other sheets do not", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, form);
    store.openSheet("effort");
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

describe("the fresh worktree choice", () => {
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

  const OPS = "github.com/acme/ops";
  const twoRepos = (): ScriptedClient =>
    new ScriptedClient({
      machines: [
        autoMachine("dev-a", {
          repos: [
            { name: "app", path: "/r/dev-a/app", defaultBranch: "main", origin: ORIGIN },
            { name: "ops", path: "/r/dev-a/ops", defaultBranch: "main", origin: OPS },
          ],
        }),
      ],
    });

  test("is remembered per repo: picking a repo again brings back the last choice made there", async () => {
    const client = twoRepos();
    const store = new Store(client, { ...DEFAULT_FORM, repo: ORIGIN, prompt: "fix it" });
    store.toggleWorktree();
    expect(deriveView(store.getState(), 0).worktree).toBe(false);

    // A repo never toggled starts from the last choice made anywhere.
    store.selectRepo(OPS);
    expect(deriveView(store.getState(), 0).worktree).toBe(false);
    store.toggleWorktree();
    expect(deriveView(store.getState(), 0).worktree).toBe(true);

    store.selectRepo(ORIGIN);
    expect(deriveView(store.getState(), 0).worktree).toBe(false);
    await store.spawn();
    expect(firstCreate(client).spec).toMatchObject({ repo: ORIGIN, mode: "here" });
    // The routing preview asks with the repo's own choice too.
    expect(client.previews.at(-1)).toMatchObject({ repo: ORIGIN, mode: "here" });

    store.selectRepo(OPS);
    expect(deriveView(store.getState(), 0).worktree).toBe(true);
    await store.spawn();
    expect(client.creates[1]?.spec).toMatchObject({ repo: OPS, mode: "worktree" });
  });

  test("with no repo picked, it belongs to the repo the form resolves to", () => {
    const store = new Store(twoRepos(), { ...DEFAULT_FORM, repo: null });
    store.toggleWorktree();
    expect(store.getState().form.worktreeByRepo).toEqual({ [ORIGIN]: false });
    expect(deriveView(store.getState(), 0).worktree).toBe(false);
  });

  test("a repo toggled past the bound evicts the oldest choice, not the newest", () => {
    const remembered = Object.fromEntries(
      Array.from({ length: WORKTREE_REPOS_MAX }, (_, i) => [`github.com/acme/r${i}`, true]),
    );
    const store = new Store(twoRepos(), { ...DEFAULT_FORM, repo: OPS, worktreeByRepo: remembered });
    store.toggleWorktree();
    const kept = Object.keys(store.getState().form.worktreeByRepo);
    expect(kept).toHaveLength(WORKTREE_REPOS_MAX);
    expect(kept).not.toContain("github.com/acme/r0");
    expect(kept.at(-1)).toBe(OPS);
  });
});

describe("attachments", () => {
  /** A fleet whose verified leader advertises attachments. */
  function capable(): ScriptedClient {
    return new ScriptedClient({
      machines: [autoMachine("dev-a", { capabilities: [CAPABILITIES.attachments] }), autoMachine("dev-b")],
    });
  }

  const file = (name: string, text: string, type = "text/plain"): File => new File([text], name, { type });

  test("are offered only while the verified leader advertises them", () => {
    expect(deriveView(new Store(capable()).getState(), 0).attachments.offered).toBe(true);
    expect(deriveView(new Store(new ScriptedClient()).getState(), 0).attachments.offered).toBe(false);
    const unverified = capable();
    unverified.relay = { ...unverified.relay, scheduler: { kind: "unverified", deviceId: "dev-a", term: 1 } };
    expect(deriveView(new Store(unverified).getState(), 0).attachments.offered).toBe(false);
  });

  const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
  const stored = (): AttachmentUploaded => ({ ok: true, id: crypto.randomUUID(), hash: "h".repeat(43) });
  const statuses = (store: Store): string[] =>
    deriveView(store.getState(), 0).attachments.files.map((chip) => chip.status);

  /** Uploads that answer only when the test says, each settled through its index. */
  function heldUploads(
    client: ScriptedClient,
  ): (index: number, reply?: AttachmentUploaded | AttachmentRefusal) => void {
    const answers: ((reply: AttachmentUploaded | AttachmentRefusal) => void)[] = [];
    client.onUpload = (_bytes, opts) =>
      new Promise((resolve) => {
        answers.push(resolve);
        opts.signal?.addEventListener("abort", () => resolve({ ok: false, code: "aborted" }));
      });
    return (index, reply = stored()) => {
      const answer = answers[index];
      if (answer === undefined) throw new Error(`no upload ${index}`);
      answer(reply);
    };
  }

  /** Reading a `File` resolves off the microtask queue, so this polls across turns of the loop. */
  async function settled(ready: () => boolean, what: string): Promise<void> {
    for (let turn = 0; turn < 200; turn += 1) {
      if (ready()) return;
      // oxlint-disable-next-line no-await-in-loop -- a poll
      await Bun.sleep(1);
    }
    throw new Error(`never: ${what}`);
  }

  test("upload one at a time as they are added; Queue waits for them, then creates the task with their manifest", async () => {
    const client = capable();
    const release = heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "look at these" });
    store.addFiles([file("a.txt", "first"), file("b.png", "second", "image/png")]);
    expect(deriveView(store.getState(), 0).attachments.summary).toBe("2 files · 11 B");
    await settled(() => client.uploads.length === 1, "the first upload, before any Queue press");
    client.uploadOpts[0]?.onProgress?.(45, 100);
    expect(statuses(store)).toEqual(["5 B · 45%", "6 B · waiting"]);
    expect(deriveView(store.getState(), 0).attachments.files[0]?.percent).toBe(45);

    const labels: string[] = [];
    store.subscribe(() => labels.push(deriveView(store.getState(), 0).button.label));
    const spawned = store.spawn();
    expect(deriveView(store.getState(), 0).button).toMatchObject({ label: "Uploading 1/2…", busy: true });
    release(0);
    await settled(() => client.uploads.length === 2, "the second upload");
    expect(statuses(store)).toEqual(["TXT · 5 B", "6 B · 0%"]);
    expect(client.creates).toEqual([]);
    release(1);
    await spawned;

    expect(client.uploads.map(decode)).toEqual(["first", "second"]);
    expect(labels).toContain("Uploading 2/2…");
    const created = firstCreate(client);
    expect(created.spec.attachments?.map(({ name, type, size }) => ({ name, type, size }))).toEqual([
      { name: "a.txt", type: "text/plain", size: 5 },
      { name: "b.png", type: "image/png", size: 6 },
    ]);
    expect(store.getState().verdict?.kind).toBe("queued");
    expect(store.getState().attachments).toEqual([]);
    // The preview is told files ride along, as a flag: never the manifest.
    expect(client.previews.at(-1)).toMatchObject({ attachments: true });
  });

  test("a refused upload shows on its chip and blocks the queue with why; the next Queue press retries only it", async () => {
    const client = capable();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    client.onUpload = async (bytes) =>
      decode(bytes) === "second"
        ? { ok: false, code: "allowance_exhausted", window: "month", retryAfter: 7200 }
        : stored();
    store.addFiles([file("a.txt", "first"), file("b.txt", "second"), file("c.txt", "third")]);
    await settled(() => client.uploads.length === 2 && !statuses(store).some((s) => s.includes("%")), "both uploads");
    // The limit would meet every file after it: the third isn't read, sealed or sent.
    expect(statuses(store)).toEqual(["TXT · 5 B", "Failed: limit reached", "5 B · waiting"]);

    await store.spawn();
    expect(client.uploads.map(decode)).toEqual(["first", "second", "second"]);
    expect(client.creates).toEqual([]);
    const verdict = store.getState().verdict;
    expect(verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: false });
    expect(verdict?.kind === "unqueued" ? verdict.message : "").toContain(
      "30-day allowance is spent. Try again in 2 hours",
    );
    expect(store.getState().spawning).toBe(false);

    expect(statuses(store)[1]).toBe("Failed: limit reached");

    client.uploads.length = 0;
    client.onUpload = async () => stored();
    store.dismissLayer();
    await store.spawn();
    expect(client.uploads.map(decode)).toEqual(["second", "third"]);
    expect(firstCreate(client).spec.attachments?.map((ref) => ref.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  test("removing a file mid-upload aborts it and the next starts; remove locks only once the create is out", async () => {
    const client = capable();
    const release = heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    store.addFiles([file("a.txt", "first"), file("b.txt", "second")]);
    await settled(() => client.uploads.length === 1, "the first upload");
    const spawned = store.spawn();
    // Waiting on uploads, a file can still go.
    expect(deriveView(store.getState(), 0).attachments).toMatchObject({ addLocked: true, removeLocked: false });
    store.removeFile(store.getState().attachments[0]?.key ?? "");
    expect(client.uploadOpts[0]?.signal?.aborted).toBe(true);
    await settled(() => client.uploads.length === 2, "the next file's upload");
    expect(store.getState().attachments.map((f) => f.name)).toEqual(["b.txt"]);

    let answerCreate: (reply: TaskCreated) => void = () => {};
    client.onCreate = () =>
      new Promise((resolve) => {
        answerCreate = resolve;
      });
    release(1);
    await settled(() => client.creates.length === 1, "the create");
    expect(deriveView(store.getState(), 0).attachments.removeLocked).toBe(true);
    store.removeFile(store.getState().attachments[0]?.key ?? "");
    expect(store.getState().attachments.map((f) => f.name)).toEqual(["b.txt"]);
    answerCreate({ ok: true, landedEarlier: false });
    await spawned;
    expect(firstCreate(client).spec.attachments?.map((ref) => ref.name)).toEqual(["b.txt"]);
    expect(store.getState().attachments).toEqual([]);
  });

  test("with files the prompt takes the lower bound, refused before the Queue press waits on any upload", async () => {
    const client = capable();
    heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "x".repeat(ATTACHMENT_LIMITS.prompt + 1) });
    store.addFiles([file("a.txt", "first")]);
    // The upload never answers: a wait on it would never return.
    await store.spawn();
    expect(client.creates).toEqual([]);
    const verdict = store.getState().verdict;
    expect(verdict?.kind === "unqueued" ? verdict.message : "").toContain(
      `at most ${ATTACHMENT_LIMITS.prompt} beside attached files`,
    );
  });

  const incapable = { machines: [autoMachine("dev-a"), autoMachine("dev-b")] };

  test("a leader that stops taking files mid-upload cuts the upload and no task is created", async () => {
    const client = capable();
    const release = heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    const detach = store.attach();
    store.addFiles([file("a.txt", "first")]);
    await settled(() => client.uploads.length === 1, "the upload");
    const spawned = store.spawn();
    client.emit(incapable);
    expect(client.uploadOpts[0]?.signal?.aborted).toBe(true);
    // The abort answers `aborted`: the file is back in line, so the press ends on its own branch.
    release(0);
    await spawned;
    expect(client.creates).toEqual([]);
    expect(store.getState().spawning).toBe(false);
    expect(store.getState().verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: false });
    expect(store.getState().attachments).toHaveLength(1);
    detach();
  });

  test("a file that stored just as the leader stopped taking files is not sent: the check after the wait refuses", async () => {
    const client = capable();
    // Ignores the abort, as a PUT that had already landed does.
    const answers: ((reply: AttachmentUploaded) => void)[] = [];
    client.onUpload = () => new Promise((resolve) => answers.push(resolve));
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    const detach = store.attach();
    store.addFiles([file("a.txt", "first")]);
    await settled(() => client.uploads.length === 1, "the upload");
    const spawned = store.spawn();
    client.emit(incapable);
    answers[0]?.(stored());
    await spawned;
    expect(client.creates).toEqual([]);
    const verdict = store.getState().verdict;
    expect(verdict?.kind === "unqueued" ? verdict.message : "").toContain("doesn't take attachments yet");
    expect(store.getState().spawning).toBe(false);
    detach();
  });

  test("a dropped socket does not cut an upload; the press goes on once the socket is back", async () => {
    const client = capable();
    const release = heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    const detach = store.attach();
    store.addFiles([file("a.txt", "first")]);
    await settled(() => client.uploads.length === 1, "the upload");
    const spawned = store.spawn();
    client.emit({ status: "retrying", registrySettled: false });
    expect(client.uploadOpts[0]?.signal?.aborted).toBe(false);
    client.emit({ status: "open", registrySettled: true });
    release(0);
    await spawned;
    expect(client.uploads).toHaveLength(1);
    expect(client.creates).toHaveLength(1);
    detach();
  });

  test("a socket that drops between two files doesn't end the press: the next starts once it is back", async () => {
    const client = capable();
    const release = heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    const detach = store.attach();
    store.addFiles([file("a.txt", "first"), file("b.txt", "second")]);
    await settled(() => client.uploads.length === 1, "the first upload");
    const spawned = store.spawn();
    client.emit({ status: "retrying", registrySettled: false });
    release(0);
    await settled(() => statuses(store)[0] === "TXT · 5 B", "the first stored");
    await drain();
    // No upload starts while the leader can't be checked, and the press waits rather than giving up.
    expect(client.uploads).toHaveLength(1);
    expect(store.getState().spawning).toBe(true);
    expect(deriveView(store.getState(), 0).button).toMatchObject({ label: "Reconnecting…", busy: true });
    client.emit({ status: "open", registrySettled: true });
    await settled(() => client.uploads.length === 2, "the second upload");
    release(1);
    await spawned;
    expect(firstCreate(client).spec.attachments?.map((ref) => ref.name)).toEqual(["a.txt", "b.txt"]);
    detach();
  });

  test("an upload that ends while the socket is down waits for it before the create", async () => {
    const client = capable();
    const release = heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    const detach = store.attach();
    store.addFiles([file("a.txt", "first")]);
    await settled(() => client.uploads.length === 1, "the upload");
    const spawned = store.spawn();
    client.emit({ status: "retrying", registrySettled: false });
    release(0);
    await settled(() => statuses(store)[0] === "TXT · 5 B", "stored");
    await drain();
    expect(client.creates).toEqual([]);
    expect(store.getState().verdict).toBeNull();
    client.emit({ status: "open", registrySettled: true });
    await spawned;
    expect(client.creates).toHaveLength(1);
    detach();
  });

  test("a socket that stays down past the wait ends the press, saying files go only while connected", async () => {
    const client = capable();
    const release = heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    const detach = store.attach();
    store.addFiles([file("a.txt", "first"), file("b.txt", "second")]);
    await settled(() => client.uploads.length === 1, "the first upload");
    const spawned = store.spawn();
    client.emit({ status: "retrying", registrySettled: false });
    // Fake before the first upload ends: the wait's timer is armed when it does.
    jest.useFakeTimers();
    try {
      release(0);
      await drain();
      jest.advanceTimersByTime(VERIFY_WAIT_MS - 1);
      await drain();
      expect(store.getState().spawning).toBe(true);
      jest.advanceTimersByTime(1);
    } finally {
      jest.useRealTimers();
    }
    await spawned;
    expect(client.uploads).toHaveLength(1);
    expect(client.creates).toEqual([]);
    expect(store.getState().spawning).toBe(false);
    const verdict = store.getState().verdict;
    expect(verdict?.kind === "unqueued" ? verdict.message : "").toContain("Files go only while connected");
    detach();
  });

  test("the file that failed as unreachable goes again when the socket reopens, without a Queue press", async () => {
    const client = capable();
    let reachable = false;
    client.onUpload = async () => (reachable ? stored() : { ok: false, code: "unreachable" });
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    const detach = store.attach();
    store.addFiles([file("a.txt", "first"), file("b.txt", "second")]);
    await settled(() => statuses(store)[0] === "Failed: unreachable", "the first fails");
    reachable = true;
    client.emit({ status: "retrying", registrySettled: false });
    client.emit({ status: "open", registrySettled: true });
    await settled(() => statuses(store).every((s) => s.startsWith("TXT")), "both stored");
    expect(client.uploads.map(decode)).toEqual(["first", "first", "second"]);
    detach();
  });

  test("removing the failed file lets the rest go: no chip is left to say why they wait", async () => {
    const client = capable();
    client.onUpload = async (bytes) => (decode(bytes) === "first" ? { ok: false, code: "unauthorized" } : stored());
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    store.addFiles([file("a.txt", "first"), file("b.txt", "second"), file("c.txt", "third")]);
    await settled(() => statuses(store)[0] === "Failed: token refused", "the first is refused");
    await drain();
    expect(client.uploads).toHaveLength(1);
    // Another file goes first: the failed chip still stands, so the halt does too.
    store.removeFile(store.getState().attachments[2]?.key ?? "");
    await drain();
    expect(client.uploads).toHaveLength(1);
    store.removeFile(store.getState().attachments[0]?.key ?? "");
    await settled(() => statuses(store)[0] === "TXT · 6 B", "the rest stored");
    expect(client.uploads.map(decode)).toEqual(["first", "second"]);
  });

  test("an upload cut because the leader stopped taking files starts again once one that takes them leads", async () => {
    const client = capable();
    const release = heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    const detach = store.attach();
    store.addFiles([file("a.txt", "first")]);
    await settled(() => client.uploads.length === 1, "the upload");
    client.emit(incapable);
    await settled(() => statuses(store)[0] === "5 B · waiting", "back in line");
    expect(client.uploads).toHaveLength(1);
    client.emit({
      machines: [autoMachine("dev-a", { capabilities: [CAPABILITIES.attachments] }), autoMachine("dev-b")],
    });
    await settled(() => client.uploads.length === 2, "the file tried again");
    release(1);
    await settled(() => statuses(store)[0] === "TXT · 5 B", "stored");
    detach();
  });

  test("an unreachable halt lifts when the socket reopens; a refused pick doesn't lift an allowance halt", async () => {
    const client = capable();
    client.onUpload = async () => ({ ok: false, code: "unreachable" });
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    const detach = store.attach();
    store.addFiles([file("a.txt", "first"), file("b.txt", "second")]);
    await settled(
      () => client.uploads.length === 1 && statuses(store)[0]?.startsWith("Failed") === true,
      "the first fails",
    );
    await drain();
    expect(client.uploads).toHaveLength(1);
    client.emit({ status: "retrying", registrySettled: false });
    client.emit({ status: "open", registrySettled: true });
    await settled(() => client.uploads.length === 2, "the second after the reopen");

    const spent = capable();
    spent.onUpload = async () => ({ ok: false, code: "allowance_exhausted", window: "hour", retryAfter: 60 });
    const limited = new Store(spent, { ...DEFAULT_FORM, prompt: "go" });
    limited.addFiles([file("a.txt", "first"), file("b.txt", "second")]);
    await settled(() => spent.uploads.length === 1, "the first is refused");
    await drain();
    limited.addFiles([new File([new Uint8Array(ATTACHMENT_LIMITS.fileBytes + 1)], "big.bin")]);
    await drain();
    expect(spent.uploads).toHaveLength(1);
    detach();
  });

  test("an upload refusal verdict names no file; a retry of a task with files meets the leader's capability again", async () => {
    const client = capable();
    client.onUpload = async () => ({ ok: false, code: "unreachable" });
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    store.addFiles([file("secret-name.txt", "first")]);
    await store.spawn();
    const refused = store.getState().verdict;
    expect(refused?.kind === "unqueued" ? refused.message : "").not.toContain("secret-name");

    const again = capable();
    again.onCreate = async () => ({ ok: false, code: "rate_limited" });
    const retrying = new Store(again, { ...DEFAULT_FORM, prompt: "go" });
    const detach = retrying.attach();
    retrying.addFiles([file("a.txt", "first")]);
    await retrying.spawn();
    const verdict = retrying.getState().verdict;
    if (verdict?.kind !== "unqueued") throw new Error("no verdict");
    expect(again.creates).toHaveLength(1);
    again.emit(incapable);
    await retrying.retryEnqueue(verdict);
    expect(again.creates).toHaveLength(1);
    const refusedRetry = retrying.getState().verdict;
    expect(refusedRetry).toMatchObject({ kind: "unqueued", retry: verdict.retry });
    expect(refusedRetry?.kind === "unqueued" ? refusedRetry.message : "").toContain("doesn't take attachments yet");
    // A leader that is only unverified (a re-dial) is not told to update seanced.
    again.emit({ scheduler: { kind: "unverified", deviceId: "dev-a", term: 2 } });
    await retrying.retryEnqueue(verdict);
    expect(again.creates).toHaveLength(1);
    const unverified = retrying.getState().verdict;
    expect(unverified?.kind === "unqueued" ? unverified.message : "").toContain("Couldn't confirm");
    detach();
  });

  test("the lock notice doesn't outlive the press that set it", async () => {
    const client = capable();
    const release = heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    store.addFiles([file("a.txt", "first")]);
    await settled(() => client.uploads.length === 1, "the upload");
    const spawned = store.spawn();
    store.addFiles([file("b.txt", "second")]);
    expect(store.getState().attachNotice).toContain("once Queue is pressed");
    release(0, { ok: false, code: "unauthorized" });
    await spawned;
    expect(store.getState().attachNotice).toBeNull();
  });

  test("the task is built from the form as it stands after the wait, and checked again", async () => {
    const client = capable();
    const release = heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "fix the crash" });
    store.addFiles([file("a.txt", "first")]);
    await settled(() => client.uploads.length === 1, "the upload");
    const spawned = store.spawn();
    store.setPrompt("fix the crash in the login screen");
    release(0);
    await spawned;
    expect(firstCreate(client).spec.prompt).toBe("fix the crash in the login screen");

    // Past the lower bound by then: refused, nothing created, form kept.
    const again = capable();
    const releaseAgain = heldUploads(again);
    const long = new Store(again, { ...DEFAULT_FORM, prompt: "short" });
    long.addFiles([file("a.txt", "first")]);
    await settled(() => again.uploads.length === 1, "the second upload");
    const pressed = long.spawn();
    long.setPrompt("x".repeat(ATTACHMENT_LIMITS.prompt + 1));
    releaseAgain(0);
    await pressed;
    expect(again.creates).toEqual([]);
    expect(long.getState().spawning).toBe(false);
    expect(long.getState().form.prompt).toHaveLength(ATTACHMENT_LIMITS.prompt + 1);
    const verdict = long.getState().verdict;
    expect(verdict?.kind === "unqueued" ? verdict.message : "").toContain("beside attached files");
  });

  test("a second Queue press while waiting is ignored: one task", async () => {
    const client = capable();
    const release = heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    store.addFiles([file("a.txt", "first")]);
    await settled(() => client.uploads.length === 1, "the upload");
    const first = store.spawn();
    await store.spawn();
    await store.startNow();
    release(0);
    await first;
    expect(client.creates).toHaveLength(1);
  });

  test("removing every file during the wait ends the press with no task", async () => {
    const client = capable();
    heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    store.addFiles([file("a.txt", "first")]);
    await settled(() => client.uploads.length === 1, "the upload");
    const spawned = store.spawn();
    store.removeFile(store.getState().attachments[0]?.key ?? "");
    await spawned;
    expect(client.creates).toEqual([]);
    expect(store.getState().spawning).toBe(false);
    expect(store.getState().attachNotice).toBe("No files left. Nothing was queued.");
  });

  test("an aborted upload of a file still on the form goes back in line", async () => {
    const client = capable();
    const release = heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    store.addFiles([file("a.txt", "first")]);
    await settled(() => client.uploads.length === 1, "the upload");
    release(0, { ok: false, code: "aborted" });
    await settled(() => client.uploads.length === 2, "the file tried again");
    release(1);
    await settled(() => statuses(store)[0] === "TXT · 5 B", "stored");
  });

  test("files added once Queue is pressed are refused with a notice", async () => {
    const client = capable();
    const release = heldUploads(client);
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    store.addFiles([file("a.txt", "first")]);
    await settled(() => client.uploads.length === 1, "the upload");
    const spawned = store.spawn();
    store.addFiles([file("b.txt", "second")]);
    expect(store.getState().attachments).toHaveLength(1);
    expect(store.getState().attachNotice).toBe("Files can't be added once Queue is pressed.");
    release(0);
    await spawned;
  });

  test("files on the form block the button once the leader stops taking them, and no task is created", async () => {
    const client = capable();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    const detach = store.attach();
    store.addFiles([file("a.txt", "first")]);
    client.emit({ machines: [autoMachine("dev-a"), autoMachine("dev-b")] });
    const view = deriveView(store.getState(), 0);
    expect(view.button).toMatchObject({ label: "Can't attach files", enabled: false });
    expect(view.formStatus).toContain("doesn't take attachments yet");
    await store.spawn();
    expect(client.creates).toEqual([]);
    // Still listed, so they can be removed; removing them frees the form.
    store.removeFile(store.getState().attachments[0]?.key ?? "");
    expect(deriveView(store.getState(), 0).button.enabled).toBe(true);
    detach();
  });

  test("files picked while a re-dial's leader is unverified wait for it, then upload and go", async () => {
    const client = capable();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    const detach = store.attach();
    const term = client.getState().scheduler;
    client.emit({ scheduler: { kind: "unverified", deviceId: "dev-a", term: 2 } });
    store.addFiles([file("a.txt", "first"), file("b.txt", "second")]);
    const waiting = deriveView(store.getState(), 0);
    expect(waiting.attachments.files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    expect(waiting.button).toMatchObject({ label: "Checking leader…", enabled: false });
    expect(waiting.formStatus).not.toContain("doesn't take attachments yet");
    expect(statuses(store)).toEqual(["5 B · waiting", "6 B · waiting"]);
    await drain();
    expect(client.uploads).toEqual([]);
    client.emit({ scheduler: term });
    expect(deriveView(store.getState(), 0).button.enabled).toBe(true);
    await settled(() => client.uploads.length === 2, "both uploads once the leader verified");
    expect(client.uploads.map(decode)).toEqual(["first", "second"]);
    detach();
  });

  test("a share appends its text to the draft and its files meet the pick's limits, in one notice", () => {
    const store = new Store(capable(), { ...DEFAULT_FORM, prompt: "draft" });
    const big = new File([], "big.mov");
    Object.defineProperty(big, "size", { value: ATTACHMENT_LIMITS.fileBytes + 1 });
    store.receiveShare({
      files: [file("a.txt", "first"), big],
      refused: ["a task takes at most 10 files"],
      problems: ["Not received from the share: c.png."],
      text: "https://x.test",
    });
    const state = store.getState();
    expect(state.form.prompt).toBe("draft\n\nhttps://x.test");
    expect(state.attachments.map((f) => f.name)).toEqual(["a.txt"]);
    expect(state.attachNotice).toBe(
      "Not attached: a task takes at most 10 files; big.mov is 30 MB; a file can be at most 30 MB. Not received from the share: c.png.",
    );
  });

  test("a share with no leader taking attachments keeps its files listed, with the reason shown", () => {
    const client = capable();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "" });
    const detach = store.attach();
    client.emit({ machines: [autoMachine("dev-a"), autoMachine("dev-b")] });
    store.receiveShare({ files: [file("rec.mp4", "video")], refused: [], problems: [], text: "" });
    const view = deriveView(store.getState(), 0);
    expect(view.attachments.files.map((f) => f.name)).toEqual(["rec.mp4"]);
    expect(view.attachments.offered).toBe(false);
    expect(view.button).toMatchObject({ label: "Can't attach files", enabled: false });
    expect(store.getState().form.prompt).toBe("");
    detach();
  });

  // Files go only to a leader verified to take them, and holding never sees one: they'd go unchecked.
  test("are never held: with the socket down they block the queue until removed, and then it holds", async () => {
    const client = capable();
    const store = new Store(client, { ...DEFAULT_FORM, prompt: "go" });
    const detach = store.attach();
    store.addFiles([file("a.txt", "first")]);
    client.emit({ status: "retrying", registrySettled: false });
    const view = deriveView(store.getState(), 0);
    expect(view.button).toMatchObject({ label: "Can't attach files", enabled: false });
    expect(view.formStatus).toBe("Files go only while connected. Remove them to keep the task on this phone");
    await store.spawn();
    expect(store.getState().held).toEqual([]);
    expect(store.getState().form.prompt).toBe("go");

    store.removeFile(store.getState().attachments[0]?.key ?? "");
    await store.spawn();
    expect(store.getState().held.map(({ task }) => task.spec.attachments)).toEqual([undefined]);
    detach();
  });
});
