import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * The archivist holds the PSK and, later, every prompt in plaintext
 * (docs/archivist.md, A11), so what it can do is held by what it can load: it
 * reuses the daemon's relay, identity, state and credential modules by import,
 * and never reaches one that spawns, drives tmux, brokers, leads, or writes the
 * queue or the store. The walk is transitive and counts type-only imports, so
 * an allowed module that grows an edge to a forbidden one fails here too.
 */
const ROOT = resolve(import.meta.dir, "../..");

/** daemon/src modules the archivist's import closure may never contain. */
const FORBIDDEN_DAEMON: ReadonlySet<string> = new Set(
  [
    // Spawning and the panes it makes.
    "spawn",
    "despawn",
    "exec",
    "tmux",
    "sessions",
    "backend",
    "backend-default",
    "attachments",
    "handoff",
    "reap",
    "reap-git",
    "launch-ledger",
    "session-events",
    "report-done",
    "usage-refresh",
    "tpmcreds",
    // Acts on the fleet's subscribers, and the leader's floor in the daemon's own state dir; neither reaches exec.ts.
    "web-push",
    "version-floor",
    // Op dispatch and the local socket.
    "handlers",
    "local-socket",
    "local-client",
    // The fleet broker.
    "broker",
    "broker-client",
    "broker-protocol",
    // The leader and every queue or store writer.
    "leader",
    "leader-adapters",
    "leader-requests",
    "queue-store",
    "store-frames",
    "settings-store",
    "fleet-quota",
    "auto",
    "cli-auto",
    // The daemon's own entry points and its config, which reaches the broker's protocol.
    "run",
    "cli",
    "mcp",
    "main",
    "config",
  ].map((name) => `daemon/src/${name}.ts`),
);

/**
 * Calls the archivist's own code may not make: every write the shared app
 * client and the daemon leg's client offer (enqueue, cancel, store, reply,
 * status, scheduler frames), and `execPath`, which nothing may persist.
 */
const WRITE_METHODS =
  "createTask|cancel|markDone|runNow|pause|resume|discard|pushSubscribe|pushUnsubscribe|queueChanged|forget|request|store|broadcast|sendStatus|sendToScheduler|sendBranchState|reply|resign|putAccountAlias|uploadAttachment";
// Dotted call, bracket access, or destructuring: each reaches the same method.
const FORBIDDEN_CALLS = new RegExp(
  String.raw`\.(?:${WRITE_METHODS})\s*\(|\[\s*["'](?:${WRITE_METHODS})["']\s*\]|\{[^}]*\b(?:${WRITE_METHODS})\b[^}]*\}\s*=|\bexecPath\b`,
  "gu",
);

/** Direct process spawning, which would inherit CREDENTIALS_DIRECTORY unstripped (`exec.ts` is what strips it). */
const SPAWN_CALLS = /\bBun\s*\.\s*(?:spawn(?:Sync)?\b|\$)/gu;

export function specifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/gu;
  return [...source.matchAll(pattern)].map((m) => m[1] ?? "");
}

/** A specifier the archivist may not name at all, wherever it sits: the scheduler library, the daemon as a package, or `child_process`. */
export function forbiddenPackage(specifier: string): boolean {
  return /^@seance\/(?:scheduler|daemon)(?:\/|$)/u.test(specifier) || /^(?:node:)?child_process$/u.test(specifier);
}

/** Repo-relative path a relative specifier names from `file`; null for a package. */
function resolveRelative(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return relative(ROOT, resolve(dirname(join(ROOT, file)), specifier));
}

/** Every repo file reachable from `entries` through relative imports, with the package specifiers met on the way. */
export async function closure(
  entries: readonly string[],
  read: (file: string) => Promise<string> = (file) => readFile(join(ROOT, file), "utf8"),
): Promise<{ readonly files: ReadonlySet<string>; readonly packages: ReadonlySet<string> }> {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of specifiers(await read(file))) {
      const target = resolveRelative(file, specifier);
      if (target === null) packages.add(specifier);
      else pending.push(target);
    }
  }
  return { files, packages };
}

/** What a closure breaks: forbidden daemon modules, any path into scheduler/, and forbidden packages. */
export function closureViolations(files: ReadonlySet<string>, packages: ReadonlySet<string>): string[] {
  return [
    ...[...files].filter((file) => FORBIDDEN_DAEMON.has(file) || file.startsWith("scheduler/")),
    ...[...packages].filter(forbiddenPackage),
  ].toSorted();
}

export function spawnCalls(source: string): string[] {
  return [...source.matchAll(SPAWN_CALLS)].map((m) => m[0]);
}

export function forbiddenCalls(source: string): string[] {
  return [...source.matchAll(FORBIDDEN_CALLS)].map((m) => m[0]);
}

