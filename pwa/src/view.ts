import {
  accountNameIn,
  CAPABILITIES,
  endedBySignal,
  knownAccounts,
  lastHeardAt,
  sentence,
  taskFailureText,
  type TaskUntil,
} from "@seance/shared";
import type { BatchStrategy, KnownAccount, Machine, RelayState } from "@seance/shared";
import {
  EFFORT_LABELS,
  MODEL_LABELS,
  type AccountsState,
  type HistoryView,
  type PersistedForm,
  type PreviewState,
  type QueueState,
  type RescanState,
  type SessionsView,
  type SheetKind,
  type TaskAction,
  type Verdict,
} from "./state.ts";
import { needsAttention } from "./decision-view.ts";

/**
 * Everything the screen renders, derived in one pure pass. Components stay dumb
 * so the six button states, three registry banners and "sessions unknown" logic
 * are unit-testable without a DOM.
 */

export type Tone = "fg2" | "err";

export type ConnectionState = "connected" | "connecting" | "offline";

/** A status dot: green online, blue for `auto`, grey otherwise — on the tile and its sheet row alike. */
export type Dot = "ok" | "off" | "auto";

export interface Tile {
  readonly label: string;
  readonly value: string;
  readonly mono: boolean;
  readonly dot: Dot | null;
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
  /** True while a spawn is in flight; drives the busy shimmer. */
  readonly busy: boolean;
}

/** Queuing's availability: needs an open relay, and says when a task will wait for a scheduler. */
export interface AutoAvailability {
  readonly available: boolean;
  /** Why it is unavailable; null while available. */
  readonly reason: string | null;
  /** Available but not leaderless-proof: the task waits in the relay's queue until a scheduler leads. */
  readonly note: string | null;
}

/** A repo by origin, labelled by its path on the host. */
export interface AutoRepo {
  readonly origin: string;
  readonly label: string;
}

/** One row of the Machine sheet. */
export interface MachineChoice {
  readonly machine: Machine;
  readonly sub: string;
  readonly disabled: boolean;
  readonly selected: boolean;
  /** Rescan is offered on connected rows only: an offline machine can't answer it. */
  readonly canRescan: boolean;
  /** One rescan runs at a time, so every row's action is off while any is scanning. */
  readonly rescanDisabled: boolean;
  /** Set only on the row of the machine being rescanned, or whose rescan failed. */
  readonly rescan: "scanning" | "failed" | null;
}

/** One row of the Account sheet: an account some exclave reports signed in. */
export interface AccountChoice {
  readonly accountId: string;
  readonly label: string;
  readonly sub: string;
  readonly disabled: boolean;
  readonly selected: boolean;
  /** Green while some machine signed in to it is connected, grey when only asleep ones are. */
  readonly dot: Dot;
}

/** Why the form's pins can't be queued, as the button's label and the sentence under it. */
export interface PinProblem {
  readonly label: string;
  readonly text: string;
}

export interface ViewModel {
  readonly meta: string;
  /** "connecting" is the settle window: not known yet, rather than known bad. */
  readonly relayState: ConnectionState;
  /** Bare connection state for the settings screen; meta carries the machine counts. */
  readonly relayLine: string;
  readonly banner: Banner | null;
  readonly machineTile: Tile;
  readonly accountTile: Tile;
  readonly repoTile: Tile;
  readonly modelTile: Tile;
  readonly effortTile: Tile;
  /** The authoring tiles: the tasks this one waits on, and the batch it joins. */
  readonly afterTile: Tile;
  readonly batchTile: Tile;
  /** The verified leader takes `until: "reported"` and `after: "done"` (DESIGN.md, capabilities). */
  readonly reportedAvailable: boolean;
  readonly worktreeHint: string;
  readonly footerStatus: string;
  readonly button: PrimaryButton;
  readonly ignoredNote: string | null;
  /** The pinned machine; null on auto, or when the pin names one the registry no longer lists. */
  readonly machine: Machine | null;
  /** The pinned accountId; null on auto. Set even when no machine reports it. */
  readonly account: string | null;
  /** The repo the task would run, by origin; null when nothing in scope has one. */
  readonly repo: AutoRepo | null;
  /** Every repo in scope of the pins. */
  readonly repos: readonly AutoRepo[];
  readonly autoAvailability: AutoAvailability;
  readonly machineChoices: readonly MachineChoice[];
  readonly accountChoices: readonly AccountChoice[];
  /** The preview asks a leader to route the form, which drops a pin: it is shown with both pickers on auto only. */
  readonly previewShown: boolean;
  /** A task escalated for input is waiting: the phone's header menu says so. */
  readonly queueAttention: boolean;
}

