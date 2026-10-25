import { describe, expect, test } from "bun:test";
import type { SettingsRecord } from "@seance/shared";
import { createTermSettings } from "../src/settings.ts";
import type { SettingsRead, SettingsStore, SettingsUnreadable, SettingsWrite } from "../src/settings-store.ts";
import { generateVapidKeys } from "../src/web-push.ts";

/** A store held in memory with the relay's version rules; `script` answers a call first, when it has an answer. */
function fakeStore(initial: SettingsRecord | null = null): {
  readonly store: SettingsStore;
  readonly puts: { readonly expect: number; readonly record: Omit<SettingsRecord, "version"> }[];
  held: SettingsRecord | null;
  readonly script: { get: SettingsRead[]; put: SettingsWrite[]; getThrows: Error[] };
  gets: number;
} {
  const fake = {
    held: initial,
    gets: 0,
    puts: [] as { expect: number; record: Omit<SettingsRecord, "version"> }[],
    script: { get: [] as SettingsRead[], put: [] as SettingsWrite[], getThrows: [] as Error[] },
    store: {
      get: async (): Promise<SettingsRead> => {
        fake.gets += 1;
        const thrown = fake.script.getThrows.shift();
        if (thrown !== undefined) throw thrown;
        const scripted = fake.script.get.shift();
        if (scripted !== undefined) return scripted;
        return fake.held === null ? null : { version: fake.held.version, record: fake.held };
      },
      put: async (at: number, record: Omit<SettingsRecord, "version">): Promise<SettingsWrite> => {
        fake.puts.push({ expect: at, record });
        // Yields, so two unserialised callers would interleave.
        await Promise.resolve();
        const scripted = fake.script.put.shift();
        if (scripted !== undefined) return scripted;
        if ((fake.held?.version ?? 0) !== at) return { ok: false, code: "version_conflict" };
        fake.held = { ...record, version: at + 1 };
        return { ok: true, version: at + 1 };
      },
    } satisfies SettingsStore,
  };
  return fake;
}

function logSpy(): { readonly lines: string[]; readonly log: { warn: (msg: string) => void } } {
  const lines: string[] = [];
  return { lines, log: { warn: (msg) => lines.push(msg) } };
}

describe("load", () => {
  test("with no record creates one at 0 with a fresh VAPID pair, once", async () => {
    const fake = fakeStore();
    const settings = createTermSettings({ store: fake.store, term: 3, log: logSpy().log });
    expect(settings.current()).toBeNull();
    expect(await settings.load()).toBe("ready");
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]?.expect).toBe(0);
    expect(settings.current()).toEqual(fake.held);
    expect(settings.current()?.vapid?.publicKey).toHaveLength(87);
  });

  test("a record that exists is held as it is, with no write", async () => {
    const existing: SettingsRecord = { version: 4, vapid: await generateVapidKeys() };
    const fake = fakeStore(existing);
    const settings = createTermSettings({ store: fake.store, term: 3, log: logSpy().log });
    expect(await settings.load()).toBe("ready");
    expect(settings.current()).toEqual(existing);
    expect(fake.puts).toEqual([]);
  });

  test("losing the create to another term holds that term's record, not ours", async () => {
    const theirs: SettingsRecord = { version: 1, vapid: await generateVapidKeys() };
    const fake = fakeStore();
    fake.script.put.push({ ok: false, code: "version_conflict" });
    fake.script.get.push(null, { version: 1, record: theirs });
    const settings = createTermSettings({ store: fake.store, term: 3, log: logSpy().log });
    expect(await settings.load()).toBe("ready");
    expect(settings.current()).toEqual(theirs);
    expect(fake.puts).toHaveLength(1);
  });

  test("a second lost race, or a record gone after the first, is unavailable and writes no more", async () => {
    const fake = fakeStore();
    fake.script.put.push({ ok: false, code: "version_conflict" });
    fake.script.get.push(null, null);
    const spy = logSpy();
    const settings = createTermSettings({ store: fake.store, term: 3, log: spy.log });
    expect(await settings.load()).toBe("unavailable");
    expect(fake.puts).toHaveLength(1);
    expect(settings.current()).toBeNull();
  });

  const reasons: SettingsUnreadable[] = [
    "unopenable",
    "malformed",
    "version_regressed",
    "version_mismatch",
    "key_mismatch",
  ];
  for (const reason of reasons) {
    test(`a ${reason} record is never written over: unavailable, one warning naming the reason and the term`, async () => {
      const fake = fakeStore();
      fake.script.get.push({ version: 5, reason }, { version: 5, reason });
      const spy = logSpy();
      const settings = createTermSettings({ store: fake.store, term: 7, log: spy.log });
      expect(await settings.load()).toBe("unavailable");
      expect(await settings.load()).toBe("unavailable");
      expect(fake.puts).toEqual([]);
      expect(settings.current()).toBeNull();
      expect(spy.lines).toEqual([`scheduler: settings unavailable (${reason}) — push is off for term 7`]);
      expect(await settings.update((r) => r)).toEqual({ ok: false, code: "unavailable" });
    });
  }

  test("a record with no VAPID key is given one at its version, keeping what it holds", async () => {
    const fake = fakeStore({ version: 2, linearKey: "lin_api_key" });
    const settings = createTermSettings({ store: fake.store, term: 3, log: logSpy().log });
    expect(await settings.load()).toBe("ready");
    expect(fake.puts[0]?.expect).toBe(2);
    expect(settings.current()).toMatchObject({ version: 3, linearKey: "lin_api_key" });
    expect(settings.current()?.vapid).toBeDefined();
  });

  test("a read that throws, or a create nobody confirmed, rejects so the caller can try again", async () => {
    const fake = fakeStore();
    fake.script.getThrows.push(new Error("store-get: the relay refused it (rate_limited)"));
    const settings = createTermSettings({ store: fake.store, term: 3, log: logSpy().log });
    await expect(settings.load()).rejects.toThrow("rate_limited");
    expect(fake.puts).toEqual([]);

    fake.script.put.push({ ok: false, code: "indeterminate" });
    await expect(settings.load()).rejects.toThrow("indeterminate");
    // The retry finds whatever did or did not commit.
    fake.held = { version: 1, vapid: await generateVapidKeys() };
    expect(await settings.load()).toBe("ready");
    expect(settings.current()).toEqual(fake.held);
  });

  test("a create the store refuses for good is unavailable", async () => {
    const fake = fakeStore();
    fake.script.put.push({ ok: false, code: "store_full" });
    const spy = logSpy();
    const settings = createTermSettings({ store: fake.store, term: 3, log: spy.log });
    expect(await settings.load()).toBe("unavailable");
    expect(spy.lines).toHaveLength(1);
  });

  test("concurrent loads share one read and one create", async () => {
    const fake = fakeStore();
    const settings = createTermSettings({ store: fake.store, term: 3, log: logSpy().log });
    expect(await Promise.all([settings.load(), settings.load()])).toEqual(["ready", "ready"]);
    expect(fake.puts).toHaveLength(1);
  });
});

