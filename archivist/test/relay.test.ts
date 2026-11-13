import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountStoreKey,
  APP_ID,
  CAPABILITIES,
  DAEMON_ROLES,
  importAccountKey,
  importPsk,
  isMetricsRequest,
  SCHEDULER_ID,
  seal,
  sealTaskRecord,
  toBase64,
  type Envelope,
  type MachineInfo,
  type Plain,
  type RegistryView,
  type RelayClient,
  type Task,
} from "@seance/shared";
import { appRelayClient } from "../../daemon/src/app-relay.ts";
import { sealMachineInfo } from "../../daemon/src/machine-info.ts";
import { MetricsStore } from "../../daemon/src/metrics-store.ts";
import { RelayClient as DaemonClient } from "../../daemon/src/relay-client.ts";
import { identityOfState, loadOrInitState } from "../../daemon/src/state.ts";
import { pollUntil } from "../../daemon/test/fixtures.ts";
import {
  connectApp,
  connectDaemon,
  envelope,
  newDeviceId,
  register,
  startRelay,
  type Client,
  type TestRelay,
} from "../../relay/test/harness.ts";
import { archivePathIn, metricsPathIn } from "../src/paths.ts";
import { startArchivist } from "../src/run.ts";

/**
 * The archivist against the real relay, where the seat is decided: the id on
 * `ARCHIVIST` registers and shows as the seat, never a machine; any other
 * archivist claim is closed 4403. Then what it collects, from a listed leader's
 * writes and a real registry. One workerd boot for the file, disposed after.
 */
const TOKEN = "archivist-relay-test-token-0123456789abcdef";
const PSK = toBase64(crypto.getRandomValues(new Uint8Array(32)));

let base: string;
let credentialPath: string;
let seatStateDir: string;
let seatId: string;
let leaderId: string;
let relay: TestRelay;
let relayUrl: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "archivist-relay-"));
  credentialPath = join(base, "seance-psk");
  await writeFile(credentialPath, `${PSK}\n`, { mode: 0o600 });
  // The seat is an id the operator names, so its identity exists before the relay is told it.
  seatStateDir = join(base, "seat");
  seatId = (await loadOrInitState(join(seatStateDir, "state.json"))).deviceId;
  leaderId = await newDeviceId();
  relay = await startRelay(TOKEN, { archivist: seatId, leaders: [leaderId], captureLogs: true });
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

/** Present in every prompt this suite writes; the archive's bytes must never hold it. */
const PROMPT_MARKER = "PROMPT-MARKER-7f3a";
const SLUG = "prompt-slug-9c1e-rotate-the-key";
const ACCOUNT = "0f0e0d0c-0b0a-0908-0706-050403020100:00010203-0405-0607-0809-0a0b0c0d0e0f";
const BUILD = "0123456789abcdef0123456789abcdef01234567";

function queued(id: string): Task {
  return {
    id,
    spec: { repo: "seance", mode: "worktree", prompt: `${PROMPT_MARKER} build it`, title: `Task ${id}` },
    state: "queued",
    createdAt: Date.now(),
  };
}

interface TaskRowView {
  readonly version: number;
  readonly state: string;
  readonly pr_state: string | null;
}

interface EventView {
  readonly kind: string;
  readonly device_id: string;
  readonly name: string | null;
  readonly build: string | null;
  readonly term: number | null;
}

