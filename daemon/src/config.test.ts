import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { toBase64 } from "@seance/shared";
import { configSkeleton, loadConfig, loadPsk, type Config } from "./config.ts";
import { importDpapiPskValue } from "./dpapi.ts";
import { importTpmPskValue, tpmAvailable } from "./tpmcreds.ts";
import { pskImportCommand, readKeychainPsk } from "./keychain.ts";
import { credentialStore, dpapiStore, keychainStore, tpmStore, type PskStore } from "./psk-store.ts";
import { identityOfState, loadOrInitState, readRuntime, saveState } from "./state.ts";
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

  test("machineTag is optional and read verbatim", async () => {
    const dir = await tempDir();
    const bare = join(dir, "bare.json");
    await writeFile(bare, JSON.stringify(VALID));
    expect((await loadConfig(bare)).machineTag).toBeUndefined();

    const tagged = join(dir, "tagged.json");
    await writeFile(tagged, JSON.stringify({ ...VALID, machineTag: "thad" }));
    expect((await loadConfig(tagged)).machineTag).toBe("thad");
  });

  test("missing repoRoots rejected", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.json");
    const { repoRoots: _, ...rest } = VALID;
    await writeFile(path, JSON.stringify(rest));
    expect(loadConfig(path)).rejects.toThrow("repoRoots");
  });

  test("reap is optional, and a partial block takes the defaults — schedule off, a four-day age gate", async () => {
    const dir = await tempDir();
    const bare = join(dir, "bare.json");
    await writeFile(bare, JSON.stringify(VALID));
    expect((await loadConfig(bare)).reap).toBeUndefined();

    const partial = join(dir, "partial.json");
    await writeFile(partial, JSON.stringify({ ...VALID, reap: { intervalHours: 24 } }));
    expect((await loadConfig(partial)).reap).toEqual({ intervalHours: 24, minAgeDays: 4 });
  });

  test("a custodian key turns reap's timer on at 6h with a one-day age gate; an explicit reap field still wins", async () => {
    const dir = await tempDir();
    const bare = join(dir, "custodian.json");
    await writeFile(bare, JSON.stringify({ ...VALID, custodian: {} }));
    const loaded = await loadConfig(bare);
    expect(loaded.custodian).toEqual({});
    expect(loaded.reap).toEqual({ intervalHours: 6, minAgeDays: 1 });

    const partial = join(dir, "custodian-reap.json");
    await writeFile(partial, JSON.stringify({ ...VALID, custodian: { model: "haiku" }, reap: { minAgeDays: 4 } }));
    expect((await loadConfig(partial)).reap).toEqual({ intervalHours: 6, minAgeDays: 4 });

    const off = join(dir, "custodian-off.json");
    await writeFile(off, JSON.stringify({ ...VALID, custodian: {}, reap: { intervalHours: 0 } }));
    expect((await loadConfig(off)).reap).toEqual({ intervalHours: 0, minAgeDays: 1 });

    for (const custodian of [true, null, [], "on"]) {
      const path = join(dir, `bad-custodian-${JSON.stringify(custodian)}.json`);
      // oxlint-disable-next-line no-await-in-loop
      await writeFile(path, JSON.stringify({ ...VALID, custodian }));
      // oxlint-disable-next-line no-await-in-loop
      await expect(loadConfig(path)).rejects.toThrow('"custodian" must be an object');
    }
  });

  test("a reap value that isn't a non-negative number is a config error, not a silent default", async () => {
    const dir = await tempDir();
    for (const reap of [{ minAgeDays: -1 }, { intervalHours: "daily" }, { minAgeDays: null }, "weekly"]) {
      const path = join(dir, `bad-${JSON.stringify(reap).length}.json`);
      // oxlint-disable-next-line no-await-in-loop
      await writeFile(path, JSON.stringify({ ...VALID, reap }));
      // oxlint-disable-next-line no-await-in-loop
      await expect(loadConfig(path)).rejects.toThrow("reap");
    }
  });

  test("quota is optional, an empty block takes the 10 min default, and a set value parses", async () => {
    const dir = await tempDir();
    const bare = join(dir, "bare.json");
    await writeFile(bare, JSON.stringify(VALID));
    expect((await loadConfig(bare)).quota).toBeUndefined();

    const empty = join(dir, "empty.json");
    await writeFile(empty, JSON.stringify({ ...VALID, quota: {} }));
    expect((await loadConfig(empty)).quota).toEqual({ staleAfterMinutes: 10 });

    const floor = join(dir, "floor.json");
    await writeFile(floor, JSON.stringify({ ...VALID, quota: { staleAfterMinutes: 1 } }));
    expect((await loadConfig(floor)).quota).toEqual({ staleAfterMinutes: 1 });
  });

  test("a staleAfter under Claude Code's 60 s debounce, or not a number, is refused, not clamped", async () => {
    const dir = await tempDir();
    const bad = [
      { staleAfterMinutes: 0.5 },
      { staleAfterMinutes: -1 },
      { staleAfterMinutes: "10m" },
      { staleAfterMinutes: null },
      "10m",
      [],
      { staleAfter: 5 },
    ];
    for (const [i, quota] of bad.entries()) {
      const path = join(dir, `bad-${i}.json`);
      // oxlint-disable-next-line no-await-in-loop
      await writeFile(path, JSON.stringify({ ...VALID, quota }));
      // oxlint-disable-next-line no-await-in-loop
      await expect(loadConfig(path)).rejects.toThrow("quota");
    }
  });

  test("authHealth is optional, an empty block keeps the macOS keychain off, and only a boolean turns it on", async () => {
    const dir = await tempDir();
    const bare = join(dir, "bare-auth.json");
    await writeFile(bare, JSON.stringify(VALID));
    expect((await loadConfig(bare)).authHealth).toBeUndefined();

    const empty = join(dir, "empty-auth.json");
    await writeFile(empty, JSON.stringify({ ...VALID, authHealth: {} }));
    expect((await loadConfig(empty)).authHealth).toEqual({ keychain: false });

    const on = join(dir, "on-auth.json");
    await writeFile(on, JSON.stringify({ ...VALID, authHealth: { keychain: true } }));
    expect((await loadConfig(on)).authHealth).toEqual({ keychain: true });

    const bad = [{ keychain: "yes" }, { keychain: 1 }, { keychain: null }, { keychains: true }, "on", [], null];
    for (const [i, authHealth] of bad.entries()) {
      const path = join(dir, `bad-auth-${i}.json`);
      // oxlint-disable-next-line no-await-in-loop
      await writeFile(path, JSON.stringify({ ...VALID, authHealth }));
      // oxlint-disable-next-line no-await-in-loop
      await expect(loadConfig(path)).rejects.toThrow("authHealth");
    }
  });

  describe("traits", () => {
    const load = async (traits: unknown): Promise<Config> => {
      const path = join(await tempDir(), "traits.json");
      await writeFile(path, JSON.stringify({ ...VALID, traits }));
      return loadConfig(path);
    };

    test("absent is no traits, and a valid block reads as written, `exclaves` optional", async () => {
      const bare = join(await tempDir(), "bare-traits.json");
      await writeFile(bare, JSON.stringify(VALID));
      expect(await loadConfig(bare)).not.toHaveProperty("traits");
      expect((await load({})).traits).toEqual({});
      expect((await load({ atlas: {}, "gpu-2": { exclaves: ["default", "work"] } })).traits).toEqual({
        atlas: {},
        "gpu-2": { exclaves: ["default", "work"] },
      });
      const longest = "a".repeat(32);
      expect((await load({ [longest]: {} })).traits).toEqual({ [longest]: {} });
      const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`t${i}`, {}]));
      expect(Object.keys((await load(sixteen)).traits ?? {})).toHaveLength(16);
    });

    test("every mistake fails the load, naming the config and the trait", async () => {
      const seventeen = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`t${i}`, {}]));
      const bad: readonly (readonly [unknown, string])[] = [
        [[], '"traits" must be an object'],
        ["atlas", '"traits" must be an object'],
        [null, '"traits" must be an object'],
        [{ Atlas: {} }, "not a trait name"],
        [{ "-x": {} }, "not a trait name"],
        [{ ["a".repeat(33)]: {} }, "not a trait name"],
        [{ "": {} }, "not a trait name"],
        [seventeen, "at most 16"],
        [{ atlas: true }, '"traits.atlas" must be an object'],
        [{ atlas: [] }, '"traits.atlas" must be an object'],
        [{ atlas: { exclave: ["x"] } }, 'unknown key "traits.atlas.exclave"'],
        [{ atlas: { exclaves: [] } }, "non-empty array"],
        [{ atlas: { exclaves: "default" } }, "non-empty array"],
        [{ atlas: { exclaves: ["Work"] } }, "non-empty array"],
        [{ atlas: { exclaves: ["a b"] } }, "non-empty array"],
        [{ atlas: { exclaves: [1] } }, "non-empty array"],
        [{ atlas: { exclaves: ["work", "work"] } }, "distinct"],
      ];
      for (const [traits, message] of bad) {
        // oxlint-disable-next-line no-await-in-loop -- one config at a time
        await expect(load(traits)).rejects.toThrow(message);
        // oxlint-disable-next-line no-await-in-loop
        await expect(load(traits)).rejects.toThrow("config at ");
      }
    });

    test("`keepFree: true` loads beside `exclaves` and `probe`; `false` is stored as absent", async () => {
      expect((await load({ atlas: { keepFree: true } })).traits).toEqual({ atlas: { keepFree: true } });
      expect((await load({ atlas: { keepFree: false } })).traits).toEqual({ atlas: {} });
      const probe = { argv: ["true"], everyMinutes: 30, timeoutSeconds: 10 };
      expect((await load({ atlas: { exclaves: ["work"], keepFree: true, probe: { argv: ["true"] } } })).traits).toEqual(
        {
          atlas: { exclaves: ["work"], keepFree: true, probe },
        },
      );
    });

    test("a non-boolean `keepFree` fails the load, naming the key", async () => {
      for (const keepFree of ["true", 1, 0, null, [], {}]) {
        // oxlint-disable-next-line no-await-in-loop -- one config at a time
        await expect(load({ atlas: { keepFree } })).rejects.toThrow('"traits.atlas.keepFree" must be true or false');
      }
    });

    test("a probe loads with its defaults filled in, beside `exclaves` or alone", async () => {
      const probe = { argv: ["az", "account", "show"], everyMinutes: 30, timeoutSeconds: 10 };
      expect((await load({ atlas: { probe: { argv: ["az", "account", "show"] } } })).traits).toEqual({
        atlas: { probe },
      });
      const full = { argv: ["/usr/bin/true", "~/x"], everyMinutes: 5, timeoutSeconds: 30 };
      expect((await load({ atlas: { exclaves: ["work"], probe: full } })).traits).toEqual({
        atlas: { exclaves: ["work"], probe: full },
      });
      expect((await load({ atlas: { probe: { argv: ["x"], everyMinutes: 1440, timeoutSeconds: 1 } } })).traits).toEqual(
        {
          atlas: { probe: { argv: ["x"], everyMinutes: 1440, timeoutSeconds: 1 } },
        },
      );
    });

    test("every probe mistake fails the load, naming the key", async () => {
      const argv = ["true"];
      const bad: readonly (readonly [unknown, string])[] = [
        [[], 'traits.atlas.probe" must be an object'],
        ["true", 'traits.atlas.probe" must be an object'],
        [{}, "traits.atlas.probe.argv"],
        [{ argv: [] }, "traits.atlas.probe.argv"],
        [{ argv: "true" }, "traits.atlas.probe.argv"],
        [{ argv: ["true", 1] }, "traits.atlas.probe.argv"],
        [{ argv: ["true", ""] }, "traits.atlas.probe.argv"],
        [{ argv: ["true", "a\0b"] }, "traits.atlas.probe.argv"],
        [{ argv: ["x".repeat(1025)] }, "traits.atlas.probe.argv"],
        [{ argv: Array.from({ length: 33 }, () => "x") }, "traits.atlas.probe.argv"],
        [{ argv: ["bin/probe"] }, "traits.atlas.probe.argv[0]"],
        [{ argv: ["./probe"] }, "traits.atlas.probe.argv[0]"],
        [{ argv, everyMinutes: 4 }, "traits.atlas.probe.everyMinutes"],
        [{ argv, everyMinutes: 1441 }, "traits.atlas.probe.everyMinutes"],
        [{ argv, everyMinutes: 5.5 }, "traits.atlas.probe.everyMinutes"],
        [{ argv, everyMinutes: "30" }, "traits.atlas.probe.everyMinutes"],
        [{ argv, timeoutSeconds: 0 }, "traits.atlas.probe.timeoutSeconds"],
        [{ argv, timeoutSeconds: 31 }, "traits.atlas.probe.timeoutSeconds"],
        [{ argv, timeoutSeconds: 1.5 }, "traits.atlas.probe.timeoutSeconds"],
        [{ argv, shell: true }, 'unknown key "traits.atlas.probe.shell"'],
      ];
      for (const [probe, message] of bad) {
        // oxlint-disable-next-line no-await-in-loop -- one config at a time
        await expect(load({ atlas: { probe } })).rejects.toThrow(message);
      }
    });
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

