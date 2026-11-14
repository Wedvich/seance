import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { isTaskId, type PushAlert } from "@seance/shared";

const SOURCE = readFileSync(new URL("../public/push-sw.js", import.meta.url), "utf8");

type Handler = (event: unknown) => void;

interface Shown {
  readonly title: string;
  readonly options: {
    readonly body: string;
    readonly tag: string;
    readonly renotify: boolean;
    readonly data?: { readonly url: string };
  };
}

interface Window {
  readonly url: string;
  readonly focus: () => Promise<void>;
  readonly postMessage?: (message: unknown) => void;
}

/** The worker's global as the file sees it: only what push-sw.js touches, recording what it does. */
function boot(windows: readonly Window[] = []): {
  push: (data: string | null) => Promise<void>;
  click: (data?: unknown) => Promise<{ closed: boolean }>;
  shown: Shown[];
  opened: string[];
  globals: () => string[];
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
  const context = { self, URL };
  runInNewContext(SOURCE, context);

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
    click: async (data) => {
      const notification = { closed: false, data, close: (): void => void (notification.closed = true) };
      await dispatch("notificationclick", { notification });
      return { closed: notification.closed };
    },
    shown,
    opened,
    globals: () => Object.keys(context),
  };
}

const TASK = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";

describe("push-sw.js", () => {
  test("each alert kind the daemon sends shows its fixed text, a tag that collapses repeats, and the path a click opens", async () => {
    const alerts: readonly PushAlert[] = [
      { v: 1, kind: "needs-input", at: 5, taskId: TASK, since: 1, escalated: false },
      { v: 1, kind: "needs-input", at: 5, taskId: TASK, since: 1, escalated: true },
      { v: 1, kind: "needs-input", at: 5, taskId: TASK, since: 1, escalated: false, question: true },
      { v: 1, kind: "spill", at: 5, taskId: TASK, window: "7d", projectedPct: 94.6 },
      { v: 1, kind: "spill", at: 5, taskId: TASK, window: "5h", projectedPct: 104.6, spending: true },
      { v: 1, kind: "disk", at: 5, deviceId: "dev-1", diskPct: 93 },
      { v: 1, kind: "auth", at: 5, deviceId: "dev-1", exclave: "work", state: "expired" },
      { v: 1, kind: "auth", at: 5, deviceId: "dev-1", exclave: "work", state: "expiring" },
      { v: 1, kind: "archivist", at: 5, since: 1 },
      { v: 1, kind: "custodian-failing", at: 5, deviceId: "dev-1" },
      { v: 1, kind: "flag", at: 5, taskId: TASK, reason: "stuck" },
    ];
    const worker = boot();
    for (const alert of alerts) await worker.push(JSON.stringify(alert));
    expect(worker.shown).toEqual([
      {
        title: "Séance",
        options: {
          body: "A task is waiting for input.",
          tag: `needs-input:${TASK}`,
          renotify: true,
          data: { url: `/?task=${TASK}` },
        },
      },
      {
        title: "Séance",
        options: {
          body: "A task is still waiting for input (30 min).",
          tag: `needs-input:${TASK}`,
          renotify: true,
          data: { url: `/?task=${TASK}` },
        },
      },
      {
        title: "Séance",
        options: {
          body: "A task is asking you a question.",
          tag: `needs-input:${TASK}`,
          renotify: true,
          data: { url: `/?task=${TASK}` },
        },
      },
      {
        title: "Séance",
        options: {
          body: "A task may spill into credits (7d projected at 95%).",
          tag: `spill:${TASK}`,
          renotify: true,
          data: { url: `/?task=${TASK}` },
        },
      },
      {
        title: "Séance",
        options: {
          body: "A task is spending credits (5h full).",
          tag: `spill:${TASK}`,
          renotify: true,
          data: { url: `/?task=${TASK}` },
        },
      },
      {
        title: "Séance",
        options: {
          body: "A machine's disk is nearly full.",
          tag: "disk:dev-1",
          renotify: true,
          data: { url: "/?screen=machines" },
        },
      },
      {
        title: "Séance",
        options: {
          body: "A Claude login needs /login.",
          tag: "auth:dev-1:work",
          renotify: true,
          data: { url: "/?screen=machines" },
        },
      },
      {
        title: "Séance",
        options: {
          body: "A Claude login expires within 3 days.",
          tag: "auth:dev-1:work",
          renotify: true,
          data: { url: "/?screen=machines" },
        },
      },
      {
        title: "Séance",
        options: {
          body: "The archivist has been offline for 24 hours.",
          tag: "archivist",
          renotify: true,
          data: { url: "/?screen=machines" },
        },
      },
      {
        title: "Séance",
        options: {
          body: "A machine's custodian has failed three rounds in a row.",
          tag: "custodian:dev-1",
          renotify: true,
          data: { url: "/?screen=machines" },
        },
      },
      {
        title: "Séance",
        options: {
          body: "A task's session looks stuck. The custodian flagged it.",
          tag: `flag:${TASK}`,
          renotify: true,
          data: { url: `/?task=${TASK}` },
        },
      },
    ]);
  });

  test("an archivist alert shows its one fixed text whatever else its payload carries", async () => {
    const worker = boot();
    await worker.push(
      JSON.stringify({ v: 1, kind: "archivist", at: 1, since: "<b>x</b>", deviceId: "../x", name: "secret" }),
    );
    expect(worker.shown).toEqual([
      {
        title: "Séance",
        options: {
          body: "The archivist has been offline for 24 hours.",
          tag: "archivist",
          renotify: true,
          data: { url: "/?screen=machines" },
        },
      },
    ]);
  });

  test("a pr-blocked alert shows fixed text per reason, and an unknown reason falls back to the general line", async () => {
    const worker = boot();
    const body = (reason: unknown): string =>
      JSON.stringify({ v: 1, kind: "pr-blocked", at: 1, taskId: TASK, reason, head: "never shown" });
    for (const reason of ["checks", "conflict", "behind", "unarmed", "<b>x</b>", "__proto__", "constructor", 7]) {
      await worker.push(body(reason));
    }
    expect(worker.shown.map((note) => note.options.body)).toEqual([
      "A task's pull request has a failing required check.",
      "A task's pull request has merge conflicts.",
      "A task's pull request is behind its base branch.",
      "A task's pull request is ready, but nothing will merge it.",
      "A task's pull request is blocked.",
      "A task's pull request is blocked.",
      "A task's pull request is blocked.",
      "A task's pull request is blocked.",
    ]);
    for (const note of worker.shown) {
      expect(note.options).toMatchObject({
        tag: `pr-blocked:${TASK}`,
        renotify: true,
        data: { url: `/?task=${TASK}` },
      });
    }
  });

  test("a quota-exhausted alert shows fixed text, the window only as 5h or 7d, and one of two texts by reason", async () => {
    const worker = boot();
    const quota = (fields: Record<string, unknown>): string =>
      JSON.stringify({ v: 1, kind: "quota-exhausted", at: 1, taskId: TASK, window: "5h", ...fields });
    await worker.push(quota({}));
    await worker.push(quota({ window: "7d" }));
    await worker.push(quota({ window: "7d sonnet" }));
    await worker.push(quota({ window: "<b>x</b>" }));
    await worker.push(quota({ window: 7 }));
    await worker.push(quota({ reason: "dirty" }));
    await worker.push(quota({ reason: "branch" }));
    await worker.push(quota({ reason: "<b>x</b>" }));
    await worker.push(quota({ reason: "__proto__" }));
    await worker.push(quota({ reason: "constructor" }));
    expect(worker.shown.map((note) => note.options.body)).toEqual([
      "A task's usage window is full (5h). Tap to pass it on.",
      "A task's usage window is full (7d). Tap to pass it on.",
      "A task's usage window is full (7d). Tap to pass it on.",
      "A task's usage window is full. Tap to pass it on.",
      "A task's usage window is full. Tap to pass it on.",
      "A task ran out of usage, but its worktree has uncommitted changes. Tap to pass it on by hand.",
      "A task ran out of usage, but its branch does not match its PR. Tap to pass it on by hand.",
      "A task's usage window is full (5h). Tap to pass it on.",
      "A task's usage window is full (5h). Tap to pass it on.",
      "A task's usage window is full (5h). Tap to pass it on.",
    ]);
    for (const note of worker.shown) {
      expect(note.options).toMatchObject({
        tag: `quota-exhausted:${TASK}`,
        renotify: true,
        data: { url: `/?task=${TASK}` },
      });
    }
    await worker.push(quota({ taskId: "../x" }));
    expect(worker.shown.at(-1)?.options).toEqual({
      body: "Something needs your attention.",
      tag: "seance",
      renotify: true,
    });
  });

  test("a flag alert shows its reason's fixed text, whatever else its payload carries, and an unknown reason a generic one", async () => {
    const worker = boot();
    const texts: Record<string, string> = {
      stuck: "A task's session looks stuck. The custodian flagged it.",
      look: "The custodian flagged a task for you to look at.",
      dirty: "A closed task's worktree holds uncommitted changes.",
      unpushed: "A closed task's worktree holds unpushed commits.",
    };
    for (const [reason, body] of Object.entries(texts)) {
      await worker.push(
        JSON.stringify({ v: 1, kind: "flag", at: 1, taskId: TASK, reason, note: "<b>never shown</b>" }),
      );
      expect(worker.shown.at(-1)?.options).toEqual({
        body,
        tag: `flag:${TASK}`,
        renotify: true,
        data: { url: `/?task=${TASK}` },
      });
    }
    for (const reason of ["<b>x</b>", "__proto__", "constructor", 7, undefined]) {
      await worker.push(JSON.stringify({ v: 1, kind: "flag", at: 1, taskId: TASK, reason }));
      expect(worker.shown.at(-1)?.options).toEqual({
        body: "The custodian flagged a task.",
        tag: `flag:${TASK}`,
        renotify: true,
        data: { url: `/?task=${TASK}` },
      });
    }
    await worker.push(JSON.stringify({ v: 1, kind: "flag", at: 1, taskId: "../x", reason: "stuck" }));
    expect(worker.shown.at(-1)?.options).toEqual({
      body: "Something needs your attention.",
      tag: "seance",
      renotify: true,
    });
  });

  test("a failing custodian shows one fixed text and opens the Machines screen, and a bad device id only the fallback", async () => {
    const worker = boot();
    await worker.push(JSON.stringify({ v: 1, kind: "custodian-failing", at: 1, deviceId: "dev-1", name: "secret" }));
    expect(worker.shown.at(-1)?.options).toEqual({
      body: "A machine's custodian has failed three rounds in a row.",
      tag: "custodian:dev-1",
      renotify: true,
      data: { url: "/?screen=machines" },
    });
    await worker.push(JSON.stringify({ v: 1, kind: "custodian-failing", at: 1, deviceId: "a/b" }));
    expect(worker.shown.at(-1)?.options).toEqual({
      body: "Something needs your attention.",
      tag: "seance",
      renotify: true,
    });
  });

  test("a pass-refused alert shows one fixed text and opens its task", async () => {
    const worker = boot();
    await worker.push(JSON.stringify({ v: 1, kind: "pass-refused", at: 1, taskId: TASK, code: "never shown" }));
    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0]?.options).toEqual({
      body: "A task's session could not pass its work on. Tap to see it.",
      tag: `pass-refused:${TASK}`,
      renotify: true,
      data: { url: `/?task=${TASK}` },
    });
  });

  test("a login alert with an id isTaskId refuses, or a state it does not know, shows only the fallback and nothing the payload says", async () => {
    const worker = boot();
    const auth = (fields: Record<string, unknown>): string =>
      JSON.stringify({ v: 1, kind: "auth", at: 1, deviceId: "dev-1", exclave: "work", state: "expired", ...fields });
    await worker.push(auth({ deviceId: "a/b" }));
    await worker.push(auth({ exclave: "../x" }));
    await worker.push(auth({ exclave: 7 }));
    await worker.push(auth({ state: "<b>soon</b>" }));
    await worker.push(auth({ state: undefined }));
    await worker.push(auth({ title: "secret" }));
    expect(worker.shown).toHaveLength(6);
    for (const { options } of worker.shown.slice(0, 5)) {
      expect(options).toEqual({ body: "Something needs your attention.", tag: "seance", renotify: true });
    }
    expect(worker.shown[5]?.options.body).toBe("A Claude login needs /login.");
    expect(JSON.stringify(worker.shown)).not.toContain("secret");
  });

  test("nothing a payload carries beyond its ids and numbers reaches the text, and only a known window label is shown", async () => {
    const worker = boot();
    const spill = (window: unknown, spending?: true): string =>
      JSON.stringify({
        v: 1,
        kind: "spill",
        at: 1,
        taskId: TASK,
        window,
        projectedPct: 104,
        spending,
        title: "secret",
      });
    // The scheduler's labels: both windows, and a per-model weekly named by a daemon-reported display name.
    const windows = ["5h", "7d", "7d Fable", "x".repeat(500), "7days", "5h <b>x</b>", "", 7, null];
    for (const window of windows) await worker.push(spill(window));
    for (const window of windows) await worker.push(spill(window, true));
    expect(worker.shown.map((n) => n.options.body)).toEqual([
      "A task may spill into credits (5h projected at 104%).",
      "A task may spill into credits (7d projected at 104%).",
      "A task may spill into credits (7d projected at 104%).",
      ...Array.from({ length: 6 }, () => "A task may spill into credits (projected at 104%)."),
      "A task is spending credits (5h full).",
      "A task is spending credits (7d full).",
      "A task is spending credits (7d full).",
      ...Array.from({ length: 6 }, () => "A task is spending credits."),
    ]);
    await worker.push(JSON.stringify({ v: 1, kind: "spill", at: 1, taskId: TASK, window: "5h", projectedPct: "high" }));
    expect(worker.shown.at(-1)?.options.body).toBe("A task may spill into credits (5h).");
    // Only `true` says spending: anything else reads as the forecast, the weaker claim.
    await worker.push(
      JSON.stringify({ v: 1, kind: "spill", at: 1, taskId: TASK, window: "5h", projectedPct: 93, spending: "yes" }),
    );
    expect(worker.shown.at(-1)?.options.body).toBe("A task may spill into credits (5h projected at 93%).");
    expect(JSON.stringify(worker.shown)).not.toContain("secret");
  });

  test("every notification renotifies: a repeat under its tag (the escalation, a second disk alert) is heard, not swapped in silently", async () => {
    const worker = boot();
    await worker.push(JSON.stringify({ v: 1, kind: "needs-input", at: 1, taskId: TASK, since: 1, escalated: false }));
    await worker.push(JSON.stringify({ v: 1, kind: "needs-input", at: 2, taskId: TASK, since: 1, escalated: true }));
    await worker.push(JSON.stringify({ v: 1, kind: "disk", at: 3, deviceId: "dev-1", diskPct: 93 }));
    await worker.push(JSON.stringify({ v: 1, kind: "disk", at: 4, deviceId: "dev-1", diskPct: 95 }));
    await worker.push("not json");
    expect(worker.shown.map((n) => n.options.tag)).toEqual([
      `needs-input:${TASK}`,
      `needs-input:${TASK}`,
      "disk:dev-1",
      "disk:dev-1",
      "seance",
    ]);
    expect(worker.shown.map((n) => n.options.renotify)).toEqual([true, true, true, true, true]);
  });

  test("a payload it cannot read still shows a notification with no target, so the browser never shows its own", async () => {
    const worker = boot();
    await worker.push("not json");
    await worker.push(null);
    await worker.push(JSON.stringify({ kind: "something-newer", taskId: "x" }));
    await worker.push(JSON.stringify({ v: 2, kind: "needs-input", taskId: TASK }));
    await worker.push(JSON.stringify(null));
    // A known kind with no version is as unreadable as one under a version this worker does not speak.
    await worker.push(JSON.stringify({ kind: "needs-input", taskId: TASK }));
    expect(worker.shown).toHaveLength(6);
    for (const { options } of worker.shown)
      expect(options).toEqual({ body: "Something needs your attention.", tag: "seance", renotify: true });
  });

  test("an id isTaskId would refuse never becomes a task path; the worker's copy of the rule agrees with it", async () => {
    const ids = [
      TASK,
      "a.b_c-d",
      "..",
      "x".repeat(64),
      "x".repeat(65),
      "",
      "a/b",
      "../x",
      "a b",
      "a:b",
      "a?b=c",
      "a&screen=machines",
      "ø",
      "a\n",
      "%2e%2e",
      7,
      null,
    ];
    const worker = boot();
    for (const taskId of ids)
      await worker.push(JSON.stringify({ v: 1, kind: "needs-input", at: 1, taskId, since: 1, escalated: false }));
    ids.forEach((taskId, i) => {
      const { options } = worker.shown[i] ?? { options: undefined };
      if (isTaskId(taskId)) expect(options?.data?.url).toBe(`/?task=${encodeURIComponent(taskId)}`);
      else expect(options).toEqual({ body: "Something needs your attention.", tag: "seance", renotify: true });
    });
  });

  test("the worker adds nothing to the global scope it shares with the generated worker", () => {
    expect(boot().globals()).toEqual(["self", "URL"]);
  });

  test("a click closes the notification and opens the app when no window is open: at its target, else the root", async () => {
    const worker = boot();
    expect(await worker.click()).toEqual({ closed: true });
    expect(await worker.click({ url: `/?task=${TASK}` })).toEqual({ closed: true });
    expect(await worker.click({ url: "/?screen=machines" })).toEqual({ closed: true });
    expect(worker.opened).toEqual(["/", `/?task=${TASK}`, "/?screen=machines"]);
  });

  test("a click never opens a path the worker did not build: an absolute URL or another path is the root", async () => {
    const worker = boot();
    for (const url of [
      "https://evil.test/",
      "//evil.test",
      "/other",
      "/?task=a/b",
      "/?task=a&x=1",
      "/?screen=queue",
      7,
    ]) {
      await worker.click({ url });
    }
    expect(worker.opened).toEqual(Array.from({ length: 7 }, () => "/"));
  });

  test("a click focuses an open window of this origin, tells it where to go, and ignores other origins", async () => {
    const calls: string[] = [];
    const window = (url: string): Window => ({
      url,
      focus: (): Promise<void> => {
        calls.push(`focus ${url}`);
        return Promise.resolve();
      },
      postMessage: (message): void => void calls.push(`post ${url} ${JSON.stringify(message)}`),
    });
    const worker = boot([window("https://elsewhere.test/"), window("https://seance.test/queue")]);
    await worker.click({ url: `/?task=${TASK}` });
    expect(calls).toEqual([
      "focus https://seance.test/queue",
      `post https://seance.test/queue ${JSON.stringify({ t: "open", url: `/?task=${TASK}` })}`,
    ]);
    expect(worker.opened).toEqual([]);
  });

  test("a click with no target focuses an open window and sends it nothing", async () => {
    const calls: string[] = [];
    const worker = boot([
      {
        url: "https://seance.test/",
        focus: (): Promise<void> => {
          calls.push("focus");
          return Promise.resolve();
        },
        postMessage: (): void => void calls.push("post"),
      },
    ]);
    await worker.click();
    expect(calls).toEqual(["focus"]);
  });
});
