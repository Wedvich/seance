import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test, type Mock } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AT_REST_OPS,
  CAPABILITIES,
  openAtRest,
  parseSettingsRecord,
  parseStoreReply,
  PUSH_MAX_SUBSCRIPTIONS,
  SCHEDULER_ID,
  SETTINGS_KEY,
  STORE_TIMEOUT_MS,
  type SessionEntry,
  type SettingsRecord,
  type SpawnResponse,
} from "@seance/shared";
import { exec } from "../daemon/src/exec.ts";
import { localSocketReachable } from "../daemon/src/local-client.ts";
import { RelayClient as DaemonRelayClient } from "../daemon/src/relay-client.ts";
import { tmux, tmuxOk } from "../daemon/src/tmux.ts";
import { pollUntil } from "../daemon/test/fixtures.ts";
import {
  cancelTask,
  killWindow,
  listRegisteredWindows,
  listWindows,
  startApp,
  takeLeakedTasks,
  type SecondDaemon,
  type Stack,
} from "./harness.ts";
import { connectApp } from "../relay/test/harness.ts";
import { fixtureOrigin, q, startSuite, watchLeader, type Suite } from "./suite.ts";

let suite: Suite | undefined;
let base: string;
let stack: Stack;
/** Every store frame the in-process daemon sends, from before its first term; a second daemon's are not here. */
let daemonStore: Mock<DaemonRelayClient["store"]> | undefined;

beforeAll(async () => {
  daemonStore = spyOn(DaemonRelayClient.prototype, "store");
  suite = await startSuite("e2e-leader");
  ({ base, stack } = suite);
});

// A task a test leaves running holds a slot under its account's cap (4) for every later test.
afterEach(() => {
  expect(takeLeakedTasks()).toEqual([]);
});

afterAll(async () => {
  daemonStore?.mockRestore();
  // startSuite failing in beforeAll leaves suite unset, having torn down what it started.
  await suite?.dispose();
});

describe("scheduler leadership ↔ real daemons", () => {
  test("real daemons are nominated, a stopped leader hands over under a higher term, and a returning one follows", async () => {
    const watch = watchLeader(stack.relay);
    const second = await stack.startSecondDaemon({ name: "LeaderBox" });
    let down = false;
    try {
      // The suite's own daemon has been connected longest.
      await pollUntil(() => watch.current()?.deviceId === stack.deviceId, "the suite's daemon to lead");
      const term = watch.current()?.term ?? 0;

      // Stopped and kept down until the handover shows, not restarted outright:
      // a redial that registers before the relay has processed its old socket's
      // close finds itself still a candidate, and a current leader keeps the
      // role across its own reconnect — on a fast runner, every time.
      stack.daemon.stop();
      down = true;
      await pollUntil(
        () => watch.current()?.deviceId === second.deviceId && (watch.current()?.term ?? 0) > term,
        "the second daemon to take over",
        10_000,
      );
      const handedOver = watch.current()?.term ?? 0;
      await stack.restartDaemon();
      down = false;
      // The first daemon is back, and connected later: it follows.
      await pollUntil(() => watch.connected(stack.deviceId), "the restarted daemon to reconnect", 10_000);
      expect(watch.current()).toMatchObject({ deviceId: second.deviceId, term: handedOver });
      await pollUntil(
        async () => (await Bun.file(second.log).text()).includes(`relay says lead term=${handedOver}`),
        "the second daemon to log its lead",
      );
    } finally {
      // The suites after this one need the stack's own daemon up.
      if (down) await stack.restartDaemon();
      await second.stop();
      watch.close();
    }
  });
});

describe("session event: mod's CLI ↔ remote daemon ↔ relay ↔ leader", () => {
  // The double spawn item 5 closes, end to end: a task reserved on machine B
  // whose spawn reply never came, and whose session reports itself ended.
  test("a session's ended event on another machine resolves the leader's reservation as done", async () => {
    const taskId = "e2e-event-task";
    let second: SecondDaemon | null = null;
    let pane: string | null = null;
    try {
      // B's id first: booted once to mint it, then down, so the suite's daemon
      // leads alone and takes the task over finding no session for it.
      const minted = await stack.startSecondDaemon({ name: "EventBox" });
      const b = minted.deviceId;
      await minted.stop();
      await stack.seedTask({
        id: taskId,
        spec: { repo: "github.com/acme/app", mode: "worktree" },
        state: "reserved",
        createdAt: Date.now(),
        reservation: { deviceId: b, exclave: "default", clone: "app", expiresAt: Date.now() + 600_000 },
      });
      await stack.restartDaemon();
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      expect((await stack.queue().get(taskId))?.body?.state).toBe("reserved");
      // Same state dir, same id; connected later, so it follows.
      second = await stack.startSecondDaemon({ name: "EventBox" });
      expect(second.deviceId).toBe(b);

      // A pane carrying the task whose process sends `ended` through the real
      // CLI to B's op socket: B binds it by peer pid and forwards it sealed to
      // the scheduler, and the relay routes it to the leader.
      const input = join(base, "event.json");
      await Bun.write(input, JSON.stringify({ state: "ended" }));
      const go = join(base, "event.go");
      const main = join(import.meta.dir, "..", "daemon", "src", "main.ts");
      // A session of its own: B's opens only with its first spawn.
      const created = await tmuxOk([
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-s",
        "e2e-event-sender",
        "-c",
        stack.fixture.root,
        "-e",
        `SEANCE_STATE_DIR=${second.stateDir}`,
        "sh",
        "-c",
        `while [ ! -e ${q(go)} ]; do sleep 0.05; done; ${q(process.execPath)} ${q(main)} session-event < ${q(input)}; exec sleep 600`,
      ]);
      pane = created.trim();
      await tmux(["set-option", "-p", "-t", pane, "@seance-task", taskId]);
      const socket = join(second.stateDir, "run", "seanced.sock");
      await pollUntil(() => localSocketReachable(socket), "B's op socket", 10_000);
      await Bun.write(go, "");

      await pollUntil(
        async () => (await stack.queue().get(taskId))?.body?.state === "done",
        "the leader to take the event",
        10_000,
      );
      expect((await stack.queue().get(taskId))?.body?.assignment).toMatchObject({ deviceId: b, pane });
    } finally {
      if (pane !== null) await tmux(["kill-session", "-t", "e2e-event-sender"]);
      await second?.stop();
    }
  });
});

