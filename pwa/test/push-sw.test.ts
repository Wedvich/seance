import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const SOURCE = readFileSync(new URL("../public/push-sw.js", import.meta.url), "utf8");

type Handler = (event: unknown) => void;

interface Shown {
  readonly title: string;
  readonly options: { readonly body: string; readonly tag: string };
}

/** The worker's global as the file sees it: only what push-sw.js touches, recording what it does. */
function boot(windows: readonly { url: string; focus: () => Promise<void> }[] = []): {
  push: (data: string | null) => Promise<void>;
  click: () => Promise<{ closed: boolean }>;
  shown: Shown[];
  opened: string[];
} {
  const handlers = new Map<string, Handler>();
  const shown: Shown[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: "https://seance.test" },
    addEventListener: (type: string, handler: Handler): void => void handlers.set(type, handler),
    registration: {
      showNotification: (title: string, options: Shown["options"]): Promise<void> => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      matchAll: () => Promise.resolve(windows),
      openWindow: (url: string): Promise<null> => {
        opened.push(url);
        return Promise.resolve(null);
      },
    },
  };
  runInNewContext(SOURCE, { self, URL, Object });

  /** Runs a handler and waits for whatever it handed `waitUntil`. */
  const dispatch = async (type: string, event: Record<string, unknown>): Promise<void> => {
    const pending: Promise<unknown>[] = [];
    handlers.get(type)?.({ ...event, waitUntil: (work: Promise<unknown>) => void pending.push(work) });
    await Promise.all(pending);
  };
  return {
    push: (data) =>
      dispatch("push", {
        data: data === null ? null : { json: (): unknown => JSON.parse(data) },
      }),
    click: async () => {
      const notification = { closed: false, close: (): void => void (notification.closed = true) };
      await dispatch("notificationclick", { notification });
      return { closed: notification.closed };
    },
    shown,
    opened,
  };
}

describe("push-sw.js", () => {
  test("an alert shows a generic notification tagged by its kind and id, with no name in it", async () => {
    const worker = boot();
    await worker.push(JSON.stringify({ v: 1, kind: "needs-input", at: 1, taskId: "t-1", since: 1, escalated: true }));
    expect(worker.shown).toEqual([
      { title: "Séance", options: { body: "A task is waiting for input.", tag: "needs-input:t-1" } },
    ]);
  });

  test("a payload it cannot read still shows a notification, so the browser never shows its own", async () => {
    const worker = boot();
    await worker.push("not json");
    await worker.push(null);
    await worker.push(JSON.stringify({ kind: "something-newer", taskId: "x" }));
    await worker.push(JSON.stringify(null));
    // A known kind under a version this worker does not speak is as unreadable as an unknown kind.
    await worker.push(JSON.stringify({ v: 2, kind: "needs-input", taskId: "t-1" }));
    await worker.push(JSON.stringify({ kind: "needs-input", taskId: "t-1" }));
    expect(worker.shown).toHaveLength(6);
    for (const { options } of worker.shown)
      expect(options).toEqual({ body: "Something needs your attention.", tag: "seance" });
  });

  test("a click closes the notification and opens the app when no window is open", async () => {
    const worker = boot();
    expect(await worker.click()).toEqual({ closed: true });
    expect(worker.opened).toEqual(["/"]);
  });

  test("a click focuses an open window of this origin instead of opening another, and ignores other origins", async () => {
    const focused: string[] = [];
    const window = (url: string) => ({
      url,
      focus: (): Promise<void> => {
        focused.push(url);
        return Promise.resolve();
      },
    });
    const worker = boot([window("https://elsewhere.test/"), window("https://seance.test/queue")]);
    await worker.click();
    expect(focused).toEqual(["https://seance.test/queue"]);
    expect(worker.opened).toEqual([]);
  });
});