describe("collection against the real relay", () => {
  let key: CryptoKey;
  let accountKey: CryptoKey;
  let leader: Client;
  let term: number;
  let writer: RelayClient;
  let leaderLeg: RelayClient;
  let archivist: Awaited<ReturnType<typeof startArchivist>> | undefined;
  let writes = 0;

  const query = <T>(sql: string, ...params: string[]): T[] => {
    const db = new Database(archivePathIn(seatStateDir), { readonly: true });
    try {
      return db.query<T, string[]>(sql).all(...params);
    } finally {
      db.close();
    }
  };
  const taskAt = (id: string): TaskRowView | undefined =>
    query<TaskRowView>("SELECT version, state, pr_state FROM tasks WHERE id = ?", id)[0];
  const events = (): EventView[] =>
    query<EventView>("SELECT kind, device_id, name, build, term FROM events ORDER BY id");

  /** A store frame from the leader's own socket under its term, as the leader writes. */
  const leaderWrite = async (frame: Record<string, unknown>): Promise<{ t: string }> => {
    writes += 1;
    const id = `w-${writes}`;
    leader.send({ ...frame, id, term });
    return leader.waitForRe<{ re: string; t: string }>(id, 5_000);
  };
  const settle = async (task: Task, version: number): Promise<void> => {
    const env = await sealTaskRecord(key, leaderId, { version, task });
    expect(await leaderWrite({ t: "store-put", key: `task:${task.id}`, expect: version - 1, env })).toMatchObject({
      t: "store-written",
    });
  };
  const opened = (client: RelayClient): Promise<void> =>
    pollUntil(() => client.getState().status === "open", "an app leg open");
  const ran = (id: string, over: Partial<Task>): Task => ({
    ...queued(id),
    state: "done",
    assignment: { deviceId: leaderId, exclave: "default", clone: "seance" },
    prUrl: "https://github.com/o/r/pull/7",
    doneBy: "session",
    ...over,
  });

  beforeAll(async () => {
    [key, accountKey] = await Promise.all([importPsk(PSK), importAccountKey(PSK)]);
    const info: MachineInfo = {
      name: "leader-box",
      platform: "linux",
      repos: [],
      scannedAt: Date.now(),
      source: { sha: BUILD, commitTs: Date.now(), branch: "main" },
      exclaves: [{ id: "default", accountId: ACCOUNT, extraUsageEnabled: null, authOk: true, skills: [] }],
    };
    const sealedInfo: Envelope = await seal(
      key,
      { to: APP_ID, from: leaderId },
      { id: crypto.randomUUID(), ts: Date.now(), op: "machine-info", payload: info },
    );
    leader = await connectDaemon(relay);
    leader.send(await register(leaderId, { roles: [DAEMON_ROLES.scheduler], info: sealedInfo }));
    ({ term } = await leader.waitFor<{ t: "lead"; term: number }>("lead", 5_000));
    const proof = await seal(
      key,
      { to: APP_ID, from: leaderId },
      { id: crypto.randomUUID(), ts: Date.now(), op: "lead-proof", payload: { term } },
    );
    leader.send({ t: "lead-proof", term, env: proof });

    const config = { relayUrl, bearerToken: TOKEN };
    writer = appRelayClient(config, { key, accountKey }, () => {});
    leaderLeg = appRelayClient(config, key, () => {}, { term });
    writer.start();
    leaderLeg.start();
    await Promise.all([opened(writer), opened(leaderLeg)]);

    // Before the archivist starts: a finished task with its prompt still on it, a queued one, and a record no key opens.
    expect(await writer.createTask(queued("arch-a"))).toEqual({ ok: true, landedEarlier: false });
    // A title-less task's window and branch are slugged from its prompt; neither may reach the archive.
    await settle(
      ran("arch-a", {
        pr: { state: "open", at: Date.now() },
        assignment: { deviceId: leaderId, exclave: "default", clone: "seance", window: SLUG, pane: "%1" },
        branch: `worktree-${SLUG}`,
      }),
      2,
    );
    expect(await writer.createTask(queued("arch-b"))).toEqual({ ok: true, landedEarlier: false });
    const raw = await connectApp(relay);
    try {
      raw.send({ t: "store-put", id: "junk", key: "task:arch-junk", expect: 0, env: envelope(SCHEDULER_ID, APP_ID) });
      expect(await raw.waitForRe<{ re: string; t: string }>("junk", 5_000)).toMatchObject({ t: "store-written" });
    } finally {
      raw.close();
    }

    archivist = await startArchivist({
      configPath: await configAt("seat"),
      stateDir: seatStateDir,
      credentialPath,
      collect: { listGapMs: 200, retryMs: 500 },
    });
  });

  afterAll(() => {
    archivist?.stop();
    writer.stop();
    leaderLeg.stop();
    leader.close();
  });

  test("a finished task is archived without its prompt, under its machine and the account's store key", async () => {
    await pollUntil(() => taskAt("arch-a") !== undefined, "task arch-a archived", 10_000);
    const [row] = query<{ version: number; state: string; machine: string; account: string; record: string }>(
      "SELECT version, state, machine, account, record FROM tasks WHERE id = ?",
      "arch-a",
    );
    expect(row).toMatchObject({ version: 2, state: "done", machine: "leader-box" });
    expect(row?.account).toBe(await accountStoreKey(accountKey, ACCOUNT));
    expect(row?.record).not.toContain(PROMPT_MARKER);
    expect(row?.record).not.toContain(SLUG);
    // Neither the queued task nor the record nothing opens is archived; the unreadable one is still in the store.
    expect(taskAt("arch-b")).toBeUndefined();
    expect(taskAt("arch-junk")).toBeUndefined();
    const raw = await connectApp(relay);
    try {
      raw.send({ t: "store-get", id: "junk-get", key: "task:arch-junk" });
      const got = await raw.waitForRe<{ re: string; record: { version: number } | null }>("junk-get", 5_000);
      expect(got.record?.version).toBe(1);
    } finally {
      raw.close();
    }
  });

  test("a later PR reading lands by version; a record that leaves the store keeps its row", async () => {
    await pollUntil(() => taskAt("arch-a") !== undefined, "task arch-a archived", 10_000);
    await settle(ran("arch-a", { pr: { state: "merged", at: Date.now() } }), 3);
    expect(await leaderLeg.queueChanged({ at: Date.now(), tasks: ["arch-a"] })).toBe(true);
    await pollUntil(() => taskAt("arch-a")?.version === 3, "arch-a at version 3", 10_000);
    expect(taskAt("arch-a")?.pr_state).toBe("merged");

    expect(await leaderWrite({ t: "store-delete", key: "task:arch-a", expect: 3 })).toMatchObject({
      t: "store-written",
    });
    expect(await writer.createTask(queued("arch-c"))).toEqual({ ok: true, landedEarlier: false });
    await settle({ ...queued("arch-c"), state: "cancelled" }, 2);
    // One nudge naming both: arch-c landing proves the deleted arch-a was read too, and left as it was.
    expect(await leaderLeg.queueChanged({ at: Date.now(), tasks: ["arch-a", "arch-c"] })).toBe(true);
    await pollUntil(() => taskAt("arch-c") !== undefined, "task arch-c archived", 10_000);
    expect(taskAt("arch-c")?.state).toBe("cancelled");
    expect(taskAt("arch-a")).toEqual({ version: 3, state: "done", pr_state: "merged" });
  });

  test("an account is kept by its store key with its alias; no archive byte holds the raw id or a prompt", async () => {
    const storeKey = await accountStoreKey(accountKey, ACCOUNT);
    expect(await writer.putAccountAlias(ACCOUNT, "Work", 0)).toMatchObject({ ok: true });
    await pollUntil(
      () => query<{ alias: string | null }>("SELECT alias FROM accounts WHERE key = ?", storeKey)[0]?.alias === "Work",
      "the alias archived",
      10_000,
    );
    for (const name of (await readdir(seatStateDir)).filter((file) => file.startsWith("archive.sqlite"))) {
      // oxlint-disable-next-line no-await-in-loop -- the database and its WAL, two small files
      const bytes = await readFile(join(seatStateDir, name), "latin1");
      expect(bytes.includes(ACCOUNT)).toBe(false);
      expect(bytes.includes(PROMPT_MARKER)).toBe(false);
      expect(bytes.includes(SLUG)).toBe(false);
    }
  });

  test("fleet events: the leader first seen, connected and its term; gone when it leaves; the seat is no machine", async () => {
    await pollUntil(() => events().some((event) => event.kind === "term_changed"), "the term event", 10_000);
    expect(events()).toEqual([
      { kind: "first_seen", device_id: leaderId, name: "leader-box", build: BUILD, term: null },
      { kind: "connected", device_id: leaderId, name: "leader-box", build: null, term: null },
      { kind: "term_changed", device_id: leaderId, name: "leader-box", build: null, term },
    ]);
    expect(query("SELECT device_id FROM machines")).toEqual([{ device_id: leaderId }]);
    leader.close();
    await pollUntil(() => events().some((event) => event.kind === "gone"), "the gone event", 10_000);
    expect(events().at(-1)).toMatchObject({ kind: "gone", device_id: leaderId, name: "leader-box" });
    expect(query("SELECT name, connected, in_registry FROM machines")).toEqual([
      { name: "leader-box", connected: 0, in_registry: 1 },
    ]);
  });
});

