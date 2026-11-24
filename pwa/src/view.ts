import {
  accountNameIn,
  CAPABILITIES,
  closedAt,
  creatorTaskTags,
  endedBySignal,
  fleetTraits,
  formatNotBefore,
  knownAccounts,
  lastHeardAt,
  originLabel,
  refTags,
  sentence,
  TASK_SPEC_LIMITS,
  taskFailureText,
  type TaskUntil,
} from "@seance/shared";
import type {
  ArchiveStatusResponse,
  AutonomyLevel,
  Capability,
  KnownAccount,
  Machine,
  RelayState,
  Task,
} from "@seance/shared";
import {
  AGENT_LABELS,
  AUTONOMY_LABELS,
  EFFORT_LABELS,
  modelLabel,
  modelPickOf,
  HELD_MAX,
  worktreeFor,
  type AccountsState,
  type HeldTask,
  type HistoryView,
  type LabellingState,
  type OlderState,
  type PersistedForm,
  type PreviewState,
  type RefDraft,
  type QueueState,
  type AvailabilityState,
  type CustodianControlState,
  type RescanState,
  type SessionsView,
  type SheetKind,
  type NotBeforeChoice,
  resolveNotBeforeChoice,
  type AccountOpenAsk,
  type StartNowRefusal,
  type TaskAction,
  type Verdict,
} from "./state.ts";
import { needsAttention } from "./asleep.ts";
import { formatBytes, typeLabel, type PickedFile } from "./attachments.ts";
import { taskTitle } from "./task-title.ts";
import type { Moment } from "./timed.ts";

/**
 * Everything the screen renders, derived in one pure pass. Components stay dumb
 * so the six button states, three registry banners and "sessions unknown" logic
 * are unit-testable without a DOM.
 */

export type Tone = "fg2" | "err";

export type ConnectionState = "connected" | "connecting" | "offline";

/**
 * A status dot: green online, amber online but closed to scheduled work (the Closed badge's colour), blue for
 * `auto`, a hollow grey ring otherwise — on the tile and its sheet row alike.
 * `unreachable` is the relay's own hollow red, worn while the relay is unreachable: the registry
 * then is the last one heard, so a green dot would claim a presence nobody can see.
 */
export type Dot = "ok" | "closed" | "off" | "auto" | "unreachable";

export interface Tile {
  readonly label: string;
  readonly value: string;
  readonly mono: boolean;
  readonly dot: Dot | null;
  /** A setting kept in the tile's sheet that is on, shown as a small tag; null when off. */
  readonly tag: string | null;
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
  readonly dot: Dot;
}

