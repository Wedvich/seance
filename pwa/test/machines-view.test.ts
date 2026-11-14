import { describe, expect, test } from "bun:test";
import {
  AUTH_EXPIRING_MS,
  CAPABILITIES,
  METRIC_NAMES,
  MIN_FREE_MIB,
  type ArchiveStatusResponse,
  type ArchivistEntry,
  type ExclaveInfo,
  type Machine,
  type MachineStatus,
  type MetricsSeries,
  type SchedulerAvailability,
  type SessionEntry,
  type Task,
} from "@seance/shared";
import { accountSeries, chartLines } from "../src/chart.ts";
import {
  accountDisplayName,
  deriveArchivist,
  deriveCloseSheet,
  deriveMachines,
  type DrainInputs,
} from "../src/machines-view.ts";
import { knownAccounts } from "@seance/shared";
import { archiveCharts } from "../src/state.ts";

const NOW = 1_800_000_000_000;
const S = NOW / 1000;
const ACCOUNT = "org-1:acct-aaaaaaaa-1111";
const NO_LEADER: SchedulerAvailability = { kind: "none" };

function exclave(id: string, accountId: string | null): ExclaveInfo {
  return { id, accountId, extraUsageEnabled: null, authOk: accountId !== null, skills: [] };
}

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    deviceId: "dev-1",
    name: "mac",
    platform: "darwin",
    repos: [],
    scannedAt: 1,
    lastSeen: NOW,
    connected: true,
    capabilities: ["metrics"],
    exclaves: [exclave("default", ACCOUNT)],
    ...overrides,
  };
}

describe("the Open for work switch", () => {
  const leader = machine({ deviceId: "lead", name: "lead", capabilities: [CAPABILITIES.drain] });
  const ready: SchedulerAvailability = { kind: "ready", deviceId: "lead", term: 1 };
  const closedStatus: MachineStatus = { at: S - 5, scan: 1, cl: NOW - 60_000 };
  const cardOf = (m: Machine, scheduler: SchedulerAvailability, others: readonly Machine[] = []) =>
    deriveMachines([m, ...others], NOW, scheduler).cards[0];

  test("none without close; on only when the verified leader drains; off while closed, whatever the leader", () => {
    expect(cardOf(machine({ capabilities: [] }), ready, [leader])?.openSwitch).toBeNull();
    const closable = machine({ capabilities: [CAPABILITIES.close] });
    expect(cardOf(closable, ready, [leader])).toMatchObject({ closed: false, openSwitch: "on" });
    expect(cardOf(closable, NO_LEADER, [leader])?.openSwitch).toBeNull();
    // Socket down: the last scheduler state is stale, and the store would refuse the close.
    expect(deriveMachines([closable, leader], NOW, ready, {}, [], undefined, false).cards[0]?.openSwitch).toBeNull();
    expect(cardOf(closable, ready, [{ ...leader, capabilities: [] }])?.openSwitch).toBeNull();
    const closed = machine({ capabilities: [CAPABILITIES.close], status: closedStatus });
    expect(cardOf(closed, NO_LEADER)).toMatchObject({ closed: true, openSwitch: "off" });
    expect(cardOf(closed, ready, [{ ...leader, capabilities: [] }])).toMatchObject({ closed: true, openSwitch: "off" });
  });
});

describe("the drain row and the close sheet", () => {
  const CL = NOW - 60_000;
  const closed = machine({
    capabilities: [CAPABILITIES.close],
    status: { at: S - 5, scan: 1, cl: CL },
  });
  const ready: SchedulerAvailability = { kind: "ready", deviceId: "lead", term: 1 };
  const task = (id: string, mode: "worktree" | "here" = "worktree"): Task => ({
    id,
    spec: { repo: "github.com/m/seance", mode, prompt: "x", title: id },
    state: "running",
    createdAt: 1,
    assignment: { deviceId: "dev-1", exclave: "default", clone: "seance" },
  });
  const pane = (taskId?: string): SessionEntry => ({
    window: "w",
    repo: "seance",
    path: "/x",
    ...(taskId === undefined ? {} : { taskId }),
  });
  const inputs = (fields: Partial<DrainInputs> = {}): DrainInputs => ({
    passes: true,
    tasks: [task("t1"), task("t2", "here")],
    sessions: { "dev-1": { sessions: [pane("t1"), pane("t2"), pane()] } },
    ...fields,
  });
  const draw = (drains: DrainInputs) => deriveMachines([closed], NOW, ready, {}, [], undefined, true, drains).cards[0];

  test("a closed machine's row says what is moving and lists what is stuck", () => {
    expect(draw(inputs())?.drain).toEqual({
      summary: "moving 1 · 2 stuck",
      stuck: ["t2: Can't move: runs in the clone", "Not a task: close it yourself"],
    });
  });

  test("no row without a drainPass leader, an unread queue, or a closed machine", () => {
    expect(draw(inputs({ passes: false }))?.drain).toBeNull();
    expect(draw(inputs({ tasks: null }))?.drain).toBeNull();
    const open = machine({ capabilities: [CAPABILITIES.close] });
    expect(deriveMachines([open], NOW, ready, {}, [], undefined, true, inputs()).cards[0]?.drain).toBeNull();
  });

  test("an unanswered sessions read reads as unknown, and an empty one as empty", () => {
    expect(draw(inputs({ tasks: [], sessions: { "dev-1": "unknown" } }))?.drain?.summary).toBe("sessions unknown");
    expect(draw(inputs({ tasks: [], sessions: { "dev-1": { sessions: [] } } }))?.drain?.summary).toBe("empty");
  });

  test("a sessions read not yet answered reads as reading, not as unreadable", () => {
    const open = machine({ capabilities: [CAPABILITIES.close] });
    expect(draw(inputs({ tasks: [], sessions: {} }))?.drain?.summary).toBe("reading sessions");
    expect(deriveCloseSheet(open, inputs({ tasks: [], sessions: {} }))).toEqual([
      "Closing mac stops new work landing on it.",
      "Reading what runs there…",
    ]);
    expect(deriveCloseSheet(open, inputs({ tasks: [], sessions: { "dev-1": "unknown" } }))[1]).toBe(
      "Its sessions could not be read.",
    );
    const lines = deriveCloseSheet(open, inputs({ sessions: { "dev-1": "unknown" } }));
    expect(lines).toContain("Its sessions could not be read.");
  });

  test("the close sheet keeps item 1's words without drainPass, and counts the passes with it", () => {
    const open = machine({ capabilities: [CAPABILITIES.close] });
    expect(deriveCloseSheet(open, inputs({ passes: false }))).toEqual([
      "Closing mac stops new work landing on it.",
      "Running work finishes where it is.",
    ]);
    expect(deriveCloseSheet(open, inputs())).toEqual([
      "Closing mac stops new work landing on it.",
      "1 running task will be passed to other machines in 10 minutes unless you reopen it.",
      "t2: Can't move: runs in the clone",
      "Not a task: close it yourself",
    ]);
    expect(deriveCloseSheet(open, inputs({ tasks: null }))[1]).toContain("10 minutes");
  });
});

