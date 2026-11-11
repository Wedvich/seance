import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

/**
 * Chrome Android scales text with the OS font size only through `<meta name="text-scale">`,
 * which scales 1rem. A px font-size passes every other check and silently stops scaling there.
 */
const SRC = new URL("../src/", import.meta.url);

/** Icon glyphs centred in fixed tap targets: scaling one would overflow its box. */
const FIXED_GLYPHS = new Set([".attach-remove", ".verdict-glyph", ".stage-dot", ".preview-refresh", ".queue-refresh"]);

function stylesheets(): ReadonlyArray<readonly [string, string]> {
  return readdirSync(SRC)
    .filter((name) => name.endsWith(".css"))
    .map((name) => [name, readFileSync(new URL(name, SRC), "utf8").replaceAll(/\/\*[\s\S]*?\*\//gu, "")] as const);
}

describe("OS text scale", () => {
  test("the page opts in", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain('<meta name="text-scale" content="scale" />');
  });

  test("text is sized in rem, outside the fixed glyphs", () => {
    const offenders = stylesheets().flatMap(([name, css]) =>
      [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
        .filter(([, , body]) => /(?:font-size|line-height)\s*:[^;]*\dpx/u.test(body ?? ""))
        .map(([, selector]) => (selector ?? "").trim())
        .filter((selector) => !FIXED_GLYPHS.has(selector))
        .map((selector) => `${name}: ${selector}`),
    );
    expect(offenders).toEqual([]);
  });

  test("no absolute root font-size overrides the scale", () => {
    const roots = stylesheets().flatMap(([name, css]) =>
      [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
        .filter(([, selector]) => /(?:^|,)\s*(?:html|:root)\b/u.test(selector ?? ""))
        .filter(([, , body]) => /font-size\s*:[^;]*\d(?:px|pt)/u.test(body ?? ""))
        .map(([, selector]) => `${name}: ${(selector ?? "").trim()}`),
    );
    expect(roots).toEqual([]);
  });
});
