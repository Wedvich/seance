import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const screen = readFileSync(new URL("../src/screen.css", import.meta.url), "utf8").replaceAll(/\/\*[\s\S]*?\*\//gu, "");

/** The declarations of the one top-level rule whose selector is exactly `selector`. */
function declarations(selector: string): string {
  const match = new RegExp(`(?:^|\\})\\s*${selector.replaceAll(".", "\\.")}\\s*\\{([^}]*)\\}`, "u").exec(screen);
  if (match?.[1] === undefined) throw new Error(`no rule for ${selector}`);
  return match[1];
}

/**
 * A waiting ring can be on screen for hours (a task behind the in-flight caps),
 * and an endless one keeps the compositor producing frames the whole time.
 */
describe("the waiting rings", () => {
  for (const ring of ["relay-sonar", "stage-sonar"]) {
    test(`.${ring} swells a few times, then rests still`, () => {
      const body = declarations(`.${ring}`);
      expect(body).not.toContain("infinite");
      const animation = /animation:([^;]*);/u.exec(body)?.[1] ?? "";
      const [swell, rest] = animation.split(",").map((part) => part.trim());
      expect(swell).toStartWith(`${ring} `);
      expect(swell).toEndWith("forwards");
      // The rest is listed last so it wins once it starts, and starts when the swells end.
      expect(rest).toStartWith(`${ring}-rest `);
      expect(rest).toContain("calc(var(--sonar-cycle) * var(--sonar-cycles))");
      expect(rest).toEndWith("forwards");
      expect(screen).toContain(`@keyframes ${ring}-rest`);
    });
  }
});