describe("the close sheet for a drainAsk machine", () => {
  const asks = machine({ capabilities: [CAPABILITIES.close, CAPABILITIES.drainAsk] });
  const running = (id: string, extra: Partial<Task> = {}): Task => ({
    id,
    spec: { repo: "github.com/m/seance", mode: "worktree", prompt: "x", title: id },
    state: "running",
    createdAt: 1,
    assignment: { deviceId: "dev-1", exclave: "default", clone: "seance" },
    ...extra,
  });
  const pane = (taskId: string): SessionEntry => ({ window: "w", repo: "seance", path: "/x", taskId });
  const inputs = (tasks: Task[], passes = true): DrainInputs => ({
    passes,
    tasks,
    sessions: { "dev-1": { sessions: tasks.map((t) => pane(t.id)) } },
  });

  test("says the sessions are asked to pass themselves, and what is left is passed in 10 minutes only under drainPass", () => {
    expect(deriveCloseSheet(asks, inputs([running("t1")]))).toEqual([
      "Closing mac stops new work landing on it.",
      "1 running task will be asked to pass itself at its next pause (interrupted after 5 minutes); any left are passed to other machines in 10 minutes unless you reopen it.",
    ]);
    expect(deriveCloseSheet(asks, inputs([running("t1"), running("t2")]))[1]).toContain(
      "2 running tasks will be asked to pass themselves at their next pause",
    );
  });

  test("without a drainPass leader there are no counts, and no promise that anything is passed on", () => {
    expect(deriveCloseSheet(asks, inputs([running("t1")], false))).toEqual([
      "Closing mac stops new work landing on it.",
      "Its sessions are asked to pass themselves at their next pause (interrupted after 5 minutes).",
    ]);
    expect(deriveCloseSheet(asks, { passes: true, tasks: null, sessions: {} })[1]).toBe(
      "Its sessions are asked to pass themselves at their next pause (interrupted after 5 minutes); any left are passed to other machines 10 minutes after, unless you reopen it.",
    );
  });

  test("counts only an open question as waiting on you, singular and plural; a permission wait is not named", () => {
    const question = (id: string): Task => running(id, { state: "needs-input", inputReason: "question" });
    const permission = running("p", { state: "needs-input", inputReason: "permission" });
    expect(deriveCloseSheet(asks, inputs([question("q1"), permission]))).toContain(
      "1 waiting on you will have its question dismissed.",
    );
    expect(deriveCloseSheet(asks, inputs([question("q1"), question("q2")]))).toContain(
      "2 waiting on you will have their questions dismissed.",
    );
    expect(deriveCloseSheet(asks, inputs([permission])).some((line) => line.includes("waiting on you"))).toBe(false);
  });

  test("a machine without drainAsk keeps the old wording", () => {
    const old = machine({ capabilities: [CAPABILITIES.close] });
    expect(deriveCloseSheet(old, inputs([running("t1")]))[1]).toBe(
      "1 running task will be passed to other machines in 10 minutes unless you reopen it.",
    );
  });
});

