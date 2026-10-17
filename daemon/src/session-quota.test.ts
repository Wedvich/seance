import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_QUOTA_MAX_AGE_S, SessionQuota } from "./session-quota.ts";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-squota-"));
  path = join(dir, "state", "session-quota.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const nowS = 2_000_000_000;
const nowMs = nowS * 1000;

describe("SessionQuota", () => {
  test("keeps the newest per exclave, and a restart reads it back owner-only", async () => {
    const quota = await SessionQuota.open(path, nowMs);
    quota.record("work", "org:a", { s: "session", at: nowS - 10, h: 5, hr: nowS + 3600 });
    quota.record("work", "org:a", { s: "session", at: nowS - 20, h: 99 });
    quota.record("default", null, { s: "session", at: nowS - 5, d: 7 });
    expect(quota.get("work", "org:a")?.h).toBe(5);
    await quota.flushed();
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const reopened = await SessionQuota.open(path, nowMs);
    expect(reopened.get("work", "org:a")).toEqual({ s: "session", at: nowS - 10, h: 5, hr: nowS + 3600 });
    expect(reopened.get("default", null)?.d).toBe(7);
  });

  test("a reading answers only for the account it was read under; a new login replaces it whatever its stamp", async () => {
    const quota = await SessionQuota.open(path, nowMs);
    quota.record("work", "org:a", { s: "session", at: nowS, h: 80 });
    expect(quota.get("work", "org:b")).toBeUndefined();
    expect(quota.get("work", null)).toBeUndefined();

    // A clock that stepped back across the re-login still lets the new account's reading in.
    quota.record("work", "org:b", { s: "session", at: nowS - 60, h: 3 });
    expect(quota.get("work", "org:b")?.h).toBe(3);
    expect(quota.get("work", "org:a")).toBeUndefined();
    await quota.flushed();
    expect((await SessionQuota.open(path, nowMs)).get("work", "org:a")).toBeUndefined();
  });

  test("an open in the same process waits out the write in flight, as a config reload's does", async () => {
    const outgoing = await SessionQuota.open(path, nowMs);
    outgoing.record("work", "org:a", { s: "session", at: nowS, h: 33 });
    expect((await SessionQuota.open(path, nowMs)).get("work", "org:a")?.h).toBe(33);
  });

  test("a burst of records lands as its last state", async () => {
    const quota = await SessionQuota.open(path, nowMs);
    for (let h = 0; h <= 50; h++) quota.record("work", "org:a", { s: "session", at: nowS + h, h });
    await quota.flushed();
    expect((await SessionQuota.open(path, nowMs)).get("work", "org:a")?.h).toBe(50);
  });

  test("a reading past every window is dropped at load; a corrupt file starts empty and is replaced", async () => {
    const quota = await SessionQuota.open(path, nowMs);
    quota.record("old", "org:a", { s: "session", at: nowS - SESSION_QUOTA_MAX_AGE_S - 1, h: 90 });
    quota.record("recent", "org:a", { s: "session", at: nowS - SESSION_QUOTA_MAX_AGE_S, h: 40 });
    await quota.flushed();
    const reopened = await SessionQuota.open(path, nowMs);
    expect(reopened.get("old", "org:a")).toBeUndefined();
    expect(reopened.get("recent", "org:a")?.h).toBe(40);

    for (const corrupt of ["{", JSON.stringify({ v: 1, exclaves: { work: { a: 1, o: { s: "session", at: 1 } } } })]) {
      await writeFile(path, corrupt);
      const fresh = await SessionQuota.open(path, nowMs);
      expect(fresh.get("work", "org:a")).toBeUndefined();
      fresh.record("work", "org:a", { s: "session", at: nowS, h: 1 });
      await fresh.flushed();
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        v: 1,
        exclaves: { work: { a: "org:a", o: { s: "session", at: nowS, h: 1 } } },
      });
    }
  });

  test("an unwritable state dir costs only the file: records still answer in memory", async () => {
    await writeFile(join(dir, "state"), "a file where the directory should be");
    const quota = await SessionQuota.open(path, nowMs);
    quota.record("work", "org:a", { s: "session", at: nowS, h: 12 });
    await quota.flushed();
    expect(quota.get("work", "org:a")?.h).toBe(12);
  });
});
