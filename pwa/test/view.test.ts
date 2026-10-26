import { describe, expect, test } from "bun:test";
import { CAPABILITIES, type ExclaveInfo, type Machine, type RelayState } from "@seance/shared";
import { DEFAULT_FORM, RESCAN_IDLE, type PersistedForm, type SessionsView } from "../src/state.ts";
import {
  derivePinProblem,
  deriveReportedAvailability,
  deriveView,
  failedBody,
  formatSeen,
  previewAsked,
  resolveRepo,
  scopedRepos,
  type AppState,
} from "../src/view.ts";

const NOW = 1_800_000_000_000;

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    deviceId: "dev-1",
    name: "MacBook Pro",
    platform: "darwin",
    repos: [
      { name: "seance", path: "/Users/martin/repos/seance", defaultBranch: "main", origin: "github.com/acme/seance" },
      {
        name: "pengefix",
        path: "/Users/martin/repos/pengefix",
        defaultBranch: "main",
        origin: "github.com/acme/pengefix",
      },
    ],
    scannedAt: NOW,
    lastSeen: NOW,
    connected: true,
    ...overrides,
  };
}

const exclave = (id: string, accountId: string | null = id): ExclaveInfo => ({
  id,
  authOk: accountId !== null,
  accountId,
  email: accountId === null ? undefined : `${id}@acme.dev`,
  extraUsageEnabled: null,
  skills: [],
});

function relay(overrides: Partial<RelayState> = {}): RelayState {
  const machines = overrides.machines ?? [machine()];
  return {
    status: "open",
    rejection: null,
    machines,
    registrySize: machines.length,
    ignored: 0,
    unbound: 0,
    skewed: 0,
    settling: false,
    registrySettled: true,
    scheduler: { kind: "none" },
    fleetQuota: [],
    ...overrides,
  };
}

function state(overrides: Partial<AppState> = {}, form: Partial<PersistedForm> = {}): AppState {
  return {
    relay: relay(),
    form: { ...DEFAULT_FORM, ...form },
    promptUndo: null,
    sheet: null,
    settings: false,
    machines: false,
    history: null,
    spawning: false,
    rescan: RESCAN_IDLE,
    verdict: null,
    preview: null,
    sessions: {},
    queue: false,
    wide: false,
    queueView: null,
    taskAction: null,
    queueNotice: null,
    pausing: false,
    discarding: false,
    accounts: { aliases: {}, nameable: true, saving: null, notice: null },
    ...overrides,
  };
}

function sessions(count: number): SessionsView {
  return {
    sessions: Array.from({ length: count }, (_unused, index) => ({
      window: `w-${index}`,
      repo: "seance",
      path: "/Users/martin/repos/seance",
    })),
    at: NOW,
  };
}

