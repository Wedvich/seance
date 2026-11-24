import { describe, expect, test } from "bun:test";
import type { SessionEntry, SessionTag } from "@seance/shared";
import type { ProcessView } from "./conversations.ts";
import { appSessionView, createSessionGeneration } from "./session-view.ts";

const pane = (id: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  id,
  window: id,
  repo: null,
  path: "/r",
  ...extra,
});

const processView = (state: ProcessView["state"], extra: Partial<ProcessView> = {}): ProcessView => ({
  pane: "%1",
  pid: 1,
  key: "1:a",
  taskId: null,
  state,
  turnEnded: false,
  since: 1_000,
  reason: null,
  remote: null,
  kind: null,
  session: null,
  ...extra,
});

/** A conversation table double: what the view reads of it, per pane. */
function table() {
  const views = new Map<string, ProcessView>();
  const tags = new Map<string, Record<string, SessionTag>>();
  return {
    views,
    tags,
    source: { process: (id: string) => views.get(id) ?? null, tagsFor: (id: string) => tags.get(id) },
  };
}

describe("appSessionView", () => {
  test("joins each pane's tags and live state, turnEnded and reason only beside their own state", () => {
    const t = table();
    t.views.set("%1", processView("idle", { turnEnded: true, reason: "question" }));
    t.views.set("%2", processView("needs-input", { turnEnded: true, reason: "question", since: 7 }));
    t.views.set("%3", processView(null));
    t.tags.set("%3", { "agent.kind": { value: "claude", at: 1, scope: "conversation" } });
    const joined = appSessionView(t.source, [
      pane("%1"),
      pane("%2"),
      pane("%3"),
      pane("%4"),
      { ...pane("x"), id: undefined },
    ]);
    expect(joined.map((entry) => entry.live)).toEqual([
      { state: "idle", since: 1_000, turnEnded: true },
      { state: "needs-input", since: 7, reason: "question" },
      undefined,
      undefined,
      undefined,
    ]);
    expect(joined[2]?.tags?.["agent.kind"]?.value).toBe("claude");
    expect(appSessionView(undefined, [pane("%1")])).toEqual([pane("%1")]);
  });
});

describe("the session generation", () => {
  const generation = (t: ReturnType<typeof table>, prepare?: () => Promise<void>) =>
    createSessionGeneration({
      seed: 1_763_000_000_000,
      view: (sessions) => appSessionView(t.source, sessions),
      ...(prepare === undefined ? {} : { prepare }),
    });
  const SEED = 1_763_000_000_000;
  const kind = (at: number): Record<string, SessionTag> => ({
    "agent.kind": { value: "claude", at, scope: "conversation" },
  });

  test("starts at its seed and holds while nothing moves", async () => {
    const t = table();
    const sg = generation(t);
    t.views.set("%1", processView("busy"));
    t.tags.set("%1", kind(1));
    expect(await sg.observe([pane("%1")])).toBe(SEED);
    expect(await sg.observe([pane("%1")])).toBe(SEED);
  });

  test("bumps once per change a sessions reply would show, a clock restamp included", async () => {
    const t = table();
    const sg = generation(t);
    let expected = SEED;
    const step = async (sessions: readonly SessionEntry[], change: () => void): Promise<void> => {
      change();
      expected += 1;
      expect(await sg.observe(sessions)).toBe(expected);
      expect(await sg.observe(sessions)).toBe(expected);
    };
    t.views.set("%1", processView("busy"));
    await sg.observe([pane("%1")]);
    await step([pane("%1")], () => t.views.set("%1", processView("idle")));
    await step([pane("%1")], () => t.views.set("%1", processView("idle", { turnEnded: true })));
    // Back to the same state within a beat: a new `since`, which the reply would show.
    await step([pane("%1")], () => t.views.set("%1", processView("busy", { since: 2_000 })));
    await step([pane("%1")], () => t.views.set("%1", processView("idle", { turnEnded: true, since: 3_000 })));
    await step([pane("%1")], () =>
      t.views.set("%1", processView("needs-input", { reason: "permission", since: 4_000 })),
    );
    await step([pane("%1")], () => t.views.set("%1", processView("needs-input", { reason: "question", since: 4_000 })));
    await step([pane("%1")], () => t.tags.set("%1", { "owner.label": { value: "a", at: 1, scope: "conversation" } }));
    await step([pane("%1")], () => t.tags.set("%1", { "owner.label": { value: "b", at: 1, scope: "conversation" } }));
    await step([pane("%1")], () => t.tags.set("%1", { "owner.label": { value: "b", at: 5, scope: "conversation" } }));
    await step([pane("%1"), pane("%2")], () => {});
    await step([pane("%1", { taskId: "t-1" }), pane("%2")], () => {});
    await step([pane("%2")], () => {});
  });

  test("a reordering of the same tags is no change", async () => {
    const t = table();
    const sg = generation(t);
    const a: SessionTag = { value: "x", at: 1, scope: "conversation" };
    const b: SessionTag = { value: "y", at: 2, scope: "conversation" };
    t.tags.set("%1", { "adapter.a.k": a, "adapter.b.k": b });
    expect(await sg.observe([pane("%1")])).toBe(SEED);
    t.tags.set("%1", { "adapter.b.k": b, "adapter.a.k": a });
    expect(await sg.observe([pane("%1")])).toBe(SEED);
  });

  test("sweeps the table before each read, and a failed sweep is no failure", async () => {
    const t = table();
    let sweeps = 0;
    let fail = false;
    const sg = generation(t, async () => {
      sweeps += 1;
      if (fail) throw new Error("tmux gone");
      t.tags.set("%1", kind(sweeps));
    });
    expect(await sg.observe([pane("%1")])).toBe(SEED);
    // The sweep itself surfaced a tag: seen in this very read.
    expect(await sg.observe([pane("%1")])).toBe(SEED + 1);
    fail = true;
    expect(await sg.observe([pane("%1")])).toBe(SEED + 1);
    expect(sweeps).toBe(3);
  });
});
