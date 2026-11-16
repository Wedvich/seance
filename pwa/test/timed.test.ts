import { describe, expect, test } from "bun:test";
import { formatStamp, plain, timed, type Timed } from "../src/timed.ts";
import { tipPlacement } from "../src/tip-placement.ts";

const AT = Date.UTC(2026, 9, 6, 15, 44, 26);
const ago = { text: "6w ago", at: AT };

describe("timed", () => {
  test("keeps a moment whole between the text around it, and reads back as that text", () => {
    const line = timed`cache · ${ago} on ${"WSL"}`;
    expect(line).toEqual(["cache · ", ago, " on WSL"]);
    expect(plain(line)).toBe("cache · 6w ago on WSL");
  });

  test("splices a nested line in place, so an empty one leaves no part behind", () => {
    const none: Timed = timed``;
    expect(none).toEqual([]);
    expect(timed`running${none}.`).toEqual(["running."]);
    expect(timed`running${timed` — asleep since ${ago}`}.`).toEqual(["running — asleep since ", ago, "."]);
  });

  test("a line of one moment has no empty text beside it", () => {
    expect(timed`${ago}`).toEqual([ago]);
  });
});

describe("formatStamp", () => {
  // Shape only: the words and separators are the runtime's ICU data, which differs between machines.
  test("is a 24-hour clock to the second, whatever the runtime's locale", () => {
    const stamp = formatStamp(AT);
    expect(stamp).toContain("2026");
    expect(stamp).toMatch(/\b\d{2}:44:26$/u);
    expect(stamp).not.toMatch(/AM|PM/iu);
  });
});

describe("tipPlacement", () => {
  const tip = { width: 200, height: 30 };

  test("centres above the anchor", () => {
    const anchor = { left: 400, top: 300, bottom: 316, width: 60 };
    expect(tipPlacement(anchor, tip, 1000)).toEqual({ left: 330, top: 264, side: "above" });
  });

  test("drops below when there is no room above", () => {
    const anchor = { left: 400, top: 20, bottom: 36, width: 60 };
    expect(tipPlacement(anchor, tip, 1000)).toEqual({ left: 330, top: 42, side: "below" });
  });

  test("slides in from either viewport edge rather than clipping", () => {
    expect(tipPlacement({ left: 4, top: 300, bottom: 316, width: 40 }, tip, 1000).left).toBe(8);
    expect(tipPlacement({ left: 950, top: 300, bottom: 316, width: 40 }, tip, 1000).left).toBe(792);
  });
});
