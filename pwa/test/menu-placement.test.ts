import { describe, expect, test } from "bun:test";
import { menuDirection, menuPlacement } from "../src/menu-placement.ts";

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

describe("menuDirection", () => {
  const panel = 230;

  test("fits below: down", () => {
    expect(menuDirection("down", { top: 10, bottom: 54 }, viewport, panel)).toBe("down");
  });

  test("doesn't fit below but fits above: up", () => {
    expect(menuDirection("down", { top: 600, bottom: 644 + 100 }, viewport, panel)).toBe("up");
  });

  test("fits neither: whichever side has more room", () => {
    const short = { height: 300 };
    expect(menuDirection("down", { top: 200, bottom: 244 }, short, panel)).toBe("up");
    expect(menuDirection("down", { top: 60, bottom: 104 }, short, panel)).toBe("down");
  });

  test("an up request stays up even where it overruns the top", () => {
    expect(menuDirection("up", { top: 20, bottom: 64 }, viewport, panel)).toBe("up");
  });
});
