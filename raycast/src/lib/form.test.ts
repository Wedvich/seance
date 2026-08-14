import { describe, expect, test } from "bun:test";
import type { Machine, RelayState } from "@seance/shared";
import { DEFAULT_FORM } from "../../../pwa/src/state.ts";
import { resolveMachine as pwaResolveMachine, resolveRepo as pwaResolveRepo } from "../../../pwa/src/view.ts";
import {
  checkSubmit,
  initialValues,
  nextLastUsed,
  reconcile,
  sortedByName,
  sortedMachines,
  type Defaults,
  type FormValues,
  type LastUsed,
  type PickerMachine,
} from "./form.ts";

const defaults: Defaults = { machineName: "", model: "opus", effort: "medium" };

function machine(overrides: Partial<PickerMachine> = {}): PickerMachine {
  return {
    deviceId: "device-1",
    name: "laptop",
    connected: true,
    lastSeen: 1_000,
    scannedAt: 900,
    repos: [
      { name: "seance", path: "/repos/seance", defaultBranch: "main" },
      { name: "other", path: "/repos/other", defaultBranch: null },
    ],
    ...overrides,
  };
}

const desktop = machine({
  deviceId: "device-2",
  name: "desktop",
  repos: [{ name: "www", path: "/w", defaultBranch: null }],
});

function values(overrides: Partial<FormValues> = {}): FormValues {
  return { prompt: "", machineId: null, repo: null, model: "opus", effort: "medium", worktree: true, ...overrides };
}

describe("initialValues", () => {
  test("first run with no preference picks the first connected machine and its first repo", () => {
    const opening = initialValues([machine({ connected: false }), desktop], null, defaults);
    expect(opening.machineId).toBe("device-2");
    expect(opening.repo).toBe("www");
  });

  test("first run seeds model and effort from the preferences", () => {
    const opening = initialValues([machine()], null, { machineName: "", model: "sonnet", effort: "max" });
    expect(opening.model).toBe("sonnet");
    expect(opening.effort).toBe("max");
  });

  test("the preference names the machine when there is nothing remembered", () => {
    const opening = initialValues([machine(), desktop], null, { ...defaults, machineName: "DESKTOP" });
    expect(opening.machineId).toBe("device-2");
  });

  test("last-used wins over the preference", () => {
    const remembered: LastUsed = {
      machineId: "device-1",
      repos: { "device-1": "other" },
      model: "fable",
      effort: "high",
      worktree: false,
    };
    const opening = initialValues([machine(), desktop], remembered, { ...defaults, machineName: "desktop" });
    expect(opening.machineId).toBe("device-1");
    expect(opening.repo).toBe("other");
    expect(opening.model).toBe("fable");
    expect(opening.effort).toBe("high");
    expect(opening.worktree).toBe(false);
  });

  test("the preference takes over when the remembered machine is gone", () => {
    const remembered: LastUsed = {
      machineId: "gone",
      repos: { gone: "x" },
      model: "opus",
      effort: "low",
      worktree: true,
    };
    const opening = initialValues([machine(), desktop], remembered, { ...defaults, machineName: "desktop" });
    expect(opening.machineId).toBe("device-2");
    // Model and effort are remembered independently of the machine.
    expect(opening.effort).toBe("low");
  });

  test("the prompt always starts empty", () => {
    const remembered: LastUsed = { machineId: "device-1", repos: {}, model: "opus", effort: "medium", worktree: true };
    expect(initialValues([machine()], remembered, defaults).prompt).toBe("");
  });

  test("an empty registry leaves nothing selected rather than inventing a machine", () => {
    const opening = initialValues([], null, defaults);
    expect(opening.machineId).toBeNull();
    expect(opening.repo).toBeNull();
  });
});

