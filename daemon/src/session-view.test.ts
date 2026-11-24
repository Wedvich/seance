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
  const generation = (t: ReturnType<typeof table>) =>
    createSessionGeneration({ seed: 1_763_000_000, view: (sessions) => appSessionView(t.source, sessions) });

  test("starts at its seed and holds while nothing a reader acts on moves", () => {
    const t = table();
    const sg = generation(t);
    t.views.set("%1", processView("busy"));
    t.tags.set("%1", { "agent.kind": { value: "claude", at: 1, scope: "conversation" } });
    expect(sg.observe([pane("%1")])).toBe(1_763_000_000);
    expect(sg.observe([pane("%1")])).toBe(1_763_000_000);
    // Clocks alone are not a change: a re-sent tag's age, a state's start.
    t.views.set("%1", processView("busy", { since: 2_000 }));
    t.tags.set("%1", { "agent.kind": { value: "claude", at: 9, scope: "conversation" } });
    expect(sg.observe([pane("%1")])).toBe(1_763_000_000);
  });

  test("bumps once per change a sessions reply would show", () => {
    const t = table();
    const sg = generation(t);
    let expected = 1_763_000_000;
    const step = (sessions: readonly SessionEntry[], change: () => void): void => {
      change();
      expected += 1;
      expect(sg.observe(sessions)).toBe(expected);
      expect(sg.observe(sessions)).toBe(expected);
    };
    t.views.set("%1", processView("busy"));
    sg.observe([pane("%1")]);
    step([pane("%1")], () => t.views.set("%1", processView("idle")));
    step([pane("%1")], () => t.views.set("%1", processView("idle", { turnEnded: true })));
    step([pane("%1")], () => t.views.set("%1", processView("needs-input", { reason: "permission" })));
    step([pane("%1")], () => t.views.set("%1", processView("needs-input", { reason: "question" })));
    step([pane("%1")], () => t.tags.set("%1", { "owner.label": { value: "a", at: 1, scope: "conversation" } }));
    step([pane("%1")], () => t.tags.set("%1", { "owner.label": { value: "b", at: 1, scope: "conversation" } }));
    step([pane("%1"), pane("%2")], () => {});
    step([pane("%1", { taskId: "t-1" }), pane("%2")], () => {});
    step([pane("%2")], () => {});
  });
});
