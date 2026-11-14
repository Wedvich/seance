import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * The archivist holds the PSK and, later, every prompt in plaintext
 * (DESIGN.md, Archivist, A11), so what it can do is held by what it can load: it
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
 * The admin commands (`install --system`, `uninstall --system`, `update`) run
 * systemctl, getent, setpriv, systemd-creds, git and `bun install` through the
 * daemon's exec path, in processes that are never handed the key: root's install
 * from a shell, and `update` from a shell or its own unit, which loads no
 * credential. `main.ts` reaches them only by `import()` in their own branches, so
 * the `run` process — the key holder — never loads them, and the walk below
 * holds the service's closure to what it was before they existed.
 */
const ADMIN_MODULES: ReadonlySet<string> = new Set(
  ["install", "self-update", "units"].map((name) => `archivist/src/${name}.ts`),
);

/**
 * What the admin closure may load of FORBIDDEN_DAEMON: the exec path and the
 * systemd-creds wrapper (`blobLoadable`), and two type-only modules `audit.ts`
 * names for its line formats. Never a module that spawns a session, drives
 * tmux, dispatches ops, brokers, leads or writes the queue or the store.
 */
const ADMIN_MAY_LOAD: ReadonlySet<string> = new Set(
  ["exec", "tpmcreds", "backend", "broker-protocol"].map((name) => `daemon/src/${name}.ts`),
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

/** Imports of `file` (by basename) that load it at runtime: not `import type`, and `import()` included. */
export function valueImportsOf(source: string, file: string): string[] {
  const name = file.replaceAll(".", String.raw`\.`);
  const statics = new RegExp(String.raw`^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s*["'][^"']*/${name}["']`, "gmu");
  const dynamic = new RegExp(String.raw`\bimport\s*\(\s*["'][^"']*/${name}["']`, "gu");
  return [...source.matchAll(statics), ...source.matchAll(dynamic)].map((m) => m[0].trim());
}

/** The `import("…")` subset of `specifiers`: loaded only when that line runs. */
export function dynamicSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/gu)].map((m) => m[1] ?? "");
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

/**
 * Every repo file reachable from `entries` through relative imports, with the
 * package specifiers met on the way. `stop` names files the walk never enters —
 * the admin modules, for the service's closure.
 */
export async function closure(
  entries: readonly string[],
  read: (file: string) => Promise<string> = (file) => readFile(join(ROOT, file), "utf8"),
  stop: ReadonlySet<string> = new Set(),
): Promise<{ readonly files: ReadonlySet<string>; readonly packages: ReadonlySet<string> }> {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file) || stop.has(file)) continue;
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

const REMOVING = String.raw`\b(?:DELETE|DROP|TRUNCATE|REPLACE\s+INTO|INSERT\s+OR\s+REPLACE)\b`;

function removing(source: string, tail = ""): RegExpMatchArray | null {
  return source.match(new RegExp(REMOVING + tail, "giu"));
}

async function archivistSources(): Promise<string[]> {
  const entries = await readdir(join(ROOT, "archivist/src"), { recursive: true });
  return entries
    .filter((path) => /\.tsx?$/u.test(path) && !/\.test\.tsx?$/u.test(path))
    .map((path) => `archivist/src/${path}`);
}

async function spawnersIn(files: ReadonlySet<string>): Promise<string[]> {
  const spawners: string[] = [];
  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of small files
    if (spawnCalls(await readFile(join(ROOT, file), "utf8")).length > 0) spawners.push(file);
  }
  return spawners.toSorted();
}

