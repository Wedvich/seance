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

const { dropLegacyHidden, dropLegacyPending, readForm, writeForm } = await import("../src/persist.ts");
const { DEFAULT_FORM } = await import("../src/state.ts");

beforeEach(() => store.clear());

const TASK = "3f1c2b7e-9d4a-4c1e-8a55-0b6f2d9e7a10";

describe("form persistence", () => {
  test("round-trips a form", () => {
    const form = {
      machine: "dev-1",
      account: "acct-1",
      repo: "github.com/acme/app",
      prompt: "port the pane",
      worktree: false,
      model: "fable",
      effort: "max",
      after: [{ task: TASK, after: "done" }],
      until: "reported",
    } as const;
    writeForm(form);
    expect(readForm()).toEqual(form);
  });

  test("a legacy auto form reads as auto/auto: autoRepo becomes repo, a saved machineId is not a pin (D2)", () => {
    store.set(
      "seance:form",
      JSON.stringify({ machineId: "dev-1", auto: true, autoRepo: "github.com/acme/app", repos: { "dev-1": "x" } }),
    );
    expect(readForm()).toMatchObject({ machine: null, account: null, repo: "github.com/acme/app" });
  });

  test("a legacy direct-spawn form (auto false) leaves repo null: its autoRepo is stale", () => {
    store.set(
      "seance:form",
      JSON.stringify({ machineId: "dev-1", auto: false, autoRepo: "github.com/acme/app", repos: { "dev-1": "x" } }),
    );
    expect(readForm()).toMatchObject({ machine: null, account: null, repo: null });
  });

  test("a form from before authoring reads with the authoring fields at their defaults", () => {
    store.set("seance:form", JSON.stringify({ prompt: "old", worktree: true, model: "opus", effort: "high" }));
    expect(readForm()).toMatchObject({ after: [], until: "merged", prompt: "old" });
  });

  test("authoring fields are validated one by one: junk entries drop, the rest stay", () => {
    const tooMany = Array.from({ length: 20 }, () => ({ task: TASK, after: "opened" }));
    store.set(
      "seance:form",
      JSON.stringify({
        after: [{ task: "has space", after: "opened" }, { task: TASK, after: "eventually" }, 7, null, ...tooMany],
        until: "whenever",
        linearIssue: "ENG-1",
      }),
    );
    const form = readForm();
    expect(form.after).toHaveLength(16);
    expect(form.after.every((dep) => dep.task === TASK && dep.after === "opened")).toBe(true);
    expect(form.until).toBe("merged");
    expect(form).not.toHaveProperty("linearIssue");
  });

  test("an older build's open batch is dropped: the form no longer authors batches", () => {
    store.set("seance:form", JSON.stringify({ prompt: "old", batch: { id: TASK, next: 3 } }));
    expect(readForm()).not.toHaveProperty("batch");
    expect(readForm().prompt).toBe("old");
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
    store.set("seance:form", JSON.stringify({ ...DEFAULT_FORM, model: "gpt-4", effort: "ludicrous" }));
    const form = readForm();
    expect(form.model).toBe(DEFAULT_FORM.model);
    expect(form.effort).toBe(DEFAULT_FORM.effort);
  });

  test("ignores wrongly typed fields rather than trusting them", () => {
    store.set("seance:form", JSON.stringify({ machine: 7, account: false, repo: 3, prompt: null, worktree: "yes" }));
    expect(readForm()).toEqual({ ...DEFAULT_FORM, prompt: "" });
  });
});

describe("the legacy pending-spawn entry", () => {
  test("is cleared, so a lost-reply record from an older build cannot linger", () => {
    store.set("seance:pending", JSON.stringify({ machineId: "dev-1", repo: "seance", requestedAt: 1 }));
    dropLegacyPending();
    expect(store.get("seance:pending")).toBeUndefined();
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