/** The Repo sheet's rescan button, beside its filter: asks every connected machine at once. */
export interface RepoRescan {
  /** Off while a rescan runs, and with no machine connected to answer one. */
  readonly disabled: boolean;
  readonly scanning: boolean;
  /** Names the machines whose rescan failed; null when none did. */
  readonly failure: string | null;
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

/** One chip: the name and × on its first row, size and upload state on its second. */
export interface AttachmentChip {
  readonly key: string;
  readonly name: string;
  /** The file itself for an `image/*` one, so the chip can preview it; null for the rest. */
  readonly image: Blob | null;
  /** "PNG"; null without an extension. */
  readonly ext: string | null;
  /** "PNG · 14 KB", "14 KB · 45%", "14 KB · waiting", "Failed: token refused". */
  readonly status: string;
  /** 0 to 99 while uploading, for the bar; null otherwise. */
  readonly percent: number | null;
  readonly failed: boolean;
}

/** The form's files: offered only while the verified leader takes them. */
export interface AttachmentsView {
  /** The attach button, paste and drop work. */
  readonly offered: boolean;
  readonly files: readonly AttachmentChip[];
  /** "3 files · 4.2 MB"; null with none. */
  readonly summary: string | null;
  /** Why files were not attached, or why attached ones can't go; cleared by the next pick. */
  readonly notice: string | null;
  /** Adding is off from the Queue press on: the list is what is being sent. */
  readonly addLocked: boolean;
  /** Remove is off only while the create itself is out; waiting on uploads, a file can still go. */
  readonly removeLocked: boolean;
}

/** One task held on this phone (`HeldTask`), as its row above the tiles. */
export interface HeldRow {
  readonly taskId: string;
  readonly title: string;
  readonly repo: string;
  readonly status: string;
  readonly failed: boolean;
  readonly sending: boolean;
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
  readonly autonomyTile: Tile;
  /** The time before which the task is not placed; "Now" with none. The choice resolves at submit, so this is what it means at this render. */
  readonly notBeforeTile: Tile;
  /** The authoring tile: the tasks this one waits on. */
  readonly afterTile: Tile;
  /** Null while no machine declares a trait and the form requires none: there is nothing to pick. */
  readonly requiresTile: Tile | null;
  readonly requires: RequiresView;
  /** Null while the leader takes no task tags and the form carries no ref: there is nothing to enter. */
  readonly refTile: Tile | null;
  readonly ref: RefView;
  /**
   * The verified leader takes `until: "reported"` and `after: "done"` (DESIGN.md, capabilities),
   * or no relay can say: a held task is checked when it is sent.
   */
  readonly reportedAvailable: boolean;
  /** Tasks kept on this phone until the relay takes them, oldest first. */
  readonly held: readonly HeldRow[];
  /** Held tasks dropped for age, as one line naming them; null when none or dismissed. */
  readonly heldDropped: string | null;
  /** The Fresh worktree toggle as it stands for the repo the form resolves to. */
  readonly worktree: boolean;
  readonly worktreeHint: string;
  /** The line under the "Settle this task on its done report" switch. */
  readonly reportedHint: string;
  /** The line under the prompt card; null when there is nothing to say. */
  readonly formStatus: string | null;
  readonly button: PrimaryButton;
  /** The button's chevron and its Start now menu: only while the verified leader answers `run-now`. */
  readonly startNow: boolean;
  /** Start now lifts a whole-queue pause too (`runNowPaused`). */
  readonly startNowPastPause: boolean;
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
  /** The Auto tile's and row's dot, both pickers'. */
  readonly autoDot: Dot;
  readonly machineChoices: readonly MachineChoice[];
  readonly repoRescan: RepoRescan;
  readonly accountChoices: readonly AccountChoice[];
  /** The preview asks a leader to route the form, which drops a pin: it is shown with both pickers on auto only. */
  readonly previewShown: boolean;
  /** A task escalated for input is waiting: the phone's header menu says so. */
  readonly queueAttention: boolean;
  readonly attachments: AttachmentsView;
}

export interface AppState {
  readonly relay: RelayState;
  readonly form: PersistedForm;
  /**
   * The next task's autonomy level. Not in `form`, so never persisted: every load and every
   * queued task starts back at `DEFAULT_AUTONOMY`, and a level picked once can't ride along
   * unnoticed on later tasks.
   */
  readonly autonomy: AutonomyLevel;
  /** The next task's not-before choice; transient as `autonomy` is. */
  readonly notBefore: NotBeforeChoice | null;
  /** The next task's ref (`creator.ref` and its URL); transient as `autonomy` is. */
  readonly ref: RefDraft;
  /** The task whose label dialog is open on the Queue screen, a layer; null when none. */
  readonly labelling: LabellingState | null;
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
  /** The Machines screen's open/close switch. */
  readonly availability: AvailabilityState;
  /** The Machines card's custodian controls. */
  readonly custodian: CustodianControlState;
  readonly verdict: Verdict | null;
  /** Tasks queued while the relay was unreachable, oldest first; persisted (`writeHeld`). */
  readonly held: readonly HeldTask[];
  /** Titles of held tasks dropped past `HELD_MAX_AGE_MS`, until dismissed: a prompt is never lost unsaid. */
  readonly heldDropped: readonly string[];
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
  /**
   * A row id, a notification's task or a drain row's session (`sessionRowId`): the Work screen scrolls to the row once
   * it is listed, then clears this.
   */
  readonly focusedTask: string | null;
  /** The cancel or mark-done in flight, if any. */
  readonly taskAction: TaskAction | null;
  /** The last queue action's refusal or failure, as a sentence; cleared by the next action or refresh. */
  readonly queueNotice: string | null;
  readonly startNowRefusal: StartNowRefusal | null;
  /** A pause or resume in flight. */
  readonly pausing: boolean;
  /** The Machines screen's account switch: its ask in flight, or its last failure. */
  readonly accountOpen: AccountOpenAsk;
  /** A `set-limits` in flight. */
  readonly limiting: boolean;
  /** Unreadable records being discarded. */
  readonly discarding: boolean;
  readonly accounts: AccountsState;
  /**
   * The archivist's last `archive-status` reply and the device it came from, for the Machines screen's card;
   * null until one lands, and dropped when the seat moves or the archivist is offline.
   */
  readonly archiveStatus: { readonly deviceId: string; readonly reply: ArchiveStatusResponse } | null;
  /** The Queue screen's Older section, read from the archive; closed and empty while no archivist is online. */
  readonly older: OlderState;
  /** Files on the form. Not in `form`: a `File` can't be persisted, and a reload drops them. */
  readonly attachments: readonly PickedFile[];
  /** Why the last pick or paste left files out; cleared by the next pick or a remove. */
  readonly attachNotice: string | null;
  /** A Queue press waiting for the form's uploads before it creates the task. */
  readonly awaitingUploads: boolean;
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

/** `formatSeen` with its instant kept, for a line that shows the timestamp on hover. */
export function seen(at: number, now: number): Moment {
  return { text: formatSeen(at, now), at };
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
/** `relayState`'s `offline`, not a settling re-dial, overrides the dot. */
function presenceDot(relay: RelayState, dot: Dot): Dot {
  return relay.status !== "open" && !relay.settling ? "unreachable" : dot;
}

/** Offline outranks closed: a machine nobody can see has no state worth colouring. */
function machineDot(machine: Machine | null): Dot {
  if (machine?.connected !== true) return "off";
  return closedAt(machine) !== null ? "closed" : "ok";
}

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
 * Whether Queue holds the task on this phone instead of putting it: the socket
 * isn't open, but this document has seen the registry, so the repo and pins
 * still resolve against it. Without one (a cold launch with no relay) there is
 * nothing to pick from, and the button waits as before.
 */
export function canHold(relay: RelayState): boolean {
  return relay.status !== "open" && relay.rejection === null && relay.machines.length > 0;
}

/** Offered while held: the leader's capability is read when the task is sent, not when it is queued. */
export function deriveReportedOffered(relay: RelayState): boolean {
  return deriveReportedAvailability(relay) || canHold(relay);
}

function reportedHint(until: TaskUntil, offered: boolean): string {
  if (!offered && until !== "reported") {
    return "The scheduler's leader doesn't take this yet — update seanced on its machine";
  }
  return until === "reported"
    ? "A merge alone won't settle it. The session is told to report when it is finished; it needs the seance MCP server"
    : "Settles when its PR merges or its session ends";
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

/**
 * A continue task is written only to a verified leader that advertises `continueTask`: an older
 * one fails to parse the record's mode and holds it unreadable. Like `deriveReportedAvailability`,
 * no leader (or an unverified one) says no.
 */
export function deriveContinueAvailability(relay: RelayState): boolean {
  return verifiedLeaderAdvertises(relay, CAPABILITIES.continueTask);
}

/**
 * Continue on an `awaiting-merge` task is offered only to a verified leader that advertises `continueHandoff`:
 * an older one never writes `Task.continuedBy`, so a second Continue would resume a session a continuation
 * already owns.
 */
export function deriveContinueHandoffAvailability(relay: RelayState): boolean {
  return verifiedLeaderAdvertises(relay, CAPABILITIES.continueHandoff);
}

/**
 * Whether the verified leader keeps the limits record and answers `set-limits`. An older one
 * runs its built-in caps and refuses the op as one it does not know, so nothing is offered to it.
 */
export function deriveLimitsAvailability(relay: RelayState): boolean {
  return verifiedLeaderAdvertises(relay, CAPABILITIES.limits);
}

/** Whether the verified leader answers `pass`; an older one refuses it as an op it does not know. */
export function derivePassAvailability(relay: RelayState): boolean {
  return verifiedLeaderAdvertises(relay, CAPABILITIES.successor);
}

/** Whether the verified leader passes a Codex task (`codexPass`): an older one refuses it `successor_unsupported`. */
export function deriveCodexPassAvailability(relay: RelayState): boolean {
  return verifiedLeaderAdvertises(relay, CAPABILITIES.codexPass);
}

/**
 * Whether a close may be sent to `machine`: it answers `availability`, and the verified leader routes
 * around `cl` (an older one fails the task it sends there). A reopen needs only the machine's `close`.
 */
export function deriveCloseAvailability(relay: RelayState, machine: Machine): boolean {
  return (
    machine.capabilities?.includes(CAPABILITIES.close) === true && verifiedLeaderAdvertises(relay, CAPABILITIES.drain)
  );
}

/** What a close asks: `soft` stops new work only, `drain` moves running tasks too, `now` drains without the grace. */
export type CloseKind = "soft" | "drain" | "now";

/**
 * Whether the close sheet's Close is soft (no drain until asked): a close may be sent, and both `machine` and the
 * verified leader advertise `softClose`. An older daemon would drop `soft` and drain; an older leader would pass on
 * `cl` alone. Otherwise the sheet keeps the close and words it as before.
 */
export function canSoftClose(relay: RelayState, machine: Machine): boolean {
  return (
    deriveCloseAvailability(relay, machine) &&
    machine.capabilities?.includes(CAPABILITIES.softClose) === true &&
    verifiedLeaderAdvertises(relay, CAPABILITIES.softClose)
  );
}

/**
 * Whether `machine`'s daemon asks its sessions to pass themselves when closed and honours `now` (`drainAsk`):
 * the close sheet's ask wording and "Drain now" are gated on it, never on `close` or `drain`.
 */
export function canDrainNow(machine: Machine): boolean {
  return machine.capabilities?.includes(CAPABILITIES.drainAsk) === true;
}

/** Whether the verified leader passes a closed machine's tasks (`drainPass`): the Machines screen then shows the drain's progress. */
export function deriveDrainAvailability(relay: RelayState): boolean {
  return verifiedLeaderAdvertises(relay, CAPABILITIES.drainPass);
}

/** Whether the verified leader answers `run-now`; an older one refuses it as an op it does not know. */
export function deriveRunNowAvailability(relay: RelayState): boolean {
  return verifiedLeaderAdvertises(relay, CAPABILITIES.runNow);
}

/** Whether the verified leader's `run-now` places past a whole-queue pause; an older one answers `unplaceable`. */
export function deriveRunNowPastPause(relay: RelayState): boolean {
  return verifiedLeaderAdvertises(relay, CAPABILITIES.runNowPaused);
}

/**
 * A task carrying attachments is written only to a verified leader that advertises
 * `attachments`: an older one holds the record unreadable (the dep sentinel), and
 * the relay may not even have the bucket.
 */
export function deriveAttachmentsAvailability(relay: RelayState): boolean {
  return verifiedLeaderAdvertises(relay, CAPABILITIES.attachments);
}

/**
 * A settled registry with a verified leader that lacks `attachments`: attaching is positively over,
 * unlike a dropped or re-dialing socket, which only means it can't be checked for now.
 */
export function attachmentsWithdrawn(relay: RelayState): boolean {
  return leaderVerified(relay) && relay.registrySettled && !deriveAttachmentsAvailability(relay);
}

/**
 * `requires` is written only to a verified leader that advertises `traits`: an older one would drop it
 * from the spec on its first write (or hold the record unreadable, by the sentinel) and place the task anywhere.
 */
export function deriveTraitsAvailability(relay: RelayState): boolean {
  return verifiedLeaderAdvertises(relay, CAPABILITIES.traits);
}

/**
 * Task tags (`ref`, `label`) are written only to a verified leader that advertises `taskTags`: an older one holds a
 * tagged record unreadable (the dep sentinel) and refuses an `amend` carrying `ownerTags`.
 */
export function deriveTaskTagsAvailability(relay: RelayState): boolean {
  return verifiedLeaderAdvertises(relay, CAPABILITIES.taskTags);
}

/**
 * `agent` is written only to a verified leader that advertises `codex`: an older one holds a Codex record unreadable
 * (the dep sentinel), and one that cannot route it would run nothing (DESIGN.md, Scheduler, "Codex tasks").
 */
export function deriveCodexAvailability(relay: RelayState): boolean {
  return verifiedLeaderAdvertises(relay, CAPABILITIES.codex);
}

/**
 * A Codex task's Continue is offered only under a verified leader advertising `codexContinue`: an older one refuses
 * `continues` beside `agent` and would hold the continuation forever (`agent_unsupported`).
 */
export function deriveCodexContinueAvailability(relay: RelayState): boolean {
  return verifiedLeaderAdvertises(relay, CAPABILITIES.codexContinue);
}

export const CODEX_UNAVAILABLE = "The scheduler's leader doesn't run Codex tasks yet. Update seanced on its machine";

/**
 * Why the form's Codex pick can't be queued as it stands, as the status line says it (no full stop), with the
 * button's short label; null for a Claude pick or one that can. V1's refusals (`codexSpecRefusal`) in the form's own
 * words, then the leader. Held (no relay), the leader is asked when it is sent (`#sendOne`).
 */
export function deriveCodexProblem(
  state: Pick<AppState, "form" | "autonomy" | "attachments" | "relay">,
): { readonly text: string; readonly label: string } | null {
  if (state.form.agent === "claude") return null;
  const name = AGENT_LABELS[state.form.agent];
  if (state.autonomy === "steer") {
    return {
      text: `${name} can't run at ${AUTONOMY_LABELS.steer} autonomy yet. Pick ${AUTONOMY_LABELS.checkpoint} or ${AUTONOMY_LABELS.auto}, or a Claude model`,
      label: `${name} can't ${AUTONOMY_LABELS.steer}`,
    };
  }
  if (state.attachments.length > 0) {
    return {
      text: `${name} tasks can't take files yet. Remove them, or pick a Claude model`,
      label: "Can't attach files",
    };
  }
  if (canHold(state.relay)) return null;
  if (!deriveCodexAvailability(state.relay)) return { text: CODEX_UNAVAILABLE, label: `Can't run ${name}` };
  if (state.autonomy === "checkpoint" && !deriveCodexCheckpointAvailability(state.relay)) {
    return { text: CODEX_CHECKPOINT_UNAVAILABLE, label: `${name} needs ${AUTONOMY_LABELS.auto}` };
  }
  return null;
}

/** A Codex task at `checkpoint` goes only to a verified leader advertising `codexCheckpoint`: an item 8 one places it nowhere. */
export function deriveCodexCheckpointAvailability(relay: RelayState): boolean {
  return verifiedLeaderAdvertises(relay, CAPABILITIES.codexCheckpoint);
}

export const CODEX_CHECKPOINT_UNAVAILABLE = `The scheduler's leader runs Codex only at ${AUTONOMY_LABELS.auto} autonomy. Pick ${AUTONOMY_LABELS.auto}, or update seanced on its machine`;

export const TASK_TAGS_UNAVAILABLE = "The scheduler's leader doesn't take task tags yet. Update seanced on its machine";

export const TRAITS_UNAVAILABLE = "The scheduler's leader can't route on traits yet. Update seanced on its machine";

export const ATTACHMENTS_UNAVAILABLE =
  "The scheduler's leader doesn't take attachments yet. Update seanced on its machine, or remove the files";

/** Files wait on a leader not yet verified (a re-dial) rather than being told it lacks attachments. */
export const ATTACHMENTS_VERIFYING = "Checking that the scheduler's leader takes attachments…";

// Files upload only while a leader verified to take them leads, so a held task carries none.
export const ATTACHMENTS_NOT_HELD = "Files go only while connected. Remove them to keep the task on this phone";

/** A press or retry that outlasted the check: nothing says the leader lacks attachments, only that it isn't verified. */
export const ATTACHMENTS_UNVERIFIED =
  "Couldn't confirm that the scheduler's leader takes attachments. Try again once connected";

export function leaderVerified(relay: RelayState): boolean {
  return relay.status === "open" && relay.scheduler.kind === "ready";
}

/**
 * Why files block the queue: a re-dial still settling is only checking; past it the task would be
 * held, and a held task carries none.
 */
export function attachmentsBlock(relay: RelayState): "unavailable" | "verifying" | "not_held" {
  if (leaderVerified(relay)) return "unavailable";
  return canHold(relay) && !relay.settling ? "not_held" : "verifying";
}

/** Why a task with files can't go now, as a verdict's opening; read only while attaching isn't offered. */
export function attachmentsRefusal(relay: RelayState): string {
  switch (attachmentsBlock(relay)) {
    case "unavailable":
      return ATTACHMENTS_UNAVAILABLE;
    case "not_held":
      return ATTACHMENTS_NOT_HELD;
    case "verifying":
      return ATTACHMENTS_UNVERIFIED;
  }
}

function chipStatus(file: PickedFile, ext: string | null): string {
  const size = formatBytes(file.size);
  switch (file.upload.kind) {
    case "waiting":
      return `${size} · waiting`;
    case "uploading":
      return `${size} · ${file.upload.percent}%`;
    case "failed":
      return `Failed: ${file.upload.short}`;
    case "stored":
      return ext === null ? size : `${ext} · ${size}`;
  }
}

function attachmentChip(file: PickedFile): AttachmentChip {
  const ext = typeLabel(file.name);
  return {
    key: file.key,
    name: file.name,
    image: file.type.startsWith("image/") ? file.file : null,
    ext,
    status: chipStatus(file, ext),
    percent: file.upload.kind === "uploading" ? file.upload.percent : null,
    failed: file.upload.kind === "failed",
  };
}

function deriveAttachments(state: AppState): AttachmentsView {
  const offered = deriveAttachmentsAvailability(state.relay);
  const files = state.attachments;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  return {
    offered,
    files: files.map(attachmentChip),
    summary:
      files.length === 0 ? null : `${files.length} ${files.length === 1 ? "file" : "files"} · ${formatBytes(total)}`,
    notice: state.attachNotice,
    addLocked: state.spawning,
    removeLocked: state.spawning && !state.awaitingUploads,
  };
}

function verifiedLeaderAdvertises(relay: RelayState, capability: Capability): boolean {
  const { scheduler } = relay;
  if (relay.status !== "open" || scheduler.kind !== "ready") return false;
  const leader = relay.machines.find((m) => m.deviceId === scheduler.deviceId);
  return leader?.capabilities?.includes(capability) === true;
}

export interface RequiresChoice {
  readonly name: string;
  /** The machines that declare it, as a line; says so when none does (a name the form kept). */
  readonly holders: string;
  readonly selected: boolean;
  /** Not pickable: the form holds as many as a task may require, or the leader cannot route on traits. */
  readonly disabled: boolean;
}

/** The Ref sheet: why it can't be written yet (a sentence), and whether the leader would take it. */
export interface RefView {
  readonly ref: string;
  readonly url: string;
  /** The entry's problem as a sentence, or the leader's lack; null when it is fine or empty. */
  readonly problem: string | null;
}

export interface RequiresView {
  readonly choices: readonly RequiresChoice[];
  /** Shown beneath the list: why picking is off, or that a task requires at most N. */
  readonly note: string | null;
}

/** Machine names as one clause, capped like a wait reason's. */
export function holdersText(machines: readonly string[]): string {
  if (machines.length === 0) return "no machine declares it";
  const shown = machines.slice(0, 3).join(", ");
  return machines.length > 3 ? `${shown}, +${machines.length - 3} more` : shown;
}

/** What the form requires, then every trait the fleet declares: a kept name no machine declares still shows, to be removed. */
function deriveRequires(state: AppState): RequiresView {
  const { form, relay } = state;
  const fleet = fleetTraits(relay.machines);
  const available = deriveTraitsAvailability(relay);
  const full = form.requires.length >= TASK_SPEC_LIMITS.requires;
  const names = [...form.requires, ...[...fleet.keys()].filter((name) => !form.requires.includes(name))];
  const choices = names.map((name) => {
    const selected = form.requires.includes(name);
    return {
      name,
      holders: holdersText(fleet.get(name) ?? []),
      selected,
      disabled: !selected && (full || !available),
    };
  });
  const note = !available
    ? `${TRAITS_UNAVAILABLE}.`
    : full
      ? `A task requires at most ${TASK_SPEC_LIMITS.requires} traits.`
      : null;
  return { choices, note };
}

/** The ref as the creator tags it would be written, or the sentence saying why not; `{}` for none. */
export function refTagsOf(
  draft: RefDraft,
): { readonly tags: Readonly<Record<string, string>> } | { readonly problem: string } {
  const ref = draft.ref.trim();
  const url = draft.url.trim();
  if (ref === "") {
    return url === "" ? { tags: {} } : { problem: "A URL needs the ref it belongs to" };
  }
  const written = creatorTaskTags(refTags(ref, url === "" ? undefined : url));
  return written.ok
    ? { tags: written.tags }
    : { problem: "The ref is source:id (e.g. linear:ENG-123), and its URL an https: address" };
}

function deriveRef(state: AppState): RefView {
  const { ref, relay } = state;
  const entry = refTagsOf(ref);
  const problem =
    "problem" in entry
      ? entry.problem
      : Object.keys(entry.tags).length > 0 && !deriveTaskTagsAvailability(relay)
        ? `${TASK_TAGS_UNAVAILABLE}.`
        : null;
  return { ref: ref.ref, url: ref.url, problem };
}

function requiresValue(requires: PersistedForm["requires"]): string {
  if (requires.length === 0) return "Any";
  return requires.length <= 2 ? requires.join(", ") : `${requires.length} traits`;
}

function afterValue(after: PersistedForm["after"]): string {
  const [only] = after;
  if (only === undefined) return "None";
  return after.length === 1 ? `1 task · ${only.after}` : `${after.length} tasks`;
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

/**
 * `route-preview` drops a pin (`parseTaskRequest`), so a pinned form would be previewed as an unpinned one: it is not asked.
 * Nor is a form with a not-before time: the preview would say where it would start now, which it will not.
 */
export function previewAsked(form: Pins, notBefore: NotBeforeChoice | null): boolean {
  return form.machine === null && form.account === null && notBefore === null;
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
    // Held: no leader to ask until it is sent, where `#sendOne` checks it.
    if (gate === "no-leader" && !canHold(relay)) {
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
      const here = rescan.kind !== "idle" && rescan.deviceIds.includes(machine.deviceId) ? rescan.kind : null;
      // Selectable: a pin on it waits until it reopens, which the form's status says.
      if (!disabled && closedAt(machine) !== null) sub = `closed to scheduled work · ${sub}`;
      if (here === "scanning") sub = "scanning…";
      if (here === "failed") sub = "couldn't rescan — last known list";
      return {
        machine,
        sub,
        disabled,
        selected: machine.deviceId === form.machine,
        dot: presenceDot(relay, machineDot(machine)),
      };
    });
}

function deriveRepoRescan(state: AppState): RepoRescan {
  const { relay, rescan } = state;
  const scanning = rescan.kind === "scanning";
  const failed =
    rescan.kind === "failed"
      ? relay.machines.filter((m) => rescan.deviceIds.includes(m.deviceId)).map((m) => m.name)
      : [];
  return {
    disabled: scanning || !relay.machines.some((m) => m.connected),
    scanning,
    failure: failed.length === 0 ? null : `Couldn't rescan ${failed.join(", ")} — showing the last known list.`,
  };
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
        dot: presenceDot(relay, relay.machines.some((m) => m.connected && hasAccount(m, accountId)) ? "ok" : "off"),
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
      body: canHold(relay)
        ? "A task you queue now is kept on this phone and sent once the app reconnects. Keep it open, or come back to it."
        : "Nothing can be queued until the app has reached the relay once. Your prompt is kept.",
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

/** The model tile's text: a pick's label, or the raw id of a pair `modelPickOf` refuses (the store never writes one). */
function formModelLabel(form: AppState["form"]): string {
  const pick = modelPickOf(form.agent, form.model);
  return pick === null ? form.model : modelLabel(pick);
}

/** An offline pin is not a block: the task waits for the machine, as `resolvePlacement` notes. */
function deriveFormStatus(state: AppState, machine: Machine | null, problem: PinProblem | null): string | null {
  const { reason, note } = deriveAutoAvailability(state.relay);
  const holding = canHold(state.relay);
  if (!holding && reason !== null) return reason;
  if (problem !== null) return problem.text;
  const codex = deriveCodexProblem(state);
  if (codex !== null) return codex.text;
  if (state.attachments.length > 0 && !deriveAttachmentsAvailability(state.relay)) {
    const block = attachmentsBlock(state.relay);
    if (block === "not_held") return ATTACHMENTS_NOT_HELD;
    return block === "unavailable" ? ATTACHMENTS_UNAVAILABLE : ATTACHMENTS_VERIFYING;
  }
  if (holding && state.held.length >= HELD_MAX)
    return `${HELD_MAX} tasks are held already. Discard one to hold another`;
  // The settle window is a resume's re-dial: a task held in it goes out within a second, so it isn't news.
  if (holding && !state.relay.settling) return "Not connected — a task you queue waits on this phone";
  // The tile says "Unknown machine" here, so the status line must not claim the scheduler picks.
  if (state.form.machine !== null && machine === null) return "The pinned machine isn't listed";
  if (machine !== null && !machine.connected) return `${machine.name} is offline — the task waits for it`;
  // Not a block: a pin waits, as for an offline machine.
  if (machine !== null && closedAt(machine) !== null) return `${machine.name} is closed: this waits until it reopens`;
  if (note !== null) return note;
  return machine === null ? null : `Pinned to ${machine.name}`;
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
  const holding = canHold(relay);
  if (relay.status !== "open" && !holding) return blocked(relay.settling ? "Connecting…" : "Waiting for the relay");
  if (relay.registrySize === 0) return blocked("No machines registered");
  if (relay.machines.length === 0) {
    if (relay.ignored > 0) return blocked("Check your key");
    if (relay.unbound > 0) return blocked("Registry tampered");
    return blocked(relay.skewed > 0 ? "Version mismatch" : "No machines listed");
  }
  if (state.awaitingUploads) {
    // Nothing in flight and attaching not offered: the press is waiting out a dropped socket or a re-dial.
    if (!state.attachments.some((f) => f.upload.kind === "uploading") && !deriveAttachmentsAvailability(relay)) {
      return { label: relay.status === "open" ? "Checking leader…" : "Reconnecting…", enabled: false, busy: true };
    }
    const total = state.attachments.length;
    const stored = state.attachments.filter((f) => f.upload.kind === "stored").length;
    return { label: `Uploading ${Math.min(stored + 1, total)}/${total}…`, enabled: false, busy: true };
  }
  if (state.spawning) return { label: "Queuing…", enabled: false, busy: true };
  if (!holding && !deriveAutoAvailability(relay).available) return blocked("Queuing is unavailable");
  if (problem !== null) return blocked(problem.label);
  const codex = deriveCodexProblem(state);
  if (codex !== null) return blocked(codex.label);
  if (state.attachments.length > 0 && !deriveAttachmentsAvailability(relay)) {
    return blocked(attachmentsBlock(relay) === "verifying" ? "Checking leader…" : "Can't attach files");
  }
  if (repo === null) return blocked("No repo to run");
  if (holding && state.held.length >= HELD_MAX) return blocked("Too many held");
  if (holding && !relay.settling) return { label: "Queue when connected", enabled: true, busy: false };
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

/**
 * Whether a held task asks something of the leader that only a verified one can answer (a done
 * report, an account pin, an agent): it waits for one rather than failing on a leader that is only asleep or
 * not yet verified.
 */
export function heldNeedsLeader(task: Task): boolean {
  return (
    settlesOnReport(task) ||
    task.spec.pin?.account !== undefined ||
    task.spec.requires !== undefined ||
    task.spec.agent !== undefined
  );
}

/** Whether a task needs a leader advertising `reportedDone`: it settles on its done report, or waits on another's. */
export function settlesOnReport(task: Task): boolean {
  const { spec } = task;
  return spec.until === "reported" || spec.deps?.some((dep) => dep.after === "done") === true;
}

function heldDroppedText(titles: readonly string[]): string | null {
  if (titles.length === 0) return null;
  const count = titles.length === 1 ? "1 task" : `${titles.length} tasks`;
  return `Dropped ${count} held over a day: ${titles.join(", ")}`;
}

function heldRow(entry: HeldTask, relay: RelayState): HeldRow {
  const { task, failure, sending } = entry;
  const waiting =
    relay.status === "open" && heldNeedsLeader(task) && !leaderVerified(relay)
      ? "Waiting for the scheduler's leader"
      : "Waiting for the relay";
  return {
    taskId: task.id,
    title: taskTitle(task),
    repo: originLabel(task.spec.repo),
    status: sending ? "Sending…" : (failure ?? waiting),
    failed: failure !== null,
    sending,
  };
}

export function deriveView(state: AppState, now: number): ViewModel {
  const { relay, form } = state;
  const { account } = form;
  const machine = form.machine === null ? null : (relay.machines.find((m) => m.deviceId === form.machine) ?? null);
  const repos = scopedRepos(relay.machines, form);
  const repo = resolveRepo(repos, form);
  const worktree = worktreeFor(form, repo?.origin ?? null);
  const problem = derivePinProblem(relay, form, state.accounts.aliases);
  const availability = deriveAutoAvailability(relay);
  const known = formAccounts(relay.machines, form);
  const signedIn = account !== null && relay.machines.some((m) => hasAccount(m, account));
  const autoDot = presenceDot(relay, availability.available ? "auto" : "off");

  return {
    meta: deriveMeta(state),
    relayState: relay.status === "open" ? "connected" : relay.settling ? "connecting" : "offline",
    relayLine: deriveRelayLine(relay),
    banner: deriveBanner(state),
    machineTile:
      form.machine === null
        ? {
            label: "MACHINE",
            value: "Auto",
            mono: false,
            dot: autoDot,
            tag: null,
          }
        : {
            label: "MACHINE",
            value: machine?.name ?? "Unknown machine",
            mono: false,
            dot: presenceDot(relay, machineDot(machine)),
            tag: null,
          },
    accountTile:
      account === null
        ? {
            label: "ACCOUNT",
            value: "Auto",
            mono: false,
            dot: autoDot,
            tag: null,
          }
        : {
            label: "ACCOUNT",
            value: `${accountNameIn(known, account, aliasOf(state.accounts.aliases, account))}${signedIn ? "" : " · signed in nowhere"}`,
            mono: false,
            dot: presenceDot(relay, signedIn ? "ok" : "off"),
            tag: null,
          },
    repoTile: {
      label: "REPOSITORY",
      value: repo?.label ?? "No repos",
      mono: true,
      dot: null,
      tag: worktree ? "worktree" : null,
    },
    modelTile: {
      label: "MODEL",
      value: formModelLabel(form),
      mono: false,
      dot: null,
      // The agent the pick runs, named on the tile so a GPT model never reads as Claude's.
      tag: form.agent === "claude" ? null : AGENT_LABELS[form.agent],
    },
    effortTile: {
      label: "EFFORT",
      value: EFFORT_LABELS[form.effort],
      mono: false,
      dot: null,
      tag: null,
    },
    autonomyTile: { label: "AUTONOMY", value: AUTONOMY_LABELS[state.autonomy], mono: false, dot: null, tag: null },
    notBeforeTile: {
      label: "NOT BEFORE",
      value: state.notBefore === null ? "Now" : formatNotBefore(resolveNotBeforeChoice(state.notBefore, now)),
      mono: false,
      dot: null,
      tag: null,
    },
    afterTile: {
      label: "AFTER",
      value: afterValue(form.after),
      mono: false,
      dot: null,
      tag: form.until === "reported" ? "on report" : null,
    },
    requiresTile:
      fleetTraits(relay.machines).size === 0 && form.requires.length === 0
        ? null
        : {
            label: "REQUIRES",
            value: requiresValue(form.requires),
            mono: false,
            dot: form.requires.length > 0 && !deriveTraitsAvailability(relay) ? "off" : null,
            tag: null,
          },
    requires: deriveRequires(state),
    refTile:
      !deriveTaskTagsAvailability(relay) && state.ref.ref === ""
        ? null
        : {
            label: "REF",
            value: state.ref.ref.trim() === "" ? "None" : state.ref.ref.trim(),
            mono: state.ref.ref.trim() !== "",
            dot: state.ref.ref !== "" && !deriveTaskTagsAvailability(relay) ? "off" : null,
            tag: null,
          },
    ref: deriveRef(state),
    reportedAvailable: deriveReportedOffered(relay),
    held: state.held.map((entry) => heldRow(entry, relay)),
    heldDropped: heldDroppedText(state.heldDropped),
    reportedHint: reportedHint(form.until, deriveReportedOffered(relay)),
    worktree,
    worktreeHint: worktree ? "Branches off the default branch on origin" : "Runs in the repo as it stands",
    formStatus: deriveFormStatus(state, machine, problem),
    button: deriveButton(state, machine, repo, problem),
    // A deferred task has no use for the split: Start now would contradict the time just chosen.
    startNow: deriveRunNowAvailability(relay) && state.notBefore === null,
    startNowPastPause: deriveRunNowPastPause(relay),
    ignoredNote: deriveIgnoredNote(relay),
    machine,
    account,
    repo,
    repos,
    autoAvailability: availability,
    autoDot,
    machineChoices: deriveMachineChoices(state, now),
    repoRescan: deriveRepoRescan(state),
    accountChoices: deriveAccountChoices(state),
    previewShown: previewAsked(form, state.notBefore),
    queueAttention: state.queueView?.kind === "ok" && needsAttention(state.queueView.tasks, state.relay.machines),
    attachments: deriveAttachments(state),
  };
}

/**
 * What follows the scheduler's own line for a failure it set (`taskFailureText`)
 * where "Nothing is running" would be wrong or not enough: the step to take.
 */
const FAILED_NEXT_STEP: ReadonlyMap<string, string> = new Map([
  ["dispatch_unconfirmed", "Check that machine before starting another."],
  [
    "continue_expired",
    "The task it continues may be continued again while its machine still holds its launch (a week).",
  ],
  ["lost_expired", "End it on that machine once it is back."],
  ["pin_expired", "It never ran. Submit it again once its machine or account is back."],
  [
    "session_closed",
    "Tasks waiting on it failed with it. Its transcript on that machine stops where its window was closed.",
  ],
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

export function failedBody(
  code: string | undefined,
  exit?: number,
  until?: TaskUntil,
  oomKill?: boolean,
  message?: string,
): string {
  // A code the scheduler set itself says why; any other is a daemon's spawn refusal.
  const scheduler = code === undefined ? null : taskFailureText(code, exit, until, oomKill);
  // The daemon's own refusal of a continue task, worded for it: the generic line would say a spawn was refused.
  // Its message says which of the several causes it was; shown as text, like any failure message.
  if (code === "not_continuable") {
    const why = message?.trim().replace(/\.$/u, "") ?? "";
    return why === ""
      ? "The machine couldn't continue the earlier session: its worktree or its launch record is gone, a session is open there, or the worktree is locked. Nothing new was started."
      : `The machine couldn't continue the earlier session: ${why}. Nothing new was started.`;
  }
  if (code === undefined || scheduler === null) return "The machine refused the spawn. Nothing is running.";
  const next = code === "session_failed" ? sessionFailedNextStep(exit) : FAILED_NEXT_STEP.get(code);
  return `${sentence(scheduler)} ${next ?? "Nothing is running."}`;
}