describe("update", () => {
  const withLoaded = async (): Promise<{
    readonly fake: ReturnType<typeof fakeStore>;
    readonly settings: ReturnType<typeof createTermSettings>;
  }> => {
    const fake = fakeStore({ version: 1, vapid: await generateVapidKeys() });
    const settings = createTermSettings({ store: fake.store, term: 3, log: logSpy().log });
    await settings.load();
    return { fake, settings };
  };

  test("two concurrent updates make two puts at consecutive versions, each applied to the one before", async () => {
    const { fake, settings } = await withLoaded();
    const [a, b] = await Promise.all([
      settings.update((r) => ({ ...r, linearKey: "first" })),
      settings.update((r) => ({ ...r, linearKey: `${r.linearKey ?? ""}+second` })),
    ]);
    expect(a).toMatchObject({ ok: true, record: { version: 2 } });
    expect(b).toMatchObject({ ok: true, record: { version: 3, linearKey: "first+second" } });
    expect(fake.puts.map((put) => put.expect)).toEqual([1, 2]);
    expect(settings.current()).toEqual(fake.held);
  });

  test("a mutation that returns null writes nothing", async () => {
    const { fake, settings } = await withLoaded();
    expect(await settings.update(() => null)).toMatchObject({ ok: true, record: { version: 1 } });
    expect(fake.puts).toEqual([]);
  });

  test("a conflict re-reads once and applies the mutation to what it found", async () => {
    const { fake, settings } = await withLoaded();
    // Another writer got in first.
    fake.held = { ...fake.held!, version: 2, linearKey: "theirs" };
    const result = await settings.update((r) => ({ ...r, linearKey: `${r.linearKey ?? ""}+ours` }));
    expect(result).toMatchObject({ ok: true, record: { version: 3, linearKey: "theirs+ours" } });
    expect(fake.puts.map((put) => put.expect)).toEqual([1, 2]);
  });

  test("a second conflict is conflict", async () => {
    const { fake, settings } = await withLoaded();
    fake.script.put.push({ ok: false, code: "version_conflict" }, { ok: false, code: "version_conflict" });
    expect(await settings.update((r) => ({ ...r, linearKey: "x" }))).toEqual({ ok: false, code: "conflict" });
    expect(fake.puts).toHaveLength(2);
    // The held copy is still usable: the next update re-reads and lands.
    expect(await settings.update((r) => ({ ...r, linearKey: "y" }))).toMatchObject({ ok: true });
  });

  test("a record that is unreadable at the re-read turns the holder unavailable, with no write over it", async () => {
    const { fake, settings } = await withLoaded();
    fake.script.put.push({ ok: false, code: "version_conflict" });
    fake.script.get.push({ version: 1, reason: "version_regressed" });
    expect(await settings.update((r) => ({ ...r, linearKey: "x" }))).toEqual({ ok: false, code: "unavailable" });
    expect(settings.current()).toBeNull();
    expect(fake.puts).toHaveLength(1);
  });

  test("a failed write comes back as its code and leaves the held record as it was", async () => {
    const { fake, settings } = await withLoaded();
    for (const code of ["too_large", "store_full", "indeterminate", "refused"] as const) {
      fake.script.put.push({ ok: false, code });
      expect(await settings.update((r) => ({ ...r, linearKey: "x" }))).toEqual({ ok: false, code });
    }
    expect(settings.current()?.version).toBe(1);
    // A create-only refusal cannot happen on an overwrite; it reads as a refusal.
    fake.script.put.push({ ok: false, code: "rate_limited" });
    expect(await settings.update((r) => ({ ...r, linearKey: "x" }))).toEqual({ ok: false, code: "refused" });
  });

  test("a throw from the store (the term ended) rejects that update and not the ones after it", async () => {
    const { fake, settings } = await withLoaded();
    const put = fake.store.put;
    let revoked = true;
    fake.store.put = async (at, record) => {
      if (revoked) throw new Error("term ended");
      return put(at, record);
    };
    await expect(settings.update((r) => ({ ...r, linearKey: "x" }))).rejects.toThrow("term ended");
    revoked = false;
    expect(await settings.update((r) => ({ ...r, linearKey: "x" }))).toMatchObject({ ok: true });
  });
});
