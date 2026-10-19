import { describe, expect, test } from "bun:test";
import { centeredScrollTop } from "../src/scroll.ts";

const container = { top: 100, height: 300, scrollTop: 0, scrollHeight: 1000 };

describe("centeredScrollTop", () => {
  test("centres a mid-list item", () => {
    // Content offset 500, 300px viewport, 50px row.
    expect(centeredScrollTop(container, { top: 600, height: 50 })).toBe(375);
  });

  test("clamps to the top for an item near the start", () => {
    expect(centeredScrollTop(container, { top: 110, height: 50 })).toBe(0);
  });

  test("clamps to the bottom for an item near the end", () => {
    expect(centeredScrollTop(container, { top: 1000, height: 50 })).toBe(700);
  });

  test("accounts for an existing scroll offset", () => {
    expect(centeredScrollTop({ ...container, scrollTop: 200 }, { top: 400, height: 50 })).toBe(375);
  });

  test("never goes negative when the list fits without scrolling", () => {
    expect(centeredScrollTop({ ...container, scrollHeight: 300 }, { top: 250, height: 50 })).toBe(0);
  });
});
