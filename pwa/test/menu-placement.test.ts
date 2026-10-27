import { describe, expect, test } from "bun:test";
import { menuPlacement } from "../src/menu-placement.ts";

const viewport = { width: 400, height: 800 };

describe("menuPlacement", () => {
  test("down: 6px under the anchor, right edges aligned", () => {
    expect(menuPlacement("down", { top: 10, bottom: 54, right: 384 }, viewport)).toEqual({
      top: 60,
      bottom: null,
      right: 16,
    });
  });

  test("up: 6px above the anchor, pinned from the viewport's bottom", () => {
    expect(menuPlacement("up", { top: 720, bottom: 772, right: 384 }, viewport)).toEqual({
      top: null,
      bottom: 86,
      right: 16,
    });
  });

  test("an anchor flush with the viewport's right edge pins the menu at 0", () => {
    expect(menuPlacement("down", { top: 0, bottom: 44, right: 400 }, viewport).right).toBe(0);
    expect(menuPlacement("up", { top: 756, bottom: 800, right: 400 }, viewport).right).toBe(0);
  });

  test("a mid-screen anchor: down pins by top only, up by bottom only", () => {
    const anchor = { top: 380, bottom: 424, right: 200 };
    expect(menuPlacement("down", anchor, viewport)).toEqual({ top: 430, bottom: null, right: 200 });
    expect(menuPlacement("up", anchor, viewport)).toEqual({ top: null, bottom: 426, right: 200 });
  });
});
