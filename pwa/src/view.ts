import type { RepoEntry, SpawnErrorCode } from "@seance/shared";
import type { Machine, RelayState } from "./relay/client.ts";
import {
  EFFORT_LABELS,
  MODEL_LABELS,
  type PersistedForm,
  type SessionsView,
  type SheetKind,
  type Verdict,
} from "./state.ts";

/**
 * Everything the screen renders, derived in one pure pass. Components stay dumb
 * so the six button states, three registry banners and "sessions unknown" logic
 * are unit-testable without a DOM.
 */

export type Tone = "fg2" | "err";

export type ConnectionState = "connected" | "connecting" | "offline";

export interface Tile {
  readonly label: string;
  readonly value: string;
  readonly mono: boolean;
  readonly dot: "ok" | "off" | null;
}

export interface Banner {
  readonly title: string;
  readonly body: string;
  readonly tone: Tone;
  /** Tapping opens settings; only true when re-entering credentials is the fix. */
  readonly opensSettings: boolean;
}

export interface PrimaryButton {
  readonly label: string;
  readonly enabled: boolean;
}

export interface ViewModel {
  readonly meta: string;
  /** "connecting" is the settle window: not known yet, rather than known bad. */
  readonly relayState: ConnectionState;
  /** Bare connection state for the settings screen; meta carries the machine counts. */
  readonly relayLine: string;
  readonly banner: Banner | null;
  readonly machineTile: Tile;
  readonly repoTile: Tile;
  readonly modelTile: Tile;
  readonly effortTile: Tile;
  readonly worktreeHint: string;
  readonly footerStatus: string;
  readonly button: PrimaryButton;
  readonly ignoredNote: string | null;
  readonly machine: Machine | null;
  readonly repo: RepoEntry | null;
}

