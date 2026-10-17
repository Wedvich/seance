import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * The placement decision is reversible only while the adapter boundary holds
 * (docs/scheduler.md, Risks): the library may not reach into the daemon, and
 * the daemon may reach the library only through the leader's modules, which
 * host it. Either import makes moving the scheduler to a fixed box the rewrite
 * the design exists to avoid, so it fails here rather than in review.
 */
const ROOT = resolve(import.meta.dir, "../..");
const LEADER_MODULES: ReadonlySet<string> = new Set([
  "daemon/src/leader.ts",
  "daemon/src/leader-adapters.ts",
  "daemon/src/leader-requests.ts",
]);

/** Every module specifier a source names — static, side-effect, re-export and dynamic. */
export function specifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/gu;
  return [...source.matchAll(pattern)].map((m) => m[1] ?? "");
}

/** Which workspace a specifier resolves into, from the file naming it; null outside both. */
function target(file: string, specifier: string): "daemon" | "scheduler" | null {
  if (/^@seance\/daemon(?:\/|$)/u.test(specifier)) return "daemon";
  if (/^@seance\/scheduler(?:\/|$)/u.test(specifier)) return "scheduler";
  if (!specifier.startsWith(".")) return null;
  const top = relative(ROOT, resolve(dirname(join(ROOT, file)), specifier)).split("/")[0];
  return top === "daemon" || top === "scheduler" ? top : null;
}

/** `file` is repo-relative; returns the forbidden specifiers it names. */
export function violations(file: string, source: string): string[] {
  const home = file.split("/")[0];
  return specifiers(source).filter((specifier) => {
    const to = target(file, specifier);
    if (home === "scheduler") return to === "daemon";
    if (home === "daemon") return to === "scheduler" && !LEADER_MODULES.has(file);
    return false;
  });
}

async function sources(workspace: string): Promise<string[]> {
  const entries = await readdir(join(ROOT, workspace), { recursive: true });
  return entries
    .filter((path) => /\.tsx?$/u.test(path) && !path.split("/").includes("node_modules"))
    .map((path) => `${workspace}/${path}`);
}

describe("scheduler ↔ daemon layering", () => {
  test("nothing in scheduler/ imports daemon/, and only the leader's modules in daemon/ import scheduler/", async () => {
    // This file is skipped: its cases below spell forbidden imports out as strings.
    const self = relative(ROOT, import.meta.path);
    const files = [...(await sources("scheduler")), ...(await sources("daemon"))].filter((file) => file !== self);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      const found = violations(file, await readFile(join(ROOT, file), "utf8"));
      for (const specifier of found) offenders.push(`${file}: ${specifier}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the check fails on either forbidden direction, by package name or by path", () => {
    expect(violations("scheduler/src/route.ts", `import { x } from "@seance/daemon";`)).toEqual(["@seance/daemon"]);
    expect(violations("scheduler/src/route.ts", `import { x } from "../../daemon/src/exec.ts";`)).toHaveLength(1);
    expect(violations("scheduler/test/a.ts", `const m = await import("../../daemon/src/run.ts");`)).toHaveLength(1);
    expect(violations("daemon/src/run.ts", `import { Scheduler } from "@seance/scheduler";`)).toHaveLength(1);
    expect(violations("daemon/test/x.test.ts", `export * from "../../scheduler/src/index.ts";`)).toHaveLength(1);
    expect(violations("daemon/src/broker.ts", `import type { Fleet } from "@seance/scheduler";`)).toHaveLength(1);
  });

  test("the allowed edges pass: the leader's modules hosting the library, either side importing shared", () => {
    for (const file of LEADER_MODULES) {
      expect(violations(file, `import { Scheduler } from "@seance/scheduler";`)).toEqual([]);
    }
    expect(violations("scheduler/src/route.ts", `import { effectivePct } from "@seance/shared";`)).toEqual([]);
    expect(violations("daemon/src/run.ts", `import { x } from "./scheduler-ish.ts";`)).toEqual([]);
  });
});
