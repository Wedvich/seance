import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { toBase64 } from "@seance/shared";
import {
  bearerTokenWarnings,
  configSkeleton,
  loadConfig,
  loadPsk,
  pskFingerprint,
  runnableProblems,
  type Config,
} from "./config.ts";
import { importDpapiPskValue } from "./dpapi.ts";
import { importTpmPskValue, tpmAvailable } from "./tpmcreds.ts";
import { pskImportCommand, readKeychainPsk } from "./keychain.ts";
import { credentialStore, dpapiStore, keychainStore, tpmStore, type PskStore } from "./psk-store.ts";
import { loadOrInitState, readRuntime, saveState } from "./state.ts";
import { isWsl } from "./wsl.ts";

const hasTpm = await tpmAvailable();

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
    expect(runnableProblems(base, VALID.psk)).toEqual([]);
  });

  test("absent psk, short psk, bad base64, bad url all reported", () => {
    expect(runnableProblems(base, null)).toHaveLength(1);
    expect(runnableProblems(base, null)[0]).toContain("psk-import");
    expect(runnableProblems(base, toBase64(new Uint8Array(16)))[0]).toContain("16 bytes");
    expect(runnableProblems(base, "!!!")[0]).toContain("base64");
    expect(runnableProblems({ ...base, relayUrl: "https://x" }, VALID.psk)[0]).toContain("ws://");
    expect(runnableProblems({ ...base, bearerToken: "" }, null)).toHaveLength(2);
  });

  test("judges the resolved key, not the config field — an empty field with a keychain key is runnable", () => {
    expect(runnableProblems({ ...base, psk: "" }, VALID.psk)).toEqual([]);
  });

  test("a key the service manager delivers is not a missing key — every other problem still reported", () => {
    expect(runnableProblems({ ...base, psk: "" }, null, { pskDelivered: true })).toEqual([]);
    expect(runnableProblems({ ...base, bearerToken: "" }, null, { pskDelivered: true })).toHaveLength(1);
  });
});

describe("psk resolution", () => {
  const base: Config = { ...VALID, repoRoots: ["/tmp"] };

  // Absent-store markers: on a WSL or TPM box the default blob path may hold
  // the machine's real key, so resolution tests always point away from it.
  const ABSENT_KEYCHAIN = "seance-psk-absent-in-tests";
  const ABSENT_DPAPI = "/nonexistent/seance-tests/psk.dpapi";
  const ABSENT_TPM = "/nonexistent/seance-tests/psk.cred";
  /** The real store set, every location swapped for one that cannot hold a key. */
  const absentStores = (overrides: { credential?: string; dpapi?: string; tpm?: string } = {}): readonly PskStore[] => [
    credentialStore(overrides.credential ?? null),
    keychainStore(ABSENT_KEYCHAIN),
    dpapiStore(overrides.dpapi ?? ABSENT_DPAPI),
    tpmStore(overrides.tpm ?? ABSENT_TPM),
  ];

  test("a non-empty config field wins over any platform store", async () => {
    expect(await loadPsk(base)).toEqual({ psk: VALID.psk, source: "config" });
  });

  test("a missing keychain item reads as null rather than throwing", async () => {
    // The keychain *hit* path needs a real login keychain with an item in it,
    // so it is verified by hand on a machine, not here.
    expect(await readKeychainPsk(ABSENT_KEYCHAIN)).toBeNull();
  });

  test("an empty field with nothing in any store resolves to null", async () => {
    expect(await loadPsk({ ...base, psk: "" }, absentStores())).toBeNull();
  });

  test("a service-manager credential wins over every platform store", async () => {
    const dir = await tempDir();
    const path = join(dir, "seance-psk");
    await writeFile(path, `${VALID.psk}\n`);
    expect(await loadPsk({ ...base, psk: "" }, absentStores({ credential: path }))).toEqual({
      psk: VALID.psk,
      source: "credential",
    });
  });

  test.skipIf(!isWsl())(
    "an empty field falls back to the dpapi blob on WSL",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "psk.dpapi");
      await importDpapiPskValue(VALID.psk, path);
      expect(await loadPsk({ ...base, psk: "" }, absentStores({ dpapi: path }))).toEqual({
        psk: VALID.psk,
        source: "dpapi",
      });
    },
    30_000,
  );

  test.skipIf(!hasTpm)(
    "an empty field falls back to the TPM-sealed blob on plain Linux",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "psk.cred");
      await importTpmPskValue(VALID.psk, path);
      expect(await loadPsk({ ...base, psk: "" }, absentStores({ tpm: path }))).toEqual({
        psk: VALID.psk,
        source: "tpm",
      });
    },
    30_000,
  );

  test("the piped-import command carries the key on security's stdin, quoted verbatim", () => {
    // The `security -i` *store* path needs a real login keychain too — only the
    // command line it feeds is pinned here.
    expect(pskImportCommand(VALID.psk, "user", "seance-psk")).toBe(
      `add-generic-password -U -a "user" -s "seance-psk" -w "${VALID.psk}"`,
    );
  });
});

const fingerprintOfKey = (fill: number): Promise<string> => pskFingerprint(toBase64(new Uint8Array(32).fill(fill)));

describe("pskFingerprint", () => {
  test("eight stable hex characters that differ between keys", async () => {
    const a = await fingerprintOfKey(1);
    expect(a).toMatch(/^[0-9a-f]{8}$/u);
    expect(await fingerprintOfKey(1)).toBe(a);
    expect(await fingerprintOfKey(2)).not.toBe(a);
  });

  test("reveals nothing of the key it summarises", async () => {
    const psk = toBase64(new Uint8Array(32).fill(7));
    expect(psk).not.toContain(await pskFingerprint(psk));
  });
});

describe("bearerTokenWarnings", () => {
  const strong = "CMQWe8MLQUjWD4UpUlqaiMrVEUTDxe3PlPpSECJn0Pg";

  test("a base64url token of decent length draws no warnings", () => {
    expect(bearerTokenWarnings(strong)).toEqual([]);
  });

  test("padded base64url is fine — `=` survives both a header and a query value", () => {
    expect(bearerTokenWarnings(`${strong}=`)).toEqual([]);
  });

  test("empty is left to runnableProblems rather than double-reported", () => {
    expect(bearerTokenWarnings("")).toEqual([]);
  });

  test("flags standard-base64 characters that ?t= mangles", () => {
    const [warning] = bearerTokenWarnings("DQ0N7k/gkySJE7MxZEyEBZuyShlCC1PP1TFOPx+fkzU=");
    expect(warning).toContain("?t=");
    expect(warning).toContain("base64url");
  });

  test("names each offending character once, quoted so whitespace is visible", () => {
    const [warning] = bearerTokenWarnings(`${strong}++&& #`);
    expect(warning).toContain(`"+" "&" " " "#"`);
  });

  test("flags a token short enough to be worth regenerating", () => {
    expect(bearerTokenWarnings("short")[0]).toContain("5 characters");
    expect(bearerTokenWarnings("a".repeat(31))[0]).toContain("31 characters");
    expect(bearerTokenWarnings("a".repeat(32))).toEqual([]);
  });

  test("reports encoding and length independently", () => {
    expect(bearerTokenWarnings("a+b")).toHaveLength(2);
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
