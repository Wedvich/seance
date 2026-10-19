import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Task, TaskState } from "@seance/shared";
import { DEFAULT_FORM, type Verdict } from "../src/state.ts";
import {
  screenKey,
  TRANSITION_KINDS,
  TransitionRunner,
  transitionKind,
  type TransitionDeps,
  type TransitionOptions,
} from "../src/transition.ts";
import type { AppState } from "../src/view.ts";

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    relay: {
      status: "open",
      rejection: null,
      machines: [],
      registrySize: 0,
      ignored: 0,
      unbound: 0,
      skewed: 0,
      settling: false,
      registrySettled: true,
      scheduler: { kind: "none" },
    },
    form: DEFAULT_FORM,
    promptUndo: null,
    sheet: null,
    settings: false,
    machines: false,
    history: null,
    spawning: false,
    rescanning: false,
    rescan: "idle",
    verdict: null,
    preview: null,
    sessions: {},
    queue: false,
    wide: false,
    queueView: null,
    taskAction: null,
    queueNotice: null,
    pausing: false,
    discarding: false,
    ...overrides,
  };
}

const queued = (id: string, taskState: TaskState): Verdict => {
  const task: Task = { id, spec: { repo: "github.com/acme/app", mode: "worktree" }, state: taskState, createdAt: 1 };
  return { kind: "queued", task };
};

const OK: Verdict = { kind: "ok", window: "seance-1" };
const OTHER: Verdict = { kind: "ok", window: "seance-2" };

const kind = (from: Partial<AppState>, to: Partial<AppState>): string | null =>
  transitionKind(screenKey(state(from)), screenKey(state(to)));

describe("transitionKind", () => {
  test("a phone layer opening is a push, closing it a pop", () => {
    for (const layer of ["queue", "machines", "settings"] as const) {
      expect(kind({}, { [layer]: true })).toBe("push");
      expect(kind({ [layer]: true }, {})).toBe("pop");
    }
  });

  test("the form gives way to a verdict and comes back from one", () => {
    expect(kind({}, { verdict: OK })).toBe("verdict-in");
    expect(kind({ verdict: OK }, {})).toBe("verdict-out");
  });

  test("one verdict replacing another is no transition", () => {
    expect(kind({ verdict: OK }, { verdict: OTHER })).toBeNull();
    expect(kind({ verdict: queued("t", "queued") }, { verdict: OK })).toBeNull();
    expect(kind({ verdict: queued("t", "queued") }, { verdict: queued("u", "queued") })).toBeNull();
  });

  test("a queued verdict's poll is the same screen, even as a new object", () => {
    const before = screenKey(state({ verdict: queued("t", "queued") }));
    const after = screenKey(state({ verdict: queued("t", "running") }));
    expect(after).toEqual(before);
    expect(transitionKind(before, after)).toBeNull();
  });

  test("content and sheets are not screen changes", () => {
    expect(kind({}, { spawning: true, form: { ...DEFAULT_FORM, prompt: "hi" } })).toBeNull();
    expect(kind({}, { sheet: "repo" })).toBeNull();
    expect(kind({ queue: true }, { queue: true, queueNotice: "refused" })).toBeNull();
  });

  test("a layout flip is never animated", () => {
    expect(kind({ wide: false }, { wide: true })).toBeNull();
    expect(kind({ wide: true, settings: true }, { wide: false })).toBeNull();
  });

  test("on a desk Settings is a modal and the columns do not move", () => {
    expect(kind({ wide: true }, { wide: true, settings: true })).toBe("modal-in");
    expect(kind({ wide: true, settings: true }, { wide: true })).toBe("modal-out");
    expect(kind({ wide: true }, { wide: true, queue: true })).toBeNull();
    expect(kind({ wide: true, machines: true }, { wide: true })).toBeNull();
  });

  test("closing a layer and the verdict in one popstate is a pop", () => {
    expect(kind({ queue: true, verdict: OK }, {})).toBe("pop");
  });

  test("a verdict landing under a phone layer is not animated", () => {
    expect(kind({ queue: true }, { queue: true, verdict: OK })).toBeNull();
  });
});