describe("formatSeen", () => {
  test("coarsens by magnitude", () => {
    expect(formatSeen(NOW, NOW)).toBe("just now");
    expect(formatSeen(NOW - 90_000, NOW)).toBe("1m ago");
    expect(formatSeen(NOW - 2 * 3_600_000, NOW)).toBe("2h ago");
    expect(formatSeen(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
  });

  test("never renders a negative age from clock skew", () => {
    expect(formatSeen(NOW + 60_000, NOW)).toBe("just now");
  });
});

describe("banner and button", () => {
  test("relay down blocks the spawn and keeps the prompt", () => {
    const view = deriveView(state({ relay: relay({ status: "retrying" }) }, { prompt: "do the thing" }), NOW);
    expect(view.banner?.title).toBe("Relay unreachable");
    expect(view.button).toEqual({ label: "Waiting for the relay", enabled: false, busy: false });
    expect(view.meta).toBe("relay unreachable · retrying");
    expect(view.relayLine).toBe("relay unreachable · retrying");
  });

  // A refresh and every resume start here, and the screen must not shout on the way in.
  test("a settling relay reads as connecting, with no banner and no red dot", () => {
    const view = deriveView(state({ relay: relay({ status: "connecting", settling: true }) }), NOW);
    expect(view.banner).toBeNull();
    expect(view.meta).toBe("connecting…");
    expect(view.relayLine).toBe("connecting…");
    expect(view.relayState).toBe("connecting");
    expect(view.button).toEqual({ label: "Connecting…", enabled: false, busy: false });
  });

  test("a rejected token is reported as such, not as an unreachable relay", () => {
    const view = deriveView(state({ relay: relay({ status: "rejected", rejection: "unauthorized" }) }), NOW);
    expect(view.meta).toBe("bearer token rejected");
    expect(view.relayLine).toBe("bearer token rejected");
    expect(view.banner?.opensSettings).toBe(true);
    expect(view.button.enabled).toBe(false);
  });

  test("an empty registry reads as a fresh install", () => {
    const view = deriveView(state({ relay: relay({ machines: [], registrySize: 0 }) }), NOW);
    expect(view.banner?.title).toBe("No machines yet");
    expect(view.banner?.tone).toBe("fg2");
    expect(view.button.label).toBe("No machines registered");
  });

  // The distinction that matters: entries exist, so this is a wrong key rather
  // than a machine that was never installed.
  test("entries that none decrypt read as a key mismatch", () => {
    const view = deriveView(state({ relay: relay({ machines: [], registrySize: 2, ignored: 2 }) }), NOW);
    expect(view.banner?.title).toBe("Key mismatch");
    expect(view.banner?.body).toContain("2 machines are registered");
    expect(view.banner?.opensSettings).toBe(true);
    expect(view.button.label).toBe("Check your key");
  });

  test("a partial mismatch stays silent apart from the footnote", () => {
    const view = deriveView(state({ relay: relay({ machines: [machine()], registrySize: 2, ignored: 1 }) }), NOW);
    expect(view.banner).toBeNull();
    expect(view.ignoredNote).toBe("1 entry ignored (key mismatch)");
    expect(view.relayLine).toBe("connected");
    expect(view.button.enabled).toBe(true);
  });

  // Entries the app has not decrypted yet must not read as a wrong key: nothing
  // has failed to open, the list is simply not built.
  test("entries not yet decrypted are not reported as a key mismatch", () => {
    const view = deriveView(state({ relay: relay({ machines: [], registrySize: 2, ignored: 0 }) }), NOW);
    expect(view.banner?.title).toBe("No machines listed");
    expect(view.banner?.tone).toBe("fg2");
    expect(view.banner?.opensSettings).toBe(false);
    expect(view.button.label).toBe("No machines listed");
  });

  test("an undecryptable entry beside an unreadable one still reads as a key mismatch", () => {
    const view = deriveView(state({ relay: relay({ machines: [], registrySize: 2, ignored: 1 }) }), NOW);
    expect(view.banner?.title).toBe("Key mismatch");
    expect(view.banner?.body).toContain("1 machine is registered");
  });

  // A swapped pairing is not a key problem either: the PSK opened nothing
  // wrong, the relay's bearer token was used to re-file a blob.
  test("entries filed under the wrong machine are reported as tampering, not a key mismatch", () => {
    const view = deriveView(state({ relay: relay({ machines: [], registrySize: 1, unbound: 1 }) }), NOW);
    expect(view.banner?.title).toBe("Registry tampered");
    expect(view.banner?.body).toContain("1 entry is filed under a machine it does not belong to");
    expect(view.banner?.opensSettings).toBe(false);
    expect(view.button.label).toBe("Registry tampered");
  });

  test("a partial swapped pairing gets its own footnote", () => {
    const view = deriveView(state({ relay: relay({ machines: [machine()], registrySize: 2, unbound: 1 }) }), NOW);
    expect(view.banner).toBeNull();
    expect(view.ignoredNote).toBe("1 entry dropped (filed under the wrong machine)");
    expect(view.button.enabled).toBe(true);
  });

  // Skew is not a key problem: "check the pre-shared key" over a blob this key
  // just opened sends someone to rotate a credential that is correct.
  test("entries this build cannot read are reported as version skew, not a key mismatch", () => {
    const view = deriveView(state({ relay: relay({ machines: [], registrySize: 2, skewed: 2 }) }), NOW);
    expect(view.banner?.title).toBe("Version mismatch");
    expect(view.banner?.body).toContain("2 machines are registered");
    expect(view.banner?.opensSettings).toBe(false);
    expect(view.button.label).toBe("Version mismatch");
  });

  test("partial skew gets its own footnote, apart from the key mismatch one", () => {
    const view = deriveView(
      state({ relay: relay({ machines: [machine()], registrySize: 3, ignored: 1, skewed: 1 }) }),
      NOW,
    );
    expect(view.banner).toBeNull();
    expect(view.ignoredNote).toBe("1 entry ignored (key mismatch) · 1 entry unreadable (version mismatch)");
    expect(view.button.enabled).toBe(true);
  });

  // The pin is the owner's choice, so a machine that left the registry is not swapped for another.
  test("a pin on a machine the registry no longer lists stays a pin, naming nothing", () => {
    const studio = machine({ deviceId: "dev-2", name: "Mac Studio", connected: false });
    const view = deriveView(
      state({ relay: relay({ machines: [studio], registrySize: 1 }) }, { machine: "dev-1" }),
      NOW,
    );
    expect(view.machine).toBeNull();
    expect(view.machineTile).toMatchObject({ value: "Unknown machine", dot: "off" });
    expect(view.footerStatus).toBe("The pinned machine isn't listed");
    expect(view.meta).toBe("0 online · 1 asleep · 0 sessions");
  });

  test("no footnote when every entry decrypts", () => {
    expect(deriveView(state(), NOW).ignoredNote).toBeNull();
  });

  // The task waits for it, so an offline pin is a note, never a block.
  test("an offline pinned machine still queues, and the footer says the task waits for it", () => {
    const asleep = machine({ connected: false, lastSeen: NOW - 3 * 86_400_000, exclaves: [exclave("default")] });
    const view = deriveView(state({ relay: relay({ machines: [asleep] }) }, { machine: "dev-1" }), NOW);
    expect(view.banner).toBeNull();
    expect(view.button).toEqual({ label: "Queue on MacBook Pro", enabled: true, busy: false });
    expect(view.machineTile.dot).toBe("off");
    expect(view.footerStatus).toBe("MacBook Pro is offline — the task waits for it");
  });

  test("queuing outranks the other labels", () => {
    const view = deriveView(state({ spawning: true }, { prompt: "hi" }), NOW);
    expect(view.button).toEqual({ label: "Queuing…", enabled: false, busy: true });
  });

  test("the label is Queue whatever the prompt, and names a pinned machine", () => {
    expect(deriveView(state(), NOW).button.label).toBe("Queue");
    expect(deriveView(state({}, { prompt: "port the pane" }), NOW).button.label).toBe("Queue");
    const pinned = machine({ exclaves: [exclave("default")] });
    expect(deriveView(state({ relay: relay({ machines: [pinned] }) }, { machine: "dev-1" }), NOW).button.label).toBe(
      "Queue on MacBook Pro",
    );
  });
});

describe("sessions", () => {
  test("totals across machines for the header", () => {
    const second = machine({ deviceId: "dev-2", name: "Mac Studio" });
    const view = deriveView(
      state({
        relay: relay({ machines: [machine(), second] }),
        sessions: { "dev-1": sessions(2), "dev-2": sessions(1) },
      }),
      NOW,
    );
    expect(view.meta).toBe("2 online · 0 asleep · 3 sessions");
  });

  // A machine whose fetch failed must not be counted as zero in the header total.
  test("marks the total as a floor when a connected machine hasn't answered", () => {
    const second = machine({ deviceId: "dev-2", name: "Mac Studio" });
    const view = deriveView(
      state({
        relay: relay({ machines: [machine(), second] }),
        sessions: { "dev-1": sessions(2), "dev-2": "unknown" },
      }),
      NOW,
    );
    expect(view.meta).toBe("2 online · 0 asleep · 2+ sessions");
  });

  test("offline machines never mark the total: their sessions are legitimately unknown", () => {
    const asleep = machine({ deviceId: "dev-2", name: "Mac Studio", connected: false });
    const view = deriveView(
      state({ relay: relay({ machines: [machine(), asleep] }), sessions: { "dev-1": sessions(2) } }),
      NOW,
    );
    expect(view.meta).toBe("1 online · 1 asleep · 2 sessions");
  });

  test("singularises the header total too", () => {
    const view = deriveView(state({ sessions: { "dev-1": sessions(1) } }), NOW);
    expect(view.meta).toBe("1 online · 0 asleep · 1 session");
  });
});

describe("repo scope", () => {
  const exclaveRepo = (name: string, origin: string, exclaveId: string) => ({
    name,
    path: `/r/${name}`,
    defaultBranch: "main",
    origin,
    exclave: exclaveId,
  });
  const mac = machine({
    deviceId: "mac",
    name: "Mac",
    exclaves: [exclave("work", "acct-work"), exclave("home", "acct-home")],
    repos: [exclaveRepo("api", "github.com/acme/api", "work"), exclaveRepo("blog", "github.com/me/blog", "home")],
  });
  const wsl = machine({
    deviceId: "wsl",
    name: "WSL",
    exclaves: [exclave("default", "acct-work")],
    repos: [
      exclaveRepo("api-1", "github.com/acme/api", "default"),
      exclaveRepo("tool", "github.com/acme/tool", "default"),
    ],
  });
  const legacy = machine({
    deviceId: "old",
    name: "Old",
    repos: [{ name: "x", path: "/r/x", defaultBranch: "main", origin: "github.com/acme/x" }],
  });
  const machines = [mac, wsl, legacy];
  const origins = (repos: readonly { origin: string }[]): string[] => repos.map((r) => r.origin);

  test("unpinned, every origin some machine clones appears once, labelled without the host", () => {
    const repos = scopedRepos(machines, { machine: null, account: null });
    expect(repos.map((r) => r.label)).toEqual(["acme/api", "acme/tool", "acme/x", "me/blog"]);
  });

  test("a machine pin narrows to that machine's clones", () => {
    expect(origins(scopedRepos(machines, { machine: "wsl", account: null }))).toEqual([
      "github.com/acme/api",
      "github.com/acme/tool",
    ]);
  });

  test("an account pin narrows to the clones in its exclaves, strictly: a daemon with no exclaves is in no account", () => {
    expect(origins(scopedRepos(machines, { machine: null, account: "acct-work" }))).toEqual([
      "github.com/acme/api",
      "github.com/acme/tool",
    ]);
    expect(origins(scopedRepos([legacy], { machine: null, account: "acct-work" }))).toEqual([]);
  });

  test("both pins intersect", () => {
    expect(origins(scopedRepos(machines, { machine: "mac", account: "acct-home" }))).toEqual(["github.com/me/blog"]);
    expect(scopedRepos(machines, { machine: "wsl", account: "acct-home" })).toEqual([]);
  });

  test("resolveRepo keeps the remembered origin while it is in scope, else the first", () => {
    const repos = scopedRepos(machines, { machine: "wsl", account: null });
    expect(resolveRepo(repos, { ...DEFAULT_FORM, repo: "github.com/acme/tool" })?.origin).toBe("github.com/acme/tool");
    expect(resolveRepo(repos, { ...DEFAULT_FORM, repo: "github.com/me/blog" })?.origin).toBe("github.com/acme/api");
    expect(resolveRepo([], DEFAULT_FORM)).toBeNull();
  });

  test("the repo tile follows the pins, and the preview is asked only with both on auto", () => {
    const auto = deriveView(state({ relay: relay({ machines }) }), NOW);
    expect(auto.previewShown).toBe(true);
    const pinned = deriveView(state({ relay: relay({ machines }) }, { machine: "mac", account: "acct-home" }), NOW);
    expect(pinned.repoTile.value).toBe("me/blog");
    expect(pinned.previewShown).toBe(false);
    expect(previewAsked({ machine: "mac", account: null })).toBe(false);
    expect(previewAsked({ machine: null, account: "acct-home" })).toBe(false);
    expect(previewAsked({ machine: null, account: null })).toBe(true);
  });
});

describe("worktree hint", () => {
  test("switches with the toggle", () => {
    expect(deriveView(state({}, { worktree: true }), NOW).worktreeHint).toBe(
      "Branches off the default branch on origin",
    );
    expect(deriveView(state({}, { worktree: false }), NOW).worktreeHint).toBe("Runs in the repo as it stands");
  });
});

describe("the pickers", () => {
  const leader = (machines: Machine[], capabilities: string[] = [CAPABILITIES.pinAccount]): RelayState =>
    relay({
      machines: machines.map((m, i) => (i === 0 ? { ...m, capabilities } : m)),
      scheduler: { kind: "ready", deviceId: machines[0]?.deviceId ?? "", term: 4 },
    });
  const mac = machine({
    deviceId: "mac",
    name: "Mac",
    exclaves: [exclave("work", "acct-work")],
    repos: [
      { name: "a", path: "/r/a", defaultBranch: "main", origin: "github.com/acme/a", exclave: "work" },
      { name: "b", path: "/r/b", defaultBranch: "main", origin: "github.com/acme/b", exclave: "work" },
    ],
  });
  const wsl = machine({ deviceId: "wsl", name: "WSL", exclaves: [exclave("home", "acct-home")] });
  const bare = machine({ deviceId: "bare", name: "Bare" });

  test("with no verified leader it still queues, and the note says the task waits for one", () => {
    const cases = [
      [{ kind: "none" }, "No scheduler is leading right now — it waits in the queue until one does"],
      [
        { kind: "unverified", deviceId: "squat", term: 3 },
        "Leader unverified — it hasn't shown it holds this key. It waits in the queue until one does",
      ],
    ] as const;
    for (const [scheduler, note] of cases) {
      const view = deriveView(state({ relay: relay({ machines: [machine()], scheduler }) }), NOW);
      expect(view.autoAvailability).toEqual({ available: true, reason: null, note });
      expect(view.footerStatus).toBe(note);
      expect(view.button).toEqual({ label: "Queue", enabled: true, busy: false });
      expect(view.machineTile).toMatchObject({ value: "Auto", dot: "auto" });
      expect(view.accountTile).toMatchObject({ label: "ACCOUNT", value: "Auto", dot: "auto" });
    }
  });

  test("greyed with the reason only while the relay socket is not open", () => {
    const down = deriveView(state({ relay: { ...leader([mac]), status: "retrying" } }), NOW);
    expect(down.autoAvailability).toEqual({ available: false, reason: "Not connected to the relay", note: null });
    expect(down.machineTile).toMatchObject({ dot: "off" });
    expect(down.footerStatus).toBe("Not connected to the relay");
  });

  test("a machine pin names the machine on the button and in the footer", () => {
    const view = deriveView(state({ relay: leader([mac, wsl]) }, { machine: "wsl" }), NOW);
    expect(view.machineTile).toMatchObject({ value: "WSL", dot: "ok" });
    expect(view.button).toEqual({ label: "Queue on WSL", enabled: true, busy: false });
    expect(view.footerStatus).toBe("Pinned to WSL");
  });

  test("an account pin shows the account by its alias, else its email", () => {
    const aliased = deriveView(
      state(
        {
          relay: leader([mac]),
          accounts: { aliases: { "acct-work": "Work" }, nameable: true, saving: null, notice: null },
        },
        {
          account: "acct-work",
        },
      ),
      NOW,
    );
    expect(aliased.accountTile).toMatchObject({ value: "Work", dot: "ok" });
    const plain = deriveView(state({ relay: leader([mac]) }, { account: "acct-work" }), NOW);
    expect(plain.accountTile.value).toBe("work@acme.dev");
    expect(plain.button).toEqual({ label: "Queue", enabled: true, busy: false });
  });

  test("an account no machine reports signed in blocks the button, and says so on the tile", () => {
    const view = deriveView(state({ relay: leader([mac]) }, { account: "acct-gone" }), NOW);
    expect(view.accountTile.value).toEndWith("signed in nowhere");
    expect(view.accountTile.dot).toBe("off");
    expect(view.button).toEqual({ label: "Account not signed in", enabled: false, busy: false });
    expect(view.footerStatus).toEndWith("isn't signed in on any machine");
  });

  test("the account gate: an unsupported leader and no leader are refused in their own words", () => {
    const unsupported = deriveView(state({ relay: leader([mac], []) }, { account: "acct-work" }), NOW);
    expect(unsupported.button).toEqual({ label: "Can't pin an account", enabled: false, busy: false });
    expect(unsupported.footerStatus).toContain("update seanced");
    const noLeader = deriveView(state({ relay: relay({ machines: [mac] }) }, { account: "acct-work" }), NOW);
    expect(noLeader.button).toEqual({ label: "Can't pin an account", enabled: false, busy: false });
    expect(noLeader.footerStatus).toContain("No verified scheduler is leading");
    // A machine pin alone needs no gate.
    expect(deriveView(state({ relay: relay({ machines: [mac] }) }, { machine: "mac" }), NOW).button.enabled).toBe(true);
  });

  test("an account the pinned machine lacks is refused; neither picker resets the other", () => {
    const aliases = {};
    const form = { ...DEFAULT_FORM, machine: "wsl", account: "acct-work" };
    expect(derivePinProblem(leader([mac, wsl]), form, aliases)).toMatchObject({ label: "Account not on that machine" });
    const view = deriveView(state({ relay: leader([mac, wsl]) }, form), NOW);
    expect(view.button).toEqual({ label: "Account not on that machine", enabled: false, busy: false });
    expect(view.machine?.deviceId).toBe("wsl");
    expect(view.account).toBe("acct-work");
  });

  test("a machine that reports no exclaves can't be pinned", () => {
    const view = deriveView(state({ relay: leader([mac, bare]) }, { machine: "bare" }), NOW);
    expect(view.button).toEqual({ label: "Machine needs an update", enabled: false, busy: false });
  });

  test("with no clone carrying an origin there is nothing to run", () => {
    const noOrigins = machine({ repos: [{ name: "x", path: "/r/x", defaultBranch: "main" }] });
    const view = deriveView(state({ relay: relay({ machines: [noOrigins] }) }), NOW);
    expect(view.repos).toEqual([]);
    expect(view.button).toEqual({ label: "No repo to run", enabled: false, busy: false });
  });

  test("the Machine sheet lists every machine, disabling the ones the account pin or a missing exclave rule out", () => {
    const view = deriveView(state({ relay: leader([mac, wsl, bare]) }, { account: "acct-work", machine: "mac" }), NOW);
    const rows = Object.fromEntries(view.machineChoices.map((c) => [c.machine.name, c]));
    expect(rows["Mac"]).toMatchObject({
      disabled: false,
      selected: true,
      sub: "online · 2 repos · last scanned just now",
    });
    expect(rows["WSL"]).toMatchObject({ disabled: true, selected: false, sub: "work@acme.dev isn't signed in here" });
    expect(rows["Bare"]).toMatchObject({ disabled: true, sub: "its daemon needs an update" });
  });

  test("the Machine sheet shows when a connected machine last scanned, and offline ones when they were last seen", () => {
    const scanned = machine({ ...mac, scannedAt: NOW - 3 * 3_600_000 });
    const asleep = machine({ ...wsl, connected: false, lastSeen: NOW - 2 * 86_400_000 });
    const rows = Object.fromEntries(
      deriveView(state({ relay: leader([scanned, asleep]) }), NOW).machineChoices.map((c) => [c.machine.name, c]),
    );
    expect(rows["Mac"]?.sub).toBe("online · 2 repos · last scanned 3h ago");
    expect(rows["WSL"]?.sub).toBe("offline · last seen 2d ago");

    // Its last status beat is newer than the register's lastSeen: the beat says when it slept.
    const beat = { at: (NOW - 5 * 60_000) / 1000, scan: 1, cpu: 1, mem: 1 };
    const slept = machine({ ...wsl, connected: false, lastSeen: NOW - 2 * 86_400_000, status: beat });
    const choice = deriveView(state({ relay: leader([scanned, slept]) }), NOW).machineChoices.find(
      (c) => c.machine.name === "WSL",
    );
    expect(choice?.sub).toBe("offline · last seen 5m ago");
  });

  test("a rescan shows on its own row only: offered while connected, disabled while any runs", () => {
    const asleep = machine({ ...wsl, connected: false });
    const idle = deriveView(state({ relay: leader([mac, asleep, bare]) }), NOW);
    const idleRows = Object.fromEntries(idle.machineChoices.map((c) => [c.machine.name, c]));
    expect(idleRows["Mac"]).toMatchObject({ canRescan: true, rescanDisabled: false, rescan: null });
    expect(idleRows["WSL"]).toMatchObject({ canRescan: false, rescanDisabled: false, rescan: null });

    const scanning = deriveView(
      state({ relay: leader([mac, asleep, bare]), rescan: { kind: "scanning", deviceId: "mac" } }),
      NOW,
    );
    const rows = Object.fromEntries(scanning.machineChoices.map((c) => [c.machine.name, c]));
    expect(rows["Mac"]).toMatchObject({ rescan: "scanning", rescanDisabled: true, sub: "scanning…" });
    expect(rows["Bare"]).toMatchObject({ rescan: null, rescanDisabled: true, canRescan: true });
    expect(rows["WSL"]).toMatchObject({ rescan: null, canRescan: false });

    const failed = deriveView(
      state({ relay: leader([mac, asleep, bare]), rescan: { kind: "failed", deviceId: "bare" } }),
      NOW,
    );
    const failedRows = Object.fromEntries(failed.machineChoices.map((c) => [c.machine.name, c]));
    expect(failedRows["Bare"]).toMatchObject({
      rescan: "failed",
      rescanDisabled: false,
      sub: "couldn't rescan — last known list",
    });
    expect(failedRows["Mac"]).toMatchObject({ rescan: null, sub: "online · 2 repos · last scanned just now" });
  });

  test("an Account row's dot is green while a machine signed in to it is connected, grey when all are asleep", () => {
    const asleep = machine({ ...wsl, connected: false });
    const view = deriveView(state({ relay: leader([mac, asleep]) }), NOW);
    expect(view.accountChoices.map((c) => [c.accountId, c.dot])).toEqual([
      ["acct-home", "off"],
      ["acct-work", "ok"],
    ]);
  });

  test("the Account sheet lists accounts some exclave reports, disabling the ones the pinned machine lacks", () => {
    const view = deriveView(state({ relay: leader([mac, wsl]) }, { machine: "mac" }), NOW);
    expect(view.accountChoices.map((c) => [c.accountId, c.disabled, c.sub])).toEqual([
      ["acct-home", true, "not signed in on Mac"],
      ["acct-work", false, "on Mac"],
    ]);
    const open = deriveView(state({ relay: leader([mac, wsl]) }, { account: "acct-home" }), NOW);
    expect(open.accountChoices.find((c) => c.accountId === "acct-home")).toMatchObject({
      selected: true,
      sub: "on WSL",
    });
  });
});

describe("failedBody", () => {
  test("words a scheduler code by taskFailureText, and leaves any other to the spawn-refusal line", () => {
    expect(failedBody("queue_expired")).toContain("30 days");
    expect(failedBody("queue_expired")).toEndWith("Nothing is running.");
    expect(failedBody("repo_not_found")).toBe("The machine refused the spawn. Nothing is running.");
    expect(failedBody(undefined)).toBe("The machine refused the spawn. Nothing is running.");
    expect(failedBody("dispatch_unconfirmed")).toContain("will not start it again");
    // It did run: "Nothing is running." would be false.
    expect(failedBody("lost_expired")).toContain("may still be running");
    expect(failedBody("lost_expired")).not.toEndWith("Nothing is running.");
    expect(failedBody("merge_expired")).toContain("No merge of its pull request was seen");
    // The task is failed and terminal (a failed task can't be marked done), so the advice is to resubmit what waited on it.
    expect(failedBody("merge_expired")).toContain("submit the tasks that waited on it again");
    expect(failedBody("merge_expired")).not.toContain("by hand");
    // It ran and ended: its dependents are the news, and "Nothing is running." would say less.
    expect(failedBody("session_failed")).toContain("exited with an error");
    expect(failedBody("session_failed")).toContain("Tasks waiting on it failed with it.");
    // With its exit status (`failure.exit`), it says how the session ended.
    expect(failedBody("session_failed", 137)).toStartWith(
      "Its session was killed (SIGKILL), possibly out of memory, and reported no pull request.",
    );
    expect(failedBody("session_failed", 139)).toStartWith("Its session ended on SIGSEGV (status 139) and reported");
    // A killed process writes nothing at the end; a plain exit's transcript says why.
    expect(failedBody("session_failed", 137)).toEndWith("Its transcript on that machine stops where it ended.");
    expect(failedBody("session_failed", 2)).toEndWith("Its transcript on that machine says why.");
    expect(failedBody("session_failed")).toEndWith("Its transcript on that machine says why.");
    expect(failedBody("session_failed", 1, "reported")).toStartWith(
      "Its session exited with status 1 and did not report done.",
    );
    expect(failedBody("session_failed", 2)).toStartWith("Its session exited with status 2 and reported");
    expect(failedBody("session_failed", 137)).toContain("Tasks waiting on it failed with it.");
    expect(failedBody("repo_not_found", 137)).toBe("The machine refused the spawn. Nothing is running.");
    // With the machine's OOM verdict (`failure.oomKill`), the SIGKILL is worded by it, either way.
    expect(failedBody("session_failed", 137, undefined, true)).toBe(
      "Its session was killed (SIGKILL), out of memory (the kernel's OOM killer fired as it died), and reported no pull request. Tasks waiting on it failed with it. Its transcript on that machine stops where it ended.",
    );
    expect(failedBody("session_failed", 137, undefined, false)).toStartWith(
      "Its session was killed (SIGKILL), not by the kernel's OOM killer, and reported no pull request.",
    );
  });
});

describe("deriveReportedAvailability", () => {
  const capable = machine({ capabilities: [CAPABILITIES.reportedDone] });
  const leading = { kind: "ready", deviceId: "dev-1", term: 1 } as const;

  test("true only for a verified leader whose own entry advertises it", () => {
    expect(deriveReportedAvailability(relay({ machines: [capable], scheduler: leading }))).toBe(true);
    expect(deriveReportedAvailability(relay({ machines: [machine()], scheduler: leading }))).toBe(false);
    expect(
      deriveReportedAvailability(relay({ machines: [machine({ capabilities: ["taskId"] })], scheduler: leading })),
    ).toBe(false);
  });

  test("another machine advertising it does not count, nor does no leader, an unverified one, or a retrying socket", () => {
    const other = machine({ deviceId: "dev-2", capabilities: [CAPABILITIES.reportedDone] });
    expect(deriveReportedAvailability(relay({ machines: [machine(), other], scheduler: leading }))).toBe(false);
    expect(deriveReportedAvailability(relay({ machines: [capable] }))).toBe(false);
    expect(
      deriveReportedAvailability(
        relay({ machines: [capable], scheduler: { kind: "unverified", deviceId: "dev-1", term: 1 } }),
      ),
    ).toBe(false);
    expect(deriveReportedAvailability(relay({ machines: [capable], scheduler: leading, status: "retrying" }))).toBe(
      false,
    );
  });

  test("the authoring tiles say what is set", () => {
    const view = deriveView(
      state(
        {},
        {
          after: [{ task: "t-1", after: "merged" }],
          batch: { id: "b", strategy: { mode: "parallel", max: 2 }, next: 3 },
        },
      ),
      NOW,
    );
    expect(view.afterTile).toMatchObject({ label: "AFTER", value: "1 task · merged" });
    expect(view.batchTile).toMatchObject({ label: "BATCH", value: "#3 · up to 2 at once" });
    const bare = deriveView(state(), NOW);
    expect(bare.afterTile.value).toBe("None");
    expect(bare.batchTile.value).toBe("Off");
  });
});