describe("session report: MCP's report path ↔ local daemon ↔ relay ↔ leader (#21)", () => {
  // A real dispatch, not a seeded record: the daemon notes a report only for a task its launch
  // ledger holds (`unrecorded` otherwise), and only a spawn writes it there.
  test("a pane carrying an until: reported task reports done: the task settles by it and a done-dependent leaves blocked", async () => {
    const predecessor = "e2e-report-pred";
    const dependent = "e2e-report-next";
    const nudge = "e2e-report-nudge";
    const app = startApp(stack);
    let window: string | undefined;
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      // A spawn before the machine's repos are listed resolves no repo and does nothing, silently.
      const ready = await app.waitForApp(
        (state) =>
          state.relay.scheduler.kind === "ready" &&
          state.relay.machines.some((m) => m.deviceId === stack.deviceId && m.connected && m.repos.length > 0),
        "the leader verified and the machine's repos listed",
      );
      const origin = fixtureOrigin(ready);
      if (origin === null) throw new Error("the fixture machine lists no repo origin");
      const queued = await app.client.createTask({
        id: predecessor,
        spec: { repo: origin, mode: "worktree", until: "reported" },
        state: "queued",
        createdAt: Date.now(),
      });
      expect(queued).toEqual({ ok: true, landedEarlier: false });
      await pollUntil(
        async () => (await stack.queue().get(predecessor))?.body?.state === "running",
        "the predecessor to run",
        20_000,
      );
      window = (await stack.queue().get(predecessor))?.body?.assignment?.window;
      // A repo no machine holds, so the released dependent only leaves `blocked` and spawns nothing.
      const waiting = await app.client.createTask({
        id: dependent,
        spec: { repo: "github.com/acme/never-cloned", mode: "worktree", deps: [{ task: predecessor, after: "done" }] },
        state: "queued",
        createdAt: Date.now(),
      });
      expect(waiting).toEqual({ ok: true, landedEarlier: false });
      await pollUntil(
        async () => (await stack.queue().get(dependent))?.body?.state === "blocked",
        "the dependent to wait on the report",
        10_000,
      );

      const out = join(base, "report.json");
      const script = join(base, "report.ts");
      const go = join(base, "report.go");
      await rm(out, { force: true });
      await rm(go, { force: true });
      const tool = join(import.meta.dir, "..", "daemon", "src", "report-done.ts");
      const socket = join(process.env["SEANCE_STATE_DIR"] ?? "", "run", "seanced.sock");
      await Bun.write(
        script,
        `import { reportDone } from ${JSON.stringify(tool)};\nawait Bun.write(${JSON.stringify(out)}, JSON.stringify(await reportDone({ path: ${JSON.stringify(socket)} })));\n`,
      );
      // The reporter takes over the spawned pane, so it runs where the session would: the daemon binds
      // it by its parent walk to that pane, and the pane carries the task the spawn tagged it with.
      // (Its assignment carries no pane until the session registers, which the stub does not.)
      const panes = await tmuxOk(["list-panes", "-a", "-F", "#{pane_id} #{@seance-task}"]);
      const pane = panes
        .split("\n")
        .map((line) => line.split(" "))
        .find(([, task]) => task === predecessor)?.[0];
      if (pane === undefined) throw new Error(`no pane carries ${predecessor}: ${panes}`);
      await tmuxOk([
        "respawn-pane",
        "-k",
        "-t",
        pane,
        "sh",
        "-c",
        `while [ ! -e ${q(go)} ]; do sleep 0.05; done; ${q(process.execPath)} ${q(script)}; exec sleep 600`,
      ]);
      await pollUntil(() => localSocketReachable(socket), "the suite daemon's op socket", 10_000);
      await Bun.write(go, "");

      await pollUntil(async () => (await Bun.file(out).exists()) && (await Bun.file(out).text()) !== "", "the report");
      expect(JSON.parse(await Bun.file(out).text())).toEqual({
        ok: true,
        text: "sent — settles the task if it was queued to settle on its report",
      });
      await pollUntil(
        async () => (await stack.queue().get(predecessor))?.body?.state === "done",
        "the leader to settle the task on its report",
        10_000,
      );
      expect((await stack.queue().get(predecessor))?.body).toMatchObject({
        doneBy: "reported",
        assignment: { deviceId: stack.deviceId, pane },
      });
      // A report moves its task and nothing else: the dependent waits for the leader's next pass (30s), which
      // an app's create nudges (`store-changed`), as in auto.test.ts.
      const nudged = await app.client.createTask({
        id: nudge,
        spec: { repo: "github.com/acme/never-cloned", mode: "worktree" },
        state: "queued",
        createdAt: Date.now(),
      });
      expect(nudged).toEqual({ ok: true, landedEarlier: false });
      await pollUntil(
        async () => (await stack.queue().get(dependent))?.body?.state === "ready",
        "the dependent to be released",
        10_000,
      );
    } finally {
      await cancelTask(app.client, nudge);
      app.stop();
      if (window !== undefined) await killWindow(window);
    }
  });
});

