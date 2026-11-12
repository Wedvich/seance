import { beforeEach, describe, expect, test } from "bun:test";
import { parseTask } from "@seance/shared";
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

const {
  dropLegacyHidden,
  dropLegacyPending,
  FORM_FILES_FRESH_MS,
  readForm,
  readFormFiles,
  readHeld,
  trackFormFiles,
  trackHeld,
  writeForm,
  writeFormFiles,
  writeHeld,
} = await import("../src/persist.ts");
const { DEFAULT_FORM, HELD_MAX, HELD_MAX_AGE_MS } = await import("../src/state.ts");

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

describe("held tasks", () => {
  const OTHER = "7b0e4c1d-2f3a-4b5c-9d6e-1a2b3c4d5e6f";
  const CREATED = Date.now();
  const held = (id: string, failure: string | null = null): HeldTask => ({
    task: {
      id,
      spec: { repo: "github.com/acme/app", mode: "worktree", prompt: "port it" },
      state: "queued",
      createdAt: CREATED,
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

  // An `auto` task holds no `plan`, so dropping `autonomy` on read would silently send it at checkpoint.
  test("keep a task's autonomy level, and steer's plan mode beside it", () => {
    const leveled = (id: string, level: Pick<HeldTask["task"]["spec"], "autonomy" | "plan">): HeldTask => {
      const entry = held(id);
      return { ...entry, task: { ...entry.task, spec: { ...entry.task.spec, ...level } } };
    };
    writeHeld([leveled(TASK, { autonomy: "auto" }), leveled(OTHER, { autonomy: "steer", plan: true })]);
    expect(readHeld().map((entry) => entry.task.spec)).toEqual([
      expect.objectContaining({ autonomy: "auto" }),
      expect.objectContaining({ autonomy: "steer", plan: true }),
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

  test("drop one held past the age limit", () => {
    const { task } = held(OTHER);
    const now = Date.now();
    store.set("seance:held", JSON.stringify([held(TASK), { task: { ...task, createdAt: now - HELD_MAX_AGE_MS - 1 } }]));
    expect(readHeld(now).map((entry) => entry.task.id)).toEqual([TASK]);
  });

  test("survive corrupt JSON", () => {
    store.set("seance:held", "[{");
    expect(readHeld()).toEqual([]);
  });
});

describe("tracking held tasks across tabs", () => {
  function tracked(initial: readonly HeldTask[] = []) {
    let state = { held: initial };
    const listeners = new Set<() => void>();
    const adopted: (readonly HeldTask[])[] = [];
    let fire: (key: string | null) => void = () => {};
    const source = {
      subscribe: (listener: () => void) => listeners.add(listener),
      getState: () => state,
      adoptHeld: (held: readonly HeldTask[]) => {
        adopted.push(held);
        set(held);
      },
    };
    const set = (held: readonly HeldTask[]): void => {
      state = { held };
      for (const listener of listeners) listener();
    };
    trackHeld(source, (handler) => {
      fire = handler;
    });
    return { set, adopted, fire: (key: string | null) => fire(key) };
  }
  const entry = (id: string): HeldTask => ({
    task: {
      id,
      spec: { repo: "github.com/acme/app", mode: "worktree", prompt: "p" },
      state: "queued",
      createdAt: Date.now(),
    },
    failure: null,
    sending: false,
  });

  test("writes this tab's changes, and adopts another tab's without writing them back", () => {
    const t = tracked();
    t.set([entry(TASK)]);
    expect(readHeld().map((e) => e.task.id)).toEqual([TASK]);

    // Another tab's write: storage changes under this one, then the event names the key.
    const other = "7b0e4c1d-2f3a-4b5c-9d6e-1a2b3c4d5e6f";
    const written = JSON.stringify([
      { task: entry(TASK).task, failure: null },
      { task: entry(other).task, failure: null },
    ]);
    store.set("seance:held", written);
    t.fire("seance:held");
    expect(t.adopted.map((list) => list.map((e) => e.task.id))).toEqual([[TASK, other]]);
    expect(store.get("seance:held")).toBe(written);

    // Another key adopts nothing.
    t.fire("seance:form");
    expect(t.adopted).toHaveLength(1);
  });

  test("adopts an empty list when another tab clears storage", () => {
    const t = tracked();
    t.set([entry(TASK)]);
    store.clear();
    t.fire(null);
    expect(t.adopted).toEqual([[]]);
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

describe("the form's files before a share", () => {
  test("round-trip, apart from the form", () => {
    writeForm(DEFAULT_FORM);
    writeFormFiles({ files: 2, submitting: true });
    expect(readFormFiles()).toEqual({ files: 2, submitting: true });
    expect(readForm()).toEqual(DEFAULT_FORM);
  });

  test("read as nothing when absent or malformed", () => {
    expect(readFormFiles()).toBeNull();
    store.set("seance:form-files", JSON.stringify({ files: -1, submitting: false, at: Date.now() }));
    expect(readFormFiles()).toBeNull();
    store.set("seance:form-files", "{");
    expect(readFormFiles()).toBeNull();
  });

  test("a closed document's facts are not a share's cost", () => {
    writeFormFiles({ files: 3, submitting: true }, 1_000);
    expect(readFormFiles(1_000 + FORM_FILES_FRESH_MS)).toEqual({ files: 3, submitting: true });
    expect(readFormFiles(1_001 + FORM_FILES_FRESH_MS)).toBeNull();
    store.set("seance:form-files", JSON.stringify({ files: 3, submitting: true }));
    expect(readFormFiles()).toBeNull();
  });

  test("tracks the form, and restamps on hide", () => {
    let attachments: readonly unknown[] = [];
    let spawning = false;
    const listeners: (() => void)[] = [];
    let flush = (): void => {};
    trackFormFiles(
      {
        subscribe: (listener) => void listeners.push(listener),
        getState: () => ({ attachments, spawning }),
      },
      (hide) => {
        flush = hide;
      },
    );
    expect(readFormFiles()).toEqual({ files: 0, submitting: false });
    attachments = [1, 2];
    spawning = true;
    for (const listener of listeners) listener();
    expect(readFormFiles()).toEqual({ files: 2, submitting: true });
    store.clear();
    flush();
    expect(readFormFiles()).toEqual({ files: 2, submitting: true });
  });
});
