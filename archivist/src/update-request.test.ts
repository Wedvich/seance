import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, open, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateRequester, readRequestOrigin, runWhileRequested } from "./update-request.ts";

let dir: string;
let seq = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "archivist-update-request-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fresh = (): string => join(dir, `request-${seq++}`);

describe("update requests", () => {
  test("an announce writes once per sha, 0600, and reads back as announce", async () => {
    const path = fresh();
    const requester = createUpdateRequester({ path });
    await requester.announce("a".repeat(40));
    expect(await readFile(path, "utf8")).toBe(`announce ${"a".repeat(40)}\n`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readRequestOrigin(path)).toBe("announce");

    await rm(path);
    await requester.announce("a".repeat(40));
    expect(await Bun.file(path).exists()).toBe(false);
    await requester.announce("b".repeat(40));
    expect(await readFile(path, "utf8")).toBe(`announce ${"b".repeat(40)}\n`);
  });

  // `PathChanged=` fires on the file's create, so a reader can open it at any instant of a write: it must
  // get a whole request, never the empty file a create-then-write leaves between its two syscalls.
  test("a request replaces the file whole, so a reader that opened the last one never sees it truncated", async () => {
    const path = fresh();
    const requester = createUpdateRequester({ path, debounceMs: 0 });
    await requester.registered();
    const reader = await open(path, "r");
    try {
      await requester.announce("c".repeat(40));
      expect(await reader.readFile("utf8")).toBe("register\n");
    } finally {
      await reader.close();
    }
    expect(await readFile(path, "utf8")).toBe(`announce ${"c".repeat(40)}\n`);

    // Two at once share the one `.part`: each lands whole, in the order asked.
    await Promise.all([requester.announce("d".repeat(40)), requester.registered()]);
    expect(await readFile(path, "utf8")).toBe("register\n");
    expect(await Bun.file(`${path}.part`).exists()).toBe(false);
  });

  test("a sha that is not hex is never written into the file", async () => {
    const path = fresh();
    await createUpdateRequester({ path }).announce("main\nregister");
    expect(await readFile(path, "utf8")).toBe("announce\n");
  });

  test("a connect asks at once, then not again inside the debounce", async () => {
    const path = fresh();
    let clock = 1_000;
    const requester = createUpdateRequester({ path, debounceMs: 100, now: () => clock });
    await requester.registered();
    expect(await readRequestOrigin(path)).toBe("register");
    await rm(path);
    clock += 99;
    await requester.registered();
    expect(await Bun.file(path).exists()).toBe(false);
    clock += 1;
    await requester.registered();
    expect(await readFile(path, "utf8")).toBe("register\n");
  });

  test("a first connect inside the debounce of a request already on disk asks nothing (a crash loop)", async () => {
    const path = fresh();
    let clock = 10_000;
    const askedAt = (): Promise<number | null> => Promise.resolve(9_950);
    const requester = createUpdateRequester({ path, debounceMs: 100, now: () => clock, askedAt });
    await requester.registered();
    expect(await Bun.file(path).exists()).toBe(false);
    clock += 50;
    await requester.registered();
    expect(await readFile(path, "utf8")).toBe("register\n");
    // An older request, or none, lets a fresh process ask at once.
    const olderPath = fresh();
    const older = createUpdateRequester({
      path: olderPath,
      debounceMs: 100,
      now: () => clock,
      askedAt: () => Promise.resolve(1),
    });
    await older.registered();
    expect(await Bun.file(olderPath).exists()).toBe(true);
  });

  test("an absent or unrecognised file reads as announce", async () => {
    expect(await readRequestOrigin(join(dir, "never-written"))).toBe("announce");
    const path = fresh();
    await Bun.write(path, "registered elsewhere\n");
    expect(await readRequestOrigin(path)).toBe("announce");
  });
});

describe("runWhileRequested", () => {
  test("runs once when the request file is untouched, and again for each write during a run", async () => {
    const path = fresh();
    let runs = 0;
    await runWhileRequested(path, async () => {
      runs++;
    });
    expect(runs).toBe(1);

    const results: number[] = [];
    await runWhileRequested(path, async () => {
      results.push(results.length);
      // A write lands while the first two runs are going, none during the third.
      if (results.length <= 2) await Bun.write(path, `announce ${results.length}\n`);
    });
    expect(results).toEqual([0, 1, 2]);
  });

  test("a rewrite of the same text still counts as a request", async () => {
    const path = fresh();
    await Bun.write(path, "register\n");
    // File times tick coarsely (about 4 ms), so age the first write rather than sleeping.
    await utimes(path, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
    let runs = 0;
    await runWhileRequested(path, async () => {
      runs++;
      if (runs === 1) await writeFile(path, "register\n");
    });
    expect(runs).toBe(2);
  });

  test("stops at max runs however often it is written", async () => {
    const path = fresh();
    let runs = 0;
    await runWhileRequested(
      path,
      async () => {
        runs++;
        await Bun.write(path, `announce ${runs}\n`);
      },
      2,
    );
    expect(runs).toBe(2);
  });
});
