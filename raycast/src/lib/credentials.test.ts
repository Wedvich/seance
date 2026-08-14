import { homedir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { configSkeleton, loadPsk, type Config } from "../../../daemon/src/config.ts";
import { PSK_SERVICE as DAEMON_PSK_SERVICE } from "../../../daemon/src/keychain.ts";
import { configDir as daemonConfigDir, configPath as daemonConfigPath } from "../../../daemon/src/paths.ts";
import { keychainStore, type PskStore } from "../../../daemon/src/psk-store.ts";
import { configDir, configPath, loadKey, PSK_SERVICE, type CredentialSources } from "./credentials.ts";

/**
 * The point of this file. The extension runs under Node inside Raycast, so it
 * cannot use the daemon's Bun-shaped config and keychain readers — but the tests
 * run under Bun, which means they can import *both* implementations and assert
 * they agree. The two may diverge in mechanism; they may never diverge in the
 * names or the precedence, because a disagreement there is silent: the extension
 * would read a different key, or none, and only fail later at the relay.
 */

function config(overrides: Partial<Config> = {}): Config {
  return {
    name: "box",
    relayUrl: "wss://relay.example.dev/daemon",
    bearerToken: "token",
    psk: "",
    repoRoots: ["/repos"],
    tmuxSession: "main",
    ...overrides,
  };
}

/** 32 bytes, so `importPsk` accepts it. */
const PSK = Buffer.alloc(32, 7).toString("base64");

/** The daemon's real keychain store with only its read swapped, so `loadPsk` takes the genuine branch. */
function keychainDouble(read: () => Promise<string | null>): PskStore {
  return { ...keychainStore(), read };
}

function sources(overrides: Partial<CredentialSources> = {}): Partial<CredentialSources> {
  return {
    readTextFile: () => Promise.resolve(JSON.stringify(config())),
    readKeychain: () => Promise.resolve(PSK),
    env: {},
    home: homedir,
    ...overrides,
  };
}

test("drift guard: the keychain service string is the daemon's", () => {
  expect(PSK_SERVICE).toBe(DAEMON_PSK_SERVICE);
});

/**
 * The daemon reads `process.env` and `homedir()` directly while our module takes
 * both as inputs, so comparability means setting the env for the daemon's call
 * and handing ours the same values.
 */
function bothAgreeUnder(env: Record<string, string | undefined>): void {
  for (const key of ["SEANCE_CONFIG_DIR", "XDG_CONFIG_HOME"] as const) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  expect(configDir({ env, home: homedir })).toBe(daemonConfigDir());
  expect(configPath({ env, home: homedir })).toBe(daemonConfigPath());
}

describe("drift guard: config-dir resolution agrees with daemon/src/paths.ts", () => {
  const saved = { seance: process.env["SEANCE_CONFIG_DIR"], xdg: process.env["XDG_CONFIG_HOME"] };

  afterEach(() => {
    for (const [key, value] of [
      ["SEANCE_CONFIG_DIR", saved.seance],
      ["XDG_CONFIG_HOME", saved.xdg],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("SEANCE_CONFIG_DIR set: used verbatim", () => {
    bothAgreeUnder({ SEANCE_CONFIG_DIR: "/tmp/seance-config" });
  });

  test("XDG_CONFIG_HOME set: seance appended to it", () => {
    bothAgreeUnder({ XDG_CONFIG_HOME: "/tmp/xdg" });
  });

  test("SEANCE_CONFIG_DIR wins over XDG_CONFIG_HOME", () => {
    bothAgreeUnder({ SEANCE_CONFIG_DIR: "/tmp/seance-config", XDG_CONFIG_HOME: "/tmp/xdg" });
  });

  test("neither set: ~/.config/seance", () => {
    bothAgreeUnder({});
  });
});

describe("drift guard: PSK precedence agrees with loadPsk", () => {
  test("a non-empty config psk wins over the keychain, in both", async () => {
    const filled = config({ psk: PSK });
    expect(await loadPsk(filled, [keychainDouble(() => Promise.resolve("other"))])).toEqual({
      psk: PSK,
      source: "config",
    });

    // Ours takes the same branch, which means the keychain is never even asked.
    let asked = false;
    const credentials = await loadKey(
      sources({
        readTextFile: () => Promise.resolve(JSON.stringify(filled)),
        readKeychain: () => {
          asked = true;
          return Promise.resolve("other");
        },
      }),
    );
    expect(asked).toBe(false);
    expect(credentials.key.extractable).toBe(false);
  });

  test("an empty config psk falls through to the keychain, in both, under the same service name", async () => {
    expect(await loadPsk(config(), [keychainDouble(() => Promise.resolve(PSK))])).toEqual({
      psk: PSK,
      source: "keychain",
    });

    const asked: string[] = [];
    await loadKey(
      sources({
        readKeychain: (name) => {
          asked.push(name);
          return Promise.resolve(PSK);
        },
      }),
    );
    expect(asked).toEqual([DAEMON_PSK_SERVICE]);
  });
});

describe("loadKey", () => {
  test("swaps the daemon relay path for the app path and imports a non-extractable key", async () => {
    const credentials = await loadKey(sources());
    expect(credentials.relayUrl).toBe("wss://relay.example.dev/app");
    expect(credentials.bearerToken).toBe("token");
    expect(credentials.key.extractable).toBe(false);
    expect(credentials.key.algorithm.name).toBe("AES-GCM");
  });

  test("names the config path when there is no config to read", async () => {
    const attempt = loadKey(sources({ readTextFile: () => Promise.reject(new Error("ENOENT")) }));
    await expect(attempt).rejects.toThrow(/no Séance config at .*config\.json/u);
  });

  test("says the config is not JSON rather than surfacing a parse error", async () => {
    await expect(loadKey(sources({ readTextFile: () => Promise.resolve("{oops") }))).rejects.toThrow(
      /is not valid JSON/u,
    );
  });

  test("rejects a config that parsed to an array", async () => {
    await expect(loadKey(sources({ readTextFile: () => Promise.resolve("[]") }))).rejects.toThrow(
      /must be a JSON object/u,
    );
  });

  test("names the field when a required string is absent", async () => {
    await expect(loadKey(sources({ readTextFile: () => Promise.resolve("{}") }))).rejects.toThrow(
      /"relayUrl" must be a string/u,
    );
  });

  test("refuses an empty bearerToken instead of dialing into a silent 401", async () => {
    await expect(
      loadKey(sources({ readTextFile: () => Promise.resolve(JSON.stringify(config({ bearerToken: "" }))) })),
    ).rejects.toThrow(/bearerToken is empty/u);
  });

  // Drift-guarded against the daemon's actual skeleton: `seanced init` writes
  // the placeholder this must catch, or `new URL` inside appRelayUrl surfaces
  // a bare "Invalid URL" naming neither the field nor the file.
  test("names the field and file for a config still holding the init placeholder", async () => {
    const placeholder = (JSON.parse(configSkeleton("box")) as { relayUrl: string }).relayUrl;
    await expect(
      loadKey(sources({ readTextFile: () => Promise.resolve(JSON.stringify(config({ relayUrl: placeholder }))) })),
    ).rejects.toThrow(/relayUrl .* is not a ws:\/\/ or wss:\/\/ URL/u);
  });

  test("points at psk-import when neither the config nor the keychain holds a key", async () => {
    await expect(loadKey(sources({ readKeychain: () => Promise.resolve(null) }))).rejects.toThrow(/no PSK for Séance/u);
  });

  test("propagates a failed keychain read rather than reporting a missing key", async () => {
    const locked = new Error("the login keychain is probably locked");
    await expect(loadKey(sources({ readKeychain: () => Promise.reject(locked) }))).rejects.toThrow(locked);
  });

  test("rejects a psk that is not 32 bytes, at import", async () => {
    const short = Buffer.alloc(16).toString("base64");
    await expect(loadKey(sources({ readKeychain: () => Promise.resolve(short) }))).rejects.toThrow(
      /PSK must be 32 bytes/u,
    );
  });
});
