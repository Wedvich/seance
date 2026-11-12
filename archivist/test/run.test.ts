import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_ID,
  CLOSE_ROLE_REFUSED,
  importPsk,
  MACHINES_ID,
  open,
  parseArchiveStatusReply,
  parseMachineInfo,
  REGISTER_REFUSALS,
  seal,
  toBase64,
  verifyRegister,
} from "@seance/shared";
import { readRuntime } from "../../daemon/src/state.ts";
import { pollUntil } from "../../daemon/test/fixtures.ts";
import { startTestRelay } from "../../daemon/test/harness.ts";
import { isStoreGetTraffic, startArchivist, type ArchivistOpts } from "../src/run.ts";

/**
 * The archivist against the daemon suite's relay double — controllable where the
 * real DO is not (a 4403 on demand). archivist/test/relay.test.ts runs it against
 * the real relay, which is where the seat itself is decided.
 */
const TOKEN = "archivist-run-test-token-0123456789abcdef";
const PSK = toBase64(crypto.getRandomValues(new Uint8Array(32)));

let base: string;
let credentialPath: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "archivist-run-"));
  credentialPath = join(base, "seance-psk");
  await writeFile(credentialPath, `${PSK}\n`, { mode: 0o600 });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

let seq = 0;

/** A fresh config and state dir per test: the identity is minted per state dir. */
async function setup(
  relayUrl: string,
  extra: Record<string, unknown> = {},
): Promise<Required<Pick<ArchivistOpts, "configPath" | "stateDir">>> {
  const dir = join(base, `case-${seq++}`);
  const configPath = join(base, `config-${seq}.json`);
  await writeFile(configPath, JSON.stringify({ name: "archive", relayUrl, bearerToken: TOKEN, ...extra }), {
    mode: 0o600,
  });
  return { configPath, stateDir: dir };
}

