import { importPsk, toBase64 } from "@seance/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { RelayClient } from "@seance/shared";
import { DEFAULT_FORM } from "../src/state.ts";
import { Store, UNDO_WINDOW_MS } from "../src/store.ts";
import { installBrowserGlobals } from "./stubs.ts";

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

/**
 * A session history with real entries, for the layer tests: traversals queue
 * like the browser's (async, popstate after the move) and are delivered by
 * `settle`, which is where the store's own follow-up traversals get applied too.
 */
function fakeHistory(entries: unknown[] = [null]): {
  settle: (store: Store) => void;
  entries: () => readonly unknown[];
  index: () => number;
  restore: () => void;
} {
  const stack = [...entries];
  let index = stack.length - 1;
  const queued: number[] = [];
  Object.defineProperty(globalThis, "history", {
    value: {
      get state(): unknown {
        return stack[index];
      },
      pushState(data: unknown): void {
        stack.splice(index + 1, Infinity, data);
        index += 1;
      },
      replaceState(data: unknown): void {
        stack[index] = data;
      },
      back(): void {
        queued.push(-1);
      },
      go(delta: number): void {
        queued.push(delta);
      },
    },
    configurable: true,
  });
  return {
    settle: (store) => {
      for (let delta = queued.shift(); delta !== undefined; delta = queued.shift()) {
        const target = index + delta;
        // Past the first entry is the OS's back: the app is gone, nothing pops.
        if (target < 0) throw new Error("traversed out of the app");
        index = target;
        store.onPopState();
      }
    },
    entries: () => stack,
    index: () => index,
    restore: installBrowserGlobals,
  };
}

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