export interface AppState {
  readonly relay: RelayState;
  readonly form: PersistedForm;
  readonly sheet: SheetKind | null;
  /** The settings screen, a layer like the sheets so back leaves it instead of the app. */
  readonly settings: boolean;
  readonly spawning: boolean;
  readonly verdict: Verdict | null;
  /** By deviceId; "unknown" once a fetch failed or timed out. */
  readonly sessions: Readonly<Record<string, SessionsView | "unknown">>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact and deliberately coarse: "3d ago" reads faster than a timestamp on a
 * phone. Carries its own "ago" so callers can't pair it with "just now".
 */
export function formatSeen(lastSeen: number, now: number): string {
  const elapsed = Math.max(0, now - lastSeen);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  return `${Math.floor(elapsed / DAY)}d ago`;
}

function segments(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

/**
 * Repo paths are absolute and ellipsise to nothing at 13px in a half-width
 * tile, and the tail is the informative end. Trims the directory prefix the
 * machine's repos share, which recovers the configured repo root without
 * needing it on the wire. With one repo there is no prefix to find, so keep the
 * last two segments.
 */
export function abbreviatePath(path: string, siblings: readonly string[]): string {
  const own = segments(path);
  if (own.length <= 1) return path;
  const others = siblings.filter((candidate) => candidate !== path).map(segments);
  if (others.length === 0) return own.slice(-2).join("/");

  let shared = 0;
  // Never consume the final segment: the repo's own directory name always shows.
  while (shared < own.length - 1 && others.every((other) => other[shared] === own[shared])) {
    shared += 1;
  }
  return own.slice(shared).join("/");
}

/**
 * The designed failure body describes a dead pane, which is wrong for codes
 * where no window ever opened. Its worktree clause is dropped as well: the
 * daemon passes --worktree to claude, so a claude that died on a bad flag
 * created nothing to leave behind.
 */
export function failureBody(code: SpawnErrorCode, repo: string, machine: string): string {
  switch (code) {
    case "claude_died":
      return "The window opened, but claude exited before the session started. Nothing is running.";
    case "launch_error":
      return "The daemon couldn't open a window for the session. Nothing is running.";
    case "repo_not_found":
      return `${repo} isn't on ${machine} anymore. Rescan its repos and try again.`;
    case "fetch_failed":
    case "timeout":
      return "Couldn't reach the git remote in time. Nothing is running.";
    case "no_default_branch":
      return `Couldn't work out ${repo}'s default branch, so there was nothing to branch from.`;
    case "internal_error":
      return "The daemon hit an error before the session started.";
  }
}

function offlineBody(machine: Machine): string {
  return machine.platform === "darwin"
    ? "Séance only holds a Mac awake while it is plugged in. Plug it in, or pick a machine that is online."
    : "No socket to the relay. Wake the machine, or check its keepalive task.";
}

function sessionCount(state: AppState, deviceId: string): number | null {
  const entry = state.sessions[deviceId];
  if (entry === undefined || entry === "unknown") return null;
  return entry.sessions.length;
}

/** The settings screen's status line: connection only, no machine counts. */
function deriveRelayLine(relay: RelayState): string {
  if (relay.rejection === "unauthorized") return "bearer token rejected";
  if (relay.rejection === "bad-request") return "no bearer token";
  if (relay.status === "open") return "connected";
  return relay.settling ? "connecting…" : "relay unreachable · retrying";
}

function deriveMeta(state: AppState): string {
  const { relay } = state;
  if (relay.rejection === "unauthorized") return "bearer token rejected";
  if (relay.rejection === "bad-request") return "no bearer token";
  if (relay.status !== "open") return relay.settling ? "connecting…" : "relay unreachable · retrying";

  const online = relay.machines.filter((machine) => machine.connected).length;
  const asleep = relay.machines.length - online;
  const counted = relay.machines
    .map((machine) => sessionCount(state, machine.deviceId))
    .filter((count): count is number => count !== null);
  const total = counted.reduce((sum, count) => sum + count, 0);
  return `${online} online · ${asleep} asleep · ${total} ${total === 1 ? "session" : "sessions"}`;
}

function deriveBanner(state: AppState, machine: Machine | null): Banner | null {
  const { relay } = state;
  if (relay.rejection !== null) {
    return {
      title: relay.rejection === "unauthorized" ? "Bearer token rejected" : "No bearer token",
      body: "The relay refused this token. Re-enter your credentials to reconnect.",
      tone: "err",
      opensSettings: true,
    };
  }
  if (relay.status !== "open") {
    if (relay.settling) return null;
    return {
      title: "Relay unreachable",
      body: "Nothing can be spawned until a daemon socket is back. Your prompt is kept.",
      tone: "err",
      opensSettings: false,
    };
  }
  if (relay.registrySize === 0) {
    return {
      title: "No machines yet",
      body: "Install seanced on a machine and it will appear here.",
      tone: "fg2",
      opensSettings: false,
    };
  }
  if (relay.machines.length === 0) {
    // Entries exist but none show. A fresh install, a wrong PSK and a list emptied
    // by hand look identical unless they are split apart here.
    if (relay.ignored > 0) {
      return {
        title: "Key mismatch",
        body: `${relay.ignored} ${relay.ignored === 1 ? "machine is" : "machines are"} registered, but none decrypt with this key. Check the pre-shared key.`,
        tone: "err",
        opensSettings: true,
      };
    }
    return {
      title: "No machines listed",
      body: "Every machine was removed while offline. Each comes back on its own the next time it connects.",
      tone: "fg2",
      opensSettings: false,
    };
  }
  if (machine !== null && !machine.connected) {
    return { title: `${machine.name} is offline`, body: offlineBody(machine), tone: "fg2", opensSettings: false };
  }
  return null;
}

function deriveFooterStatus(state: AppState, machine: Machine | null, now: number): string {
  if (machine === null) return "";
  if (!machine.connected) return `Last seen ${formatSeen(machine.lastSeen, now)} · sessions unknown`;
  const count = sessionCount(state, machine.deviceId);
  if (count === null) return `Checking sessions on ${machine.name}…`;
  if (count === 0) return `Nothing running on ${machine.name} right now`;
  return `${count} claude ${count === 1 ? "session" : "sessions"} already on ${machine.name}`;
}

const blocked = (label: string): PrimaryButton => ({ label, enabled: false });

function deriveButton(state: AppState, machine: Machine | null): PrimaryButton {
  const { relay } = state;

  if (relay.rejection !== null) return blocked("Bearer token rejected");
  if (relay.status !== "open") return blocked(relay.settling ? "Connecting…" : "Waiting for the relay");
  if (relay.registrySize === 0) return blocked("No machines registered");
  if (relay.machines.length === 0) return blocked(relay.ignored > 0 ? "Check your key" : "No machines listed");
  if (state.spawning) return blocked("Summoning…");
  if (machine === null) return blocked("Pick a machine");
  if (!machine.connected) return blocked(`${machine.name} is asleep`);
  return {
    label: state.form.prompt.trim() === "" ? "Start empty session" : "Start with this prompt",
    enabled: true,
  };
}

/** First connected machine, else first listed — the form may hold a machine that has gone. */
export function resolveMachine(relay: RelayState, machineId: string | null): Machine | null {
  const chosen = relay.machines.find((machine) => machine.deviceId === machineId);
  if (chosen !== undefined) return chosen;
  return relay.machines.find((machine) => machine.connected) ?? relay.machines[0] ?? null;
}

/** The machine's remembered repo, else its first — the form may name one that has gone. */
export function resolveRepo(machine: Machine | null, form: PersistedForm): RepoEntry | null {
  if (machine === null) return null;
  const remembered = form.repos[machine.deviceId];
  return machine.repos.find((repo) => repo.name === remembered) ?? machine.repos[0] ?? null;
}

export function deriveView(state: AppState, now: number): ViewModel {
  const machine = resolveMachine(state.relay, state.form.machineId);
  const repo = resolveRepo(machine, state.form);
  const paths = machine?.repos.map((entry) => entry.path) ?? [];

  return {
    meta: deriveMeta(state),
    relayState: state.relay.status === "open" ? "connected" : state.relay.settling ? "connecting" : "offline",
    relayLine: deriveRelayLine(state.relay),
    banner: deriveBanner(state, machine),
    machineTile: {
      label: "MACHINE",
      value: machine?.name ?? "No machines",
      mono: false,
      dot: machine === null ? null : machine.connected ? "ok" : "off",
    },
    repoTile: {
      label: "REPOSITORY",
      value: repo === null ? "No repos" : abbreviatePath(repo.path, paths),
      mono: true,
      dot: null,
    },
    modelTile: {
      label: "MODEL",
      value: MODEL_LABELS[state.form.model],
      mono: false,
      dot: null,
    },
    effortTile: {
      label: "EFFORT",
      value: EFFORT_LABELS[state.form.effort],
      mono: false,
      dot: null,
    },
    worktreeHint: state.form.worktree ? "Branches off main, fast-forwarded first" : "Runs in the repo as it stands",
    footerStatus: deriveFooterStatus(state, machine, now),
    button: deriveButton(state, machine),
    ignoredNote:
      state.relay.ignored > 0 && state.relay.machines.length > 0
        ? `${state.relay.ignored} ${state.relay.ignored === 1 ? "entry" : "entries"} ignored (key mismatch)`
        : null,
    machine,
    repo,
  };
}