interface Fake {
  readonly deps: TransitionDeps<string>;
  readonly applied: string[];
  readonly starts: TransitionOptions[];
  /** Settles the nth started transition's updateCallbackDone. */
  readonly reject: (index: number) => void;
  /** Indexes of starts whose skipTransition was called. */
  readonly skipped: number[];
}

function fake(
  options: { supported?: boolean; reduced?: boolean; hidden?: boolean; applyResult?: Promise<void> } = {},
): Fake {
  const applied: string[] = [];
  const starts: TransitionOptions[] = [];
  const rejects: (() => void)[] = [];
  const skipped: number[] = [];
  const deps: TransitionDeps<string> = {
    start:
      options.supported === false
        ? undefined
        : (transition) => {
            const index = starts.push(transition) - 1;
            return {
              skipTransition: () => void skipped.push(index),
              updateCallbackDone: new Promise<void>((_resolve, reject) => {
                rejects.push(() => reject(new Error("skipped")));
              }),
            };
          },
    reducedMotion: () => options.reduced ?? false,
    hidden: () => options.hidden ?? false,
    apply: (next) => {
      applied.push(next);
      return options.applyResult ?? Promise.resolve();
    },
  };
  return { deps, applied, starts, skipped, reject: (index) => rejects[index]?.() };
}

const FORM = screenKey(state());
const QUEUE = screenKey(state({ queue: true }));
const MACHINES = screenKey(state({ machines: true }));
const VERDICT = screenKey(state({ verdict: OK }));

describe("TransitionRunner", () => {
  test("unsupported, reduced motion or a hidden page applies at once and starts nothing", () => {
    for (const options of [{ supported: false }, { reduced: true }, { hidden: true }]) {
      const f = fake(options);
      new TransitionRunner(FORM, f.deps).offer("queue", QUEUE);
      expect(f.applied).toEqual(["queue"]);
      expect(f.starts).toHaveLength(0);
    }
  });

  test("a non-screen change applies at once even where transitions run", () => {
    const f = fake();
    new TransitionRunner(FORM, f.deps).offer("typed", FORM);
    expect(f.applied).toEqual(["typed"]);
    expect(f.starts).toHaveLength(0);
  });

  test("a screen change waits for the update callback, whose promise is the commit", async () => {
    const f = fake();
    new TransitionRunner(FORM, f.deps).offer("queue", QUEUE);
    expect(f.starts.map((s) => s.types)).toEqual([["push"]]);
    expect(f.applied).toEqual([]);
    await f.starts[0]?.update();
    expect(f.applied).toEqual(["queue"]);
  });

  test("offers before the callback collapse into one apply of the latest", async () => {
    const f = fake();
    const runner = new TransitionRunner(FORM, f.deps);
    runner.offer("verdict", VERDICT);
    runner.offer("verdict, typed", VERDICT);
    runner.offer("verdict, typed again", VERDICT);
    expect(f.starts).toHaveLength(1);
    expect(f.applied).toEqual([]);
    await f.starts[0]?.update();
    expect(f.applied).toEqual(["verdict, typed again"]);
  });

  test("update returns the promise apply returned, so the commit is awaitable", async () => {
    const gate = Promise.withResolvers<void>();
    const f = fake({ applyResult: gate.promise });
    new TransitionRunner(FORM, f.deps).offer("queue", QUEUE);
    let settled = false;
    const done = (async (): Promise<void> => {
      await f.starts[0]?.update();
      settled = true;
    })();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await done;
    expect(settled).toBe(true);
  });

  test("a collapse into a different screen change skips the transition and still lands the latest", async () => {
    const f = fake();
    const runner = new TransitionRunner(FORM, f.deps);
    runner.offer("queue", QUEUE);
    runner.offer("form", FORM);
    expect(f.skipped).toEqual([0]);
    await f.starts[0]?.update();
    expect(f.applied).toEqual(["form"]);
  });

  test("a collapse that keeps the same screen change does not skip", async () => {
    const f = fake();
    const runner = new TransitionRunner(FORM, f.deps);
    runner.offer("a", VERDICT);
    runner.offer("b", VERDICT);
    runner.offer("c", VERDICT);
    expect(f.skipped).toEqual([]);
    await f.starts[0]?.update();
    expect(f.applied).toEqual(["c"]);
  });

  test("an offer after the callback starts a fresh transition and leaves the first's state alone", async () => {
    const f = fake();
    const runner = new TransitionRunner(FORM, f.deps);
    runner.offer("queue", QUEUE);
    await f.starts[0]?.update();
    runner.offer("form", FORM);
    expect(f.starts.map((s) => s.types)).toEqual([["push"], ["pop"]]);
    await f.starts[1]?.update();
    expect(f.applied).toEqual(["queue", "form"]);
    // The first's callback running again (or late) has nothing left to apply.
    await f.starts[0]?.update();
    expect(f.applied).toEqual(["queue", "form"]);
  });

  test("a transition that never ran its callback still lands its latest state", async () => {
    const f = fake();
    const runner = new TransitionRunner(FORM, f.deps);
    runner.offer("queue", QUEUE);
    runner.offer("machines", MACHINES);
    f.reject(0);
    await Promise.resolve();
    expect(f.applied).toEqual(["machines"]);
  });

  test("a late rejection does not flush a newer transition's state before its capture", async () => {
    const f = fake();
    const runner = new TransitionRunner(FORM, f.deps);
    runner.offer("queue", QUEUE);
    await f.starts[0]?.update();
    runner.offer("form", FORM);
    f.reject(0);
    await Promise.resolve();
    expect(f.applied).toEqual(["queue"]);
  });

  test("a start that throws applies at once", () => {
    const applied: string[] = [];
    const runner = new TransitionRunner<string>(FORM, {
      start: () => {
        throw new Error("InvalidStateError");
      },
      reducedMotion: () => false,
      hidden: () => false,
      apply: (next) => {
        applied.push(next);
        return Promise.resolve();
      },
    });
    runner.offer("queue", QUEUE);
    expect(applied).toEqual(["queue"]);
  });
});