describe("deriveMachines", () => {
  test("a daemon that predates exclaves still renders, marked as such", () => {
    const { exclaves: _, ...old } = machine();
    const [card] = deriveMachines([old], NOW, NO_LEADER).cards;
    expect(card?.name).toBe("mac");
    expect(card?.note).toContain("predates exclaves");
    expect(card?.exclaves).toEqual([]);
  });

  test("load and disk render from the status alone, indexed sessions land on their exclave", () => {
    const status = { at: S - 10, scan: 1, cpu: 95, mem: 80, disk: 99, free: 10, sess: [2] };
    const [card] = deriveMachines([machine({ status })], NOW, NO_LEADER).cards;
    expect(card?.gauges.map((gauge) => [gauge.label, gauge.level])).toEqual([
      ["CPU", "err"],
      ["Memory", "warn"],
      ["Disk", "err"],
    ]);
    expect(card?.exclaves[0]?.sessions).toBe(2);
    expect(card?.charts).toBe(true);
  });

  describe("exclave login", () => {
    const withAuth = (auth: Partial<MachineStatus>, caps: readonly string[] = [CAPABILITIES.authHealth]): Machine =>
      machine({
        capabilities: ["metrics", ...caps],
        exclaves: [exclave("default", ACCOUNT), exclave("work", "org-2:acct-bbbbbbbb-2222"), exclave("soon", ACCOUNT)],
        status: { at: S - 10, scan: 1, ...auth },
      });
    const rows = (m: Machine) => deriveMachines([m], NOW, NO_LEADER).cards[0]?.exclaves.map((row) => row.auth);
    const at = (ms: number): number => Math.round((NOW + ms) / 1000);
    const HOUR = 3_600_000;

    test("a lapsed login reads as an error, an expiring one as a warning in days then hours, and ok says nothing", () => {
      expect(rows(withAuth({ ax: [0], ae: [[2, at(2 * 24 * HOUR + 60_000)]] }))).toEqual([
        { text: "needs /login", level: "err" },
        null,
        { text: "login expires in 2d", level: "warn" },
      ]);
      expect(rows(withAuth({ ae: [[1, at(5 * HOUR + 60_000)]] }))?.[1]).toEqual({
        text: "login expires in 5h",
        level: "warn",
      });
      // Under an hour is "1h", never "0h"; a time already past reads lapsed.
      expect(rows(withAuth({ ae: [[1, at(10 * 60_000)]] }))?.[1]?.text).toBe("login expires in 1h");
      expect(rows(withAuth({ ae: [[1, at(-5_000)]] }))?.[1]).toEqual({ text: "needs /login", level: "err" });
      expect(rows(withAuth({ ae: [[1, at(AUTH_EXPIRING_MS)]] }))?.[1]?.text).toBe("login expires in 3d");
    });

    test("unread, no capability, an asleep machine and a stale status say nothing, never a false ok or a false lapse", () => {
      expect(rows(withAuth({ au: [0, 1, 2] }))).toEqual([null, null, null]);
      expect(rows(withAuth({ ax: [0] }, []))).toEqual([null, null, null]);
      expect(rows({ ...withAuth({ ax: [0] }), connected: false })).toEqual([null, null, null]);
      expect(rows({ ...withAuth({ ax: [0] }), status: { at: S - 3600, scan: 1, ax: [0] } })).toEqual([
        null,
        null,
        null,
      ]);
      expect(rows(withAuth({}))).toEqual([null, null, null]);
    });
  });

  describe("exclave trait probes", () => {
    const probed = (status: Partial<MachineStatus>, connected = true): Machine =>
      machine({
        connected,
        exclaves: [
          { ...exclave("default", ACCOUNT), traits: ["atlas", "az"] },
          { ...exclave("work", "org-2:acct-bbbbbbbb-2222"), traits: ["az"] },
          exclave("plain", ACCOUNT),
        ],
        status: { at: S - 10, scan: 1, ...status },
      });
    const rows = (m: Machine) => deriveMachines([m], NOW, NO_LEADER).cards[0]?.exclaves.map((row) => row.probes);

    test("a failing probe names its traits per exclave, singular or plural; unchecked and healthy say nothing", () => {
      expect(
        rows(
          probed({
            tf: [
              [0, 0],
              [0, 1],
              [1, 0],
            ],
            tu: [],
          }),
        ),
      ).toEqual([{ text: "atlas, az probes failing", level: "err" }, { text: "az probe failing", level: "err" }, null]);
      expect(rows(probed({ tu: [[0, 0]] }))).toEqual([null, null, null]);
      expect(rows(probed({}))).toEqual([null, null, null]);
    });

    test("an asleep machine and a stale status say nothing: the reading is not current", () => {
      expect(rows(probed({ tf: [[0, 0]] }, false))).toEqual([null, null, null]);
      expect(rows({ ...probed({}), status: { at: S - 3600, scan: 1, tf: [[0, 0]] } })).toEqual([null, null, null]);
    });
  });

  // The scheduler's floor is free space, not percent: a small LXC root can be out of routing at 80%.
  test("disk reads red under the scheduler's free-space floor whatever its percent, and is absent with no reading", () => {
    const gauges = (status: MachineStatus): [string, string][] =>
      (deriveMachines([machine({ status })], NOW, NO_LEADER).cards[0]?.gauges ?? []).map((gauge) => [
        gauge.label,
        gauge.level,
      ]);
    expect(gauges({ at: S - 10, scan: 1, cpu: 5, mem: 5, disk: 80, free: MIN_FREE_MIB - 1 })).toContainEqual([
      "Disk",
      "err",
    ]);
    expect(gauges({ at: S - 10, scan: 1, cpu: 5, mem: 5, disk: 80, free: MIN_FREE_MIB })).toContainEqual([
      "Disk",
      "warn",
    ]);
    // No statfs answer: no Disk gauge, rather than a 0% one.
    expect(gauges({ at: S - 10, scan: 1, cpu: 5, mem: 5 })).toEqual([
      ["CPU", "ok"],
      ["Memory", "ok"],
    ]);
  });

  // The status the relay kept when a Mac slept, or a beat from a socket the relay still lists
  // after a timed-out request marked it asleep: either read as CPU 85% beside "last seen 17m ago".
  test("an asleep card draws no pressure or sessions from its last status; its quota still counts, with its age", () => {
    const status = {
      at: S - 17 * 60,
      scan: 1,
      cpu: 85,
      mem: 39,
      sess: [2],
      quota: [{ x: 0, h: 7, s: "cache" as const, at: S - 18 * 60 }],
    };
    const { cards, accounts } = deriveMachines(
      [machine({ connected: false, lastSeen: NOW - 17 * 60_000, status })],
      NOW,
      NO_LEADER,
    );
    expect(cards[0]?.meta).toBe("asleep · last seen 17m ago");
    expect(cards[0]?.gauges).toEqual([]);
    expect(cards[0]?.exclaves[0]?.sessions).toBeNull();
    expect(accounts[0]?.bars.map((bar) => bar.pct)).toEqual([7]);
    expect(accounts[0]?.observed).toEndWith("18m ago on mac, asleep");
    // A socket the relay still listed when it slept: lastSeen is the register's, days old; the beat is the sleep.
    const listed = deriveMachines(
      [machine({ connected: false, lastSeen: NOW - 3 * 86_400_000, status })],
      NOW,
      NO_LEADER,
    );
    expect(listed.cards[0]?.meta).toBe("asleep · last seen 17m ago");
  });

  test("an account across machines takes the newest observation; unsigned exclaves group nowhere", () => {
    const older = machine({
      deviceId: "a",
      name: "a",
      exclaves: [exclave("default", ACCOUNT), exclave("scratch", null)],
      status: { at: S, scan: 1, quota: [{ x: 0, h: 10, s: "cache", at: S - 600 }] },
    });
    const newer = machine({
      deviceId: "b",
      name: "b",
      exclaves: [exclave("work", ACCOUNT)],
      status: { at: S, scan: 1, quota: [{ x: 0, h: 50, s: "cache", at: S - 60 }] },
    });
    const { accounts } = deriveMachines([older, newer], NOW, NO_LEADER);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.title).toBe("default · work");
    expect(accounts[0]?.bars.map((bar) => bar.pct)).toEqual([50]);
    expect(accounts[0]?.observed).toContain("on b");
    expect(accounts[0]?.historyFrom).toBe("b");
  });

  test("a reading only the fleet quota record holds shows bars, observed on a machine no longer listed", () => {
    const unobserved = machine({ status: { at: S, scan: 1 } });
    const fleet = [{ accountId: ACCOUNT, observer: "retired", reading: { h: 40, s: "cache", at: S - 120 } }] as const;
    const { accounts } = deriveMachines([unobserved], NOW, NO_LEADER, {}, fleet);
    expect(accounts[0]?.bars.map((bar) => bar.pct)).toEqual([40]);
    expect(accounts[0]?.observed).toBe("cache · 2m ago on a machine no longer listed");
    expect(deriveMachines([unobserved], NOW, NO_LEADER).accounts[0]?.observed).toStartWith("No quota seen yet");
  });

  test("an account is named by the email any of its exclaves reports, else its short id", () => {
    const first = machine({
      deviceId: "a",
      name: "a",
      exclaves: [exclave("default", ACCOUNT), exclave("work", "org-2:acct-bbbbbbbb-2222")],
    });
    // An old daemon reports no email for the same account; the other machine's still names it.
    const old = machine({ deviceId: "b", name: "b", exclaves: [exclave("default", ACCOUNT)] });
    const named = machine({
      deviceId: "c",
      name: "c",
      exclaves: [{ ...exclave("default", ACCOUNT), email: "me@example.com" }],
    });
    const { cards, accounts } = deriveMachines([first, old, named], NOW, NO_LEADER);
    expect(accounts.map((account) => account.detail)).toEqual(["me@example.com · on a, b, c", "acct acct-bbb · on a"]);
    expect(cards[2]?.exclaves[0]?.account).toBe("me@example.com");
    expect(cards[0]?.exclaves[0]?.account).toBe("me@example.com");
  });

  test("an alias titles the card, its exclaves lead the meta line; the exclave row and display name take it too", () => {
    const named = machine({
      deviceId: "a",
      name: "a",
      exclaves: [
        { ...exclave("default", ACCOUNT), email: "me@example.com" },
        exclave("work", "org-2:acct-bbbbbbbb-2222"),
      ],
    });
    const aliases = { [ACCOUNT]: "personal", "org-2:acct-bbbbbbbb-2222": "client" };
    const { cards, accounts } = deriveMachines([named], NOW, NO_LEADER, aliases);
    expect(accounts.map((account) => [account.alias, account.title, account.detail])).toEqual([
      ["personal", "personal", "default · me@example.com · on a"],
      ["client", "client", "work · acct acct-bbb · on a"],
    ]);
    expect(accounts.map((account) => [account.exclaves, account.plainName])).toEqual([
      ["default", "me@example.com"],
      ["work", "acct acct-bbb"],
    ]);
    expect(cards[0]?.exclaves.map((row) => row.account)).toEqual(["personal", "client"]);
    expect(accountDisplayName(knownAccounts([named]), ACCOUNT, aliases)).toBe("personal");
    expect(
      accountDisplayName(knownAccounts([named]), "org-3:unseen-account", { "org-3:unseen-account": "ghost" }),
    ).toBe("ghost");

    const cleared = deriveMachines([named], NOW, NO_LEADER, {});
    expect(cleared.accounts.map((account) => [account.alias, account.title, account.detail])).toEqual([
      [null, "default", "me@example.com · on a"],
      [null, "work", "acct acct-bbb · on a"],
    ]);
    expect(accountDisplayName(knownAccounts([named]), ACCOUNT)).toBe("me@example.com");
    expect(accountDisplayName(knownAccounts([named]), "org-2:acct-bbbbbbbb-2222")).toBe("acct acct-bbb");
  });

  test("two accounts under one alias are told apart by their exclave ids in the title", () => {
    const both = machine({
      deviceId: "a",
      name: "a",
      exclaves: [exclave("default", ACCOUNT), exclave("work", "org-2:acct-bbbbbbbb-2222")],
    });
    const same = { [ACCOUNT]: "Martin", "org-2:acct-bbbbbbbb-2222": "Martin" };
    expect(deriveMachines([both], NOW, NO_LEADER, same).accounts.map((account) => account.title)).toEqual([
      "Martin (default)",
      "Martin (work)",
    ]);
    const one = { [ACCOUNT]: "Martin", "org-2:acct-bbbbbbbb-2222": "Other" };
    expect(deriveMachines([both], NOW, NO_LEADER, one).accounts.map((account) => account.title)).toEqual([
      "Martin",
      "Other",
    ]);
  });

  test("same-named accounts on the same exclave id on different machines still read apart", () => {
    const first = machine({ deviceId: "a", name: "a", exclaves: [exclave("default", ACCOUNT)] });
    const second = machine({ deviceId: "b", name: "b", exclaves: [exclave("default", "org-2:acct-bbbbbbbb-2222")] });
    const same = { [ACCOUNT]: "Martin", "org-2:acct-bbbbbbbb-2222": "Martin" };
    expect(deriveMachines([first, second], NOW, NO_LEADER, same).accounts.map((account) => account.title)).toEqual([
      "Martin (default on a)",
      "Martin (default on b)",
    ]);
    const clash = { [ACCOUNT]: "default" };
    const titles = deriveMachines([first, second], NOW, NO_LEADER, clash).accounts.map((account) => account.title);
    expect(new Set(titles).size).toBe(2);
  });

  test("one email on two orgs reads with each org on the card, the exclave row and a hold; an alias still leads", () => {
    const personal = "1a2b3c4d-personal:acct-same";
    const team = "9f8e7d6c-team:acct-same";
    const both = machine({
      deviceId: "a",
      name: "a",
      exclaves: [
        { ...exclave("default", personal), email: "me@example.com" },
        { ...exclave("work", team), email: "me@example.com" },
      ],
    });
    const { cards, accounts } = deriveMachines([both], NOW, NO_LEADER);
    expect(accounts.map((account) => account.detail)).toEqual([
      "me@example.com (org 1a2b3c4d) · on a",
      "me@example.com (org 9f8e7d6c) · on a",
    ]);
    expect(cards[0]?.exclaves.map((row) => row.account)).toEqual([
      "me@example.com (org 1a2b3c4d)",
      "me@example.com (org 9f8e7d6c)",
    ]);
    expect(accountDisplayName(knownAccounts([both]), team)).toBe("me@example.com (org 9f8e7d6c)");
    expect(accountDisplayName(knownAccounts([both]), team, { [team]: "work" })).toBe("work");

    // The tag stays with the email: an alias title never carries one, and its unaliased twin keeps its own.
    const aliased = deriveMachines([both], NOW, NO_LEADER, { [team]: "work" }).accounts;
    expect(aliased.map((account) => [account.title, account.detail])).toEqual([
      ["default", "me@example.com (org 1a2b3c4d) · on a"],
      ["work", "work · me@example.com (org 9f8e7d6c) · on a"],
    ]);
  });

  test("one account has one label on every machine, whether or not that machine reports its email", () => {
    const personal = "1a2b3c4d-personal:acct-same";
    const team = "9f8e7d6c-team:acct-same";
    const withEmail = machine({
      deviceId: "a",
      name: "a",
      exclaves: [
        { ...exclave("default", personal), email: "me@example.com" },
        { ...exclave("work", team), email: "me@example.com" },
      ],
    });
    const old = machine({ deviceId: "b", name: "b", exclaves: [exclave("default", personal)] });
    const { cards } = deriveMachines([withEmail, old], NOW, NO_LEADER);
    expect(cards[1]?.exclaves[0]?.account).toBe("me@example.com (org 1a2b3c4d)");
    expect(cards[0]?.exclaves[0]?.account).toBe(cards[1]?.exclaves[0]?.account);

    // A short-id twin: one account's emailless row must not collide with another account's short id.
    const bare = machine({
      deviceId: "c",
      name: "c",
      exclaves: [exclave("default", "org-x:acct-abcdefgh1"), exclave("work", "org-y:acct-abcdefgh2")],
    });
    const named = machine({
      deviceId: "d",
      name: "d",
      exclaves: [{ ...exclave("default", "org-x:acct-abcdefgh1"), email: "x@example.com" }],
    });
    const labels = deriveMachines([bare, named], NOW, NO_LEADER).cards.map((card) =>
      card.exclaves.map((row) => row.account),
    );
    expect(labels).toEqual([["x@example.com", "acct acct-abc"], ["x@example.com"]]);
  });

  test("an account id that names an inherited property is no alias", () => {
    const odd = machine({ exclaves: [exclave("default", "constructor")] });
    expect(deriveMachines([odd], NOW, NO_LEADER, {}).accounts[0]?.alias).toBeNull();
    expect(accountDisplayName(knownAccounts([odd]), "toString", {})).toBe("acct toString");
  });

  test("a window past its reset reads empty, however full the reading was", () => {
    const quota = [
      {
        x: 0,
        s: "cache" as const,
        at: S - 5 * 3600,
        h: 92,
        hr: S - 60,
        d: 43,
        dr: S + 5 * 86_400,
        w: [{ m: "Fable", p: 27, r: S - 1 }],
      },
    ];
    const [account] = deriveMachines([machine({ status: { at: S, scan: 1, quota } })], NOW, NO_LEADER).accounts;
    expect(account?.bars.map((bar) => [bar.label, bar.pct, bar.level, bar.note])).toEqual([
      ["5h", 0, "ok", "reset"],
      ["7d", 43, "ok", "resets in 5d"],
      ["7d Fable", 0, "ok", "reset"],
    ]);
  });

  test("credits show only while a window is full, a past reset not counting; spent of cap in whole units", () => {
    type Window = { h?: number; hr?: number; w?: { m: string; p: number }[]; cu?: number; at?: number };
    const labels = (window: Window): string[] => {
      const quota = [{ x: 0, s: "cache" as const, at: S - 60, d: 40, c: 84, cu: 4177, cl: 5000, ...window }];
      const [account] = deriveMachines([machine({ status: { at: S, scan: 1, quota } })], NOW, NO_LEADER).accounts;
      return account?.bars.map((bar) => [bar.label, `${bar.pct}%`, bar.note].join(" ").trim()) ?? [];
    };
    expect(labels({ h: 99 })).toEqual(["5h 99%", "7d 40%"]);
    expect(labels({ h: 100 })).toEqual(["5h 100%", "7d 40%", "Credits 84% $42 of $50"]);
    expect(labels({ h: 100, hr: S - 1 })).toEqual(["5h 0% reset", "7d 40%"]);
    expect(labels({ w: [{ m: "Fable", p: 100 }] })).toEqual(["7d 40%", "7d Fable 100%", "Credits 84% $42 of $50"]);
    // A daemon that predates the amounts sends `c` alone: the note is empty.
    const bare = labels({ h: 100, cu: undefined });
    expect(bare.at(-1)).toBe("Credits 84%");
    // Credits reset at 00:00 UTC on the 1st: last month's figure shows no bar.
    expect(labels({ h: 100, at: Date.UTC(2027, 0, 1) / 1000 - 1 })).toEqual(["5h 100%", "7d 40%"]);
  });

  test("the credits bar is never green: yellow below the red threshold", () => {
    const level = (c: number): string | undefined => {
      const quota = [{ x: 0, s: "cache" as const, at: S - 60, h: 100, c }];
      const [account] = deriveMachines([machine({ status: { at: S, scan: 1, quota } })], NOW, NO_LEADER).accounts;
      return account?.bars.find((bar) => bar.label === "Credits")?.level;
    };
    expect([level(0), level(74), level(75), level(89), level(90)]).toEqual(["warn", "warn", "warn", "warn", "err"]);
  });

  // The newest observer is asleep, or predates `metrics`: any online host still
  // has some history, and with none the card offers no chart at all.
  test("an account's history comes from another online host when the newest can't serve it", () => {
    const quota = (
      at: number,
    ): { at: number; scan: number; quota: { x: number; h: number; s: "cache"; at: number }[] } => ({
      at: S,
      scan: 1,
      quota: [{ x: 0, h: 10, s: "cache", at }],
    });
    const serving = machine({ deviceId: "a", status: quota(S - 600) });
    const old = machine({ deviceId: "b", capabilities: [], status: quota(S - 60) });
    expect(deriveMachines([serving, old], NOW, NO_LEADER).accounts[0]?.historyFrom).toBe("a");

    const asleep = machine({ deviceId: "a", connected: false });
    expect(deriveMachines([asleep, old], NOW, NO_LEADER).accounts[0]?.historyFrom).toBeNull();
  });

  // DESIGN.md, Archivist, A35, A36d, A36f: with no archivist nothing changes; with one, an asleep
  // machine and a host-less account gain a chart, and the picker gains 90d and 1y.
  test("the archive adds charts and long ranges only while it serves them", () => {
    const fleet = [machine({ deviceId: "a" }), machine({ deviceId: "z", connected: false })];
    const charts = (view: ReturnType<typeof deriveMachines>): unknown => ({
      machines: view.cards.map((card) => card.charts),
      account: view.accounts.map((account) => [account.historyFrom, account.charts]),
      ranges: view.ranges,
    });

    expect(charts(deriveMachines(fleet, NOW, NO_LEADER))).toEqual({
      machines: [true, false],
      account: [["a", true]],
      ranges: { machine: ["6h", "24h", "30d"], account: ["6h", "24h", "30d"] },
    });
    expect(charts(deriveMachines(fleet, NOW, NO_LEADER, {}, [], { machine: true, account: true }))).toEqual({
      machines: [true, true],
      account: [["a", true]],
      ranges: { machine: ["6h", "24h", "30d", "90d", "1y"], account: ["6h", "24h", "30d", "90d", "1y"] },
    });

    // Every host asleep: only the archive can chart the account, and only with the key its series are filed under.
    const asleep = [machine({ deviceId: "z", connected: false })];
    expect(charts(deriveMachines(asleep, NOW, NO_LEADER, {}, [], { machine: true, account: false }))).toEqual({
      machines: [true],
      account: [[null, false]],
      ranges: { machine: ["6h", "24h", "30d", "90d", "1y"], account: ["6h", "24h", "30d"] },
    });
    expect(deriveMachines(asleep, NOW, NO_LEADER, {}, [], { machine: true, account: true }).accounts[0]?.charts).toBe(
      true,
    );
  });

  test("the archive charts a machine only while the archivist is connected, an account only with the account key", () => {
    const entry = (connected: boolean): ArchivistEntry => ({
      deviceId: "arch",
      name: "archive",
      platform: "linux",
      connected,
      lastSeen: 1,
    });
    expect(archiveCharts(null, true)).toEqual({ machine: false, account: false });
    expect(archiveCharts(entry(false), true)).toEqual({ machine: false, account: false });
    expect(archiveCharts(entry(true), false)).toEqual({ machine: true, account: false });
    expect(archiveCharts(entry(true), true)).toEqual({ machine: true, account: true });
  });

  // An unverified nominee is never drawn as the leader (DESIGN.md, Leadership).
  test("the leader is named and badged only once verified; an unverified nominee is named as such", () => {
    const fleet = [machine({ deviceId: "a", name: "mac" }), machine({ deviceId: "b", name: "box" })];
    const ready = deriveMachines(fleet, NOW, { kind: "ready", deviceId: "b", term: 4 });
    expect(ready.scheduler).toBe("scheduler on box · term 4");
    expect(ready.cards.map((card) => card.role)).toEqual([null, "leader"]);

    const unverified = deriveMachines(fleet, NOW, { kind: "unverified", deviceId: "b", term: 4 });
    expect(unverified.scheduler).toBe("scheduler box unverified");
    expect(unverified.cards.map((card) => card.role)).toEqual([null, "unverified"]);
    // Its entry did not open: only the id can say which seed it is.
    const unlisted = deriveMachines(fleet, NOW, { kind: "unverified", deviceId: "zzzzzzzzzzzz", term: 4 });
    expect(unlisted.scheduler).toBe("scheduler device zzzzzzzz unverified");
    expect(unlisted.cards.map((card) => card.role)).toEqual([null, null]);

    const none = deriveMachines(fleet, NOW, NO_LEADER);
    expect(none.scheduler).toBe("no scheduler");
    expect(none.cards.map((card) => card.role)).toEqual([null, null]);
  });

  test("a card shows the build its daemon runs, and a note only when its last update attempt was a skip or a failure", () => {
    const source = { sha: "0123456789abcdef0123456789abcdef01234567", commitTs: NOW - 3 * 86_400_000, branch: "main" };
    const behind = machine({ source, lastUpdate: { at: NOW - 2 * 3_600_000, outcome: "skipped_dirty" } });
    const [card] = deriveMachines([behind], NOW, NO_LEADER).cards;
    expect(card?.build).toBe("0123456789ab · committed 3d ago · main");
    expect(card?.updateNote).toBe("Last update attempt 2h ago: skipped, working tree had uncommitted changes.");

    const detached = machine({ source: { ...source, branch: null }, lastUpdate: { at: NOW, outcome: "ok" } });
    const [fine] = deriveMachines([detached], NOW, NO_LEADER).cards;
    expect(fine?.build).toEndWith("· detached");
    expect(fine?.updateNote).toBeNull();

    const [old] = deriveMachines([machine()], NOW, NO_LEADER).cards;
    expect(old?.build).toBeNull();
    expect(old?.updateNote).toBeNull();
  });
});

