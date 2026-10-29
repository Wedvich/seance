import { beforeEach, describe, expect, test } from "bun:test";
import { parseTask, TASK_SPEC_LIMITS } from "@seance/shared";
// Type-only, so erased: the module itself loads below, after the localStorage fake.
import type { HeldTask } from "../src/state.ts";

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

const { dropLegacyHidden, dropLegacyPending, readForm, readHeld, writeForm, writeHeld } =
  await import("../src/persist.ts");
const { DEFAULT_FORM, HELD_MAX } = await import("../src/state.ts");

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
      batch: { id: TASK, next: 4 },
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
    expect(readForm()).toMatchObject({ after: [], until: "merged", batch: null, prompt: "old" });
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

  test("a batch that parseTaskSpec would refuse is dropped whole", () => {
    const good = { id: TASK, next: 2 };
    for (const batch of [
      { ...good, id: "has space" },
      { ...good, next: 0 },
      { ...good, next: 1.5 },
      { ...good, next: TASK_SPEC_LIMITS.batchIndex + 2 },
      { ...good, next: 100_000 },
      "batch",
    ]) {
      store.set("seance:form", JSON.stringify({ batch }));
      expect(readForm().batch).toBeNull();
    }
    store.set("seance:form", JSON.stringify({ batch: good }));
    expect(readForm().batch).toEqual(good);
  });

  test("an older build's open batch with an order or a bound is dropped; auto or none stays open", () => {
    for (const strategy of [{ mode: "sequential" }, { mode: "parallel", max: 99 }, "sequential", "parallel", 7]) {
      store.set("seance:form", JSON.stringify({ batch: { id: TASK, strategy, next: 3 } }));
      expect(readForm().batch).toBeNull();
    }
    for (const strategy of [{ mode: "auto" }, "auto", undefined]) {
      store.set("seance:form", JSON.stringify({ batch: { id: TASK, strategy, next: 3 } }));
      expect(readForm().batch).toEqual({ id: TASK, next: 3 });
    }
  });

  test("a full batch (next one past the last index) survives a reload, so the form still says it is full", () => {
    for (const next of [TASK_SPEC_LIMITS.batchIndex, TASK_SPEC_LIMITS.batchIndex + 1]) {
      const batch = { id: TASK, next };
      store.set("seance:form", JSON.stringify({ batch }));
      expect(readForm().batch).toEqual(batch);
    }
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

describe("held tasks", () => {
  const OTHER = "7b0e4c1d-2f3a-4b5c-9d6e-1a2b3c4d5e6f";
  const held = (id: string, failure: string | null = null): HeldTask => ({
    task: {
      id,
      spec: { repo: "github.com/acme/app", mode: "worktree", prompt: "port it" },
      state: "queued",
      createdAt: 5,
    },
    failure,
    sending: true,
  });

  test("round-trip with their failures, never as sending", () => {
    writeHeld([held(TASK), held(OTHER, "Refused.")]);
    expect(readHeld()).toEqual([
      { ...held(TASK), sending: false },
      { ...held(OTHER, "Refused."), sending: false },
    ]);
  });

  test("clear the key once none are left", () => {
    writeHeld([held(TASK)]);
    writeHeld([]);
    expect(store.get("seance:held")).toBeUndefined();
  });

  // Sent as it stands, so anything this build can't parse is dropped rather than sent.
  test("drop entries that don't parse, aren't queued, or repeat an id", () => {
    store.set(
      "seance:held",
      JSON.stringify([
        held(TASK),
        { task: { ...held(OTHER).task, state: "running" } },
        { task: { id: "not a task" } },
        held(TASK, "dup"),
        "junk",
      ]),
    );
    expect(readHeld().map((entry) => entry.task.id)).toEqual([TASK]);
  });

  // Files go only to a leader verified to take them, which holding never checks.
  test("drop one carrying files, though it parses", () => {
    const ref = {
      id: "0b6f0c9e-1a2b-4c3d-8e9f-000000000000",
      name: "a.png",
      type: "image/png",
      size: 1024,
      hash: "A".repeat(43),
    };
    const { task } = held(OTHER);
    store.set(
      "seance:held",
      JSON.stringify([held(TASK), { task: { ...task, spec: { ...task.spec, attachments: [ref] } } }]),
    );
    expect(parseTask({ ...task, spec: { ...task.spec, attachments: [ref] } })).not.toBeNull();
    expect(readHeld().map((entry) => entry.task.id)).toEqual([TASK]);
  });

  test("stop at the cap", () => {
    const ids = Array.from({ length: HELD_MAX + 2 }, (_, i) => `${TASK.slice(0, -2)}${String(i).padStart(2, "0")}`);
    store.set("seance:held", JSON.stringify(ids.map((id) => held(id))));
    expect(readHeld()).toHaveLength(HELD_MAX);
  });

  test("survive corrupt JSON", () => {
    store.set("seance:held", "[{");
    expect(readHeld()).toEqual([]);
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
