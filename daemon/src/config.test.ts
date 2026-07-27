import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { toBase64 } from "@seance/shared";
import { configSkeleton, loadConfig, runnableProblems, type Config } from "./config.ts";
import { loadOrInitState, readRuntime, saveState } from "./state.ts";

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "seance-config-"));
  cleanups.push(dir);
  return dir;
}

const VALID = {
  name: "Test Mac",
  relayUrl: "wss://relay.example/daemon",
  bearerToken: "token",
  psk: toBase64(new Uint8Array(32).fill(1)),
  repoRoots: ["~/repos"],
  tmuxSession: "main",
};

describe("loadConfig", () => {
  test("missing file points at seanced init", async () => {
    const dir = await tempDir();
    expect(loadConfig(join(dir, "config.json"))).rejects.toThrow("seanced init");
  });

  test("invalid JSON is a clear error", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    await writeFile(path, "{nope");
    expect(loadConfig(path)).rejects.toThrow("not valid JSON");
  });

  test("loads a valid config and expands tildes", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify(VALID));
    const config = await loadConfig(path);
    expect(config.name).toBe("Test Mac");
    expect(config.repoRoots[0]).toBe(join(homedir(), "repos"));
  });

  test("tmuxSession defaults to main", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    const { tmuxSession: _, ...rest } = VALID;
    await writeFile(path, JSON.stringify(rest));
    expect((await loadConfig(path)).tmuxSession).toBe("main");
  });

  test("missing repoRoots rejected", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    const { repoRoots: _, ...rest } = VALID;
    await writeFile(path, JSON.stringify(rest));
    expect(loadConfig(path)).rejects.toThrow("repoRoots");
  });
});

describe("runnableProblems", () => {
  const base: Config = { ...VALID, repoRoots: ["/tmp"] };

  test("valid config has no problems", () => {
    expect(runnableProblems(base)).toEqual([]);
  });

  test("empty psk, short psk, bad base64, bad url all reported", () => {
    expect(runnableProblems({ ...base, psk: "" })).toHaveLength(1);
    expect(runnableProblems({ ...base, psk: toBase64(new Uint8Array(16)) })[0]).toContain("16 bytes");
    expect(runnableProblems({ ...base, psk: "!!!" })[0]).toContain("base64");
    expect(runnableProblems({ ...base, relayUrl: "https://x" })[0]).toContain("ws://");
    expect(runnableProblems({ ...base, bearerToken: "", psk: "" })).toHaveLength(2);
  });
});

describe("configSkeleton", () => {
  test("is valid JSON with an empty psk — seanced never generates key material", () => {
    const parsed = JSON.parse(configSkeleton("My Mac")) as Record<string, unknown>;
    expect(parsed["psk"]).toBe("");
    expect(parsed["name"]).toBe("My Mac");
  });
});

describe("state", () => {
  test("initializes with a fresh deviceId and persists it", async () => {
    const dir = await tempDir();
    const path = join(dir, "state.json");
    const first = await loadOrInitState(path);
    expect(first.deviceId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.repos).toEqual([]);
    const second = await loadOrInitState(path);
    expect(second.deviceId).toBe(first.deviceId);
  });

  test("reinitializes on corrupt state", async () => {
    const dir = await tempDir();
    const path = join(dir, "state.json");
    await writeFile(path, "not json");
    const state = await loadOrInitState(path);
    expect(state.deviceId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  test("saveState roundtrips repos", async () => {
    const dir = await tempDir();
    const path = join(dir, "state.json");
    const state = {
      deviceId: crypto.randomUUID(),
      repos: [{ name: "x", path: "/x", defaultBranch: "main" }],
      scannedAt: 123,
    };
    await saveState(state, path);
    expect(await loadOrInitState(path)).toEqual(state);
  });

  test("readRuntime returns null when absent or corrupt", async () => {
    const dir = await tempDir();
    expect(await readRuntime(join(dir, "runtime.json"))).toBeNull();
    await writeFile(join(dir, "runtime.json"), "garbage");
    expect(await readRuntime(join(dir, "runtime.json"))).toBeNull();
  });
});
