import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toBase64 } from "@seance/shared";
import { pskFingerprint } from "../../daemon/src/config-checks.ts";
import { loadOrInitState, writeRuntime } from "../../daemon/src/state.ts";
import { statusLines } from "../src/status.ts";

const TOKEN = "archivist-status-test-token-0123456789abcdef";
const PSK = toBase64(crypto.getRandomValues(new Uint8Array(32)));

let base: string;
let configPath: string;
let credentialPath: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "archivist-status-"));
  configPath = join(base, "config.json");
  credentialPath = join(base, "seance-psk");
  await writeFile(configPath, JSON.stringify({ name: "archive", relayUrl: "wss://relay.example", bearerToken: TOKEN }));
  await writeFile(credentialPath, PSK);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("seance-archivist status", () => {
  test("before a first run: reads only, mints no identity, and says the key is the unit's", async () => {
    const stateDir = join(base, "fresh");
    const text = (await statusLines({ configPath, stateDir, credentialPath: null })).join("\n");
    expect(text).toContain("none yet");
    expect(text).toContain("not delivered to this process");
    expect(text).toContain("running: no");
    expect(existsSync(stateDir)).toBe(false);
  });

  test("names the device, the key's fingerprint and a live run — never the token, key or seed", async () => {
    const stateDir = join(base, "live");
    const state = await loadOrInitState(join(stateDir, "state.json"));
    const connectedSince = Date.now();
    await writeRuntime(
      { pid: process.pid, startedAt: connectedSince, connected: true, connectedSince },
      join(stateDir, "runtime.json"),
    );
    const text = (await statusLines({ configPath, stateDir, credentialPath })).join("\n");
    expect(text).toContain(state.deviceId);
    expect(text).toContain(await pskFingerprint(PSK));
    expect(text).toContain(`running: pid ${process.pid}, connected since`);
    expect(text).toContain("wss://relay.example");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(PSK);
    expect(state.identitySeed).toBeString();
    expect(text).not.toContain(state.identitySeed ?? "");
  });

  test("a missing config is reported, not thrown", async () => {
    const text = (
      await statusLines({ configPath: join(base, "absent.json"), stateDir: base, credentialPath: null })
    ).join("\n");
    expect(text).toContain("no config at");
  });
});