describe("reconcile", () => {
  const context = (cached: readonly PickerMachine[], lastUsed: LastUsed | null = null) => ({
    cached,
    lastUsed,
    defaults,
  });

  test("a selection the live registry still holds is left alone, silently", () => {
    const current = values({ machineId: "device-1", repo: "other" });
    const result = reconcile(current, [machine()], context([machine()]));
    expect(result.values).toEqual(current);
    expect(result.note).toBeNull();
  });

  test("a machine gone from the live registry switches, naming the one that went", () => {
    const cached = [machine(), desktop];
    const result = reconcile(values({ machineId: "device-1", repo: "seance" }), [desktop], context(cached));
    expect(result.values.machineId).toBe("device-2");
    expect(result.values.repo).toBe("www");
    expect(result.note).toBe("laptop is no longer registered — switched to desktop");
  });

  test("a machine gone from both the live registry and the cache still reports the switch", () => {
    const result = reconcile(values({ machineId: "vanished", repo: "seance" }), [desktop], context([]));
    expect(result.values.machineId).toBe("device-2");
    expect(result.note).toBe("the last machine is no longer registered — switched to desktop");
  });

  test("a repo gone from the selected machine picks another and says so", () => {
    const shrunk = machine({ repos: [{ name: "other", path: "/repos/other", defaultBranch: null }] });
    const result = reconcile(values({ machineId: "device-1", repo: "seance" }), [shrunk], context([machine()]));
    expect(result.values.repo).toBe("other");
    expect(result.note).toBe("seance is gone from laptop — picked other");
  });

  test("a machine with no repos at all reports the emptiness", () => {
    const empty = machine({ repos: [] });
    const result = reconcile(values({ machineId: "device-1", repo: "seance" }), [empty], context([machine()]));
    expect(result.values.repo).toBeNull();
    expect(result.note).toBe("laptop has no repos to spawn in");
  });

  test("a first selection is not an apology", () => {
    const result = reconcile(values(), [machine()], context([]));
    expect(result.values.machineId).toBe("device-1");
    expect(result.values.repo).toBe("seance");
    expect(result.note).toBeNull();
  });

  test("an empty live registry clears the selection without a note — the blocker explains it", () => {
    const result = reconcile(values({ machineId: "device-1", repo: "seance" }), [], context([machine()]));
    expect(result.values.machineId).toBeNull();
    expect(result.values.repo).toBeNull();
    expect(result.note).toBeNull();
  });

  test("switching machine by hand restores that machine's repo, not the previous one's", () => {
    const current = values({ machineId: "device-1", repo: "seance" });
    const result = reconcile({ ...current, machineId: "device-2" }, [machine(), desktop], context([]));
    expect(result.values.repo).toBe("www");
  });

  test("switching machines restores the target machine's remembered repo, not its first", () => {
    const desktopTwo = machine({
      deviceId: "device-2",
      name: "desktop",
      repos: [
        { name: "api", path: "/a", defaultBranch: null },
        { name: "www", path: "/w", defaultBranch: null },
      ],
    });
    const remembered: LastUsed = {
      machineId: "device-1",
      repos: { "device-2": "www" },
      model: "opus",
      effort: "medium",
      worktree: true,
    };
    // The view hands reconcile `repo: null` on a switch, so the previous
    // machine's selection cannot carry over.
    const result = reconcile(
      values({ machineId: "device-2", repo: null }),
      [machine(), desktopTwo],
      context([], remembered),
    );
    expect(result.values.repo).toBe("www");
    expect(result.note).toBeNull();
  });

  test("a repo gone from the machine falls back to its remembered one before its first", () => {
    const shifted = machine({
      repos: [
        { name: "alpha", path: "/repos/alpha", defaultBranch: null },
        { name: "other", path: "/repos/other", defaultBranch: null },
      ],
    });
    const remembered: LastUsed = {
      machineId: "device-1",
      repos: { "device-1": "other" },
      model: "opus",
      effort: "medium",
      worktree: true,
    };
    const result = reconcile(
      values({ machineId: "device-1", repo: "seance" }),
      [shifted],
      context([machine()], remembered),
    );
    expect(result.values.repo).toBe("other");
    expect(result.note).toBe("seance is gone from laptop — picked other");
  });

  test("an offline machine is still selectable — refusing to submit is the blocker's job", () => {
    const asleep = machine({ connected: false });
    const result = reconcile(values({ machineId: "device-1" }), [asleep], context([asleep]));
    expect(result.values.machineId).toBe("device-1");
  });
});

describe("checkSubmit", () => {
  test("resolves the target when everything lines up", () => {
    const result = checkSubmit(values({ machineId: "device-1", repo: "seance" }), [machine()], true);
    expect(result).toEqual({ ok: true, machine: machine(), repo: "seance" });
  });

  test("refuses while the machine list is still empty and the relay is not open", () => {
    const result = checkSubmit(values(), [], false);
    expect(result).toEqual({ ok: false, reason: "Still reaching the relay — no machine list yet" });
  });

  test("refuses a connected relay with an empty registry, and says the registry is empty", () => {
    expect(checkSubmit(values(), [], true)).toEqual({ ok: false, reason: "No machines are registered with the relay" });
  });

  test("refuses when nothing is selected out of a non-empty list", () => {
    expect(checkSubmit(values(), [machine()], true)).toEqual({ ok: false, reason: "Pick a machine" });
  });

  test("refuses on a cached machine while the socket is not open", () => {
    const result = checkSubmit(values({ machineId: "device-1", repo: "seance" }), [machine()], false);
    expect(result).toEqual({ ok: false, reason: "Not connected to the relay" });
  });

  test("refuses an asleep machine rather than spawning into a void", () => {
    const asleep = machine({ connected: false });
    const result = checkSubmit(values({ machineId: "device-1", repo: "seance" }), [asleep], true);
    expect(result).toEqual({ ok: false, reason: "laptop is asleep — nothing would receive the spawn" });
  });

  test("refuses a machine with no repo selected, pointing at repoRoots", () => {
    const result = checkSubmit(values({ machineId: "device-1" }), [machine({ repos: [] })], true);
    expect(result).toEqual({
      ok: false,
      reason: "laptop has no repos — check repoRoots in its config, then rescan",
    });
  });
});

