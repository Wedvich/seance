import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toBase64, type RegistryView } from "@seance/shared";
import { loadOrInitState } from "../../daemon/src/state.ts";
import { pollUntil } from "../../daemon/test/fixtures.ts";
import { connectApp, startRelay, type TestRelay } from "../../relay/test/harness.ts";
import { startArchivist } from "../src/run.ts";

/**
 * The archivist against the real relay, where the seat is decided: the id on
 * `ARCHIVIST` registers and shows as the seat, never a machine; any other
 * archivist claim is closed 4403. One workerd boot for the file, disposed after.
 */
const TOKEN = "archivist-relay-test-token-0123456789abcdef";
const PSK = toBase64(crypto.getRandomValues(new Uint8Array(32)));

let base: string;
let credentialPath: string;
let seatStateDir: string;
let seatId: string;
let relay: TestRelay;
let relayUrl: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "archivist-relay-"));
  credentialPath = join(base, "seance-psk");
  await writeFile(credentialPath, `${PSK}\n`, { mode: 0o600 });
  // The seat is an id the operator names, so its identity exists before the relay is told it.
  seatStateDir = join(base, "seat");
  seatId = (await loadOrInitState(join(seatStateDir, "state.json"))).deviceId;
  relay = await startRelay(TOKEN, { archivist: seatId, captureLogs: true });
  const url = new URL("/daemon", relay.url);
  url.protocol = "ws:";
  relayUrl = url.href;
});

afterAll(async () => {
  await relay.dispose();
  await rm(base, { recursive: true, force: true });
});

async function configAt(name: string): Promise<string> {
  const path = join(base, `${name}.json`);
  await writeFile(path, JSON.stringify({ name, relayUrl, bearerToken: TOKEN }), { mode: 0o600 });
  return path;
}

describe("seance-archivist against the real relay", () => {
  test("the seat's id registers and every app sees it flagged as the archivist", async () => {
    const archivist = await startArchivist({
      configPath: await configAt("seat"),
      stateDir: seatStateDir,
      credentialPath,
    });
    const app = await connectApp(relay);
    try {
      expect(archivist.deviceId).toBe(seatId);
      let entry: RegistryView | undefined;
      await pollUntil(async () => {
        const frame = await app.waitFor<{ t: "registry"; entries: readonly RegistryView[] }>("registry", 5_000);
        entry = frame.entries.find((candidate) => candidate.deviceId === seatId);
        return entry?.connected === true;
      }, "the seat's registry entry");
      expect(entry?.archivist).toBe(true);
    } finally {
      app.close();
      archivist.stop();
    }
  });

  test("any other archivist claim is closed 4403 and logged as a role refusal", async () => {
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map(String).join(" "));
    };
    let archivist: Awaited<ReturnType<typeof startArchivist>> | undefined;
    try {
      archivist = await startArchivist({
        configPath: await configAt("squatter"),
        stateDir: join(base, "squatter"),
        credentialPath,
      });
      expect(archivist.deviceId).not.toBe(seatId);
      await pollUntil(
        () => lines.some((line) => line.includes('code=4403 reason="register role-refused"')),
        "the role refusal",
        10_000,
      );
      // The relay half of "squats nothing": the refused claim left no registry entry behind.
      const app = await connectApp(relay);
      try {
        const frame = await app.waitFor<{ t: "registry"; entries: readonly RegistryView[] }>("registry", 5_000);
        expect(frame.entries.some((entry) => entry.deviceId === archivist?.deviceId)).toBe(false);
      } finally {
        app.close();
      }
    } finally {
      console.log = realLog;
      archivist?.stop();
    }
  });
});
