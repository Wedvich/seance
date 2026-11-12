import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateRequester, readRequestOrigin } from "./update-request.ts";

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

  test("an absent or unrecognised file reads as announce", async () => {
    expect(await readRequestOrigin(join(dir, "never-written"))).toBe("announce");
    const path = fresh();
    await Bun.write(path, "registered elsewhere\n");
    expect(await readRequestOrigin(path)).toBe("announce");
  });
});