describe("takeover: a leader stopped between spawn and verdict", () => {
  // M3's Exit bullet "kill the leader between `spawn` and its verdict": B's spawn is
  // held mid-flight (a claude stub that waits for a go file), the leader stops, and B
  // answers into the void. The next term finds the session and must not start a twin.
  let held: string;
  let go: string;

  beforeAll(async () => {
    const dir = join(base, "held");
    await mkdir(dir, { recursive: true });
    held = join(dir, "claude");
    go = join(dir, "go");
    // The go path is baked in: a pane gets the tmux server's environment, not B's.
    await Bun.write(
      held,
      [
        "#!/bin/bash",
        '[ "$1" = --held-warm ] && exit 0',
        `while [ ! -e ${q(go)} ]; do sleep 0.05; done`,
        `exec ${q(stack.stub.ok)} "$@"`,
        "",
      ].join("\n"),
    );
    await chmod(held, 0o755);
    // First exec of a new executable pays the macOS scan: here, not inside a timed window.
    await exec([held, "--held-warm"]);
  });

  test("a spawn answered after the leader stopped is settled running by the next term, with no second spawn", async () => {
    // A rerun in this process finds the go file the last run left, and the stub would not hold.
    await rm(go, { force: true });
    const id = crypto.randomUUID();
    const title = "held-dispatch";
    // The suite's daemon audits to its stdout, which in-process is console.log.
    const audit = spyOn(console, "log");
    const app = startApp(stack);
    let second: SecondDaemon | null = null;
    let down = false;
    try {
      // The takeover settles what the earlier tests in this file left running, whose windows are gone: caps are clear.
      await stack.restartDaemon();
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();

      // A ledger old enough to prove a never-landed spawn (`ledgerSince` + the replay window <= the
      // reservation), so only B's write-ahead listing of the task keeps the next term from
      // returning it to `ready`. A ledger created at B's boot would be too young to ever do so.
      const ledgerSince = Date.now() - 10 * 60_000;
      second = await stack.startSecondDaemon({
        name: "LedgerBox",
        exclaves: [{ id: "default", observedAtMs: Date.now(), fiveHourPct: 10 }],
        env: { SEANCE_CLAUDE_BIN: held, SEANCE_E2E_SPAWN_WAIT_MS: "60000" },
        beforeBoot: (stateDir) =>
          writeFile(join(stateDir, "launched.json"), JSON.stringify({ v: 1, since: ledgerSince, tasks: [] }), {
            mode: 0o600,
          }),
      });
      const b = second.deviceId;
      // Not on SCHEDULER_LEADERS: with the suite's daemon down, nobody leads.
      const ready = await app.waitForApp(
        (state) =>
          state.relay.scheduler.kind === "ready" &&
          fixtureOrigin(state) !== null &&
          state.relay.machines.some(
            (m) => m.deviceId === b && m.connected && m.status !== undefined && m.repos.length > 0,
          ),
        "the leader verified and LedgerBox live with its repos listed",
      );
      const origin = fixtureOrigin(ready) ?? "";

      // The pin forces the decision onto B.
      const created = await app.client.createTask({
        id,
        spec: { repo: origin, mode: "here", title, prompt: "held", pin: { deviceId: b } },
        state: "queued",
        createdAt: Date.now(),
      });
      expect(created).toEqual({ ok: true, landedEarlier: false });
      // The window exists only after B's launch ledger recorded the id: the write precedes the spawn.
      await pollUntil(async () => (await listWindows()).includes(title), "B's spawn to reach its backend", 15_000);

      stack.daemon.stop();
      down = true;
      await app.waitForApp((state) => state.relay.scheduler.kind === "none", "no leader after the stop");
      const stopped = await app.client.getTask(id);
      if (stopped === null || !stopped.ok || stopped.task === null || !("task" in stopped.task)) {
        throw new Error(`no readable record: ${JSON.stringify(stopped)}`);
      }
      // The verdict never landed.
      expect(stopped.task.task).toMatchObject({ state: "reserved", reservation: { deviceId: b } });

      // B's stub registers and its reply goes out, to no leader.
      await Bun.write(go, "");
      await pollUntil(async () => (await listRegisteredWindows()).includes(title), "the held pane to register", 15_000);
      await pollUntil(
        async () => (await Bun.file(second?.log ?? "").text()).includes("audit spawn origin=relay ok window="),
        "B to audit the spawn as done",
        15_000,
      );

      await stack.restartDaemon();
      down = false;
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead again", 10_000);
      await stack.daemon.leader.settled();

      const listed = await app.client.request<{ sessions: readonly SessionEntry[] }>(b, "sessions", {});
      if ("ok" in listed) throw new Error(listed.code);
      // The precondition of the whole test, read off B's disk (only the scheduler is sent
      // `ledgerSince`): the ledger reaches back past the reservation, and lists the task.
      const ledger: unknown = await Bun.file(join(second.stateDir, "launched.json")).json();
      expect(ledger).toMatchObject({ since: ledgerSince, tasks: expect.arrayContaining([[id, expect.any(Number)]]) });
      const carrying = listed.sessions.filter((s) => s.taskId === id);
      expect(carrying).toHaveLength(1);
      const pane = carrying[0]?.id;
      if (pane === undefined) throw new Error("the session has no pane id");
      await pollUntil(
        async () => (await stack.queue().get(id))?.body?.state === "running",
        "the next term to settle the task running",
        10_000,
      );
      expect((await stack.queue().get(id))?.body).toMatchObject({
        state: "running",
        assignment: { deviceId: b, pane },
      });

      // No second spawn. A sleep is right before a negative assertion: a non-event cannot be polled.
      await Bun.sleep(500);
      const requests = (await Bun.file(second.log).text())
        .split("\n")
        .filter((line) => line.includes("audit spawn origin=relay") && line.includes(`task=${JSON.stringify(id)}`));
      expect(requests).toHaveLength(1);
      expect((await listWindows()).filter((w) => w === title)).toHaveLength(1);
      expect(
        audit.mock.calls.map((args) => args.join(" ")).filter((l) => l.includes("audit spawn") && l.includes(id)),
      ).toEqual([]);
    } finally {
      if (down) await stack.restartDaemon();
      // Frees a stub still waiting if the test failed before releasing it.
      await Bun.write(go, "");
      await cancelTask(app.client, id);
      if (second !== null) await tmux(["kill-session", "-t", second.tmuxSession]).catch(() => undefined);
      await second?.stop();
      app.stop();
      audit.mockRestore();
    }
  }, 60_000);
});

/**
 * RFC 8291 Appendix A's user agent: a real P-256 point, so a send gets as far as the request,
 * where `pushGuardFetch` refuses it. Keys that were not a point would fail earlier, at
 * encryption, and prove nothing about the seam.
 */
const USER_AGENT_KEYS = {
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};

