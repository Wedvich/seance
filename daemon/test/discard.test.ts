import { describe, expect, test } from "bun:test";
import { MemoryQueueStore } from "../src/leader.ts";
import { VersionFloor } from "../src/version-floor.ts";
import { captureLog } from "./fixtures.ts";
import { task, withLeader } from "./term-fixture.ts";

// S2 of the M3 review: records no reader can use — a token holder's junk, or
// tasks sealed under an old PSK — are never deleted unasked, so a person must
// be able to: `discard`, at the version the queue listed.

describe("discard", () => {
  test("deletes an unreadable record at the version listed, audited, and frees its slot for a create", async () => {
    const store = new MemoryQueueStore({ maxTasks: 2 });
    store.plant("junk", "unopenable", 3);
    await store.put("real", 0, task("real", { state: "done" }));
    const lines = await captureLog(async () => {
      await withLeader(store, VersionFloor.memory(), async ({ lead, ask, queue }) => {
        await lead(1);
        expect((await queue()).unreadable).toEqual([{ taskId: "junk", version: 3, reason: "unopenable" }]);
        expect(await store.put("new", 0, task("new"))).toEqual({ ok: false, code: "store_full" });

        expect(await ask("discard", { taskId: "junk", version: 3 })).toEqual({ taskId: "junk" });
        expect(await store.get("junk")).toBeNull();
        expect((await queue()).unreadable).toBeUndefined();
        expect(await store.put("new", 0, task("new"))).toEqual({ ok: true, version: 1 });
      });
    });
    expect(lines).toContainEqual(expect.stringContaining('audit queue origin=relay op=discard id="'));
    expect(lines).toContainEqual(expect.stringContaining('task="junk" version=3 ok'));
  });

  test("never a readable task, nor a record at another version than the one asked for, nor a malformed ask", async () => {
    const store = new MemoryQueueStore();
    store.plant("junk", "unopenable", 3);
    await store.put("real", 0, task("real", { state: "done" }));
    const lines = await captureLog(async () => {
      await withLeader(store, VersionFloor.memory(), async ({ lead, ask }) => {
        await lead(1);
        expect(await ask("discard", { taskId: "real", version: 1 })).toMatchObject({
          ok: false,
          code: "task_not_found",
        });
        expect(await ask("discard", { taskId: "junk", version: 2 })).toMatchObject({ ok: false, code: "conflict" });
        expect(await ask("discard", { taskId: "junk" })).toMatchObject({ ok: false, code: "invalid_request" });
      });
    });
    expect(await store.get("real")).toMatchObject({ version: 1 });
    expect(await store.get("junk")).toMatchObject({ version: 3, reason: "unopenable" });
    expect(lines).toContainEqual(expect.stringContaining('op=discard id="'));
    expect(lines).toContainEqual(expect.stringContaining('task="junk" refused code=conflict'));
  });
});
