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
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  },
});

const {
  dropLegacyHeld,
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
const { DEFAULT_FORM, HELD_MAX, HELD_MAX_AGE_MS, WORKTREE_REPOS_MAX } = await import("../src/state.ts");

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
      worktreeByRepo: { "github.com/acme/app": false, "github.com/acme/ops": true },
      model: "fable",
      effort: "max",
      after: [{ task: TASK, after: "done" }],
      until: "reported",
      requires: ["atlas", "gpu-2"],
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

  test("worktreeByRepo keeps boolean entries only, the newest at most WORKTREE_REPOS_MAX, and none when malformed", () => {
    store.set(
      "seance:form",
      JSON.stringify({ worktreeByRepo: { a: true, b: "yes", c: null, constructor: false, d: false } }),
    );
    expect(readForm().worktreeByRepo).toEqual({ a: true, constructor: false, d: false });
    const many = Object.fromEntries(Array.from({ length: WORKTREE_REPOS_MAX + 5 }, (_, i) => [`r${i}`, i % 2 === 0]));
    store.set("seance:form", JSON.stringify({ worktreeByRepo: many }));
    const kept = Object.keys(readForm().worktreeByRepo);
    expect(kept).toHaveLength(WORKTREE_REPOS_MAX);
    expect(kept[0]).toBe("r5");
    for (const malformed of [[true], "on", null]) {
      store.set("seance:form", JSON.stringify({ worktreeByRepo: malformed }));
      expect(readForm().worktreeByRepo).toEqual({});
    }
  });

  test("requires is read as trait names only, once each, at most four, and as none when it is not a list", () => {
    store.set(
      "seance:form",
      JSON.stringify({ requires: ["atlas", "Atlas", 7, null, "atlas", "has space", "a", "b", "c", "d", "e"] }),
    );
    expect(readForm().requires).toEqual(["atlas", "a", "b", "c"]);
    store.set("seance:form", JSON.stringify({ requires: "atlas" }));
    expect(readForm().requires).toEqual([]);
    store.set("seance:form", JSON.stringify({ prompt: "from before traits" }));
    expect(readForm().requires).toEqual([]);
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
  const held = (id: string, failure: string | null = null, createdAt = 5): HeldTask => ({
    task: {
      id,
      spec: { repo: "github.com/acme/app", mode: "worktree", prompt: "port it" },
      state: "queued",
      createdAt,
    },
    failure,
    sending: true,
  });
  const key = (id: string): string => `seance:held:${id}`;

  test("round-trip one key per task, oldest first, with failures and never as sending", () => {
    writeHeld([], [held(OTHER, "Refused.", 7), held(TASK, null, 6)]);
    expect([...store.keys()].toSorted()).toEqual([key(TASK), key(OTHER)].toSorted());
    expect(readHeld()).toEqual([
      { ...held(TASK, null, 6), sending: false },
      { ...held(OTHER, "Refused.", 7), sending: false },
    ]);
  });

  test("write only what changed: a sending flip writes nothing, a removal clears its key", () => {
    const first = held(TASK);
    const second = held(OTHER);
    writeHeld([], [first, second]);
    store.set(key(OTHER), "written by another tab");
    writeHeld([first, second], [{ ...first, sending: false }, second]);
    expect(store.get(key(OTHER))).toBe("written by another tab");

    writeHeld([first, second], [second]);
    expect(store.has(key(TASK))).toBe(false);
  });

  // Sent as it stands, so anything this build can't parse is dropped rather than sent.
  test("skip entries that don't parse, aren't queued, or sit under another task's key", () => {
    writeHeld([], [held(TASK)]);
    const { task } = held(OTHER);
    store.set(key(OTHER), JSON.stringify({ task: { ...task, state: "running" } }));
    store.set(key("x"), JSON.stringify({ task: { id: "not a task" } }));
    store.set(key("7b0e4c1d-2f3a-4b5c-9d6e-000000000000"), JSON.stringify({ task }));
    store.set(key("junk"), "[{");
    expect(readHeld().map((entry) => entry.task.id)).toEqual([TASK]);
  });

  // Files go only to a leader verified to take them, which holding never checks.
  test("skip one carrying files, though it parses", () => {
    const ref = {
      id: "0b6f0c9e-1a2b-4c3d-8e9f-000000000000",
      name: "a.png",
      type: "image/png",
      size: 1024,
      hash: "A".repeat(43),
    };
    const { task } = held(OTHER);
    const withFiles = { ...task, spec: { ...task.spec, attachments: [ref] } };
    writeHeld([], [held(TASK)]);
    store.set(key(OTHER), JSON.stringify({ task: withFiles }));
    expect(parseTask(withFiles)).not.toBeNull();
    expect(readHeld().map((entry) => entry.task.id)).toEqual([TASK]);
  });

  test("stop at the cap", () => {
    const ids = Array.from({ length: HELD_MAX + 2 }, (_, i) => `${TASK.slice(0, -2)}${String(i).padStart(2, "0")}`);
    writeHeld(
      [],
      ids.map((id) => held(id)),
    );
    expect(readHeld()).toHaveLength(HELD_MAX);
  });

  // The store drops these, and says so: a read that skipped them would lose them unsaid.
  test("read one past the age limit like any other", () => {
    writeHeld([], [held(TASK, null, Date.now() - HELD_MAX_AGE_MS - 1)]);
    expect(readHeld().map((entry) => entry.task.id)).toEqual([TASK]);
  });

  test("clear an earlier build's single-list key", () => {
    store.set("seance:held", JSON.stringify([{ task: held(TASK).task, failure: null }]));
    dropLegacyHeld();
    expect(store.has("seance:held")).toBe(false);
    expect(readHeld()).toEqual([]);
  });
});

describe("tracking held tasks across tabs", () => {
  function tracked(initial: readonly HeldTask[] = []) {
    let state = { held: initial };
    const listeners = new Set<() => void>();
    const adopted: (readonly HeldTask[])[] = [];
    let fire: (key: string | null) => void = () => {};
    const set = (held: readonly HeldTask[]): void => {
      state = { held };
      for (const listener of listeners) listener();
    };
    const source = {
      subscribe: (listener: () => void) => listeners.add(listener),
      getState: () => state,
      adoptHeld: (held: readonly HeldTask[]) => {
        adopted.push(held);
        set(held);
      },
    };
    trackHeld(source, (handler) => {
      fire = handler;
    });
    return { set, adopted, fire: (key: string | null) => fire(key) };
  }
  const entry = (id: string): HeldTask => ({
    task: { id, spec: { repo: "github.com/acme/app", mode: "worktree", prompt: "p" }, state: "queued", createdAt: 1 },
    failure: null,
    sending: false,
  });
  const OTHER = "7b0e4c1d-2f3a-4b5c-9d6e-1a2b3c4d5e6f";

  test("writes this tab's changes, and adopts another tab's without writing them back", () => {
    const t = tracked();
    t.set([entry(TASK)]);
    expect(readHeld().map((e) => e.task.id)).toEqual([TASK]);

    // Another tab's write: storage changes under this one, then the event names the key.
    const theirs = JSON.stringify({ task: entry(OTHER).task, failure: null });
    store.set(`seance:held:${OTHER}`, theirs);
    t.fire(`seance:held:${OTHER}`);
    expect(t.adopted.map((list) => list.map((e) => e.task.id))).toEqual([[TASK, OTHER]]);
    expect(store.get(`seance:held:${OTHER}`)).toBe(theirs);

    t.fire("seance:form");
    expect(t.adopted).toHaveLength(1);
  });

  // The race a single list had: each tab writing its whole list over the other's.
  test("two tabs holding at once both keep their tasks", () => {
    const a = tracked();
    const b = tracked();
    a.set([entry(TASK)]);
    b.set([entry(OTHER)]);
    expect(readHeld().map((e) => e.task.id)).toEqual([TASK, OTHER]);
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
