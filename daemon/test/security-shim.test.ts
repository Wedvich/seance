import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/exec.ts";
import { PSK_SERVICE, readKeychainPsk } from "../src/keychain.ts";
import { makeSecurityShim, type SecurityShim } from "./security-shim.ts";

let base: string;
let shim: SecurityShim;
let savedPath: string | undefined;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-security-shim-"));
  shim = await makeSecurityShim(base);
  savedPath = process.env["PATH"];
  process.env["PATH"] = shim.path;
  // The daemon's read below would otherwise reach the developer's real keychain. PATH passed
  // explicitly: bare `Bun.which` keeps the PATH the process started with.
  if (Bun.which("security", { PATH: shim.path }) !== join(shim.binDir, "security")) {
    throw new Error("the shim is not first on PATH");
  }
});

afterAll(async () => {
  if (savedPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = savedPath;
  await rm(base, { recursive: true, force: true });
});

const CREDENTIALS = "Claude Code-credentials";

describe("security shim", () => {
  test("answers a stored item as `-w` prints it, and a missing or deleted one with exit 44", async () => {
    const find = ["security", "find-generic-password", "-a", "me", "-s", CREDENTIALS, "-w"];
    await shim.set(CREDENTIALS, '{"claudeAiOauth":{"accessToken":"tok"}}');
    expect(await exec(find)).toMatchObject({ exitCode: 0, stdout: '{"claudeAiOauth":{"accessToken":"tok"}}\n' });

    expect((await exec(["security", "find-generic-password", "-s", "absent", "-w"])).exitCode).toBe(44);
    // A trailing flag missing its value ends the parse rather than stalling it.
    expect((await exec(["security", "find-generic-password", "-s"], { timeoutMs: 5_000 })).exitCode).toBe(44);

    await shim.set(CREDENTIALS, null);
    expect((await exec(find)).exitCode).toBe(44);
    expect(await shim.calls()).toContainEqual(find.slice(1));
  });

  test("records a no-arg call as an empty argv, and concurrent calls as whole records", async () => {
    const before = (await shim.calls()).length;
    await exec(["security"]);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => exec(["security", "find-generic-password", "-s", `c${i}`, "-w"])),
    );
    const calls = (await shim.calls()).slice(before);
    expect(calls[0]).toEqual([]);
    expect(calls).toHaveLength(21);
    expect(
      calls
        .slice(1)
        .map((c) => c.join(" "))
        .toSorted(),
    ).toEqual(Array.from({ length: 20 }, (_, i) => `find-generic-password -s c${i} -w`).toSorted());
  });

  test("refuses a command it does not model rather than pretending", async () => {
    const added = await exec(["security", "add-generic-password", "-s", CREDENTIALS, "-w", "x"]);
    expect(added.exitCode).toBe(1);
    expect(added.stderr).toContain("unsupported command: add-generic-password");
  });

  test("refuses a service name that cannot be an item file", async () => {
    await expect(shim.set("../escape", "x")).rejects.toThrow(/cannot name an item file/u);
  });

  test.if(process.platform === "darwin")("the daemon's keychain read goes through it on PATH", async () => {
    // A test-only service: were resolution to bypass the shim, the read would miss rather than
    // surface the developer's real PSK.
    const service = "seance-shim-test";
    await shim.set(service, "c2hpbQ==");
    expect(await readKeychainPsk(service)).toBe("c2hpbQ==");
    expect(await shim.calls()).toContainEqual(["find-generic-password", "-s", service, "-w"]);
    await shim.set(service, null);
    expect(await readKeychainPsk(service)).toBeNull();
  });

  test.if(process.platform !== "darwin")("off macOS the daemon's keychain read never asks it", async () => {
    const before = (await shim.calls()).length;
    await shim.set(PSK_SERVICE, "c2hpbQ==");
    expect(await readKeychainPsk()).toBeNull();
    expect(await shim.calls()).toHaveLength(before);
  });
});