/** Rules as [selector, declarations], comments stripped; nested at-rules flatten to their inner rule. */
function rules(css: string): [string, string][] {
  return css
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .split("}")
    .map((chunk) => chunk.split("{"))
    .filter((parts) => parts.length >= 2)
    .map((parts): [string, string] => [parts.at(-2)?.trim() ?? "", parts.at(-1) ?? ""]);
}

const read = (name: string): string => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

describe("the view-transition stylesheet", () => {
  const screen = read("screen.css");

  test("names and classes are set only while a transition runs", () => {
    const naming = rules(screen).filter(([, body]) => /view-transition-(name|class)\s*:/u.test(body));
    expect(naming.length).toBeGreaterThan(0);
    for (const [selector] of naming) {
      for (const part of selector.split(",")) {
        expect(part.trim()).toMatch(/^:root:active-view-transition(-type\(|\s)/u);
      }
    }
  });

  test("every type a selector names is one the runner starts", () => {
    const named = [...screen.matchAll(/:active-view-transition-type\(([^)]*)\)/gu)].flatMap((m) =>
      (m[1] ?? "").split(",").map((type) => type.trim()),
    );
    expect(named.length).toBeGreaterThan(0);
    const known: readonly string[] = TRANSITION_KINDS;
    for (const type of named) expect(known).toContain(type);
  });

  test("reduced motion reaches the transition pseudo-elements", () => {
    const base = read("base.css");
    const start = base.lastIndexOf("@media (prefers-reduced-motion: reduce)");
    expect(start).toBeGreaterThanOrEqual(0);
    const open = base.indexOf("{", start);
    let depth = 0;
    let end = open;
    for (; end < base.length; end++) {
      if (base[end] === "{") depth++;
      else if (base[end] === "}" && --depth === 0) break;
    }
    const clamp = base.slice(open, end);
    expect(clamp).toContain("::view-transition-group(*)");
    expect(clamp).toContain("::view-transition-old(*)");
    expect(clamp).toContain("::view-transition-new(*)");
  });
});
