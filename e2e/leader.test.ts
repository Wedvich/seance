import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry } from "@seance/shared";
import { exec } from "../daemon/src/exec.ts";
import { localSocketReachable } from "../daemon/src/local-client.ts";
import { tmux, tmuxOk } from "../daemon/src/tmux.ts";
import { pollUntil } from "../daemon/test/fixtures.ts";
import { listRegisteredWindows, listWindows, startApp, type SecondDaemon, type Stack } from "./harness.ts";
import { fixtureOrigin, q, startSuite, watchLeader, type Suite } from "./suite.ts";

let suite: Suite | undefined;
let base: string;
let stack: Stack;

beforeAll(async () => {
  suite = await startSuite("e2e-leader");
  ({ base, stack } = suite);
});

afterAll(async () => {
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
    const app = startApp(stack, { auto: true });
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
      await app.client.cancel(id).catch(() => null);
      if (second !== null) await tmux(["kill-session", "-t", second.tmuxSession]).catch(() => undefined);
      await second?.stop();
      app.stop();
      audit.mockRestore();
    }
  }, 60_000);
});
