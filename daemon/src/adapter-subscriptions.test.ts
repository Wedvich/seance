import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  adapterFingerprint,
  CONVERSATION_IDLE_MS,
  CONVERSATIONS_KEPT_MAX,
  openSubscriptions,
} from "./adapter-subscriptions.ts";

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tg = adapterFingerprint({ argv: ["/opt/tg"] });
const mail = adapterFingerprint({ argv: ["/opt/mail"] });

let dir: string;
let path: string;
let clock: number;
const now = (): number => clock;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-subs-"));
  path = join(dir, "conversations.json");
  clock = 1_000_000;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("adapter subscriptions", () => {
  test("kept at rest, 0600, across a reopen (a daemon restart)", async () => {
    const subs = openSubscriptions(path, { now });
    subs.reconcile(new Map([["tg", tg]]));
    subs.add("tg", id(1));
    await subs.flushed();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const again = openSubscriptions(path, { now });
    again.reconcile(new Map([["tg", tg]]));
    expect(again.has("tg", id(1))).toBe(true);
    expect(again.has("mail", id(1))).toBe(false);
  });

  test("a leave ends one adapter's subscription, not another's", async () => {
    const subs = openSubscriptions(path, { now });
    subs.reconcile(
      new Map([
        ["tg", tg],
        ["mail", mail],
      ]),
    );
    subs.add("tg", id(1));
    subs.add("mail", id(1));
    subs.leave("tg", id(1));
    expect(subs.has("tg", id(1))).toBe(false);
    expect(subs.has("mail", id(1))).toBe(true);
  });

  test("an adapter removed, or configured as another program under its name, inherits none", async () => {
    const subs = openSubscriptions(path, { now });
    subs.reconcile(
      new Map([
        ["tg", tg],
        ["mail", mail],
      ]),
    );
    subs.add("tg", id(1));
    subs.add("mail", id(2));
    await subs.flushed();
    // Next start: `mail` gone from config.json, `tg` re-added with another argv.
    const next = openSubscriptions(path, { now });
    next.reconcile(new Map([["tg", adapterFingerprint({ argv: ["/opt/tg-v2"] })]]));
    expect(next.has("tg", id(1))).toBe(false);
    expect(next.has("mail", id(2))).toBe(false);
    // The same program again keeps what it had.
    next.add("tg", id(3));
    await next.flushed();
    const third = openSubscriptions(path, { now });
    third.reconcile(new Map([["tg", adapterFingerprint({ argv: ["/opt/tg-v2"] })]]));
    expect(third.has("tg", id(3))).toBe(true);
  });

  test("drop ends a name's subscriptions (`seance adapter add` under the same name)", () => {
    const subs = openSubscriptions(path, { now });
    subs.reconcile(new Map([["tg", tg]]));
    subs.add("tg", id(1));
    subs.drop("tg");
    expect(subs.has("tg", id(1))).toBe(false);
  });

  test("a conversation not live for 30 days is dropped at load; one touched is kept", async () => {
    const subs = openSubscriptions(path, { now });
    subs.reconcile(new Map([["tg", tg]]));
    subs.add("tg", id(1));
    subs.add("tg", id(2));
    clock += CONVERSATION_IDLE_MS - 1_000;
    subs.touch(id(2));
    await subs.flushed();
    clock += 2_000;
    const later = openSubscriptions(path, { now });
    expect(later.has("tg", id(1))).toBe(false);
    expect(later.has("tg", id(2))).toBe(true);
  });

  test("past the cap the least recently live goes first", () => {
    const subs = openSubscriptions(path, { now });
    subs.reconcile(new Map([["tg", tg]]));
    for (let n = 0; n <= CONVERSATIONS_KEPT_MAX; n++) {
      clock += 1;
      subs.add("tg", id(n));
    }
    expect(subs.has("tg", id(0))).toBe(false);
    expect(subs.has("tg", id(CONVERSATIONS_KEPT_MAX))).toBe(true);
  });

  test("a file it cannot read loads empty, never invented", async () => {
    await writeFile(path, "{not json", { mode: 0o600 });
    expect(openSubscriptions(path, { now }).has("tg", id(1))).toBe(false);
    await writeFile(path, JSON.stringify({ v: 1, adapters: {}, conversations: { "not-an-id": { lastLive: 1 } } }));
    expect(openSubscriptions(path, { now }).has("tg", "not-an-id")).toBe(false);
  });

  test("holds no text: ids, names, fingerprints and times only", async () => {
    const subs = openSubscriptions(path, { now });
    subs.reconcile(new Map([["tg", adapterFingerprint({ argv: ["/opt/tg", "--token", "secret-value"] })]]));
    subs.add("tg", id(1));
    await subs.flushed();
    expect(await readFile(path, "utf8")).not.toContain("secret-value");
  });
});