function series(metric: string, points: [number, number][], labels: Record<string, string> = {}): MetricsSeries {
  return { metric, labels, points };
}

describe("chartLines", () => {
  const window = { from: 0, to: 300, step: 30 };
  const size = { width: 300, height: 100 };

  test("a gauge breaks at one missed tick and drops points outside the window", () => {
    const [line] = chartLines(
      [
        series(METRIC_NAMES.cpu, [
          [-30, 1],
          [0, 0],
          [30, 50],
          [90, 100],
          [330, 1],
        ]),
      ],
      window,
      size,
    );
    // 90 is a run of one, so it is drawn as a dot; the gap before it is bridged apart, dotted.
    expect([line?.d, line?.gaps]).toEqual(["M0 100L30 50M90 0h0", "M30 50L90 0"]);
  });

  // What a Mac in clamshell sleep leaves: one tick per dark wake, each alone.
  test("lone points between gaps are dots, each gap bridged once", () => {
    const [line] = chartLines(
      [
        series(METRIC_NAMES.cpu, [
          [0, 50],
          [120, 50],
          [240, 0],
          [270, 0],
        ]),
      ],
      window,
      size,
    );
    expect(line?.d).toBe("M0 50h0M120 50h0M240 100L270 100");
    expect(line?.gaps).toBe("M0 50L120 50M120 50L240 100");
  });

  test("a quota series holds its level between observations, across any gap", () => {
    const [line] = chartLines(
      [
        series(METRIC_NAMES.h, [
          [0, 0],
          [240, 50],
        ]),
      ],
      window,
      size,
    );
    expect([line?.d, line?.gaps]).toEqual(["M0 100H240V50", ""]);
  });
});