describe("seance-archivist run", () => {
  test("registers v2 claiming archivist, with a blob no client reads as a machine, and opens an app leg", async () => {
    const relay = startTestRelay(TOKEN);
    const paths = await setup(relay.url);
    const archivist = await startArchivist({ ...paths, credentialPath });
    try {
      const frame = await relay.registers.next();
      expect(frame.deviceId).toBe(archivist.deviceId);
      expect(frame.roles).toEqual(["archivist"]);
      const claim = {
        deviceId: frame.deviceId,
        publicKey: frame.key,
        ts: frame.ts,
        sig: frame.sig,
        roles: frame.roles,
      };
      expect(await verifyRegister(claim, Date.now())).toBe("ok");

      expect(frame.info.from).toBe(archivist.deviceId);
      expect(frame.info.to).toBe(APP_ID);
      const plain = await open(await importPsk(PSK), frame.info);
      expect(plain.op).toBe("machine-info");
      expect(plain.payload).toEqual({ archivist: true, name: "archive", platform: process.platform });
      // An older client opens it, fails the parse and counts it skewed — never a machine.
      expect(parseMachineInfo(plain.payload)).toBeNull();

      expect(await relay.appEvents.next()).toBe("open");
      expect((await stat(paths.stateDir)).mode & 0o777).toBe(0o700);
      await pollUntil(
        async () => (await readRuntime(join(paths.stateDir, "runtime.json")))?.connected === true,
        "runtime.json to say connected",
      );
    } finally {
      archivist.stop();
      relay.stop();
    }
  });

  test("answers no other op than archive-status, and sends no status and no store frame", async () => {
    const relay = startTestRelay(TOKEN);
    const paths = await setup(relay.url);
    // Captured by hand rather than through `captureLog`: the drops are polled for while it runs.
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map(String).join(" "));
    };
    const drops = (): number => lines.filter((line) => line.includes("the archivist answers only archive-status")).length;
    let archivist: Awaited<ReturnType<typeof startArchivist>> | undefined;
    try {
      archivist = await startArchivist({ ...paths, credentialPath });
      const { deviceId } = archivist;
      await relay.registers.next();
      const key = await importPsk(PSK);
      for (const op of ["sessions", "spawn", "despawn"] as const) {
        // oxlint-disable-next-line no-await-in-loop -- sealed in order, so the log lines are too
        const env = await seal(
          key,
          { to: deviceId, from: APP_ID },
          { id: crypto.randomUUID(), ts: Date.now(), op, payload: {} },
        );
        relay.sendToDaemon(env);
      }
      await pollUntil(() => drops() === 3, "three drops");
      // A non-event: whatever reply or frame was coming has had its chance.
      await Bun.sleep(200);
      expect(relay.messages.size).toBe(0);
      expect(relay.statuses.size).toBe(0);
      expect(relay.storeFrames.size).toBe(0);
      expect(relay.toScheduler.size).toBe(0);
    } finally {
      console.log = realLog;
      archivist?.stop();
      relay.stop();
    }
  });

  test("answers archive-status from the app, and drops one sealed from anyone else", async () => {
    const relay = startTestRelay(TOKEN);
    const paths = await setup(relay.url);
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map(String).join(" "));
    };
    let archivist: Awaited<ReturnType<typeof startArchivist>> | undefined;
    try {
      archivist = await startArchivist({ ...paths, credentialPath });
      const { deviceId } = archivist;
      await relay.registers.next();
      await pollUntil(
        async () => (await readRuntime(join(paths.stateDir, "runtime.json")))?.connected === true,
        "runtime.json to say connected",
      );
      const key = await importPsk(PSK);
      const sealRequest = (from: string, id: string): ReturnType<typeof seal> =>
        seal(key, { to: deviceId, from }, { id, ts: Date.now(), op: "archive-status", payload: {} });

      // A sender that is not the app: dropped with a warn line, never answered.
      relay.sendToDaemon(await sealRequest("some-daemon", "req-other"));
      await pollUntil(() => lines.some((line) => line.includes("not sealed from the app")), "the drop line");
      expect(relay.messages.size).toBe(0);

      relay.sendToDaemon(await sealRequest(APP_ID, "req-app"));
      await pollUntil(() => relay.messages.size === 1, "the reply");
      const reply = await open(key, await relay.messages.next());
      expect(reply.op).toBe("archive-status");
      expect(reply.re).toBe("req-app");
      const parsed = parseArchiveStatusReply(reply.payload);
      if (parsed === null || !parsed.ok) throw new Error("not an ok reply");
      expect(parsed.onlineSince).not.toBeNull();
      expect(parsed.database.archiveBytes).toBeGreaterThan(0);
      expect(parsed.database.metricsBytes).toBeGreaterThan(0);
      expect(Object.keys(parsed.lastIngest).toSorted()).toEqual(["pull", "registry", "status", "store"]);
    } finally {
      console.log = realLog;
      archivist?.stop();
      relay.stop();
    }
  });

  test("puts the build line the update unit recorded in the blob, and none when the file is unusable", async () => {
    const source = { sha: "d".repeat(40), commitTs: 1_700_000_000_000, branch: "main" };
    for (const [text, expected] of [
      [JSON.stringify(source), { source }],
      ["{ not json", {}],
      [JSON.stringify({ sha: "short" }), {}],
    ] as const) {
      const relay = startTestRelay(TOKEN);
      // oxlint-disable-next-line no-await-in-loop -- one archivist at a time
      const paths = await setup(relay.url);
      // oxlint-disable-next-line no-await-in-loop -- as above
      await mkdir(paths.stateDir, { recursive: true });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await writeFile(join(paths.stateDir, "served-source.json"), text);
      // oxlint-disable-next-line no-await-in-loop -- as above
      const archivist = await startArchivist({ ...paths, credentialPath });
      try {
        // oxlint-disable-next-line no-await-in-loop -- as above
        const frame = await relay.registers.next();
        // oxlint-disable-next-line no-await-in-loop -- as above
        const plain = await open(await importPsk(PSK), frame.info);
        expect(plain.payload).toEqual({ archivist: true, name: "archive", platform: process.platform, ...expected });
      } finally {
        archivist.stop();
        relay.stop();
      }
    }
  });

  test("follows the fleet's update announce by writing a request, never by replying", async () => {
    const relay = startTestRelay(TOKEN);
    const paths = await setup(relay.url);
    const requestPath = join(paths.stateDir, "update-requested");
    const archivist = await startArchivist({ ...paths, credentialPath });
    try {
      const { deviceId } = archivist;
      await relay.registers.next();
      // The seat's connect asks once, as a daemon checks on its register.
      await pollUntil(async () => existsSync(requestPath), "the connect's request");
      expect(await readFile(requestPath, "utf8")).toBe("register\n");

      const key = await importPsk(PSK);
      const broadcast = async (payload: unknown): Promise<void> => {
        const env = await seal(
          key,
          { to: MACHINES_ID, from: "some-daemon" },
          { id: crypto.randomUUID(), ts: Date.now(), op: "update-available", payload },
        );
        relay.sendRawToDaemon(deviceId, JSON.stringify({ t: "msg", env }));
      };
      await broadcast({ sha: "malformed" });
      // A non-event, and frames are handled in order: the file must still hold the connect's request.
      await Bun.sleep(200);
      expect(await readFile(requestPath, "utf8")).toBe("register\n");
      const sha = "c".repeat(40);
      await broadcast({ sha, commitTs: Date.now() });
      await pollUntil(
        async () => (await readFile(requestPath, "utf8")) === `announce ${sha}\n`,
        "the announce's request",
      );
      // A non-event: an announce is never answered.
      await Bun.sleep(200);
      expect(relay.messages.size).toBe(0);
    } finally {
      archivist.stop();
      relay.stop();
    }
  });

  // The relay closes a non-seat archivist claim 4403; the client must count it a refusal and back off.
  test("a role refusal keeps backing off and keeps claiming archivist", async () => {
    const relay = startTestRelay(TOKEN);
    relay.refuseRegisters = true;
    relay.refuseWith = { code: CLOSE_ROLE_REFUSED, reason: REGISTER_REFUSALS.roleRefused };
    const paths = await setup(relay.url);
    let archivist: Awaited<ReturnType<typeof startArchivist>> | undefined;
    try {
      const lines: string[] = [];
      const realLog = console.log;
      console.log = (...args: unknown[]): void => {
        lines.push(args.map(String).join(" "));
      };
      try {
        // Base backoff below the cap: a cap under the default base would make every delay the cap, reset or not.
        archivist = await startArchivist({ ...paths, credentialPath, baseBackoffMs: 20, maxBackoffMs: 400 });
        await relay.registers.next();
        await pollUntil(
          () => lines.some((line) => line.includes('code=4403 reason="register role-refused"')),
          "the role refusal",
        );
        // A non-event window: how many dials the backoff lets through.
        await Bun.sleep(1_000);
      } finally {
        console.log = realLog;
      }
      // On the order of ten attempts, where a backoff reset on every open gives ~50.
      expect(relay.connectionCount()).toBeLessThanOrEqual(25);
      const roles: (readonly string[] | undefined)[] = [];
      while (relay.registers.size > 0) roles.push((await relay.registers.next()).roles);
      expect(roles.every((claim) => claim?.length === 1 && claim[0] === "archivist")).toBe(true);
    } finally {
      archivist?.stop();
      relay.stop();
    }
  });

  // The seat's id is configuration: a re-mint would squat forever, so damage stops the start and leaves the file.
  test("refuses to replace a state file it cannot use", async () => {
    const paths = await setup("ws://127.0.0.1:1");
    await mkdir(paths.stateDir, { recursive: true });
    const statePath = join(paths.stateDir, "state.json");
    for (const damaged of ["{ truncated", JSON.stringify({ deviceId: "abc", repos: [], identitySeed: "AAAA" })]) {
      // oxlint-disable-next-line no-await-in-loop -- one damaged file at a time
      await writeFile(statePath, damaged);
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(startArchivist({ ...paths, credentialPath })).rejects.toThrow("refusing to replace");
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect(await readFile(statePath, "utf8")).toBe(damaged);
    }
  });

  test("refuses root before it writes anything", async () => {
    for (const ids of [
      { uid: 0, gid: 1000 },
      { uid: 1000, gid: 0 },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time, each against its own dir
      const paths = await setup("ws://127.0.0.1:1");
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(startArchivist({ ...paths, credentialPath, ...ids })).rejects.toThrow("must never run as root");
      expect(existsSync(paths.stateDir)).toBe(false);
    }
  });

  test("refuses to start without the delivered credential, or with a psk in its config", async () => {
    const paths = await setup("ws://127.0.0.1:1");
    await expect(startArchivist({ ...paths, credentialPath: null })).rejects.toThrow(
      "$CREDENTIALS_DIRECTORY/seance-psk",
    );
    await expect(startArchivist({ ...paths, credentialPath: join(base, "absent") })).rejects.toThrow("docs/psk.md");
    const withPsk = await setup("ws://127.0.0.1:1", { psk: PSK });
    await expect(startArchivist({ ...withPsk, credentialPath })).rejects.toThrow('holds a "psk"');
    expect(existsSync(paths.stateDir)).toBe(false);
    expect(existsSync(withPsk.stateDir)).toBe(false);
  });

  test("the app leg's log drops the per-get wire lines and keeps every failure", () => {
    expect(isStoreGetTraffic('wire send id="abc-1" t=store-get')).toBe(true);
    expect(isStoreGetTraffic('wire recv re="abc-1" t=store-record pending=yes')).toBe(true);
    expect(isStoreGetTraffic('wire send id="abc-2" t=store-list')).toBe(false);
    expect(isStoreGetTraffic('wire timeout id="abc-1" t=store-get after=10000ms')).toBe(false);
    expect(isStoreGetTraffic('wire recv re="abc-1" t=store-refused pending=yes')).toBe(false);
    expect(isStoreGetTraffic('wire dropped re="abc-1" reason=store-stale')).toBe(false);
  });
});
