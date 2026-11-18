import { describe, expect, test } from "bun:test";
import { createLeadFallback } from "./lead-fallback.ts";

function rig(opts: { launching?: boolean } = {}) {
  const changes: [boolean, number][] = [];
  const state = { launching: opts.launching ?? false };
  const fallback = createLeadFallback({
    launching: () => state.launching,
    changed: (active, cl) => changes.push([active, cl]),
  });
  return { fallback, changes, state };
}

describe("lead fallback", () => {
  test("an open machine never falls back, however empty", () => {
    const { fallback, changes } = rig();
    fallback.observe(null, 0);
    expect(fallback.active()).toBe(false);
    expect(changes).toEqual([]);
  });

  test("a closed machine falls back at its first empty read, not before", () => {
    const { fallback, changes } = rig();
    fallback.observe(1000, 2);
    expect(fallback.active()).toBe(false);
    fallback.observe(1000, 0);
    expect(fallback.active()).toBe(true);
    expect(changes).toEqual([[true, 1000]]);
  });

  test("a launch in flight is not empty", () => {
    const { fallback, changes, state } = rig({ launching: true });
    fallback.observe(1000, 0);
    expect(fallback.active()).toBe(false);
    state.launching = false;
    fallback.observe(1000, 0);
    expect(changes).toEqual([[true, 1000]]);
  });

  test("once per close: a pane appearing again keeps the fallback, so the term never flips back and forth", () => {
    const { fallback, changes } = rig();
    fallback.observe(1000, 0);
    fallback.observe(1000, 1);
    fallback.observe(1000, 0);
    expect(fallback.active()).toBe(true);
    expect(changes).toEqual([[true, 1000]]);
  });

  test("a reopen claims the role plainly again, and a later close must empty afresh", () => {
    const { fallback, changes } = rig();
    fallback.observe(1000, 0);
    fallback.observe(null, 0);
    expect(fallback.active()).toBe(false);
    fallback.observe(5000, 1);
    expect(fallback.active()).toBe(false);
    fallback.observe(5000, 0);
    expect(changes).toEqual([
      [true, 1000],
      [false, 1000],
      [true, 5000],
    ]);
  });

  test("a new close seen without the reopen between drops the old one's fallback before judging the new", () => {
    const { fallback, changes } = rig();
    fallback.observe(1000, 0);
    fallback.observe(5000, 3);
    expect(fallback.active()).toBe(false);
    expect(changes).toEqual([
      [true, 1000],
      [false, 1000],
    ]);
  });
});