describe("accountSeries", () => {
  // A machine with two exclaves signed in as one account reports the same
  // windows twice; the chart draws each window once, labelled by window alone.
  test("keeps one account's quota windows, folded across exclaves", () => {
    const other = "org-1:acct-bbbbbbbb-2222";
    const folded = accountSeries(
      [
        series(METRIC_NAMES.cpu, [[0, 50]], { account: ACCOUNT }),
        series(
          METRIC_NAMES.h,
          [
            [0, 10],
            [60, 20],
          ],
          { exclave: "default", account: ACCOUNT },
        ),
        series(
          METRIC_NAMES.h,
          [
            [30, 15],
            [60, 25],
          ],
          { exclave: "work", account: ACCOUNT },
        ),
        series(METRIC_NAMES.w, [[0, 70]], { exclave: "default", account: ACCOUNT, model: "Fable" }),
        series(METRIC_NAMES.h, [[0, 99]], { exclave: "home", account: other }),
      ],
      ACCOUNT,
    );
    expect(folded).toEqual([
      {
        metric: METRIC_NAMES.h,
        labels: {},
        points: [
          [0, 10],
          [30, 15],
          [60, 25],
        ],
      },
      { metric: METRIC_NAMES.w, labels: { model: "Fable" }, points: [[0, 70]] },
    ]);
    expect(
      chartLines(folded, { from: 0, to: 60, step: 30 }, { width: 60, height: 100 }).map((line) => line.label),
    ).toEqual(["5h", "7d Fable"]);
  });
});

