import { describe, expect, spyOn, test } from "bun:test";
import { DespawnFailure, type DespawnResult } from "./backend.ts";
import { createHandOff, createPassClose } from "./handoff.ts";
import type { BoundPane } from "./session-events.ts";

const pane = (taskId: string | null, dead = false): BoundPane => ({
  id: "%1",
  pid: 10,
  dead,
  taskId,
  ours: true,
  path: "/w",
});

function setup(panes: readonly BoundPane[], despawn?: () => Promise<DespawnResult>) {
  const lines: string[] = [];
  const despawned: { id: string; force: boolean; closing: boolean }[] = [];
  const closed: string[] = [];
  const handOff = createHandOff({
    despawn: async (id, opts) => {
      despawned.push({ id, force: opts.force, closing: opts.closing !== undefined });
      await opts.closing?.("t1");
      return despawn === undefined ? { window: "fix-it", outcome: "exited" } : despawn();
    },
    panes: () => Promise.resolve(panes),
    closing: (taskId) => {
      closed.push(taskId);
      return Promise.resolve();
    },
    sink: (line) => void lines.push(line),
  });
  return { handOff, lines, despawned, closed };
}

describe("createHandOff", () => {
  test("despawns the pane gracefully, noting the close, under origin=handoff", async () => {
    const { handOff, lines, despawned, closed } = setup([pane("t1")]);
    await handOff("%1", "t1");
    expect(despawned).toEqual([{ id: "%1", force: false, closing: true }]);
    expect(closed).toEqual(["t1"]);
    expect(lines).toEqual([
      'audit despawn origin=handoff target="%1"',
      'audit despawn origin=handoff ok window="fix-it" outcome=exited',
    ]);
  });

  test("a pane that no longer runs the task, or is dead, is left alone and the refusal audited", async () => {
    for (const panes of [[pane("t2")], [pane("t1", true)], []]) {
      const { handOff, lines, despawned } = setup(panes);
      // oxlint-disable-next-line no-await-in-loop -- one double per case
      await handOff("%1", "t1");
      expect(despawned).toEqual([]);
      expect(lines.at(-1)).toContain("rejected the pane no longer runs the task that handed off");
    }
  });

  test("a despawn failure is audited with its code and never thrown", async () => {
    const { handOff, lines } = setup([pane("t1")], () =>
      Promise.reject(new DespawnFailure("session_not_found", "gone")),
    );
    await handOff("%1", "t1");
    expect(lines.at(-1)).toBe("audit despawn origin=handoff failed code=session_not_found");
  });
});

describe("createPassClose", () => {
  const passClose = (panes: readonly BoundPane[], despawn?: () => Promise<DespawnResult>) => {
    const lines: string[] = [];
    const despawned: string[] = [];
    const close = createPassClose({
      despawn: (id) => {
        despawned.push(id);
        return despawn === undefined ? Promise.resolve({ window: "fix-it", outcome: "exited" }) : despawn();
      },
      panes: () => Promise.resolve(panes),
      closing: () => Promise.resolve(),
      sink: (line) => void lines.push(line),
    });
    return { close, lines, despawned };
  };

  test("despawns the pane gracefully under origin=successor, never the hand-off's", async () => {
    const { close, lines, despawned } = passClose([pane("t1")]);
    await close("%1", "t1");
    expect(despawned).toEqual(["%1"]);
    expect(lines).toEqual([
      'audit despawn origin=successor target="%1"',
      'audit despawn origin=successor ok window="fix-it" outcome=exited',
    ]);
  });

  test("a pane that no longer runs the task is left alone and the refusal audited", async () => {
    const { close, lines, despawned } = passClose([pane("t2")]);
    await close("%1", "t1");
    expect(despawned).toEqual([]);
    expect(lines.at(-1)).toContain("rejected the pane no longer runs the task that was passed");
  });

  test("a despawn failure is audited with its code and never thrown", async () => {
    const { close, lines } = passClose([pane("t1")], () =>
      Promise.reject(new DespawnFailure("session_not_found", "gone")),
    );
    await close("%1", "t1");
    expect(lines.at(-1)).toBe("audit despawn origin=successor failed code=session_not_found");
  });
});

describe("a despawn that crashes", () => {
  test("is logged under each act's own words, the hand-off's unchanged, and audited internal_error", async () => {
    const crash = (): Promise<DespawnResult> => Promise.reject(new Error("boom"));
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      const lines: string[] = [];
      const deps = {
        despawn: crash,
        panes: () => Promise.resolve([pane("t1")]),
        closing: () => Promise.resolve(),
        sink: (line: string) => void lines.push(line),
      };
      await createHandOff(deps)("%1", "t1");
      await createPassClose(deps)("%1", "t1");
      const logged = stderr.mock.calls.map((call) => String(call[0]));
      expect(logged[0]).toContain(" error hand-off despawn crashed: Error: boom");
      expect(logged[1]).toContain(" error pass despawn crashed: Error: boom");
      expect(lines.filter((l) => l.endsWith("failed code=internal_error"))).toHaveLength(2);
    } finally {
      stderr.mockRestore();
    }
  });
});
