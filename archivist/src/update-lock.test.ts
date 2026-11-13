import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_LOCK_STALE_MS, withUpdateLock } from "./update-lock.ts";

let dir: string;
let seq = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "archivist-update-lock-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
const fresh = (): string => join(dir, `lock-${seq++}`);

describe("withUpdateLock", () => {
  test("holds the lock while it runs and releases it after, even on a throw", async () => {
    const path = fresh();
    const inside = await withUpdateLock(path, async () => (await readFile(path, "utf8")).trim());
    expect(inside).toBe(String(process.pid));
    await expect(readFile(path, "utf8")).rejects.toThrow();
    await expect(
      withUpdateLock(path, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withUpdateLock(path, async () => "again")).toBe("again");
  });

  test("a second taker is turned away while the first runs", async () => {
    const path = fresh();
    const second = await withUpdateLock(path, () => withUpdateLock(path, async () => "ran"));
    expect(second).toBeNull();
  });

  test("a dead holder's lock, or one older than the timeout, is taken over", async () => {
    const dead = fresh();
    // A pid above pid_max cannot be alive.
    await writeFile(dead, "4194999\n");
    expect(await withUpdateLock(dead, async () => "ran")).toBe("ran");

    const old = fresh();
    await writeFile(old, `${process.pid}\n`);
    const past = new Date(Date.now() - UPDATE_LOCK_STALE_MS - 60_000);
    await utimes(old, past, past);
    expect(await withUpdateLock(old, async () => "ran")).toBe("ran");
  });

  test("a live holder's recent lock is respected", async () => {
    const path = fresh();
    await writeFile(path, `${process.pid}\n`);
    expect(await withUpdateLock(path, async () => "ran")).toBeNull();
  });
});