export interface AppState {
  readonly relay: RelayState;
  readonly form: PersistedForm;
  /**
   * Text a CLEAR took away, offered back for six seconds. Deliberately outside
   * `form`: a draft you already discarded shouldn't survive a reload.
   */
  readonly promptUndo: string | null;
  readonly sheet: SheetKind | null;
  /** The settings screen, a layer like the sheets so back leaves it instead of the app. */
  readonly settings: boolean;
  /** The machines screen, opened from settings and stacked over it. */
  readonly machines: boolean;
  /** The machines screen's open chart; cleared with the screen. */
  readonly history: HistoryView | null;
  readonly spawning: boolean;
  /** The Machine sheet's rescan action; a failure is cleared once its sheet closes. */
  readonly rescan: RescanState;
  readonly verdict: Verdict | null;
  /** The form's `route-preview`; null while either picker is pinned. */
  readonly preview: PreviewState | null;
  /** By deviceId; "unknown" once a fetch failed or timed out. */
  readonly sessions: Readonly<Record<string, SessionsView | "unknown">>;
  /** The Queue screen, a layer like settings. */
  readonly queue: boolean;
  /** Desktop layout: the Queue and Machines screens sit beside the form, so they are always on screen. */
  readonly wide: boolean;
  /** What the screen last read; null until it was opened. */
  readonly queueView: QueueState | null;
  /** The cancel or mark-done in flight, if any. */
  readonly taskAction: TaskAction | null;
  /** The last queue action's refusal or failure, as a sentence; cleared by the next action or refresh. */
  readonly queueNotice: string | null;
  /** A pause or resume in flight. */
  readonly pausing: boolean;
  /** Unreadable records being discarded. */
  readonly discarding: boolean;
  readonly accounts: AccountsState;
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

function sessionCount(state: AppState, deviceId: string): number | null {
  const entry = state.sessions[deviceId];
  if (entry === undefined || entry === "unknown") return null;
  // The list is stored exactly as the reply carried it, and a daemon a version
  // ahead is still inside the PSK boundary — but "no count" is a line the UI
  // already has, and a render that throws is not.
  return Array.isArray(entry.sessions) ? entry.sessions.length : null;
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

  const connected = relay.machines.filter((machine) => machine.connected);
  const asleep = relay.machines.length - connected.length;
  const counted = relay.machines
    .map((machine) => sessionCount(state, machine.deviceId))
    .filter((count): count is number => count !== null);
  const total = counted.reduce((sum, count) => sum + count, 0);
  // "3+": a connected machine that hasn't answered makes the total a floor, not a fact.
  const partial = connected.some((machine) => sessionCount(state, machine.deviceId) === null);
  const noun = total === 1 && !partial ? "session" : "sessions";
  return `${connected.length} online · ${asleep} asleep · ${total}${partial ? "+" : ""} ${noun}`;
}

/**
 * `auto` needs only an open relay socket: the app writes the task to the
 * relay's store, which answers for itself, and whichever scheduler leads next
 * reads it. With no leader — or one that has not shown this app it holds the
 * PSK (the relay nominates only ids on `SCHEDULER_LEADERS`, so it is a listed
 * seed running without it, most likely) — it still queues, and `note` says it
 * waits. The preview is different: it asks a leader, so it keeps its own check.
 */
export function deriveAutoAvailability(relay: RelayState): AutoAvailability {
  if (relay.status !== "open") return { available: false, reason: "Not connected to the relay", note: null };
  if (relay.scheduler.kind === "none") {
    return {
      available: true,
      reason: null,
      note: "No scheduler is leading right now — it waits in the queue until one does",
    };
  }
  if (relay.scheduler.kind === "unverified") {
    return {
      available: true,
      reason: null,
      note: "Leader unverified — it hasn't shown it holds this key. It waits in the queue until one does",
    };
  }
  return { available: true, reason: null, note: null };
}

/**
 * `until: "reported"` and a `done` edge are written only to a leader that
 * advertises `reportedDone`: an older one would strip the first and hold the
 * second unreadable. Needs the verified leader's own entry, so no leader (or an
 * unverified one) says no — unlike `auto`, which queues and waits.
 */
export function deriveReportedAvailability(relay: RelayState): boolean {
  const { scheduler } = relay;
  if (relay.status !== "open" || scheduler.kind !== "ready") return false;
  const leader = relay.machines.find((m) => m.deviceId === scheduler.deviceId);
  return leader?.capabilities?.includes(CAPABILITIES.reportedDone) === true;
}

export function describeStrategy(strategy: BatchStrategy): string {
  return strategy.mode === "sequential"
    ? "one at a time"
    : strategy.mode === "parallel"
      ? `up to ${strategy.max} at once`
      : "no limit";
}

function afterValue(after: PersistedForm["after"]): string {
  const [only] = after;
  if (only === undefined) return "None";
  return after.length === 1 ? `1 task · ${only.after}` : `${after.length} tasks`;
}

/** `host/path` → `path`: the host says nothing a person picks a repo by. A remote-less origin is its basename already. */
export function originLabel(origin: string): string {
  const slash = origin.indexOf("/");
  return slash === -1 ? origin : origin.slice(slash + 1);
}

type Pins = Pick<PersistedForm, "machine" | "account">;

/**
 * Every repo the task could run, by origin, once each: the clones of every
 * machine, narrowed to the pinned machine, and to the exclaves of the pinned
 * account. Strict, as `inAccount` in `daemon/src/auto.ts` is: a clone from a
 * daemon predating exclaves is in no account.
 */
export function scopedRepos(machines: readonly Machine[], pins: Pins): readonly AutoRepo[] {
  const origins = new Set<string>();
  for (const machine of machines) {
    if (pins.machine !== null && machine.deviceId !== pins.machine) continue;
    const homes =
      pins.account === null
        ? null
        : new Set((machine.exclaves ?? []).filter((x) => x.accountId === pins.account).map((x) => x.id));
    for (const repo of machine.repos) {
      if (repo.origin === undefined) continue;
      if (homes !== null && (repo.exclave === undefined || !homes.has(repo.exclave))) continue;
      origins.add(repo.origin);
    }
  }
  return [...origins]
    .map((origin) => ({ origin, label: originLabel(origin) }))
    .toSorted((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** `route-preview` drops a pin (`parseTaskRequest`), so a pinned form would be previewed as an unpinned one: it is not asked. */
export function previewAsked(form: Pins): boolean {
  return form.machine === null && form.account === null;
}

/** The remembered origin, else the first of those in scope. */
export function resolveRepo(repos: readonly AutoRepo[], form: PersistedForm): AutoRepo | null {
  return repos.find((repo) => repo.origin === form.repo) ?? repos[0] ?? null;
}

/**
 * `pin.account` is written only to a verified leader that advertises
 * `pinAccount`: an older one would drop it from the spec, or hold the task
 * unreadable. With no verified leader it can't be confirmed either, so nothing
 * is written — unlike a plain task, which waits in the store.
 */
export function derivePinAccountAvailability(relay: RelayState): "available" | "unsupported" | "no-leader" {
  const { scheduler } = relay;
  if (relay.status !== "open" || scheduler.kind !== "ready") return "no-leader";
  const leader = relay.machines.find((m) => m.deviceId === scheduler.deviceId);
  return leader?.capabilities?.includes(CAPABILITIES.pinAccount) === true ? "available" : "unsupported";
}

const collator = new Intl.Collator();

function aliasOf(aliases: Readonly<Record<string, string>>, accountId: string): string | undefined {
  return Object.hasOwn(aliases, accountId) ? aliases[accountId] : undefined;
}

/** The accounts some exclave reports signed in, plus the form's own pin: one that no machine reports still gets a label. */
function formAccounts(machines: readonly Machine[], form: PersistedForm): KnownAccount[] {
  return knownAccounts(machines, form.account === null ? [] : [form.account]);
}

function hasAccount(machine: Machine, accountId: string): boolean {
  return (machine.exclaves ?? []).some((x) => x.accountId === accountId);
}

/**
 * Why the form's pins can't be queued, mirroring `resolvePlacement` in
 * `daemon/src/auto.ts`: neither picker resets the other, so a pair that no
 * longer fits (the registry changed under a persisted pin) is refused here.
 * One resolver for the button and `Store.spawn`.
 */
export function derivePinProblem(
  relay: RelayState,
  form: PersistedForm,
  aliases: Readonly<Record<string, string>>,
): PinProblem | null {
  const machine = form.machine === null ? undefined : relay.machines.find((m) => m.deviceId === form.machine);
  const { account } = form;
  if (account !== null) {
    const known = formAccounts(relay.machines, form);
    const name = accountNameIn(known, account, aliasOf(aliases, account));
    if (!relay.machines.some((m) => hasAccount(m, account))) {
      return { label: "Account not signed in", text: `${name} isn't signed in on any machine` };
    }
    const gate = derivePinAccountAvailability(relay);
    if (gate === "unsupported") {
      return {
        label: "Can't pin an account",
        text: "The scheduler's leader can't pin an account yet — update seanced on its machine",
      };
    }
    if (gate === "no-leader") {
      return {
        label: "Can't pin an account",
        text: "No verified scheduler is leading, so an account pin can't be confirmed; try again once one leads",
      };
    }
    if (machine !== undefined && !hasAccount(machine, account)) {
      return { label: "Account not on that machine", text: `${name} isn't signed in on ${machine.name}` };
    }
  }
  if (machine !== undefined && (machine.exclaves ?? []).length === 0) {
    return {
      label: "Machine needs an update",
      text: `${machine.name} reports no exclaves, so the scheduler can't place there — its daemon needs an update`,
    };
  }
  return null;
}

function deriveMachineChoices(state: AppState, now: number): readonly MachineChoice[] {
  const { relay, form, rescan } = state;
  const known = formAccounts(relay.machines, form);
  return relay.machines
    .toSorted((a, b) => collator.compare(a.name, b.name))
    .map((machine) => {
      const base = machine.connected
        ? `online · ${machine.repos.length} ${machine.repos.length === 1 ? "repo" : "repos"} · last scanned ${formatSeen(machine.scannedAt, now)}`
        : `offline · last seen ${formatSeen(lastHeardAt(machine), now)}`;
      let disabled = false;
      let sub = base;
      if ((machine.exclaves ?? []).length === 0) {
        disabled = true;
        sub = "its daemon needs an update";
      } else if (form.account !== null && !hasAccount(machine, form.account)) {
        disabled = true;
        sub = `${accountNameIn(known, form.account, aliasOf(state.accounts.aliases, form.account))} isn't signed in here`;
      }
      const here = rescan.kind !== "idle" && rescan.deviceId === machine.deviceId ? rescan.kind : null;
      if (here === "scanning") sub = "scanning…";
      if (here === "failed") sub = "couldn't rescan — last known list";
      return {
        machine,
        sub,
        disabled,
        selected: machine.deviceId === form.machine,
        canRescan: machine.connected,
        rescanDisabled: rescan.kind === "scanning",
        rescan: here,
      };
    });
}

function deriveAccountChoices(state: AppState): readonly AccountChoice[] {
  const { relay, form } = state;
  const known = formAccounts(relay.machines, form);
  const pinned = form.machine === null ? undefined : relay.machines.find((m) => m.deviceId === form.machine);
  return known
    .filter(({ accountId }) => relay.machines.some((m) => hasAccount(m, accountId)))
    .map(({ accountId }): AccountChoice => {
      const label = accountNameIn(known, accountId, aliasOf(state.accounts.aliases, accountId));
      const where = relay.machines.filter((m) => hasAccount(m, accountId)).map((m) => m.name);
      const away = pinned !== undefined && !hasAccount(pinned, accountId);
      return {
        accountId,
        label,
        sub: away ? `not signed in on ${pinned.name}` : `on ${where.join(", ")}`,
        disabled: away,
        selected: accountId === form.account,
        dot: relay.machines.some((m) => m.connected && hasAccount(m, accountId)) ? "ok" : "off",
      };
    })
    .toSorted((a, b) => collator.compare(a.label, b.label));
}

function deriveBanner(state: AppState): Banner | null {
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
    // Entries exist but none show. A fresh install, a wrong PSK and version skew
    // look identical unless they are split apart here — and only the key case
    // should send anyone to rotate a credential.
    if (relay.ignored > 0) {
      return {
        title: "Key mismatch",
        body: `${relay.ignored} ${relay.ignored === 1 ? "machine is" : "machines are"} registered, but none decrypt with this key. Check the pre-shared key.`,
        tone: "err",
        opensSettings: true,
      };
    }
    if (relay.unbound > 0) {
      return {
        title: "Registry tampered",
        body: `${relay.unbound} ${relay.unbound === 1 ? "entry is" : "entries are"} filed under a machine ${relay.unbound === 1 ? "it does" : "they do"} not belong to. Only the relay's bearer token can do that — rotate it.`,
        tone: "err",
        opensSettings: false,
      };
    }
    if (relay.skewed > 0) {
      return {
        title: "Version mismatch",
        body: `${relay.skewed} ${relay.skewed === 1 ? "machine is" : "machines are"} registered, but this app can't read what ${relay.skewed === 1 ? "it" : "they"} sent. Update seanced and the app to matching versions.`,
        tone: "err",
        opensSettings: false,
      };
    }
    // Not a steady state: entries the app has not finished decrypting land here
    // for a frame. Anything that stays is neither a key nor a version problem, so
    // it names what is true and sends nobody anywhere.
    return {
      title: "No machines listed",
      body: "The relay holds machines, but none can be shown right now.",
      tone: "fg2",
      opensSettings: false,
    };
  }
  return null;
}

/** An offline pin is not a block: the task waits for the machine, as `resolvePlacement` notes. */
function deriveFooterStatus(state: AppState, machine: Machine | null, problem: PinProblem | null): string {
  const { reason, note } = deriveAutoAvailability(state.relay);
  if (reason !== null) return reason;
  if (problem !== null) return problem.text;
  // The tile says "Unknown machine" here, so the footer must not claim the scheduler picks.
  if (state.form.machine !== null && machine === null) return "The pinned machine isn't listed";
  if (machine !== null && !machine.connected) return `${machine.name} is offline — the task waits for it`;
  if (note !== null) return note;
  return machine === null ? "The scheduler picks the machine" : `Pinned to ${machine.name}`;
}

const blocked = (label: string): PrimaryButton => ({ label, enabled: false, busy: false });

function deriveButton(
  state: AppState,
  machine: Machine | null,
  repo: AutoRepo | null,
  problem: PinProblem | null,
): PrimaryButton {
  const { relay } = state;

  if (relay.rejection !== null) return blocked("Bearer token rejected");
  if (relay.status !== "open") return blocked(relay.settling ? "Connecting…" : "Waiting for the relay");
  if (relay.registrySize === 0) return blocked("No machines registered");
  if (relay.machines.length === 0) {
    if (relay.ignored > 0) return blocked("Check your key");
    if (relay.unbound > 0) return blocked("Registry tampered");
    return blocked(relay.skewed > 0 ? "Version mismatch" : "No machines listed");
  }
  if (state.spawning) return { label: "Queuing…", enabled: false, busy: true };
  if (!deriveAutoAvailability(relay).available) return blocked("Queuing is unavailable");
  if (problem !== null) return blocked(problem.label);
  if (repo === null) return blocked("No repo to run");
  return { label: machine === null ? "Queue" : `Queue on ${machine.name}`, enabled: true, busy: false };
}

/**
 * Shown only beside a list that still has machines — the empty-list cases get a
 * banner instead. Key, pairing and version trouble stay separate lines: they
 * have different fixes, and "key mismatch" over either of the others sends
 * someone to rotate a credential that is correct.
 */
function deriveIgnoredNote(relay: RelayState): string | null {
  if (relay.machines.length === 0) return null;
  const notes: string[] = [];
  if (relay.ignored > 0)
    notes.push(`${relay.ignored} ${relay.ignored === 1 ? "entry" : "entries"} ignored (key mismatch)`);
  if (relay.unbound > 0)
    notes.push(`${relay.unbound} ${relay.unbound === 1 ? "entry" : "entries"} dropped (filed under the wrong machine)`);
  if (relay.skewed > 0)
    notes.push(`${relay.skewed} ${relay.skewed === 1 ? "entry" : "entries"} unreadable (version mismatch)`);
  return notes.length === 0 ? null : notes.join(" · ");
}

export function deriveView(state: AppState, now: number): ViewModel {
  const { relay, form } = state;
  const { account } = form;
  const machine = form.machine === null ? null : (relay.machines.find((m) => m.deviceId === form.machine) ?? null);
  const repos = scopedRepos(relay.machines, form);
  const repo = resolveRepo(repos, form);
  const problem = derivePinProblem(relay, form, state.accounts.aliases);
  const availability = deriveAutoAvailability(relay);
  const known = formAccounts(relay.machines, form);
  const signedIn = account !== null && relay.machines.some((m) => hasAccount(m, account));

  return {
    meta: deriveMeta(state),
    relayState: relay.status === "open" ? "connected" : relay.settling ? "connecting" : "offline",
    relayLine: deriveRelayLine(relay),
    banner: deriveBanner(state),
    machineTile:
      form.machine === null
        ? { label: "MACHINE", value: "Auto", mono: false, dot: availability.available ? "auto" : "off" }
        : {
            label: "MACHINE",
            value: machine?.name ?? "Unknown machine",
            mono: false,
            dot: machine?.connected === true ? "ok" : "off",
          },
    accountTile:
      account === null
        ? { label: "ACCOUNT", value: "Auto", mono: false, dot: availability.available ? "auto" : "off" }
        : {
            label: "ACCOUNT",
            value: `${accountNameIn(known, account, aliasOf(state.accounts.aliases, account))}${signedIn ? "" : " · signed in nowhere"}`,
            mono: false,
            dot: signedIn ? "ok" : "off",
          },
    repoTile: { label: "REPOSITORY", value: repo?.label ?? "No repos", mono: true, dot: null },
    modelTile: {
      label: "MODEL",
      value: MODEL_LABELS[form.model],
      mono: false,
      dot: null,
    },
    effortTile: {
      label: "EFFORT",
      value: EFFORT_LABELS[form.effort],
      mono: false,
      dot: null,
    },
    afterTile: { label: "AFTER", value: afterValue(form.after), mono: false, dot: null },
    batchTile: {
      label: "BATCH",
      value: form.batch === null ? "Off" : `#${form.batch.next} · ${describeStrategy(form.batch.strategy)}`,
      mono: false,
      dot: null,
    },
    reportedAvailable: deriveReportedAvailability(relay),
    worktreeHint: form.worktree ? "Branches off the default branch on origin" : "Runs in the repo as it stands",
    footerStatus: deriveFooterStatus(state, machine, problem),
    button: deriveButton(state, machine, repo, problem),
    ignoredNote: deriveIgnoredNote(relay),
    machine,
    account,
    repo,
    repos,
    autoAvailability: availability,
    machineChoices: deriveMachineChoices(state, now),
    accountChoices: deriveAccountChoices(state),
    previewShown: previewAsked(form),
    queueAttention: state.queueView?.kind === "ok" && needsAttention(state.queueView.tasks, state.relay.machines),
  };
}

/**
 * What follows the scheduler's own line for a failure it set (`taskFailureText`)
 * where "Nothing is running" would be wrong or not enough: the step to take.
 */
const FAILED_NEXT_STEP: ReadonlyMap<string, string> = new Map([
  ["dispatch_unconfirmed", "Check that machine before starting another."],
  ["lost_expired", "End it on that machine once it is back."],
  [
    "merge_expired",
    "Tasks waiting on it failed with it. If it did merge, submit the tasks that waited on it again. Its session had already ended.",
  ],
]);

/** A killed process writes nothing at the end, so its transcript has no reason to give. */
function sessionFailedNextStep(exit: number | undefined): string {
  const transcript = endedBySignal(exit)
    ? "Its transcript on that machine stops where it ended."
    : "Its transcript on that machine says why.";
  return `Tasks waiting on it failed with it. ${transcript}`;
}

export function failedBody(code: string | undefined, exit?: number, until?: TaskUntil, oomKill?: boolean): string {
  // A code the scheduler set itself says why; any other is a daemon's spawn refusal.
  const scheduler = code === undefined ? null : taskFailureText(code, exit, until, oomKill);
  if (code === undefined || scheduler === null) return "The machine refused the spawn. Nothing is running.";
  const next = code === "session_failed" ? sessionFailedNextStep(exit) : FAILED_NEXT_STEP.get(code);
  return `${sentence(scheduler)} ${next ?? "Nothing is running."}`;
}