describe("sortedByName", () => {
  test("orders alphabetically, since the relay pushes deviceId order", () => {
    const pushed = [machine({ deviceId: "a", name: "WSL 26.04" }), desktop, machine({ name: "MacBook M4 Pro" })];
    expect(sortedByName(pushed).map((entry) => entry.name)).toEqual(["desktop", "MacBook M4 Pro", "WSL 26.04"]);
  });

  test("sorts case-insensitively, as a reader expects rather than by code point", () => {
    const names = sortedByName([machine({ name: "beta" }), machine({ name: "Alpha" })]).map((entry) => entry.name);
    expect(names).toEqual(["Alpha", "beta"]);
  });

  test("does not mutate the list it was given", () => {
    const pushed = [machine({ name: "z" }), machine({ name: "a" })];
    sortedByName(pushed);
    expect(pushed.map((entry) => entry.name)).toEqual(["z", "a"]);
  });

  test("sorts repos too, which the daemon reports in scan order", () => {
    const repos = [
      { name: "zeta", path: "/z", defaultBranch: null },
      { name: "alpha", path: "/a", defaultBranch: null },
    ];
    expect(sortedByName(repos).map((repo) => repo.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("sortedMachines", () => {
  test("sorts each machine's repos at entry, so the first-repo fallback is the first shown", () => {
    const entered = sortedMachines([
      machine({
        repos: [
          { name: "zeta", path: "/z", defaultBranch: null },
          { name: "alpha", path: "/a", defaultBranch: null },
        ],
      }),
      desktop,
    ]);
    expect(entered.map((entry) => entry.name)).toEqual(["desktop", "laptop"]);
    expect(entered[1]?.repos.map((repo) => repo.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("nextLastUsed", () => {
  test("records the repo under the machine it was picked for", () => {
    const next = nextLastUsed(null, values({ machineId: "device-1", repo: "other", model: "fable", effort: "max" }));
    expect(next).toEqual({
      machineId: "device-1",
      repos: { "device-1": "other" },
      model: "fable",
      effort: "max",
      worktree: true,
    });
  });

  test("keeps other machines' remembered repos", () => {
    const previous: LastUsed = {
      machineId: "device-2",
      repos: { "device-2": "www" },
      model: "opus",
      effort: "medium",
      worktree: true,
    };
    const next = nextLastUsed(previous, values({ machineId: "device-1", repo: "seance" }));
    expect(next.repos).toEqual({ "device-2": "www", "device-1": "seance" });
  });

  test("does not invent an entry when nothing was selected", () => {
    expect(nextLastUsed(null, values()).repos).toEqual({});
  });
});

function relayOf(machines: readonly Machine[]): RelayState {
  return {
    status: "open",
    rejection: null,
    machines,
    registrySize: machines.length,
    hidden: [],
    ignored: 0,
    settling: false,
    registrySettled: true,
  };
}

/**
 * pickMachine and pickRepo document themselves as the PWA's resolveMachine /
 * resolveRepo fallback policy, extended only by the named-default preference
 * (inert here: machineName is ""). Asserted the way credentials.test.ts pins
 * the daemon: import the PWA's own functions, feed both sides equivalent
 * inputs, and require the same choice. `reconcile` is the exported surface the
 * pickers sit behind.
 */
describe("drift guard: fallback policy agrees with pwa/src/view.ts", () => {
  function pwaMachine(overrides: Partial<Machine> = {}): Machine {
    return { ...machine(), platform: "darwin", ...overrides };
  }

  function expectAgreement(
    machines: readonly Machine[],
    machineId: string | null,
    repos: Readonly<Record<string, string>>,
  ): void {
    const chosen = pwaResolveMachine(relayOf(machines), machineId);
    const repo = pwaResolveRepo(chosen, { ...DEFAULT_FORM, machineId, repos });
    const lastUsed: LastUsed = { machineId, repos, model: "opus", effort: "medium", worktree: true };
    const ours = reconcile(values({ machineId }), machines, { cached: machines, lastUsed, defaults });
    expect(ours.values.machineId).toBe(chosen?.deviceId ?? null);
    expect(ours.values.repo).toBe(repo?.name ?? null);
  }

  const twoRepos = [
    { name: "api", path: "/a", defaultBranch: null },
    { name: "www", path: "/w", defaultBranch: null },
  ];

  test("a remembered machine still present keeps its remembered repo", () => {
    expectAgreement(
      [pwaMachine(), pwaMachine({ deviceId: "device-2", name: "desktop", repos: twoRepos })],
      "device-2",
      { "device-2": "www" },
    );
  });

  test("a remembered machine that is gone falls to the first connected", () => {
    expectAgreement(
      [pwaMachine({ connected: false }), pwaMachine({ deviceId: "device-2", name: "desktop" })],
      "gone",
      {},
    );
  });

  test("nothing connected falls to the first listed", () => {
    expectAgreement(
      [pwaMachine({ connected: false }), pwaMachine({ deviceId: "device-2", connected: false })],
      null,
      {},
    );
  });

  test("a remembered repo that is gone falls to the machine's first", () => {
    expectAgreement([pwaMachine({ repos: twoRepos })], "device-1", { "device-1": "vanished" });
  });

  test("an empty registry resolves nothing on either side", () => {
    expectAgreement([], "device-1", {});
  });
});
