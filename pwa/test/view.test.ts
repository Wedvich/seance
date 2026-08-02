import { describe, expect, test } from "bun:test";
import type { Machine, RelayState } from "../src/relay/client.ts";
import { DEFAULT_FORM, type PersistedForm, type SessionsView } from "../src/state.ts";
import {
  abbreviatePath,
  abbreviatePaths,
  deriveView,
  failureBody,
  formatSeen,
  resolveMachine,
  type AppState,
} from "../src/view.ts";

const NOW = 1_800_000_000_000;

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    deviceId: "dev-1",
    name: "MacBook Pro",
    platform: "darwin",
    repos: [
      { name: "seance", path: "/Users/martin/repos/seance", defaultBranch: "main" },
      { name: "pengefix", path: "/Users/martin/repos/pengefix", defaultBranch: "main" },
    ],
    scannedAt: NOW,
    lastSeen: NOW,
    connected: true,
    ...overrides,
  };
}

function relay(overrides: Partial<RelayState> = {}): RelayState {
  const machines = overrides.machines ?? [machine()];
  return {
    status: "open",
    rejection: null,
    machines,
    registrySize: machines.length,
    hidden: [],
    ignored: 0,
    settling: false,
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
    spawning: false,
    rescanning: false,
    rescan: "idle",
    verdict: null,
    sessions: {},
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

describe("abbreviatePaths", () => {
  test("trims the prefix the machine's repos share", () => {
    const labels = abbreviatePaths(["/Users/martin/repos/seance", "/Users/martin/repos/pengefix"]);
    expect(labels.get("/Users/martin/repos/seance")).toBe("seance");
    expect(labels.get("/Users/martin/repos/pengefix")).toBe("pengefix");
  });

  test("keeps the diverging segment when repos sit under different roots", () => {
    const labels = abbreviatePaths(["/Users/martin/repos/seance", "/Users/martin/pengefix/api"]);
    expect(labels.get("/Users/martin/repos/seance")).toBe("repos/seance");
    expect(labels.get("/Users/martin/pengefix/api")).toBe("pengefix/api");
  });

  // The prefix belongs to the set, so a shallow repo does not pull the deeper
  // ones up with it — each keeps everything past the shared root.
  test("trims every path by the set's prefix, not by its own depth", () => {
    const labels = abbreviatePaths([
      "/Users/martin/repos/seance",
      "/Users/martin/repos/work/api",
      "/Users/martin/repos/work/deep/nested",
    ]);
    expect(labels.get("/Users/martin/repos/seance")).toBe("seance");
    expect(labels.get("/Users/martin/repos/work/api")).toBe("work/api");
    expect(labels.get("/Users/martin/repos/work/deep/nested")).toBe("work/deep/nested");
  });

  test("falls back to the last two segments with nothing to compare against", () => {
    expect(abbreviatePaths(["/Users/martin/repos/seance"]).get("/Users/martin/repos/seance")).toBe("repos/seance");
  });

  // Two entries but one distinct path is still "nothing to compare against".
  test("treats a duplicated path as a single repo", () => {
    const paths = ["/Users/martin/repos/seance", "/Users/martin/repos/seance"];
    expect(abbreviatePaths(paths).get("/Users/martin/repos/seance")).toBe("repos/seance");
  });

  // A repo whose whole path is a prefix of a sibling's would otherwise be
  // trimmed down to nothing.
  test("never swallows the repo's own directory name", () => {
    const labels = abbreviatePaths(["/srv/app", "/srv/app/vendor/thing"]);
    expect(labels.get("/srv/app")).toBe("app");
    expect(labels.get("/srv/app/vendor/thing")).toBe("vendor/thing");
  });

  test("leaves a path with a single segment as it is", () => {
    const labels = abbreviatePaths(["/srv", "/srv/app"]);
    expect(labels.get("/srv")).toBe("/srv");
    expect(labels.get("/srv/app")).toBe("app");
  });

  test("labels every path once and leaves an empty list empty", () => {
    expect([...abbreviatePaths(["/a/one", "/a/two", "/a/three"])]).toEqual([
      ["/a/one", "one"],
      ["/a/two", "two"],
      ["/a/three", "three"],
    ]);
    expect(abbreviatePaths([]).size).toBe(0);
  });
});

// The single form exists for the repo tile: one label per render without the
// batch's Map. Same rule, so the same edges apply.
describe("abbreviatePath", () => {
  test("labels one path against its siblings", () => {
    expect(
      abbreviatePath("/Users/martin/repos/seance", ["/Users/martin/repos/seance", "/Users/martin/repos/pengefix"]),
    ).toBe("seance");
  });

  test("keeps the last two segments of a lone path, duplicated or not", () => {
    expect(abbreviatePath("/Users/martin/repos/seance", ["/Users/martin/repos/seance"])).toBe("repos/seance");
    expect(abbreviatePath("/a/b/c", ["/a/b/c", "/a/b/c"])).toBe("b/c");
  });

  test("leaves a single-segment path as it is", () => {
    expect(abbreviatePath("/srv", ["/srv", "/srv/app"])).toBe("/srv");
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

  // Removing the last offline machine must not read as a wrong key: nothing is
  // undecryptable, the list is simply empty by choice.
  test("a list emptied by removals is not reported as a key mismatch", () => {
    const view = deriveView(
      state({ relay: relay({ machines: [], registrySize: 2, hidden: ["dev-1", "dev-2"], ignored: 0 }) }),
      NOW,
    );
    expect(view.banner?.title).toBe("No machines listed");
    expect(view.banner?.tone).toBe("fg2");
    expect(view.banner?.opensSettings).toBe(false);
    expect(view.button.label).toBe("No machines listed");
  });

  test("removals alongside an undecryptable entry still read as a key mismatch", () => {
    const view = deriveView(
      state({ relay: relay({ machines: [], registrySize: 2, hidden: ["dev-1"], ignored: 1 }) }),
      NOW,
    );
    expect(view.banner?.title).toBe("Key mismatch");
    expect(view.banner?.body).toContain("1 machine is registered");
  });

  test("a removed machine leaves the counts and the selection to the rest", () => {
    const studio = machine({ deviceId: "dev-2", name: "Mac Studio", connected: false });
    const view = deriveView(
      state({ relay: relay({ machines: [studio], registrySize: 2, hidden: ["dev-1"] }) }, { machineId: "dev-1" }),
      NOW,
    );
    expect(view.machine?.deviceId).toBe("dev-2");
    expect(view.meta).toBe("0 online · 1 asleep · 0 sessions");
  });

  test("no footnote when every entry decrypts", () => {
    expect(deriveView(state(), NOW).ignoredNote).toBeNull();
  });

  test("an offline machine blocks the spawn and names itself", () => {
    const asleep = machine({ connected: false, lastSeen: NOW - 3 * 86_400_000 });
    const view = deriveView(state({ relay: relay({ machines: [asleep] }) }), NOW);
    expect(view.banner?.title).toBe("MacBook Pro is offline");
    expect(view.banner?.body).toContain("plugged in");
    expect(view.button).toEqual({ label: "MacBook Pro is asleep", enabled: false, busy: false });
    expect(view.machineTile.dot).toBe("off");
    expect(view.footerStatus).toBe("Last seen 3d ago · sessions unknown");
  });

  test("a non-Mac offline machine gets the keepalive copy instead", () => {
    const wsl = machine({ connected: false, platform: "linux", name: "tower-wsl" });
    const view = deriveView(state({ relay: relay({ machines: [wsl] }) }), NOW);
    expect(view.banner?.body).toContain("keepalive");
  });

  test("pending outranks the prompt-dependent labels", () => {
    const view = deriveView(state({ spawning: true }, { prompt: "hi" }), NOW);
    expect(view.button).toEqual({ label: "Starting…", enabled: false, busy: true });
  });

  test("a retry's rescan is named rather than passed off as the spawn it precedes", () => {
    const view = deriveView(state({ rescanning: true }, { prompt: "hi" }), NOW);
    expect(view.button).toEqual({ label: "Rescanning…", enabled: false, busy: true });
  });

  test("the label follows whether a prompt was typed", () => {
    expect(deriveView(state(), NOW).button.label).toBe("Start empty session");
    expect(deriveView(state({}, { prompt: "   " }), NOW).button.label).toBe("Start empty session");
    expect(deriveView(state({}, { prompt: "port the pane" }), NOW).button.label).toBe("Start with this prompt");
  });
});

describe("sessions", () => {
  test("totals across machines for the header and reads the selected one for the footer", () => {
    const second = machine({ deviceId: "dev-2", name: "Mac Studio" });
    const view = deriveView(
      state({
        relay: relay({ machines: [machine(), second] }),
        sessions: { "dev-1": sessions(2), "dev-2": sessions(1) },
      }),
      NOW,
    );
    expect(view.meta).toBe("2 online · 0 asleep · 3 sessions");
    expect(view.footerStatus).toBe("2 claude sessions already on MacBook Pro");
  });

  test("singularises one session", () => {
    const view = deriveView(state({ sessions: { "dev-1": sessions(1) } }), NOW);
    expect(view.footerStatus).toBe("1 claude session already on MacBook Pro");
  });

  test("says so plainly when nothing is running", () => {
    const view = deriveView(state({ sessions: { "dev-1": sessions(0) } }), NOW);
    expect(view.footerStatus).toBe("Nothing running on MacBook Pro right now");
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

  test("shows a checking state before the first reply", () => {
    expect(deriveView(state(), NOW).footerStatus).toBe("Checking sessions on MacBook Pro…");
  });
});

describe("selection", () => {
  test("prefers a connected machine when the form names one that has gone", () => {
    const online = machine({ deviceId: "dev-2", name: "Mac Studio" });
    const chosen = resolveMachine(relay({ machines: [online] }), "dev-vanished");
    expect(chosen?.deviceId).toBe("dev-2");
  });

  test("falls back to the machine's first repo when the form names a missing one", () => {
    const view = deriveView(state({}, { repos: { "dev-1": "deleted-repo" } }), NOW);
    expect(view.repo?.name).toBe("seance");
  });

  test("restores the repo remembered for the selected machine", () => {
    const studio = machine({ deviceId: "dev-2", name: "Mac Studio" });
    const view = deriveView(
      state(
        { relay: relay({ machines: [machine(), studio] }) },
        { machineId: "dev-2", repos: { "dev-1": "seance", "dev-2": "pengefix" } },
      ),
      NOW,
    );
    expect(view.machine?.deviceId).toBe("dev-2");
    expect(view.repo?.name).toBe("pengefix");
  });

  test("the repo tile carries the abbreviated label", () => {
    expect(deriveView(state(), NOW).repoTile.value).toBe("seance");
  });

  test("reports no repos when the machine has none", () => {
    const bare = machine({ repos: [] });
    const view = deriveView(state({ relay: relay({ machines: [bare] }) }), NOW);
    expect(view.repo).toBeNull();
    expect(view.repoTile.value).toBe("No repos");
  });
});

describe("worktree hint", () => {
  test("switches with the toggle", () => {
    expect(deriveView(state({}, { worktree: true }), NOW).worktreeHint).toBe("Branches off main, fast-forwarded first");
    expect(deriveView(state({}, { worktree: false }), NOW).worktreeHint).toBe("Runs in the repo as it stands");
  });
});

describe("failureBody", () => {
  test("only claude_died describes a window that opened", () => {
    expect(failureBody("claude_died", "seance", "MacBook Pro")).toContain("The window opened");
    expect(failureBody("launch_error", "seance", "MacBook Pro")).toContain("couldn't open a window");
  });

  test("names the repo and machine where that is the actionable part", () => {
    expect(failureBody("repo_not_found", "seance", "Mac Studio")).toBe(
      "seance isn't on Mac Studio anymore. Rescan its repos and try again.",
    );
  });

  // The design's copy claimed a worktree was left behind; claude creates it, so a
  // claude that never started created nothing.
  test("never claims a worktree was left behind", () => {
    const codes = [
      "claude_died",
      "launch_error",
      "repo_not_found",
      "fetch_failed",
      "timeout",
      "no_default_branch",
      "internal_error",
    ] as const;
    for (const code of codes) {
      expect(failureBody(code, "seance", "MacBook Pro")).not.toContain("worktree");
    }
  });
});
