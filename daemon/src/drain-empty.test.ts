import { describe, expect, test } from "bun:test";
import { createDrainEmptyWatch, watchedSessions } from "./drain-empty.ts";

describe("the drain's time to empty", () => {
  const watch = (): { observe: (cl: number | null, panes: number) => void; lines: string[]; at: { now: number } } => {
    const lines: string[] = [];
    const at = { now: 0 };
    const { observe } = createDrainEmptyWatch({ now: () => at.now, log: (line) => lines.push(line) });
    return { observe, lines, at };
  };

  test("logs once, the first time a closed machine reads empty, with the elapsed time and the most panes seen", () => {
    const { observe, lines, at } = watch();
    at.now = 1_000;
    observe(1_000, 2);
    at.now = 31_000;
    observe(1_000, 3);
    at.now = 61_000;
    observe(1_000, 1);
    expect(lines).toEqual([]);
    at.now = 91_000;
    observe(1_000, 0);
    at.now = 121_000;
    observe(1_000, 0);
    observe(1_000, 1);
    observe(1_000, 0);
    expect(lines).toEqual(["drain: empty cl=1000 after_ms=90000 peak=3"]);
  });

  test("nothing while open; a box already empty at its close logs peak=0", () => {
    const { observe, lines, at } = watch();
    observe(null, 0);
    observe(null, 4);
    expect(lines).toEqual([]);
    at.now = 5_000;
    observe(2_000, 0);
    expect(lines).toEqual(["drain: empty cl=2000 after_ms=3000 peak=0"]);
  });

  test("a re-close at a new cl logs again, and so does a close after a reopen", () => {
    const { observe, lines, at } = watch();
    at.now = 10_000;
    observe(1_000, 0);
    at.now = 20_000;
    observe(15_000, 2);
    at.now = 25_000;
    observe(15_000, 0);
    observe(null, 0);
    at.now = 40_000;
    observe(30_000, 1);
    at.now = 50_000;
    observe(30_000, 0);
    expect(lines).toEqual([
      "drain: empty cl=1000 after_ms=9000 peak=0",
      "drain: empty cl=15000 after_ms=10000 peak=2",
      "drain: empty cl=30000 after_ms=20000 peak=1",
    ]);
  });

  test("a reopen forgets the cl: closed again at the same time, it is watched afresh", () => {
    const { observe, lines } = watch();
    observe(1_000, 0);
    observe(null, 0);
    observe(1_000, 0);
    expect(lines).toHaveLength(2);
  });

  test("the status loop's read feeds the watch only when it succeeds: a failed read is not empty", async () => {
    const { observe, lines, at } = watch();
    at.now = 7_000;
    let fail = true;
    const read = watchedSessions(
      () => (fail ? Promise.reject(new Error("tmux gone")) : Promise.resolve([])),
      () => 1_000,
      { observe },
    );
    await expect(read()).rejects.toThrow("tmux gone");
    expect(lines).toEqual([]);
    fail = false;
    expect(await read()).toEqual([]);
    expect(lines).toEqual(["drain: empty cl=1000 after_ms=6000 peak=0"]);
  });
});