describe("configSkeleton", () => {
  test("is valid JSON with an empty psk — seanced never generates key material", () => {
    const parsed = JSON.parse(configSkeleton("My Mac")) as Record<string, unknown>;
    expect(parsed["psk"]).toBe("");
    expect(parsed["name"]).toBe("My Mac");
    // Empty, not derived from the name: an unset tag means unsuffixed sessions.
    expect(parsed["machineTag"]).toBe("");
  });
});

describe("state", () => {
  test("initializes with a fresh deviceId and persists it", async () => {
    const dir = await tempDir();
    const path = join(dir, "state.json");
    const first = await loadOrInitState(path);
    expect(first.deviceId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.repos).toEqual([]);
    const second = await loadOrInitState(path);
    expect(second.deviceId).toBe(first.deviceId);
    expect((await identityOfState(second)).deviceId).toBe(first.deviceId);
  });

  test("a legacy state without an identity gets one, and a new deviceId with it", async () => {
    const dir = await tempDir();
    const path = join(dir, "state.json");
    const legacy = {
      deviceId: crypto.randomUUID(),
      repos: [{ name: "x", path: "/x", defaultBranch: "main" }],
      scannedAt: 7,
    };
    await writeFile(path, JSON.stringify(legacy));
    const upgraded = await loadOrInitState(path);
    expect(upgraded.deviceId).not.toBe(legacy.deviceId);
    expect(upgraded.repos).toEqual(legacy.repos);
    expect(upgraded.scannedAt).toBe(7);
    expect((await identityOfState(upgraded)).deviceId).toBe(upgraded.deviceId);
    // Persisted, so the next load keeps the minted id rather than minting again.
    expect((await loadOrInitState(path)).deviceId).toBe(upgraded.deviceId);
  });

  test("a seed that does not derive the stored deviceId reinitializes", async () => {
    const dir = await tempDir();
    const path = join(dir, "state.json");
    const genuine = await loadOrInitState(path);
    await writeFile(path, JSON.stringify({ ...genuine, deviceId: "forged" }));
    const state = await loadOrInitState(path);
    expect(state.deviceId).not.toBe("forged");
    expect(state.deviceId).not.toBe(genuine.deviceId);
    expect((await identityOfState(state)).deviceId).toBe(state.deviceId);
  });

  test("reinitializes on corrupt state", async () => {
    const dir = await tempDir();
    const path = join(dir, "state.json");
    await writeFile(path, "not json");
    const state = await loadOrInitState(path);
    expect(state.deviceId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test("saveState roundtrips repos", async () => {
    const dir = await tempDir();
    const path = join(dir, "state.json");
    const state = {
      ...(await loadOrInitState(path)),
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
