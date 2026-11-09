import { importPsk, RelayClient, toBase64 } from "@seance/shared";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { openDeepLink, openLaunchLink, openMessage, parseDeepLink, parseOpenMessage } from "../src/deep-link.ts";
import { Store } from "../src/store.ts";
import { fakeHistory, installBrowserGlobals } from "./stubs.ts";

installBrowserGlobals();

let key: CryptoKey;

beforeAll(async () => {
  key = await importPsk(toBase64(new Uint8Array(32).fill(3)));
});

/** Never started, so nothing dials: the link's effect on the store is the subject. */
const storeOver = (): Store => new Store(new RelayClient({ url: "ws://127.0.0.1:1/app", token: "unused", key }));

const TASK = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";

describe("parseDeepLink", () => {
  test("reads the two queries the service worker builds", () => {
    expect(parseDeepLink(`?task=${TASK}`)).toEqual({ to: "task", taskId: TASK });
    expect(parseDeepLink("?screen=machines")).toEqual({ to: "machines" });
  });

  test("anything else is no link: a bad id, another screen, no query", () => {
    for (const search of ["", "?task=", "?task=a/b", "?task=a%20b", `?task=${"x".repeat(65)}`, "?screen=queue", "?x=1"])
      expect(parseDeepLink(search)).toBeNull();
  });

  test("a task wins over a screen when both are named, and a bad task does not fall through to it", () => {
    expect(parseDeepLink(`?task=${TASK}&screen=machines`)).toEqual({ to: "task", taskId: TASK });
    expect(parseDeepLink("?task=a/b&screen=machines")).toBeNull();
  });
});

describe("parseOpenMessage", () => {
  test("takes only the worker's open message for an app path", () => {
    expect(parseOpenMessage({ t: "open", url: `/?task=${TASK}` })).toEqual({ to: "task", taskId: TASK });
    expect(parseOpenMessage({ t: "open", url: "/?screen=machines" })).toEqual({ to: "machines" });
    for (const data of [
      null,
      "open",
      { t: "close", url: "/?screen=machines" },
      { t: "open" },
      { t: "open", url: 7 },
      { t: "open", url: "https://evil.test/?screen=machines" },
      { t: "open", url: "/other?screen=machines" },
      { t: "open", url: "/?task=a/b" },
    ])
      expect(parseOpenMessage(data)).toBeNull();
  });
});

describe("opening a link", () => {
  let history: ReturnType<typeof fakeHistory> | null = null;

  afterEach(() => {
    history?.restore();
    history = null;
  });

  test("a task link opens the Queue with that task focused, until the screen has used it", () => {
    history = fakeHistory([null]);
    const store = storeOver();
    openDeepLink(store, { to: "task", taskId: TASK });
    expect(store.getState()).toMatchObject({ queue: true, focusedTask: TASK });
    store.clearFocus();
    expect(store.getState().focusedTask).toBeNull();
  });

  test("a machines link opens the Machines screen and focuses nothing", () => {
    history = fakeHistory([null]);
    const store = storeOver();
    openDeepLink(store, { to: "machines" });
    expect(store.getState()).toMatchObject({ machines: true, focusedTask: null });
  });

  test("a launch query opens its link; an invalid id opens nothing", () => {
    history = fakeHistory([null]);
    const store = storeOver();
    openLaunchLink(store, "?task=../x");
    openLaunchLink(store, "?task=a%2Fb");
    expect(store.getState()).toMatchObject({ queue: false, machines: false, focusedTask: null });
    openLaunchLink(store, `?task=${TASK}`);
    expect(store.getState()).toMatchObject({ queue: true, focusedTask: TASK });
  });

  test("a message from the worker opens its link; a forged one does nothing", () => {
    history = fakeHistory([null]);
    const store = storeOver();
    openMessage(store, { t: "open", url: "https://evil.test/?screen=machines" });
    openMessage(store, "open");
    expect(store.getState().machines).toBe(false);
    openMessage(store, { t: "open", url: "/?screen=machines" });
    expect(store.getState().machines).toBe(true);
  });
});
