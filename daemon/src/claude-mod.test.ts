import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { modChecksFrom, parseMarketplace, readMarketplace, realCheckoutRoot } from "./claude-mod.ts";

const MARKET = { name: "seance", plugins: [{ name: "tmux-rename", source: "./claude-mods/tmux-rename" }] };
const ROOT = "/repos/seance";
const listed = (extra: Record<string, unknown> = {}): unknown => [
  { id: "tmux-rename@seance", enabled: true, readFromFolder: join(ROOT, "claude-mods/tmux-rename"), ...extra },
];

describe("modChecksFrom", () => {
  test("ok when installed, enabled and read from this checkout", () => {
    expect(modChecksFrom(MARKET, ROOT, listed())).toEqual([
      { level: "ok", message: "Claude mod tmux-rename installed" },
    ]);
  });

  test("warns, with the remedy, when not installed — or when claude printed no list", () => {
    for (const output of [[], [{ id: "tmux-rename@elsewhere" }], { not: "a list" }]) {
      const [check] = modChecksFrom(MARKET, ROOT, output);
      expect(check?.level).toBe("warn");
      expect(check?.message).toContain("seanced mod install");
    }
  });

  test("warns when read from another clone — the stale-checkout hazard", () => {
    const [check] = modChecksFrom(MARKET, ROOT, listed({ readFromFolder: "/old/seance/claude-mods/tmux-rename" }));
    expect(check?.level).toBe("warn");
    expect(check?.message).toContain("/old/seance");
    expect(check?.message).toContain("repoints it");
  });

  test("warns when disabled in Claude Code", () => {
    const [check] = modChecksFrom(MARKET, ROOT, listed({ enabled: false }));
    expect(check?.level).toBe("warn");
    expect(check?.message).toContain("disabled");
  });
});

describe("marketplace file", () => {
  test("this checkout's parses, and every listed mod has a manifest by its name", async () => {
    const root = await realCheckoutRoot();
    const market = await readMarketplace(root);
    expect(market.plugins.length).toBeGreaterThan(0);
    for (const plugin of market.plugins) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of small reads
      const manifest: unknown = await Bun.file(join(root, plugin.source, ".claude-plugin", "plugin.json")).json();
      expect(manifest).toMatchObject({ name: plugin.name });
    }
  });

  test("a malformed one is refused, not half-read", () => {
    expect(() => parseMarketplace('{"plugins": []}')).toThrow("expected a name");
    expect(() => parseMarketplace('{"name": "x", "plugins": [{"name": "y"}]}')).toThrow("relative source");
  });
});