describe("deriveArchivist", () => {
  const source = { sha: "a".repeat(40), commitTs: NOW - 2 * 3_600_000, branch: "main" };
  const entry: ArchivistEntry = {
    deviceId: "arch-1",
    name: "archive",
    platform: "linux",
    connected: true,
    lastSeen: NOW - 3 * 3_600_000,
    source,
  };
  // Noon UTC: the same calendar day in every zone.
  const since = Date.UTC(2026, 10, 12, 12);
  const reply: ArchiveStatusResponse = {
    ok: true,
    onlineSince: NOW - 1000,
    lastIngest: { store: NOW - 12_000 - 100_000, registry: NOW - 12_000, status: null, pull: null },
    tasks: { rows: 1284, oldest: since },
    samples: { rows: 18_400_000, oldest: since },
    events: { rows: 52, oldest: since },
    database: { archiveBytes: 100_000_000, metricsBytes: 2_000_000_000 },
    countedAt: NOW,
  };
  const held = { deviceId: "arch-1", reply };

  test("no archivist, no card", () => {
    expect(deriveArchivist(null, held, NOW)).toBeNull();
  });

  test("online with a reply: last ingest, the build line, four rows and the history note", () => {
    const card = deriveArchivist(entry, held, NOW);
    expect(card).toMatchObject({
      name: "Archivist",
      online: true,
      meta: "linux · last ingest just now",
      note: null,
    });
    expect(card?.build).toBe(`${"a".repeat(12)} · committed 2h ago · main`);
    expect(card?.rows).toEqual([
      { label: "Tasks", detail: "since 12 Nov 2026", value: "1,284", unit: "rows" },
      { label: "Samples", detail: "since 12 Nov 2026", value: "18.4M", unit: "rows" },
      { label: "Events", detail: "since 12 Nov 2026", value: "52", unit: "rows" },
      { label: "Database", detail: "archive + metrics", value: "2.1", unit: "GB" },
    ]);
  });

  test("last ingest is the newest of the sources, aged", () => {
    const older = {
      deviceId: "arch-1",
      reply: { ...reply, lastIngest: { store: NOW - 5 * 60_000, registry: null, status: null, pull: null } },
    };
    expect(deriveArchivist(entry, older, NOW)?.meta).toBe("linux · last ingest 5m ago");
  });

  test("online without a reply, or with one for another device, has the platform and no rows", () => {
    expect(deriveArchivist(entry, null, NOW)).toMatchObject({ meta: "linux", rows: [] });
    expect(deriveArchivist(entry, { deviceId: "arch-2", reply }, NOW)).toMatchObject({ meta: "linux", rows: [] });
  });

  test("a reply with no ingest yet reads as the platform alone", () => {
    const fresh = { ...reply, lastIngest: { store: null, registry: null, status: null, pull: null } };
    expect(deriveArchivist(entry, { deviceId: "arch-1", reply: fresh }, NOW)?.meta).toBe("linux");
  });

  test("offline: last seen, no rows even with counts held, and the offline note", () => {
    const card = deriveArchivist({ ...entry, connected: false }, held, NOW);
    expect(card).toMatchObject({
      online: false,
      meta: "offline · last seen 3h ago",
      rows: [],
      note: "While it is offline, 90-day and 1-year charts, merged account charts, asleep machines' history and older tasks are hidden until it is back.",
    });
    expect(card?.build).not.toBeNull();
  });

  test("an archivist with no source has no build line", () => {
    const { source: _source, ...bare } = entry;
    expect(deriveArchivist(bare, null, NOW)?.build).toBeNull();
  });

  test("an empty table says none yet, and an uncounted one a dash", () => {
    const card = deriveArchivist(
      entry,
      { deviceId: "arch-1", reply: { ...reply, tasks: { rows: 0, oldest: null }, samples: null } },
      NOW,
    );
    expect(card?.rows[0]).toEqual({ label: "Tasks", detail: "none yet", value: "0", unit: "rows" });
    expect(card?.rows[1]).toEqual({ label: "Samples", detail: "", value: "—", unit: "rows" });
  });

  test("counts of a billion or more read in B, sizes under a kilobyte in bytes", () => {
    const card = deriveArchivist(
      entry,
      {
        deviceId: "arch-1",
        reply: {
          ...reply,
          events: { rows: 2_500_000_000, oldest: since },
          database: { archiveBytes: 500, metricsBytes: 0 },
        },
      },
      NOW,
    );
    expect(card?.rows[2]?.value).toBe("2.5B");
    expect(card?.rows[3]).toMatchObject({ value: "500", unit: "B" });
  });
});