describe("archivist layering", () => {
  test("nothing the service loads, however indirectly, spawns, brokers, leads or writes the queue", async () => {
    const entries = (await archivistSources()).filter((file) => !ADMIN_MODULES.has(file));
    expect(entries).toContain("archivist/src/main.ts");
    expect(entries).toContain("archivist/src/run.ts");
    const { files, packages } = await closure(entries, undefined, ADMIN_MODULES);
    // The reuse is real: the walk does reach into the daemon.
    expect(files).toContain("daemon/src/relay-client.ts");
    expect(closureViolations(files, packages)).toEqual([]);
    expect(await spawnersIn(files)).toEqual([]);
  });

  test("the admin modules are reached only by main.ts's import(), never a static import", async () => {
    const sources = await archivistSources();
    // Every admin module is named here; a new one that is not would be walked as service code and fail above.
    for (const admin of ADMIN_MODULES) expect(sources).toContain(admin);
    const offenders: string[] = [];
    for (const file of sources.filter((source) => !ADMIN_MODULES.has(source))) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of small files
      const source = await readFile(join(ROOT, file), "utf8");
      const all = specifiers(source);
      const dynamic = dynamicSpecifiers(source);
      for (const specifier of new Set(all)) {
        const target = relative(ROOT, resolve(dirname(join(ROOT, file)), specifier));
        if (!ADMIN_MODULES.has(target)) continue;
        // One static import beside any number of dynamic ones still loads it at start.
        const count = (list: readonly string[]): number => list.filter((s) => s === specifier).length;
        if (file !== "archivist/src/main.ts" || count(all) > count(dynamic)) offenders.push(`${file} → ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the admin commands load the exec path, but nothing that spawns a session, brokers, leads or writes", async () => {
    const { files, packages } = await closure([...ADMIN_MODULES]);
    expect(files).toContain("daemon/src/systemd.ts");
    expect(files).toContain("daemon/src/update.ts");
    expect(closureViolations(files, packages).filter((file) => !ADMIN_MAY_LOAD.has(file))).toEqual([]);
    // exec.ts is the one spawner, and it strips CREDENTIALS_DIRECTORY from every child.
    expect(await spawnersIn(files)).toEqual(["daemon/src/exec.ts"]);
  });

  test("the admin closure names backend.ts and broker-protocol.ts only as `import type`", async () => {
    const { files } = await closure([...ADMIN_MODULES]);
    const offenders: string[] = [];
    for (const file of files) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of small files
      const source = await readFile(join(ROOT, file), "utf8");
      for (const name of ["backend", "broker-protocol"]) {
        for (const specifier of valueImportsOf(source, `${name}.ts`)) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(valueImportsOf(`import { X } from "./backend.ts";`, "backend.ts")).toHaveLength(1);
    expect(valueImportsOf(`import type { X } from "./backend.ts";`, "backend.ts")).toEqual([]);
    expect(valueImportsOf(`import {\n  a,\n} from "./backend.ts";`, "backend.ts")).toHaveLength(1);
    expect(valueImportsOf(`await import("./backend.ts");`, "backend.ts")).toHaveLength(1);
  });

  test("archivist/src makes no write call and names no execPath", async () => {
    const offenders: string[] = [];
    for (const file of await archivistSources()) {
      for (const call of forbiddenCalls(await readFile(join(ROOT, file), "utf8"))) offenders.push(`${file}: ${call}`);
    }
    expect(offenders).toEqual([]);
  });

  test("only archive.ts and metrics-archive.ts open SQLite, and neither holds a statement that removes history", async () => {
    const sqliteUsers: string[] = [];
    for (const file of await archivistSources()) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of small files
      if (specifiers(await readFile(join(ROOT, file), "utf8")).includes("bun:sqlite")) sqliteUsers.push(file);
    }
    expect(sqliteUsers.toSorted()).toEqual(["archivist/src/archive.ts", "archivist/src/metrics-archive.ts"]);
    // Append-only (DESIGN.md, Archivist, A23): a purge is SQL on the box, never this code. The metrics tiers'
    // retention (A22) is the one prune, and it is the daemon's own module's, not a statement here.
    // Comments are stripped first: one saying "never delete" is not a statement.
    const sources = await Promise.all(
      sqliteUsers
        .toSorted()
        .map(async (file) =>
          (await readFile(join(ROOT, file), "utf8")).replaceAll(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gmu, ""),
        ),
    );
    const [archive = "", metrics = ""] = sources;
    expect(removing(metrics)).toBeNull();
    // The one exception: migration 2's rebuild drops the old `tasks` only after copying every row and checking the
    // count (SQLite cannot alter a CHECK), so it moves history and removes none. Pinned to that exact statement,
    // beside the `wal_checkpoint(TRUNCATE)` that follows a migrating open (it empties the log file, no row).
    expect(removing(archive, '[^;`"]*')).toEqual(["DROP TABLE tasks", "TRUNCATE)"]);
    // And an event is never rewritten, whatever else UPDATE touches.
    expect(sources.join("\n").match(/\bUPDATE\s+events\b/giu)).toBeNull();
  });

  test("bun:sqlite reaches the archivist only through its two files and the shared tiers' type", async () => {
    const { files } = await closure(await archivistSources());
    const users: string[] = [];
    for (const file of files) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of small files
      if (specifiers(await readFile(join(ROOT, file), "utf8")).includes("bun:sqlite")) users.push(file);
    }
    // metrics-tiers.ts takes the Database it is handed (a type import); metrics-store.ts, which opens the daemon's own file, is not here.
    expect(users.toSorted()).toEqual([
      "archivist/src/archive.ts",
      "archivist/src/metrics-archive.ts",
      "daemon/src/metrics-tiers.ts",
    ]);
  });

  test("the archive's tiers are built pulled, and the one replacing rollup is the unguarded branch", async () => {
    const archive = await readFile(join(ROOT, "archivist/src/metrics-archive.ts"), "utf8");
    expect(archive).toMatch(/new TieredMetrics\(db, \{[^}]*\bpulled: true\b/u);
    const tiers = (await readFile(join(ROOT, "daemon/src/metrics-tiers.ts"), "utf8")).replaceAll(
      /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gmu,
      "",
    );
    // Only `rollupSql`'s `if (!guarded)` statement replaces a row, and `pulled: true` is what keeps the archive off it.
    expect(tiers.match(/\bINSERT OR REPLACE\b/gu)).toHaveLength(1);
    expect(tiers.match(/\bREPLACE\b/gu)).toHaveLength(1);
  });

  test("the archive's metrics prune only through the shared tiers' two horizon deletes", async () => {
    const source = await readFile(join(ROOT, "archivist/src/metrics-archive.ts"), "utf8");
    expect(specifiers(source)).toContain("../../daemon/src/metrics-tiers.ts");
    const tiers = (await readFile(join(ROOT, "daemon/src/metrics-tiers.ts"), "utf8")).replaceAll(
      /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gmu,
      "",
    );
    // The two horizon prunes, and nothing else that removes a row.
    expect(tiers.match(/\bDELETE\b[^"`]*/gu)).toEqual(["DELETE FROM raw WHERE ts < ?", "DELETE FROM m5 WHERE ts < ?"]);
    expect(tiers.match(/\b(?:DROP|TRUNCATE)\b/gu)).toBeNull();
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

  test("the walk stops at an admin module, and the dynamic scan sees only import()", async () => {
    const tree: Record<string, string> = {
      "archivist/src/main.ts": `const { x } = await import("./install.ts");`,
      "archivist/src/install.ts": `import { exec } from "../../daemon/src/exec.ts";`,
    };
    const read = (file: string): Promise<string> => Promise.resolve(tree[file] ?? "");
    const { files } = await closure(["archivist/src/main.ts"], read, ADMIN_MODULES);
    expect([...files]).toEqual(["archivist/src/main.ts"]);
    expect(dynamicSpecifiers(`import { a } from "./install.ts"; await import("./install.ts");`)).toEqual([
      "./install.ts",
    ]);
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