describe("metrics against the real relay", () => {
  const METRICS_ACCOUNT = "1a1a1a1a-2b2b-3c3c-4d4d-5e5e5e5e5e5e:6f6f6f6f-7a7a-8b8b-9c9c-0d0d0d0d0d0d";
  let store: MetricsStore;
  // `daemon.stop()` leaves an envelope already read to run its handler: one the archivist's pull
  // timer sent just before teardown must not reach a closed store.
  let storeOpen = true;
  let daemon: DaemonClient;
  let daemonId: string;
  let archivist: Awaited<ReturnType<typeof startArchivist>> | undefined;
  const nowS = Math.floor(Date.now() / 1000);
  const scannedAt = Date.now();

  const points = (sql: string, ...params: string[]): { ts: number; value: number; labels: string }[] => {
    const db = new Database(metricsPathIn(seatStateDir), { readonly: true });
    try {
      return db
        .query<{ ts: number; value: number; labels: string }, string[]>(
          `SELECT r.ts, r.value, s.labels FROM raw r JOIN series s ON s.id = r.series WHERE ${sql}`,
        )
        .all(...params);
    } finally {
      db.close();
    }
  };

  beforeAll(async () => {
    const key = await importPsk(PSK);
    store = MetricsStore.memory();
    // The daemon's last ten minutes, one tick every 30 s, as its own collectors write them.
    for (let ts = nowS - 600; ts <= nowS - 30; ts += 30) {
      store.write(
        [
          { metric: "cpu_pct", labels: {}, ts, value: 12.34 },
          { metric: "quota_5h_pct", labels: { exclave: "default", account: METRICS_ACCOUNT }, ts, value: 40 },
        ],
        ts,
      );
    }
    const state = await loadOrInitState(join(base, "metrics-daemon", "state.json"));
    daemonId = state.deviceId;
    const info: MachineInfo = {
      name: "metrics-box",
      platform: "linux",
      repos: [],
      scannedAt,
      capabilities: [CAPABILITIES.metrics],
      exclaves: [{ id: "default", accountId: METRICS_ACCOUNT, extraUsageEnabled: null, authOk: true, skills: [] }],
    };
    daemon = new DaemonClient({
      url: relayUrl,
      bearerToken: TOKEN,
      identity: await identityOfState(state),
      key,
      buildInfo: async () => (await sealMachineInfo(key, daemonId, info)).sealed,
      // The daemon's metrics op, from its own store: what the archivist pulls.
      handle: (plain: Plain): Promise<Plain | null> =>
        Promise.resolve(
          storeOpen && plain.op === "metrics" && isMetricsRequest(plain.payload)
            ? {
                id: crypto.randomUUID(),
                ts: Date.now(),
                op: "metrics",
                re: plain.id,
                payload: { series: store.query(plain.payload) },
              }
            : null,
        ),
    });
    daemon.start();
    archivist = await startArchivist({
      configPath: await configAt("seat"),
      stateDir: seatStateDir,
      credentialPath,
      metrics: { pullMs: 200 },
    });
  });

  afterAll(() => {
    archivist?.stop();
    daemon.stop();
    storeOpen = false;
    store.close();
  });

  test("a live status and the daemon's pulled history land per observer, the account by its store key", async () => {
    // A tick the daemon's store has not written yet: only the live frame carries it.
    await pollUntil(() => daemon.sendStatus({ at: nowS, scan: scannedAt, cpu: 42 }), "the status sent", 10_000);
    await pollUntil(() => points("r.ts = ?", String(nowS)).length > 0, "the live sample", 10_000);
    await pollUntil(() => points("r.ts = ?", String(nowS - 600)).length === 2, "the pulled history", 10_000);
    const observer = { machine: daemonId };
    expect(points("r.ts = ?", String(nowS)).map((p) => [p.value, JSON.parse(p.labels)])).toEqual([[42, observer]]);
    const storeKey = await accountStoreKey(await importAccountKey(PSK), METRICS_ACCOUNT);
    expect(
      points("r.ts = ?", String(nowS - 600))
        .map((p) => [p.value, JSON.parse(p.labels)])
        .toSorted((a, b) => Number(a[0]) - Number(b[0])),
    ).toEqual([
      [12.34, observer],
      [40, { ...observer, exclave: "default", account: storeKey }],
    ]);
    for (const name of (await readdir(seatStateDir)).filter((file) => file.startsWith("metrics.sqlite"))) {
      // oxlint-disable-next-line no-await-in-loop -- the database and its WAL, two small files
      expect((await readFile(join(seatStateDir, name), "latin1")).includes(METRICS_ACCOUNT)).toBe(false);
    }
  });
});