describe("the custodian row", () => {
  const RC = `session_${"A".repeat(20)}`;
  const seated = (cu: MachineStatus["cu"], capabilities: string[] = [CAPABILITIES.custodian]): Machine =>
    machine({ capabilities, ...(cu === undefined ? {} : { status: { at: S - 5, scan: 1, cu } }) });
  const rowOf = (m: Machine) => deriveMachines([m], NOW, NO_LEADER).cards[0]?.custodian;

  test("no row without the capability, however the status looks", () => {
    expect(rowOf(seated({ s: "idle" }, []))).toBeNull();
  });

  test("with the capability and no cu yet: no report", () => {
    expect(rowOf(seated(undefined))).toEqual({ state: null, ended: null, counts: null, link: null, warn: false });
  });

  test("idle with a last round: its age and counts", () => {
    expect(rowOf(seated({ s: "idle", e: S - 600, n: [3, 1, 2] }))).toEqual({
      state: "idle",
      ended: "last round ended 10m ago",
      counts: "closed 3 · nudged 1 · flagged 2",
      link: null,
      warn: false,
    });
  });

  test("no round yet when e is absent; zero parts are dropped but closed, and closed 0 alone reads as nothing closed", () => {
    expect(rowOf(seated({ s: "idle" }))).toMatchObject({ ended: "no round yet", counts: null });
    expect(rowOf(seated({ s: "idle", e: S - 60, n: [0, 0, 0] }))?.counts).toBe("nothing closed");
    expect(rowOf(seated({ s: "idle", e: S - 60, n: [4, 0, 0] }))?.counts).toBe("closed 4");
    expect(rowOf(seated({ s: "idle", e: S - 60, n: [0, 2, 0] }))?.counts).toBe("closed 0 · nudged 2");
    expect(rowOf(seated({ s: "idle", e: S - 60, n: [0, 0, 1] }))?.counts).toBe("closed 0 · flagged 1");
  });

  test("failing is the warn colour; paused and idle are not", () => {
    expect(rowOf(seated({ s: "failing" }))?.warn).toBe(true);
    expect(rowOf(seated({ s: "paused" }))?.warn).toBe(false);
  });

  test("a running round with a valid rc links to claude.ai", () => {
    expect(rowOf(seated({ s: "running", rc: RC }))?.link).toBe(`https://claude.ai/code/${RC}`);
    expect(rowOf(seated({ s: "running" }))?.link).toBeNull();
  });

  test("an rc that fails the check here, or sits beside another state, never links", () => {
    // Built past the parser, which would have dropped these.
    for (const rc of ["session_a/../b", "https://evil.example/x", "session_a b", ""]) {
      const bad = { s: "running", rc } satisfies MachineStatus["cu"];
      expect(rowOf(seated(bad))?.link).toBeNull();
    }
    expect(rowOf(seated({ s: "paused", rc: RC }))?.link).toBeNull();
    expect(rowOf(seated({ s: "idle", rc: RC }))?.link).toBeNull();
  });
});
