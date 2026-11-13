import { describe, expect, test } from "bun:test";
import { lockedSheetHeight, viewportInsets } from "../src/viewport.ts";

describe("viewportInsets", () => {
  test("is null when the visual viewport covers the layout one", () => {
    expect(viewportInsets({ offsetTop: 0, height: 844 }, 844)).toBeNull();
  });

  test("ignores a sub-pixel shortfall", () => {
    expect(viewportInsets({ offsetTop: 0, height: 843.4 }, 844)).toBeNull();
  });

  test("a keyboard leaves its height below", () => {
    expect(viewportInsets({ offsetTop: 0, height: 460 }, 844)).toEqual({ top: 0, bottom: 384 });
  });

  test("a panned viewport also leaves room above", () => {
    expect(viewportInsets({ offsetTop: 120, height: 460 }, 844)).toEqual({ top: 120, bottom: 264 });
  });

  test("a negative offset clamps to zero", () => {
    expect(viewportInsets({ offsetTop: -30, height: 460 }, 844)).toEqual({ top: 0, bottom: 384 });
  });

  test("a visual height past the layout viewport gives no bottom inset", () => {
    expect(viewportInsets({ offsetTop: 100, height: 800 }, 844)).toEqual({ top: 100, bottom: 0 });
  });
});

describe("lockedSheetHeight", () => {
  test("keeps content that fits", () => {
    expect(lockedSheetHeight(300, 844)).toBe(300);
  });

  test("caps taller content at 74% of the layout viewport", () => {
    expect(lockedSheetHeight(900, 1000)).toBe(740);
  });
});