describe("settings record: the leader's term creates it, and no later term replaces it", () => {
  /** What an app's `store-get` of `settings:main` opens to, as any PSK holder reads it. */
  const readSettings = async (): Promise<{ readonly version: number; readonly record: SettingsRecord } | null> => {
    const app = await connectApp(stack.relay);
    try {
      const id = crypto.randomUUID();
      app.send({ t: "store-get", id, key: SETTINGS_KEY });
      const reply = parseStoreReply(await app.waitForRe<{ re: string }>(id, STORE_TIMEOUT_MS));
      if (reply?.t !== "store-record") throw new Error(`store-get answered ${JSON.stringify(reply)}`);
      if (reply.record === null) return null;
      expect(reply.record.env.to).toBe(SCHEDULER_ID);
      const opened = await openAtRest(stack.appKey, reply.record.env, AT_REST_OPS.settings);
      const record = parseSettingsRecord(opened.payload);
      if (record === null) throw new Error("the settings record does not parse");
      return { version: reply.record.version, record };
    } finally {
      app.close();
    }
  };

  /** The `expect` of each settings create or overwrite the daemon sent, in order. */
  const settingsPuts = (): readonly number[] =>
    (daemonStore?.mock.calls ?? []).flatMap(([frame]) =>
      frame.t === "store-put" && frame.key === SETTINGS_KEY ? [frame.expect] : [],
    );
  /** Each settings read the daemon sent, as the promise of its answer. */
  const settingsReads = (): readonly Promise<unknown>[] =>
    (daemonStore?.mock.calls ?? []).flatMap(([frame], i) =>
      frame.t === "store-get" && frame.key === SETTINGS_KEY
        ? [Promise.resolve(daemonStore?.mock.results[i]?.value)]
        : [],
    );

  test("a leader's term created the record once with a VAPID pair; a re-lead reads the same pair and moves nothing; nothing logs the key", async () => {
    const lines: string[] = [];
    const out = spyOn(console, "log").mockImplementation((...args) => void lines.push(args.join(" ")));
    const err = spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));
    try {
      await stack.restartDaemon();
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      // Created beside takeover, not before it.
      await pollUntil(async () => (await readSettings()) !== null, "the leader to create the settings record", 10_000);
      const created = await readSettings();
      // Not necessarily this daemon's create: the leadership test stops it as soon as it leads, so LeaderBox's
      // term (a subprocess, outside the spy) may load settings first. Version 1 is one create, no overwrite.
      expect(created?.version).toBe(1);
      expect(created?.record.version).toBe(1);
      const publicKey = created?.record.vapid?.publicKey ?? "";
      const privateKey = created?.record.vapid?.privateKey ?? "";
      expect(publicKey).toHaveLength(87);

      // A new term on the same relay: it reads the record, whose floor it already holds.
      const term = stack.daemon.leader.term();
      const readsBefore = settingsReads().length;
      const putsBefore = settingsPuts();
      await stack.restartDaemon();
      await pollUntil(
        () => stack.daemon.leader.term() !== null && stack.daemon.leader.term() !== term,
        "a later term",
        10_000,
      );
      await stack.daemon.leader.settled();
      // Positive first: the later term's read of the record has been answered, so the sleep below
      // waits out a write that load would have made, not a load that never ran.
      await pollUntil(() => settingsReads().length > readsBefore, "the later term to read the settings record", 10_000);
      await Promise.allSettled(settingsReads());
      // A sleep is right before a negative assertion: a write that never happened cannot be polled.
      await Bun.sleep(300);
      expect(settingsPuts()).toEqual(putsBefore);
      const again = await readSettings();
      expect(again?.version).toBe(1);
      expect(again?.record.vapid?.publicKey).toBe(publicKey);

      expect(lines.some((line) => line.includes("settings unavailable"))).toBe(false);
      expect(lines.some((line) => line.includes(publicKey) || line.includes(privateKey))).toBe(false);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  }, 30_000);

  test("push-subscribe adds a browser's subscription to the record, is idempotent, refuses a host off the allowlist, stops at the cap, and push-unsubscribe frees a slot", async () => {
    await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
    await stack.daemon.leader.settled();
    const app = startApp(stack);
    const keys = USER_AGENT_KEYS;
    const sub = (id: string, host = "fcm.googleapis.com") => ({ endpoint: `https://${host}/fcm/send/${id}`, keys });
    try {
      await app.waitForApp((state) => state.relay.scheduler.kind === "ready", "the leader verified");
      // Settings load beside takeover, so the first answers can be `not_ready`.
      await pollUntil(
        async () => {
          const reply = await app.client.pushSubscribe(sub("first"));
          return reply !== null && "endpoint" in reply;
        },
        "the leader to take a subscription",
        10_000,
      );
      const held = await readSettings();
      // The leader stamps `addedAt` from its own clock; the request never carries one.
      expect(held?.record.subscriptions).toEqual([{ ...sub("first"), addedAt: expect.any(Number) }]);
      const version = held?.version;

      expect(await app.client.pushSubscribe(sub("first"))).toEqual({ endpoint: sub("first").endpoint });
      expect((await readSettings())?.version).toBe(version);

      // A label the held entry lacks is backfilled in one write, and a second identical request writes nothing.
      const labelled = { ...sub("first"), label: "Firefox · Linux" };
      expect(await app.client.pushSubscribe(labelled)).toEqual({ endpoint: sub("first").endpoint });
      const backfilled = await readSettings();
      expect(backfilled?.record.subscriptions).toEqual([
        { ...labelled, addedAt: held?.record.subscriptions?.[0]?.addedAt },
      ]);
      expect(backfilled?.version).toBe((version ?? 0) + 1);
      expect(await app.client.pushSubscribe(labelled)).toEqual({ endpoint: sub("first").endpoint });
      expect((await readSettings())?.version).toBe(backfilled?.version);

      // The page's reading lists each entry as a device, and never the private key.
      const reading = await app.client.pushSettings(sub("first").endpoint);
      expect(reading).toMatchObject({
        devices: [
          {
            endpoint: sub("first").endpoint,
            vendor: "Chrome/Android",
            label: "Firefox · Linux",
            addedAt: expect.any(Number),
            self: true,
          },
        ],
      });
      expect(JSON.stringify(reading)).not.toContain("privateKey");

      expect(await app.client.pushSubscribe(sub("x", "example.com"))).toMatchObject({
        ok: false,
        code: "invalid_request",
      });

      for (let i = 1; i < PUSH_MAX_SUBSCRIPTIONS; i += 1) {
        // oxlint-disable-next-line no-await-in-loop -- each lands on the version the last wrote
        expect(await app.client.pushSubscribe(sub(`fill-${i}`))).toEqual({ endpoint: sub(`fill-${i}`).endpoint });
      }
      expect(await app.client.pushSubscribe(sub("over"))).toMatchObject({ ok: false, code: "subscriptions_full" });
      expect((await readSettings())?.record.subscriptions).toHaveLength(PUSH_MAX_SUBSCRIPTIONS);

      // push-unsubscribe frees a slot; asking again for the same endpoint leaves the subscriptions as they were.
      // The record's version is not compared: the leader also writes disk alerts into it.
      const leaving = sub("fill-1").endpoint;
      expect(await app.client.pushUnsubscribe({ endpoint: leaving })).toEqual({ endpoint: leaving });
      const freed = await readSettings();
      expect(freed?.record.subscriptions).toHaveLength(PUSH_MAX_SUBSCRIPTIONS - 1);
      expect(freed?.record.subscriptions?.some((s) => s.endpoint === leaving)).toBe(false);
      expect(await app.client.pushUnsubscribe({ endpoint: leaving })).toEqual({ endpoint: leaving });
      expect((await readSettings())?.record.subscriptions).toEqual(freed?.record.subscriptions);
      expect(await app.client.pushSubscribe(sub("over"))).toEqual({ endpoint: sub("over").endpoint });
    } finally {
      app.stop();
    }
  }, 60_000);

  test("an alert the leader raises is pushed at the seam, which refuses it: no real push service is contacted", async () => {
    const app = startApp(stack);
    const taskId = "e2e-push-stuck";
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await app.waitForApp((state) => state.relay.scheduler.kind === "ready", "the leader verified");
      const keys = USER_AGENT_KEYS;
      await pollUntil(
        async () => {
          const reply = await app.client.pushSubscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/guard", keys });
          // Full is fine: the record then holds the subscriptions an earlier test wrote.
          return reply !== null && ("endpoint" in reply || reply.code === "subscriptions_full");
        },
        "the leader to answer the subscribe",
        10_000,
      );
      // Escalates on the next term's first pass, and the term pushes beside its log line.
      await stack.seedTask({
        id: taskId,
        spec: { repo: "github.com/acme/app", mode: "worktree" },
        state: "needs-input",
        createdAt: Date.now(),
        needsInputSince: 1,
      });
      await stack.restartDaemon();
      await pollUntil(() => stack.pushAttempts().length > 0, "the leader to try a push", 10_000);
      expect(stack.pushAttempts().every((host) => host === "fcm.googleapis.com")).toBe(true);
    } finally {
      await cancelTask(app.client, taskId);
      app.stop();
    }
  }, 60_000);
});

/**
 * The claude stub makes no git worktree of its own at the path the daemon noted for the launch, and a push
 * refuses a path that is not a linked checkout (`not_launched`): make the one a real session would run in,
 * on a new `branch` of the fixture clone. Returns its path.
 */