async function archivistSources(): Promise<string[]> {
  const entries = await readdir(join(ROOT, "archivist/src"), { recursive: true });
  return entries
    .filter((path) => /\.tsx?$/u.test(path) && !/\.test\.tsx?$/u.test(path))
    .map((path) => `archivist/src/${path}`);
}

describe("archivist layering", () => {
  test("nothing archivist/src loads, however indirectly, spawns, brokers, leads or writes the queue", async () => {
    const entries = await archivistSources();
    expect(entries).toContain("archivist/src/main.ts");
    const { files, packages } = await closure(entries);
    // The reuse is real: the walk does reach into the daemon.
    expect(files).toContain("daemon/src/relay-client.ts");
    expect(closureViolations(files, packages)).toEqual([]);
    const spawners: string[] = [];
    for (const file of files) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of small files
      if (spawnCalls(await readFile(join(ROOT, file), "utf8")).length > 0) spawners.push(file);
    }
    expect(spawners).toEqual([]);
  });

  test("archivist/src makes no write call and names no execPath", async () => {
    const offenders: string[] = [];
    for (const file of await archivistSources()) {
      for (const call of forbiddenCalls(await readFile(join(ROOT, file), "utf8"))) offenders.push(`${file}: ${call}`);
    }
    expect(offenders).toEqual([]);
  });

  test("only archive.ts opens SQLite, and it holds no statement that removes or rewrites history", async () => {
    const sqliteUsers: string[] = [];
    for (const file of await archivistSources()) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of small files
      if (specifiers(await readFile(join(ROOT, file), "utf8")).includes("bun:sqlite")) sqliteUsers.push(file);
    }
    expect(sqliteUsers).toEqual(["archivist/src/archive.ts"]);
    // Append-only (docs/archivist.md, A23): a purge is SQL on the box, never this code.
    const source = await readFile(join(ROOT, "archivist/src/archive.ts"), "utf8");
    expect(source.match(/\b(?:DELETE|DROP|TRUNCATE|REPLACE\s+INTO|INSERT\s+OR\s+REPLACE)\b/giu)).toBeNull();
  });

  test("the walk catches a forbidden module behind an allowed one, a type-only import, and a package", async () => {
    const tree: Record<string, string> = {
      "archivist/src/a.ts": `import { x } from "../../daemon/src/state.ts";`,
      "daemon/src/state.ts": `import type { Y } from "./queue-store.ts";`,
      "daemon/src/queue-store.ts": `import { S } from "@seance/scheduler";`,
    };
    const { files, packages } = await closure(["archivist/src/a.ts"], (file) => Promise.resolve(tree[file] ?? ""));
    expect(closureViolations(files, packages)).toEqual(["@seance/scheduler", "daemon/src/queue-store.ts"]);
    const viaPath = await closure(["archivist/src/b.ts"], (file) =>
      Promise.resolve(file === "archivist/src/b.ts" ? `const m = await import("../../scheduler/src/task.ts");` : ""),
    );
    expect(closureViolations(viaPath.files, viaPath.packages)).toEqual(["scheduler/src/task.ts"]);
    expect(closureViolations(new Set(["daemon/src/relay-client.ts"]), new Set(["@seance/shared"]))).toEqual([]);
  });

  test("the call scan catches writes and execPath, and passes reads", () => {
    expect(forbiddenCalls(`await appLeg.createTask(task);`)).toEqual([".createTask("]);
    expect(forbiddenCalls(`seat.store ({ op: "put" })`)).toHaveLength(1);
    expect(forbiddenCalls(`const bin = process.execPath;`)).toEqual(["execPath"]);
    expect(forbiddenCalls(`appLeg.start(); seat.stop(); appLeg.getState();`)).toEqual([]);
    expect(forbiddenCalls(`await appLeg.putAccountAlias(a);`)).toEqual([".putAccountAlias("]);
    expect(forbiddenCalls(`await appLeg.uploadAttachment(a);`)).toEqual([".uploadAttachment("]);
    expect(forbiddenCalls(`appLeg["createTask"](task);`)).toHaveLength(1);
    expect(forbiddenCalls(`const { createTask } = appLeg;`)).toHaveLength(1);
  });

  test("the process scan catches Bun.spawn, Bun.$ and child_process, and passes other Bun calls", () => {
    expect(spawnCalls("Bun.spawn(['git']); Bun.spawnSync(['git']); Bun.$`ls`;")).toHaveLength(3);
    expect(spawnCalls("Bun.file(path); Bun.write(path, x); Bun.sleep(1);")).toEqual([]);
    expect(forbiddenPackage("node:child_process")).toBe(true);
    expect(forbiddenPackage("child_process")).toBe(true);
    expect(forbiddenPackage("node:fs/promises")).toBe(false);
  });
});
