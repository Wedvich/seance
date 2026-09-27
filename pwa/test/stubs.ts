/**
 * The runtime half of globals.d.ts (which says why it isn't named after it):
 * the browser globals pwa/src/store.ts touches (visibilitychange in attach(),
 * history for layer symmetry), stubbed rather than injected because they are an
 * external boundary Bun does not provide. No-ops suffice for tests that read
 * verdicts from getState(); the ones about back and layers use fakeHistory.
 *
 * One module rather than a copy per test file: a shard loads its files in no
 * particular order and a narrowed run loads only one, so every file that builds
 * a Store has to install these itself, and two hand-kept copies would silently
 * let the first-loaded one win with a shape the other never wrote.
 */
export function installBrowserGlobals(): void {
  Object.defineProperty(globalThis, "document", {
    value: { visibilityState: "visible", addEventListener(): void {}, removeEventListener(): void {} },
    configurable: true,
  });
  Object.defineProperty(globalThis, "history", {
    value: { state: null, pushState(): void {}, replaceState(): void {}, back(): void {}, go(): void {} },
    configurable: true,
  });
}

/**
 * A session history with real entries, for the layer tests: traversals queue
 * like the browser's (async, popstate after the move) and are delivered by
 * `settle`, which is where the store's own follow-up traversals get applied too.
 */
export function fakeHistory(entries: unknown[] = [null]): {
  settle: (store: { onPopState(): void }) => void;
  forward: () => void;
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
        if (target >= stack.length) continue;
        index = target;
        store.onPopState();
      }
    },
    forward: () => queued.push(1),
    entries: () => stack,
    index: () => index,
    restore: installBrowserGlobals,
  };
}