async function realWorktree(taskId: string, branch: string): Promise<string> {
  const ledger = JSON.parse(await Bun.file(join(process.env["SEANCE_STATE_DIR"] ?? "", "launched.json")).text()) as {
    readonly progress: readonly { readonly taskId: string; readonly path?: string }[];
  };
  const noted = ledger.progress.find((p) => p.taskId === taskId)?.path;
  if (noted === undefined) throw new Error("the launch ledger noted no worktree for the task");
  await rm(noted, { recursive: true, force: true });
  const added = await exec(["git", "worktree", "add", "-q", "-b", branch, noted], { cwd: stack.fixture.repoPath });
  expect(added.exitCode).toBe(0);
  return noted;
}

/** A ref's sha in the fixture's origin, or null when it has none. */
async function originRef(ref: string): Promise<string | null> {
  const found = await exec(["git", "--git-dir", stack.fixture.barePath, "rev-parse", "--verify", "-q", ref]);
  return found.exitCode === 0 ? found.stdout.trim() : null;
}

describe("pass: a session's own pass ↔ local daemon ↔ leader ↔ the daemon's close", () => {
  // The production wiring no unit test joins: the pane-bound `pass` frame, the daemon's push of the real
  // spawned worktree, the leader's commit of the successor, its `pass-close` back, and the close at the
  // session's turn end. Only the session is a stand-in: a script in the spawned pane that calls the tool's
  // own function, then reports its turn's end through the real CLI.
  test("the leader commits the successor from the session's record, and the pane closes only at its turn's end", async () => {
    const taskId = "e2e-pass-task";
    const record = "done: the e2e wiring; left: nothing";
    // The suite's daemon audits to its stdout, which in-process is console.log.
    const audit = spyOn(console, "log");
    const closes = (): string[] =>
      audit.mock.calls.map((args) => args.join(" ")).filter((l) => l.includes("audit despawn origin=successor"));
    const app = startApp(stack);
    let window: string | undefined;
    let successorId: string | undefined;
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      const ready = await app.waitForApp(
        (state) =>
          state.relay.scheduler.kind === "ready" &&
          state.relay.machines.some(
            (m) =>
              m.deviceId === stack.deviceId &&
              m.connected &&
              m.repos.length > 0 &&
              m.capabilities?.includes(CAPABILITIES.successorSelf) === true,
          ),
        "the leader verified and the machine advertising successorSelf",
      );
      const origin = fixtureOrigin(ready);
      if (origin === null) throw new Error("the fixture machine lists no repo origin");
      const queued = await app.client.createTask({
        id: taskId,
        spec: { repo: origin, mode: "worktree" },
        state: "queued",
        createdAt: Date.now(),
      });
      expect(queued).toEqual({ ok: true, landedEarlier: false });
      await pollUntil(
        async () => (await stack.queue().get(taskId))?.body?.state === "running",
        "the task to run",
        20_000,
      );
      window = (await stack.queue().get(taskId))?.body?.assignment?.window;

      const noted = await realWorktree(taskId, "pass-e2e");

      const out = join(base, "pass.json");
      const go = join(base, "pass.go");
      const idle = join(base, "pass-idle.json");
      const script = join(base, "pass.ts");
      await rm(out, { force: true });
      await rm(go, { force: true });
      await Bun.write(idle, JSON.stringify({ state: "idle", turnEnded: true }));
      const tool = join(import.meta.dir, "..", "daemon", "src", "report-done.ts");
      const main = join(import.meta.dir, "..", "daemon", "src", "main.ts");
      const stateDir = process.env["SEANCE_STATE_DIR"] ?? "";
      const socket = join(stateDir, "run", "seanced.sock");
      await Bun.write(
        script,
        // The running state can precede the daemon's launch landing in its ledger (the stub never registers, so the
        // launch stays in flight for the spawn's wait); the tool's own answer then is "call again".
        `import { passToSuccessor } from ${JSON.stringify(tool)};
let result = await passToSuccessor(${JSON.stringify(record)}, { path: ${JSON.stringify(socket)} });
for (let i = 0; i < 40 && !result.ok && result.text.includes("holds no launch"); i++) {
  await Bun.sleep(250);
  result = await passToSuccessor(${JSON.stringify(record)}, { path: ${JSON.stringify(socket)} });
}
await Bun.write(${JSON.stringify(out)}, JSON.stringify(result));\n`,
      );
      const panes = async (): Promise<string> => tmuxOk(["list-panes", "-a", "-F", "#{pane_id} #{@seance-task}"]);
      const pane = (await panes())
        .split("\n")
        .map((line) => line.split(" "))
        .find(([, task]) => task === taskId)?.[0];
      if (pane === undefined) throw new Error(`no pane carries ${taskId}`);
      // The turn ends only when the test says so: a close before it would be the bug.
      await tmuxOk([
        "respawn-pane",
        "-k",
        "-t",
        pane,
        "sh",
        "-c",
        `${q(process.execPath)} ${q(script)}; while [ ! -e ${q(go)} ]; do sleep 0.05; done; SEANCE_STATE_DIR=${q(stateDir)} ${q(process.execPath)} ${q(main)} session-event < ${q(idle)}; exec sleep 600`,
      ]);

      await pollUntil(
        async () => (await Bun.file(out).exists()) && (await Bun.file(out).text()) !== "",
        "the pass",
        30_000,
      );
      expect(JSON.parse(await Bun.file(out).text())).toMatchObject({ ok: true });
      await pollUntil(
        async () => (await stack.queue().get(taskId))?.body?.successor !== undefined,
        "the leader to commit the successor",
        10_000,
      );
      successorId = (await stack.queue().get(taskId))?.body?.successor ?? "";
      const successor = (await stack.queue().get(successorId))?.body;
      expect(successor?.spec).toMatchObject({ succeeds: { task: taskId, trigger: "session" } });
      expect(successor?.spec.prompt).toContain(record);
      // The daemon's push is what the successor's prompt names: the branch is on origin at the worktree's tip.
      const head = await exec(["git", "rev-parse", "HEAD"], { cwd: noted });
      expect(await originRef("refs/heads/pass-e2e")).toBe(head.stdout.trim());

      // The pass-close has had its time to arrive (the commit precedes it); nothing has closed the pane.
      await Bun.sleep(1_000);
      expect(await panes()).toContain(pane);
      expect(closes()).toEqual([]);

      await Bun.write(go, "");
      // The audit line, not the pane's absence: the stand-in pane is no registered session, so the graceful
      // despawn answers `session_not_found` after the close was decided, and what is under test is the decision.
      await pollUntil(
        () => closes().some((l) => l.includes(`target="${pane}"`)),
        "the daemon to close the pane at its turn's end",
        20_000,
      );
    } finally {
      audit.mockRestore();
      if (successorId !== undefined) await cancelTask(app.client, successorId);
      await cancelTask(app.client, taskId);
      app.stop();
      if (window !== undefined) await killWindow(window);
    }
  }, 60_000);
});

