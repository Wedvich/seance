import { describe, expect, test } from "bun:test";
import { adapterChecks, type AdapterCheckDeps } from "./adapter-checks.ts";
import type { AdapterView } from "./adapter-control.ts";
import type { ManifestRead } from "./adapter-manifest.ts";
import type { AdapterConfig } from "./config.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
// A word that exists: an absolute argv word that is gone is a warning of its own.
const ARGV = ["bun", import.meta.path] as const;

const manifest = (name = "chat", argv: readonly string[] = ARGV): ManifestRead => ({
  ok: true,
  manifest: { name, protocol: 1, argv: ["bun", "src/main.ts"] },
  dir: "/src/chat",
  argv,
});

const entry = (extra: Partial<AdapterConfig> = {}): AdapterConfig => ({
  argv: [...ARGV],
  kinds: ["note"],
  dir: "/src/chat",
  commit: A,
  ...extra,
});

async function checks(config: AdapterConfig, deps: AdapterCheckDeps = {}): Promise<readonly string[]> {
  const out = await adapterChecks(
    { chat: config },
    { which: () => "/usr/bin/bun", commitOf: async () => A, manifestOf: async () => manifest(), ...deps },
  );
  return out.map((check) => `${check.level} ${check.message}`);
}

describe("doctor's adapter checks", () => {
  test("a checkout still at the recorded commit is ok", async () => {
    const lines = await checks(entry());
    expect(lines.filter((line) => !line.startsWith("ok "))).toEqual([]);
    expect(lines).toContain(`ok chat: checkout at ${A.slice(0, 12)}, as added`);
  });

  test("a checkout that moved is a warning naming both commits, never a failure", async () => {
    const lines = await checks(entry(), { commitOf: async () => B });
    expect(lines.filter((line) => line.startsWith("warn "))).toEqual([
      `warn chat: its checkout moved since \`seance adapter add\` (${A.slice(0, 12)} → ${B.slice(0, 12)}): the daemon runs that code from its next start — review it, then \`seance adapter add /src/chat\` records it`,
    ]);
    expect(lines.some((line) => line.startsWith("fail "))).toBe(false);
  });

  test("a checkout no longer in git, a renamed or changed manifest, and a broken one each warn", async () => {
    expect(await checks(entry(), { commitOf: async () => null })).toContainEqual(
      expect.stringMatching(/^warn chat: \/src\/chat is no longer a git checkout/u),
    );
    expect(await checks(entry(), { manifestOf: async () => manifest("other") })).toContainEqual(
      expect.stringContaining('now names "other"'),
    );
    expect(await checks(entry(), { manifestOf: async () => manifest("chat", ["node", "x.js"]) })).toContainEqual(
      expect.stringContaining("argv changed"),
    );
    expect(await checks(entry(), { manifestOf: async () => ({ ok: false, message: "gone" }) })).toContain(
      "warn chat: gone",
    );
  });

  test("a hand-written entry has nothing to compare; a missing program fails or warns by how it is named", async () => {
    const hand = await checks({ argv: ["/nonexistent/adapter"], kinds: ["note"] });
    expect(hand).toContain("ok chat: written by hand (no dir recorded): no manifest or commit to check");
    expect(hand).toContain("fail chat: /nonexistent/adapter is missing or not executable — the daemon cannot start it");
    expect(await checks(entry(), { which: () => null })).toContainEqual(
      expect.stringMatching(/^warn chat: bun is not on this shell's PATH/u),
    );
    expect(await checks(entry({ commit: undefined }))).toContainEqual(expect.stringContaining("no commit is recorded"));
  });

  test("a live adapter held as failed or refused points at `seance adapter restart`", async () => {
    const live = (state: AdapterView["state"]): AdapterCheckDeps => ({
      view: {
        pid: 1,
        at: 0,
        adapters: {
          chat: {
            state,
            exits: 5,
            fingerprint: "0".repeat(64),
            restarts: 0,
            delivered: 0,
            messages: 0,
            lastExit: { at: 0, code: null, reason: "protocol" },
          },
        },
      },
    });
    expect(await checks(entry(), live("failed"))).toContainEqual(
      expect.stringContaining("seance adapter restart chat"),
    );
    expect(await checks(entry(), live("refused"))).toContainEqual(expect.stringContaining("refused (protocol)"));
    expect((await checks(entry(), live("running"))).some((line) => line.startsWith("warn "))).toBe(false);
  });
});
