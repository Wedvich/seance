import { beforeEach, describe, expect, test } from "bun:test";

/**
 * localStorage is an external boundary Bun does not provide, so it is faked here
 * rather than injected into the module under test. Installed before importing
 * persist.ts, which reads the global lazily but would otherwise throw on load.
 */
const store = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  },
});

const { dropLegacyHidden, readForm, readPending, writeForm, writePending } = await import("../src/persist.ts");
const { DEFAULT_FORM } = await import("../src/state.ts");

beforeEach(() => store.clear());

describe("form persistence", () => {
  test("round-trips a form", () => {
    const form = {
      machineId: "dev-1",
      repos: { "dev-1": "seance" },
      prompt: "port the pane",
      worktree: false,
      model: "fable",
      effort: "max",
    } as const;
    writeForm(form);
    expect(readForm()).toEqual(form);
  });

  test("returns the defaults with nothing stored", () => {
    expect(readForm()).toEqual(DEFAULT_FORM);
  });

  test("survives corrupt JSON", () => {
    store.set("seance:form", "{not json");
    expect(readForm()).toEqual(DEFAULT_FORM);
  });

  // A model or effort dropped from the offered list would otherwise come back as
  // an unselectable value the daemon then rejects.
  test("falls back on a model or effort this build no longer offers", () => {
    store.set("seance:form", JSON.stringify({ ...DEFAULT_FORM, model: "haiku", effort: "ludicrous" }));
    const form = readForm();
    expect(form.model).toBe(DEFAULT_FORM.model);
    expect(form.effort).toBe(DEFAULT_FORM.effort);
  });

  test("ignores wrongly typed fields rather than trusting them", () => {
    store.set(
      "seance:form",
      JSON.stringify({ machineId: 7, repos: { "dev-1": 3, "dev-2": "seance" }, prompt: null, worktree: "yes" }),
    );
    expect(readForm()).toEqual({ ...DEFAULT_FORM, machineId: null, repos: { "dev-2": "seance" }, prompt: "" });
  });
});

describe("pending spawn persistence", () => {
  test("round-trips and clears", () => {
    const pending = { machineId: "dev-1", repo: "seance", requestedAt: 1_800_000_000_000 };
    writePending(pending);
    expect(readPending()).toEqual(pending);
    writePending(null);
    expect(readPending()).toBeNull();
  });

  // A half-written entry must not resurrect a reconciliation for a machine that
  // was never asked.
  test("rejects an incomplete entry", () => {
    store.set("seance:pending", JSON.stringify({ machineId: "dev-1" }));
    expect(readPending()).toBeNull();
  });
});

describe("the legacy hidden-machine list", () => {
  test("is cleared, so an upgrade leaves no stale list behind", () => {
    store.set("seance:hidden", JSON.stringify(["dev-1", "dev-2"]));
    dropLegacyHidden();
    expect(store.get("seance:hidden")).toBeUndefined();
  });

  test("is safe to clear when nothing was stored", () => {
    dropLegacyHidden();
    expect(store.get("seance:hidden")).toBeUndefined();
  });
});