describe("pass: an app's pass ↔ leader ↔ the machine's push and close", () => {
  // The outside path no unit test joins: the app's `pass` op, the leader pushing through its own machine's
  // op (origin=leader) with the real git of a real worktree, the successor's create and commit, and the
  // old pane's close. Only the session is a stand-in (the stub's pane).
  test("a dirty worktree refuses and writes nothing; a clean one pushes, passes once, and a repeat answers the same successor", async () => {
    const taskId = "e2e-outside-pass";
    const branch = "outside-pass-e2e";
    const audit = spyOn(console, "log");
    const lines = (needle: string): string[] =>
      audit.mock.calls.map((args) => args.join(" ")).filter((l) => l.includes(needle));
    const successorsOf = async (): Promise<string[]> =>
      (await stack.queue().list()).flatMap((entry) =>
        "body" in entry && entry.body?.spec.succeeds?.task === taskId ? [entry.id] : [],
      );
    const app = startApp(stack);
    let window: string | undefined;
    let successorId: string | undefined;
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      const ready = await app.waitForApp(
        (state) =>
          state.relay.scheduler.kind === "ready" &&
          state.relay.machines.some(
            (m) =>
              m.deviceId === stack.deviceId &&
              m.connected &&
              m.repos.length > 0 &&
              m.capabilities?.includes(CAPABILITIES.successor) === true,
          ),
        "the leader verified and the machine advertising successor",
      );
      const origin = fixtureOrigin(ready);
      if (origin === null) throw new Error("the fixture machine lists no repo origin");
      const queued = await app.client.createTask({
        id: taskId,
        spec: { repo: origin, mode: "worktree" },
        state: "queued",
        createdAt: Date.now(),
      });
      expect(queued).toEqual({ ok: true, landedEarlier: false });
      await pollUntil(
        async () => (await stack.queue().get(taskId))?.body?.state === "running",
        "the task to run",
        20_000,
      );
      window = (await stack.queue().get(taskId))?.body?.assignment?.window;
      const worktree = await realWorktree(taskId, branch);

      const unchanged = async (): Promise<void> => {
        expect(await originRef(`refs/heads/${branch}`)).toBeNull();
        expect(await successorsOf()).toEqual([]);
        expect((await stack.queue().get(taskId))?.body?.successor).toBeUndefined();
      };

      // Dirty first. The launch may still be in flight (the stub never registers), which the machine answers
      // `not_launched`: ask again until it answers about the worktree, with nothing written after each refusal.
      await Bun.write(join(worktree, "dirty.txt"), "uncommitted\n");
      let refusal: Awaited<ReturnType<typeof app.client.pass>> = null;
      for (let i = 0; i < 40; i++) {
        // oxlint-disable-next-line no-await-in-loop -- each ask follows the refusal before it
        refusal = await app.client.pass(taskId);
        // oxlint-disable-next-line no-await-in-loop -- the same
        await unchanged();
        if (refusal !== null && "ok" in refusal && refusal.code !== "not_launched") break;
        // oxlint-disable-next-line no-await-in-loop -- a retry delay, not an assertion's wait
        await Bun.sleep(250);
      }
      expect(refusal).toMatchObject({ ok: false, code: "dirty_worktree" });

      // Clean: commit, then the same pass goes through.
      await rm(join(worktree, "dirty.txt"));
      await Bun.write(join(worktree, "outside.txt"), "work\n");
      expect((await exec(["git", "add", "outside.txt"], { cwd: worktree })).exitCode).toBe(0);
      const committed = await exec(
        [
          "git",
          "-c",
          "user.email=e2e@seance.test",
          "-c",
          "user.name=e2e",
          "commit",
          "-q",
          "--no-gpg-sign",
          "-m",
          "outside pass",
        ],
        { cwd: worktree },
      );
      expect(committed.exitCode).toBe(0);
      const tip = (await exec(["git", "rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();

      const passed = await app.client.pass(taskId);
      if (passed === null || "ok" in passed) throw new Error(`the pass was refused: ${JSON.stringify(passed)}`);
      successorId = passed.successorId;
      expect(await originRef(`refs/heads/${branch}`)).toBe(tip);

      await pollUntil(
        () =>
          lines(`audit queue origin=relay op=pass`).some((l) =>
            l.includes(`successor="${successorId}" trigger=manual`),
          ),
        "the pass's audit line",
        10_000,
      );
      await pollUntil(
        () => lines(`audit push origin=leader task="${taskId}"`).length > 0,
        "the leader's push audit",
        10_000,
      );
      await pollUntil(
        async () => {
          const old = (await stack.queue().get(taskId))?.body;
          return old?.state === "superseded" && old.successor === successorId;
        },
        "the old task to be superseded, naming the successor",
        20_000,
      );
      expect(await successorsOf()).toEqual([successorId]);
      const prompt = (await stack.queue().get(successorId))?.body?.spec.prompt ?? "";
      expect(prompt).toContain(branch);
      expect(prompt).toContain(tip);

      // A repeat answers the same successor and pushes nothing more.
      const pushes = lines(`audit push origin=leader task="${taskId}"`).length;
      const again = await app.client.pass(taskId);
      if (again === null || "ok" in again) throw new Error(`the repeat was refused: ${JSON.stringify(again)}`);
      expect(again.successorId).toBe(successorId);
      expect(await successorsOf()).toEqual([successorId]);
      expect(lines(`audit push origin=leader task="${taskId}"`).length).toBe(pushes);

      // The old pane is closed.
      await pollUntil(
        async () => !(await tmuxOk(["list-panes", "-a", "-F", "#{@seance-task}"])).split("\n").includes(taskId),
        "the old task's pane to close",
        20_000,
      );
    } finally {
      audit.mockRestore();
      if (successorId !== undefined) await cancelTask(app.client, successorId);
      // A failure before the pass leaves the original running; once passed it is finished, which returns at once.
      await cancelTask(app.client, taskId);
      app.stop();
      if (window !== undefined) await killWindow(window);
    }
  }, 60_000);
});

describe("hand-off: a successor's inherited PR ↔ the leader's dispatch ↔ the daemon's hand-off", () => {
  // The wiring no unit test joins: the leader's dispatch carrying the successor record's PR as
  // `SpawnRequest.inheritedPr`, the daemon's launch note, the pane-bound hand-off frame, the close
  // at the turn's end, and the leader settling the ended task `awaiting-merge`. Only the session is a
  // stand-in: a script in the spawned pane that calls the tool's own function.
  // A GitHub-shaped URL is safe: the suite points `SEANCE_GH_BIN` at a missing binary, so no poller reads it.
  const PR = "https://github.com/acme/app/pull/1";
  const tool = join(import.meta.dir, "..", "daemon", "src", "report-done.ts");
  const main = join(import.meta.dir, "..", "daemon", "src", "main.ts");

  /** The launch ledger's notes as `launched.json` holds them (`realWorktree` reads the same key). */
  async function launched(): Promise<readonly { readonly taskId: string; readonly continuedPr?: string }[]> {
    const ledger = JSON.parse(await Bun.file(join(process.env["SEANCE_STATE_DIR"] ?? "", "launched.json")).text()) as {
      readonly progress: readonly { readonly taskId: string; readonly continuedPr?: string }[];
    };
    return ledger.progress;
  }

  const paneOf = async (taskId: string): Promise<string> => {
    const panes = await tmuxOk(["list-panes", "-a", "-F", "#{pane_id} #{@seance-task}"]);
    const pane = panes
      .split("\n")
      .map((line) => line.split(" "))
      .find(([, task]) => task === taskId)?.[0];
    if (pane === undefined) throw new Error(`no pane carries ${taskId}: ${panes}`);
    return pane;
  };

  /**
   * Takes over the task's pane with a script that calls `handOff` and writes its answer to `out`. With
   * `steps`, it then waits for `go` and sends an idle turn end, waits for `go2` and sends `ended`.
   */
  async function handOffFrom(
    taskId: string,
    name: string,
    steps: boolean,
  ): Promise<{ out: string; go: string; go2: string }> {
    const out = join(base, `${name}.json`);
    const go = join(base, `${name}.go`);
    const go2 = join(base, `${name}.go2`);
    const script = join(base, `${name}.ts`);
    const idle = join(base, `${name}-idle.json`);
    const ended = join(base, `${name}-ended.json`);
    for (const file of [out, go, go2]) await rm(file, { force: true });
    await Bun.write(idle, JSON.stringify({ state: "idle", turnEnded: true }));
    await Bun.write(ended, JSON.stringify({ state: "ended" }));
    const stateDir = process.env["SEANCE_STATE_DIR"] ?? "";
    const socket = join(stateDir, "run", "seanced.sock");
    await Bun.write(
      script,
      // The running state can precede the daemon's launch landing in its ledger; the tool then answers "call again".
      `import { handOff } from ${JSON.stringify(tool)};
let result = await handOff({ path: ${JSON.stringify(socket)} });
for (let i = 0; i < 40 && !result.ok && result.text.includes("holds no launch"); i++) {
  await Bun.sleep(250);
  result = await handOff({ path: ${JSON.stringify(socket)} });
}
await Bun.write(${JSON.stringify(out)}, JSON.stringify(result));\n`,
    );
    const event = (input: string): string =>
      `SEANCE_STATE_DIR=${q(stateDir)} ${q(process.execPath)} ${q(main)} session-event < ${q(input)}`;
    const wait = (file: string): string => `while [ ! -e ${q(file)} ]; do sleep 0.05; done`;
    const rest = steps ? `; ${wait(go)}; ${event(idle)}; ${wait(go2)}; ${event(ended)}` : "";
    await tmuxOk([
      "respawn-pane",
      "-k",
      "-t",
      await paneOf(taskId),
      "sh",
      "-c",
      `${q(process.execPath)} ${q(script)}${rest}; exec sleep 600`,
    ]);
    return { out, go, go2 };
  }

  const answer = async (out: string): Promise<unknown> => {
    await pollUntil(
      async () => (await Bun.file(out).exists()) && (await Bun.file(out).text()) !== "",
      "the hand-off's answer",
      30_000,
    );
    return JSON.parse(await Bun.file(out).text());
  };

  test("a successor's hand-off is taken for the PR it inherited, and the task waits awaiting-merge; a PR-less successor's is prless", async () => {
    const P1 = "e2e-handoff-pred";
    const P2 = "e2e-handoff-pred-bare";
    const S1 = "e2e-handoff-succ";
    const S2 = "e2e-handoff-succ-bare";
    const audit = spyOn(console, "log");
    const closes = (): string[] =>
      audit.mock.calls.map((args) => args.join(" ")).filter((l) => l.includes("audit despawn origin=handoff"));
    let app: ReturnType<typeof startApp> | undefined;
    const windows: string[] = [];
    try {
      // Superseded predecessors naming their successors, as the leader leaves them after a pass.
      await stack.seedTask({
        id: P1,
        spec: { repo: "github.com/acme/app", mode: "worktree" },
        state: "superseded",
        successor: S1,
        prUrl: PR,
        createdAt: Date.now(),
      });
      await stack.seedTask({
        id: P2,
        spec: { repo: "github.com/acme/app", mode: "worktree" },
        state: "superseded",
        successor: S2,
        createdAt: Date.now(),
      });
      await stack.restartDaemon();
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      await stack.daemon.leader.settled();
      app = startApp(stack);
      const ready = await app.waitForApp(
        (state) =>
          state.relay.scheduler.kind === "ready" &&
          state.relay.machines.some(
            (m) =>
              m.deviceId === stack.deviceId &&
              m.connected &&
              m.repos.length > 0 &&
              m.capabilities?.includes(CAPABILITIES.successor) === true,
          ),
        "the leader verified and the machine advertising successor",
      );
      const origin = fixtureOrigin(ready);
      const clone = ready.relay.machines
        .find((m) => m.deviceId === stack.deviceId)
        ?.repos.find((r) => r.origin === origin)?.name;
      if (origin === null || clone === undefined) throw new Error("the fixture machine lists no repo origin");
      const successor = (id: string, predecessor: string, prUrl?: string) => ({
        id,
        spec: {
          repo: origin,
          mode: "worktree" as const,
          succeeds: {
            task: predecessor,
            account: "org:e2e",
            at: { deviceId: stack.deviceId, exclave: "default", clone },
            trigger: "manual" as const,
          },
        },
        ...(prUrl === undefined ? {} : { prUrl }),
        state: "queued" as const,
        createdAt: Date.now(),
      });
      expect(await app.client.createTask(successor(S1, P1, PR))).toEqual({ ok: true, landedEarlier: false });
      expect(await app.client.createTask(successor(S2, P2))).toEqual({ ok: true, landedEarlier: false });
      // The verdict's window is written from the spawn's reply, which the daemon sends only after its ledger
      // note; a bare `running` can come from a hook event before the note lands.
      const spawned = async (id: string): Promise<void> => {
        await pollUntil(
          async () => (await stack.queue().get(id))?.body?.assignment?.window !== undefined,
          `${id} to be spawned`,
          30_000,
        );
        windows.push((await stack.queue().get(id))?.body?.assignment?.window ?? "");
      };
      await spawned(S1);
      await spawned(S2);
      const notes = await launched();
      expect(notes.find((n) => n.taskId === S1)?.continuedPr).toBe(PR);
      expect(notes.find((n) => n.taskId === S2)?.continuedPr).toBeUndefined();

      const inherited = await handOffFrom(S1, "handoff-succ", true);
      expect(await answer(inherited.out)).toMatchObject({ ok: true });
      // The close waits for the turn's end. The stand-in pane is no registered session, so the graceful despawn
      // answers `session_not_found` after the close was decided, and what is under test is the decision.
      expect(closes()).toEqual([]);
      const pane = await paneOf(S1);
      await Bun.write(inherited.go, "");
      await pollUntil(
        () => closes().some((l) => l.includes(`target="${pane}"`)),
        "the daemon to decide the close at the turn's end",
        20_000,
      );
      await Bun.write(inherited.go2, "");
      await pollUntil(
        async () => (await stack.queue().get(S1))?.body?.state === "awaiting-merge",
        "the leader to settle the ended successor awaiting-merge",
        20_000,
      );
      expect((await stack.queue().get(S1))?.body).toMatchObject({ prUrl: PR });

      // No PR on the record, none noted: the same call is refused, after the daemon's wait for a PR still on its way.
      const bare = await handOffFrom(S2, "handoff-succ-bare", false);
      const refused = await answer(bare.out);
      expect(refused).toMatchObject({ ok: false });
      expect(JSON.stringify(refused)).toContain("noted no pull request");
    } finally {
      audit.mockRestore();
      if (app !== undefined) {
        await cancelTask(app.client, S1);
        await cancelTask(app.client, S2);
        app.stop();
      }
      for (const window of windows) await killWindow(window);
    }
  }, 90_000);

  test("an app-sealed spawn carrying inheritedPr runs, but notes no PR, so its hand-off is prless", async () => {
    const taskId = "e2e-forged-pr";
    const audit = spyOn(console, "log");
    const app = startApp(stack);
    let window: string | undefined;
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      const ready = await app.waitForApp(
        (state) =>
          state.relay.scheduler.kind === "ready" &&
          state.relay.machines.some((m) => m.deviceId === stack.deviceId && m.connected && m.repos.length > 0),
        "the leader verified and the machine's repos listed",
      );
      const repo = ready.relay.machines.find((m) => m.deviceId === stack.deviceId)?.repos[0]?.name;
      if (repo === undefined) throw new Error("the fixture machine lists no repo");
      const reply = await app.client.request<SpawnResponse>(stack.deviceId, "spawn", {
        repo,
        mode: "worktree",
        taskId,
        client: "scheduler",
        inheritedPr: PR,
      });
      if (reply === null || !("ok" in reply) || !reply.ok)
        throw new Error(`the spawn was refused: ${JSON.stringify(reply)}`);
      window = reply.window;
      const lines = audit.mock.calls
        .map((args) => args.join(" "))
        .filter((l) => l.includes("audit spawn origin=relay"));
      expect(lines.some((l) => l.includes("inheritedPr=true"))).toBe(true);
      expect(lines.some((l) => l.includes(PR))).toBe(false);
      expect((await launched()).find((n) => n.taskId === taskId)).not.toHaveProperty("continuedPr");

      const sent = await handOffFrom(taskId, "handoff-forged", false);
      const refused = await answer(sent.out);
      expect(refused).toMatchObject({ ok: false });
      expect(JSON.stringify(refused)).toContain("noted no pull request");
    } finally {
      audit.mockRestore();
      app.stop();
      if (window !== undefined) await killWindow(window);
    }
  }, 60_000);
});

describe("continue: an app's continue task ↔ leader ↔ the machine that ran the failed session", () => {
  // Only the machine's own launch ledger knows where the old session ran, so the ledger is
  // seeded with a task note instead of running a failing session first; everything after the
  // app's write is the real path: leader routing to the exact clone, the spawn frame, the
  // daemon's site check and `claude --resume <noted id>` in the existing worktree.
  test("the continue task lands on the machine and clone it names and resumes in the noted worktree", async () => {
    const oldId = crypto.randomUUID();
    const session = crypto.randomUUID();
    const id = crypto.randomUUID();
    const worktree = await stack.fixture.pushBranch("cont-e2e");
    const app = startApp(stack);
    let second: SecondDaemon | null = null;
    try {
      await pollUntil(() => stack.daemon.leader.term() !== null, "the suite's daemon to lead", 10_000);
      const now = Date.now();
      second = await stack.startSecondDaemon({
        name: "ContinueBox",
        exclaves: [{ id: "default", observedAtMs: now, fiveHourPct: 10 }],
        beforeBoot: (stateDir) =>
          writeFile(
            join(stateDir, "launched.json"),
            JSON.stringify({
              v: 1,
              since: now - 10 * 60_000,
              tasks: [[oldId, now - 60_000]],
              progress: [
                {
                  taskId: oldId,
                  at: now - 60_000,
                  siteAt: now - 60_000,
                  repo: stack.fixture.repoPath,
                  path: worktree,
                  session,
                },
              ],
            }),
            { mode: 0o600 },
          ),
      });
      const b = second.deviceId;
      const ready = await app.waitForApp(
        (state) =>
          state.relay.scheduler.kind === "ready" &&
          state.relay.machines.some(
            (m) =>
              m.deviceId === b &&
              m.connected &&
              m.status !== undefined &&
              m.capabilities?.includes(CAPABILITIES.continueTask) === true &&
              m.capabilities.includes(CAPABILITIES.continueSession) &&
              m.repos.length > 0,
          ),
        "the leader verified and ContinueBox live, advertising continueTask and continueSession",
      );
      const origin = fixtureOrigin(ready) ?? "";

      const created = await app.client.createTask({
        id,
        spec: {
          repo: origin,
          mode: "continue",
          title: "cont-e2e",
          prompt: "carry on",
          continues: { task: oldId, at: { deviceId: b, exclave: "default", clone: basename(stack.fixture.repoPath) } },
          client: "pwa",
        },
        state: "queued",
        createdAt: Date.now(),
      });
      expect(created).toEqual({ ok: true, landedEarlier: false });

      await pollUntil(
        async () => {
          const log = await Bun.file(second?.log ?? "").text();
          return log.includes("mode=continue") && log.includes("audit spawn origin=relay ok window=");
        },
        "B to audit the continue spawn as done",
        20_000,
      );
      const log = await Bun.file(second.log).text();
      expect(log).toContain(`continues=${JSON.stringify(oldId)}`);
      // The stub's argv record: claude resumed the session id B noted at the old launch rather than starting one.
      const argvOf = async (): Promise<readonly string[]> =>
        (
          await Bun.file(`${stack.stub.ok}.argv`)
            .text()
            .catch(() => "")
        ).split("\0");
      await pollUntil(
        async () => {
          const argv = await argvOf();
          return argv[argv.indexOf("--resume") + 1] === session;
        },
        "claude to be started with --resume and the noted session id",
        10_000,
      );
      expect(await argvOf()).not.toContain("--continue");
      await pollUntil(
        async () => (await stack.queue().get(id))?.body?.state === "running",
        "the leader to settle the continue task running",
        10_000,
      );
      expect((await stack.queue().get(id))?.body).toMatchObject({
        assignment: { deviceId: b, clone: basename(stack.fixture.repoPath) },
      });
    } finally {
      await cancelTask(app.client, id);
      if (second !== null) await tmux(["kill-session", "-t", second.tmuxSession]).catch(() => undefined);
      await second?.stop();
      app.stop();
    }
  }, 60_000);
});
