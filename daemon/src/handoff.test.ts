import { describe, expect, test } from "bun:test";
import { DespawnFailure, type DespawnResult } from "./backend.ts";
import { createHandOff } from "./handoff.ts";
import type { BoundPane } from "./session-events.ts";

const pane = (taskId: string | null, dead = false): BoundPane => ({ id: "%1", pid: 10, dead, taskId, path: "/w" });

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
