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
  type QueueReply,
  type RelayState,
  type RoutePreviewReply,
  type SubmitReply,
  type Task,
  type TaskRequest,
} from "@seance/shared";
import { DEFAULT_FORM } from "../src/state.ts";
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
 * `route-preview`, `submit` and `queue` answered by scripts. The relay is a
 * network boundary; the real client meets the real relay in client.test.ts.
 */
class ScriptedClient extends RelayClient {
  relay: RelayState;
  readonly listeners = new Set<() => void>();
  readonly previews: TaskRequest[] = [];
  onPreview: () => Promise<RoutePreviewReply | null> = async () => ({ decision: DECISION });
  onSubmit: () => Promise<SubmitReply | null> = async () => ({ task: QUEUED });
  onQueue: () => Promise<QueueReply | null> = async () => ({ tasks: [QUEUED], at: 1 });

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

  override submit(): Promise<SubmitReply | null> {
    return this.onSubmit();
  }

  override queue(): Promise<QueueReply | null> {
    return this.onQueue();
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

  test("a re-ask keeps the last decision on screen until its answer lands", async () => {
    const client = new ScriptedClient();
    client.onPreview = async () => ({ decision: DECISION });
    const store = new Store(client);
    store.selectAuto();
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

  test("a submit that times out keeps the prompt and says it may have queued", async () => {
    const client = new ScriptedClient();
    client.onSubmit = async () => {
      throw new RequestFailure("timeout", "submit timed out after 10000ms");
    };
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
    await store.spawn();
    expect(store.getState().verdict).toMatchObject({ kind: "unqueued", mayHaveLanded: true });
    expect(store.getState().form.prompt).toBe("fix it");
  });

  test("a submit that never left is not queued; one dropped after the send may be", async () => {
    for (const [reason, mayHaveLanded] of [
      ["disconnected", false],
      ["dropped", true],
    ] as const) {
      const client = new ScriptedClient();
      client.onSubmit = async () => {
        throw new RequestFailure(reason, "the relay socket closed");
      };
      const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
      // oxlint-disable-next-line no-await-in-loop -- one store each
      await store.spawn();
      expect(store.getState().verdict).toMatchObject({ kind: "unqueued", mayHaveLanded });
    }
  });

  test("following stops once the task is running", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
    await store.spawn();
    expect(store.getState().verdict).toMatchObject({ kind: "queued", task: { state: "ready" } });
    expect(store.getState().form.prompt).toBe("");

    const running: Task = { ...QUEUED, state: "running" };
    client.onQueue = async () => ({ tasks: [running], at: 2 });
    timers.fire(QUEUE_POLL_MS);
    await until(() => {
      const verdict = store.getState().verdict;
      return verdict?.kind === "queued" && verdict.task.state === "running";
    }, "the running task shown");
    await drain();
    expect(store.getState().verdict).toEqual({ kind: "queued", task: running });
    expect(timers.armed(QUEUE_POLL_MS)).toBe(0);
  });

  test("following stops and says so when the leader answers without the task, or refuses", async () => {
    for (const [reply, follow] of [
      [{ tasks: [], at: 2 }, { kind: "gone" }],
      [{ ok: false, code: "invalid_request", message: "?" }, { kind: "refused" }],
    ] as const) {
      const client = new ScriptedClient();
      const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
      // oxlint-disable-next-line no-await-in-loop -- one store each
      await store.spawn();
      client.onQueue = async () => reply;
      timers.fire(QUEUE_POLL_MS);
      // oxlint-disable-next-line no-await-in-loop -- as above
      await until(() => followEnd(store) !== undefined, "following to stop");
      expect(store.getState().verdict).toMatchObject({ kind: "queued", follow });
      expect(timers.armed(QUEUE_POLL_MS)).toBe(0);
    }
  });

  test("missed polls keep what was shown and ask again; out of polls, it says what it last knew may be stale", async () => {
    const client = new ScriptedClient();
    const store = new Store(client, { ...DEFAULT_FORM, auto: true, prompt: "fix it" });
    await store.spawn();
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
    expect(store.getState().verdict).toEqual({ kind: "queued", task: QUEUED, follow: { kind: "unanswered" } });
  });
});
