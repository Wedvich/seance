import type { JSX } from "preact";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { type ChartLine, chartLines } from "../chart.ts";
import type {
  AccountCard,
  ArchivistCard,
  CustodianRow,
  DrainAction,
  Gauge,
  GaugeIcon,
  MachineCard,
  MachinesView,
} from "../machines-view.ts";
import { custodianMenu } from "../machines-view.ts";
import {
  type AccountsState,
  type AvailabilityState,
  type CustodianControlState,
  type HistoryRange,
  type HistoryTarget,
  type HistoryView,
} from "../state.ts";
import { ACCOUNT_ALIAS_MAX_LENGTH, type CustodianRequest, type Machine } from "@seance/shared";
import type { Timed } from "../timed.ts";
import { canDrainNow, type CloseKind, type ConnectionState } from "../view.ts";
import { StrokeIcon } from "./icons.tsx";
import { Menu, MenuDivider, MenuGroup, MenuItem, MenuSwitchItem, MoreTrigger, useMenu } from "./menu.tsx";
import { RelayDot } from "./relay-dot.tsx";
import { Seg } from "./seg.tsx";
import { Sheet } from "./sheet.tsx";
import { TimedText } from "./timed.tsx";

const TARGET_LABELS: Record<HistoryTarget["kind"], string> = { machine: "Load and disk", account: "Quota" };

const CHART_WIDTH = 320;
const CHART_HEIGHT = 120;
/** Series beyond the palette wrap around; a quota panel past five is already hard to read. */
const PALETTE_SIZE = 5;

/**
 * Reached from settings, stacked over it: every machine's pressure and
 * exclaves, then quota per account across the fleet. Charts follow the same
 * split — pressure under a machine, quota under an account — one open at a
 * time, under the card it belongs to.
 */
export function MachinesScreen(props: {
  view: MachinesView;
  /** The archivist's own card, after the machines; null with no archivist in the registry. */
  archivist: ArchivistCard | null;
  relayLine: string;
  relayState: ConnectionState;
  /** The registry is authoritative (`RelayState.registrySettled`). */
  settled: boolean;
  history: HistoryView | null;
  accounts: AccountsState;
  availability: AvailabilityState;
  custodian: CustodianControlState;
  /** Round now, pause or resume a machine's custodian (the card's menu, for a machine advertising `custodian`). */
  onCustodian: (deviceId: string, request: CustodianRequest) => void;
  /**
   * Asks a machine to close (false) or reopen (true); `close` says how: soft, drained, or drained now (the sheets'
   * buttons, and Drain / Drain now on a closed machine). The confirm sheets are this screen's.
   */
  onSetOpen: (deviceId: string, open: boolean, close?: CloseKind) => void;
  /** The registry, which the confirm sheets' words are derived from (`closeSheet`, `drainSheet`). */
  machines: readonly Machine[];
  /** The close sheet's lines for a machine (`deriveCloseSheet`); `soft` when its Close stops new work only. */
  closeSheet: (machine: Machine, soft: boolean) => readonly string[];
  /** The Drain sheet's lines for a soft-closed machine (`deriveDrainSheet`). */
  drainSheet: (machine: Machine) => readonly string[];
  /** Reads a machine's sessions and the queue afresh: asked as the confirm sheet opens. */
  onReadDrain: (deviceId: string) => void;
  /** Absent in the desktop layout, where the screen is a column rather than a layer. */
  onDismiss?: () => void;
  onShowHistory: (target: HistoryTarget, range?: HistoryRange) => void;
  onHideHistory: () => void;
  onOpenRename: (accountId: string) => void;
  /** Closes the dialog the way back does. */
  onCloseRename: () => void;
  /** Resolves once the rename has settled: true when the name landed, which closes the dialog. */
  onRename: (accountId: string, text: string) => Promise<boolean>;
}): JSX.Element {
  const {
    view,
    archivist,
    relayLine,
    relayState,
    settled,
    history,
    accounts,
    availability,
    custodian,
    onCustodian,
    onSetOpen,
    machines,
    closeSheet,
    drainSheet,
    onReadDrain,
    onDismiss,
    onShowHistory,
    onHideHistory,
    onOpenRename,
    onCloseRename,
    onRename,
  } = props;
  const { renaming } = accounts;
  // The open confirm sheet: closing an open machine, or Drain / Drain now on a closed one.
  const [closing, setClosing] = useState<{ readonly deviceId: string; readonly act: "close" | DrainAction } | null>(
    null,
  );
  const closingCard = closing === null ? undefined : view.cards.find((card) => card.deviceId === closing.deviceId);
  const closingMachine =
    closing === null ? undefined : machines.find((machine) => machine.deviceId === closing.deviceId);
  const confirm = (deviceId: string, close: CloseKind) => (): void => {
    setClosing(null);
    onSetOpen(deviceId, false, close);
  };
  // Kept while the account is briefly unreported (a sign-out in between), so a typed draft survives; Cancel or Save closes it.
  const seen = useRef<AccountCard | undefined>(undefined);
  const found = view.accounts.find((account) => account.accountId === renaming);
  if (found !== undefined) seen.current = found;
  const renamed =
    renaming === null ? undefined : (found ?? (seen.current?.accountId === renaming ? seen.current : undefined));
  return (
    <>
      <header className="header">
        <div className="header-lead">
          {onDismiss !== undefined && (
            <button type="button" className="header-back" onClick={onDismiss} aria-label="Back">
              ‹
            </button>
          )}
          <div>
            <h1 className="header-title">Machines</h1>
            <p className="header-meta header-status">
              <RelayDot state={relayState} />
              {/* One text node: the flex gap would otherwise split the " · ". Unsettled, the scheduler is still its initial "none"; offline, it is stale. */}
              {settled && relayState === "connected" ? `${relayLine} · ${view.scheduler}` : relayLine}
            </p>
          </div>
        </div>
      </header>

      <div className="fleet">
        {/* Unsettled, an empty list means "no push yet", not "no machines" — the store's rule too. */}
        {view.cards.length === 0 && (
          <p className="fleet-empty">{settled ? "No machines to show." : "Waiting for the relay…"}</p>
        )}
        {view.cards.map((card) => (
          <MachineCardView
            key={card.deviceId}
            card={card}
            history={history?.target.kind === "machine" && history.target.deviceId === card.deviceId ? history : null}
            ranges={view.ranges.machine}
            availability={availability}
            custodian={custodian}
            onCustodian={(request) => onCustodian(card.deviceId, request)}
            onShowHistory={onShowHistory}
            onHideHistory={onHideHistory}
            onToggleOpen={(open) => {
              if (open) return onSetOpen(card.deviceId, true);
              onReadDrain(card.deviceId);
              setClosing({ deviceId: card.deviceId, act: "close" });
            }}
            onDrain={(act) => {
              onReadDrain(card.deviceId);
              setClosing({ deviceId: card.deviceId, act });
            }}
          />
        ))}
        {archivist !== null && <ArchivistCardView card={archivist} />}

        {view.accounts.length > 0 && <h2 className="label fleet-heading">Accounts</h2>}
        {view.accounts.map((account) => (
          <AccountCardView
            key={account.accountId}
            account={account}
            nameable={accounts.nameable}
            onRename={() => onOpenRename(account.accountId)}
            history={
              history?.target.kind === "account" && history.target.accountId === account.accountId ? history : null
            }
            ranges={view.ranges.account}
            onShowHistory={onShowHistory}
            onHideHistory={onHideHistory}
          />
        ))}
      </div>
      {closing !== null && closingCard !== undefined && closingMachine !== undefined && (
        <CloseMachineDialog
          {...closeDialog(closing.act, closingCard, closingMachine, closeSheet, drainSheet, (close) =>
            confirm(closingCard.deviceId, close),
          )}
          onClose={() => setClosing(null)}
        />
      )}
      {renamed !== undefined && (
        <RenameDialog
          key={renamed.accountId}
          account={renamed}
          saving={accounts.saving === renamed.accountId}
          blocked={accounts.saving !== null && accounts.saving !== renamed.accountId}
          notice={accounts.notice}
          onSave={(text) => void onRename(renamed.accountId, text)}
          onClose={onCloseRename}
        />
      )}
    </>
  );
}

function MachineCardView(props: {
  card: MachineCard;
  history: HistoryView | null;
  ranges: readonly HistoryRange[];
  availability: AvailabilityState;
  custodian: CustodianControlState;
  onCustodian: (request: CustodianRequest) => void;
  onShowHistory: (target: HistoryTarget, range?: HistoryRange) => void;
  onHideHistory: () => void;
  /** The switch's new state: true reopens at once, false asks for confirmation first. */
  onToggleOpen: (open: boolean) => void;
  /** Drain or Drain now on a closed machine: asks for confirmation first. */
  onDrain: (act: DrainAction) => void;
}): JSX.Element {
  const {
    card,
    history,
    ranges,
    availability,
    custodian,
    onCustodian,
    onShowHistory,
    onHideHistory,
    onToggleOpen,
    onDrain,
  } = props;
  // The asked state shows while the request is out and until the status agrees, so neither the switch nor the badge bounces back.
  const here = availability[card.deviceId] ?? null;
  const asked = here?.kind === "sending" || here?.kind === "sent" ? here.open : null;
  const switchOn = asked ?? card.openSwitch === "on";
  const closed = here?.kind === "sent" ? !here.open : card.closed;
  // Only for the machine's own closed state: a sent close or reopen leaves them hidden until its status agrees.
  const drainActions = closed && card.closed && here?.kind !== "sent" ? card.drainActions : [];
  const sending = here?.kind === "sending";
  const asking = custodian[card.deviceId] ?? null;
  const custodianState = custodianMenu(card, asking);
  const offersMenu = card.charts || history !== null || card.openSwitch !== null || card.custodianControls;
  const target: HistoryTarget = { kind: "machine", deviceId: card.deviceId };
  const menu = useMenu();
  // Kept while a chart is open even if its source drops: the item is the chart's only close.
  const offersHistory = card.charts || history !== null;

  return (
    <section className="fleet-card card">
      <div className="fleet-card-head">
        <div className="fleet-card-title">
          <div className="fleet-name-row">
            <span className={card.connected ? "dot dot-ok" : "dot"} aria-hidden="true" />
            <h2 className="fleet-name">{card.name}</h2>
            {card.role !== null && (
              <span className={card.role === "leader" ? "fleet-badge" : "fleet-badge fleet-badge-unverified"}>
                {card.role === "leader" ? "Scheduler" : "Unverified"}
              </span>
            )}
            {closed && <span className="fleet-badge fleet-badge-closed">Closed</span>}
          </div>
          <p className="fleet-meta">
            <TimedText line={card.meta} />
          </p>
          {card.build !== null && (
            <p className="fleet-meta fleet-build">
              <TimedText line={card.build} />
            </p>
          )}
        </div>
        {offersMenu && (
          <>
            <MoreTrigger menu={menu} label={`More actions for ${card.name}`} />
            <Menu menu={menu} label={`Actions for ${card.name}`}>
              {card.openSwitch !== null && (
                <MenuSwitchItem
                  label="Open for work"
                  icon={<WorkIcon />}
                  checked={switchOn}
                  closesMenu={switchOn}
                  onToggle={() => onToggleOpen(!switchOn)}
                />
              )}
              {drainActions.map((act) => (
                <MenuItem
                  key={act}
                  label={DRAIN_LABELS[act]}
                  icon={<DrainIcon />}
                  disabled={sending}
                  onClick={() => onDrain(act)}
                />
              ))}
              {offersHistory && (
                <HistoryItem history={history} onShow={() => onShowHistory(target)} onHide={onHideHistory} />
              )}
              {card.custodianControls && (
                <>
                  {(card.openSwitch !== null || offersHistory) && <MenuDivider />}
                  <MenuGroup label="Custodian">
                    <CustodianItems
                      paused={custodianState.paused}
                      running={custodianState.running}
                      sending={custodianState.sending}
                      onCustodian={onCustodian}
                    />
                  </MenuGroup>
                </>
              )}
            </Menu>
          </>
        )}
      </div>

      {card.gauges.length > 0 && (
        <div className="bars">
          {card.gauges.map((entry) => (
            <Bar key={entry.label} gauge={entry} />
          ))}
        </div>
      )}

      {here?.kind === "failed" && (
        <p className="fleet-note fleet-warn" role="alert">
          {here.text}
        </p>
      )}
      {card.drain !== null && closed && (
        <div className="fleet-note">
          <p>
            {card.drain.draining ? "Draining" : "Closed"}: {card.drain.summary}
          </p>
          {keyed(card.drain.stuck).map(({ key, line }) => (
            <p key={key} className="fleet-warn">
              {line}
            </p>
          ))}
          {drainActions.length > 0 && (
            <div className="fleet-drain-actions">
              {drainActions.map((act) => (
                <button key={act} type="button" disabled={sending} onClick={() => onDrain(act)}>
                  {DRAIN_LABELS[act]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {asking?.kind === "failed" && (
        <p className="fleet-note fleet-warn" role="alert">
          {asking.text}
        </p>
      )}
      {custodianState.roundRequested && <p className="fleet-note">Round requested</p>}
      {card.custodian !== null && <CustodianLine row={card.custodian} paused={custodianState.paused} />}
      {card.note !== null && <p className="fleet-note">{card.note}</p>}
      {card.updateNote !== null && (
        <p className="fleet-note fleet-warn">
          <TimedText line={card.updateNote} />
        </p>
      )}

      {card.exclaves.length > 0 && (
        <ul className="exclaves">
          {card.exclaves.map((row) => (
            <li key={row.id} className="exclave">
              <span className="exclave-id">{row.id}</span>
              <span className="exclave-account" title={row.account}>
                {row.account}
              </span>
              <span className="exclave-sessions">
                {row.sessions === null ? <b>—</b> : <SessionCount count={row.sessions} />}
              </span>
              {row.auth !== null && (
                <span className={`exclave-auth exclave-auth-${row.auth.level}`}>{row.auth.text}</span>
              )}
              {row.probes !== null && (
                <span className={`exclave-auth exclave-auth-${row.probes.level}`}>{row.probes.text}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {history !== null && (
        <HistoryChart history={history} ranges={ranges} onPick={(range) => onShowHistory(target, range)} />
      )}
    </section>
  );
}

/** No actions: it is a status, not a target, so no menu and no spawn. */
function ArchivistCardView(props: { card: ArchivistCard }): JSX.Element {
  const { card } = props;
  return (
    <section className="fleet-card card" aria-label="Archivist">
      <div className="fleet-card-head">
        <div className="fleet-card-title">
          <div className="fleet-name-row">
            <span className={card.online ? "dot dot-ok" : "dot"} aria-hidden="true" />
            <h2 className="fleet-name">{card.name}</h2>
          </div>
          <p className="fleet-meta">
            <TimedText line={card.meta} />
          </p>
          {card.build !== null && (
            <p className="fleet-meta fleet-build">
              <TimedText line={card.build} />
            </p>
          )}
        </div>
      </div>
      {card.rows.length > 0 && (
        <ul className="exclaves">
          {card.rows.map((row) => (
            <li key={row.label} className="exclave">
              <span className="exclave-id">{row.label}</span>
              <span className="exclave-account">{row.detail}</span>
              <span className="exclave-sessions exclave-sessions-wide">
                <b>{row.value}</b>
                <span>{row.unit}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {card.note !== null && <p className="fleet-note">{card.note}</p>}
      {card.warnings.map((line) => (
        <p key={line} className="fleet-note fleet-warn">
          {line}
        </p>
      ))}
    </section>
  );
}

function AccountCardView(props: {
  account: AccountCard;
  nameable: boolean;
  history: HistoryView | null;
  ranges: readonly HistoryRange[];
  onRename: () => void;
  onShowHistory: (target: HistoryTarget, range?: HistoryRange) => void;
  onHideHistory: () => void;
}): JSX.Element {
  const { account, nameable, history, ranges, onRename, onShowHistory, onHideHistory } = props;
  const menu = useMenu();
  const { historyFrom } = account;
  // Pinned to the host it was opened against: without the archive a range change
  // re-asks that one, and a host gone since leaves the chart to say so rather than switch hosts.
  const host = history?.target.kind === "account" ? history.target.deviceId : historyFrom;
  // Kept while a chart is open even if its source drops: the item is the chart's only close.
  const target: HistoryTarget | null =
    account.charts || history !== null ? { kind: "account", accountId: account.accountId, deviceId: host } : null;
  const offersHistory = target !== null;

  return (
    <section className="fleet-card card">
      <div className="fleet-card-head">
        <div className="fleet-card-title">
          <h2 className="fleet-name">{account.title}</h2>
          <p className="fleet-meta">{account.detail}</p>
        </div>
        <MoreTrigger menu={menu} label={`More actions for ${account.title}`} />
        <Menu menu={menu} label={`Actions for ${account.title}`}>
          <MenuItem
            label="Rename"
            icon={<PencilIcon />}
            sub={nameable ? undefined : "Re-enter the pre-shared key in Settings"}
            disabled={!nameable}
            onClick={onRename}
          />
          {offersHistory && (
            <>
              <MenuDivider />
              <HistoryItem
                history={history}
                onShow={() => target !== null && onShowHistory(target)}
                onHide={onHideHistory}
              />
            </>
          )}
        </Menu>
      </div>
      {account.bars.length > 0 && (
        <div className="bars">
          {account.bars.map((bar) => (
            <Bar key={bar.label} gauge={bar} note={bar.note} />
          ))}
        </div>
      )}
      <p className="fleet-note">
        <TimedText line={account.observed} />
      </p>
      {history !== null && target !== null && (
        <HistoryChart history={history} ranges={ranges} onPick={(range) => onShowHistory(target, range)} />
      )}
    </section>
  );
}

/** Run a round now, then pause (for an hour or until resumed) or resume, by what the seat reports or was last asked. */
function CustodianItems(props: {
  paused: boolean;
  running: boolean;
  /** A request is out: the store takes one per machine at a time. */
  sending: boolean;
  onCustodian: (request: CustodianRequest) => void;
}): JSX.Element {
  const { paused, running, sending, onCustodian } = props;
  return (
    <>
      <MenuItem
        label="Run round now"
        icon={<RoundIcon />}
        disabled={sending || running}
        {...(running ? { sub: "A round is running" } : {})}
        onClick={() => onCustodian({ act: "round" })}
      />
      {paused ? (
        <MenuItem
          label="Resume"
          icon={<ResumeIcon />}
          disabled={sending}
          onClick={() => onCustodian({ act: "resume" })}
        />
      ) : (
        <>
          <MenuItem
            label="Pause for 1 hour"
            icon={<TimerIcon />}
            disabled={sending}
            onClick={() => onCustodian({ act: "pause", minutes: 60 })}
          />
          <MenuItem
            label="Pause until resumed"
            icon={<PauseIcon />}
            disabled={sending}
            onClick={() => onCustodian({ act: "pause" })}
          />
        </>
      )}
    </>
  );
}

/** A switch, so the chart can be flipped on and off with the menu still open. */
function HistoryItem(props: { history: HistoryView | null; onShow: () => void; onHide: () => void }): JSX.Element {
  const { history, onShow, onHide } = props;
  return (
    <MenuSwitchItem
      label="Show history"
      icon={<HistoryIcon />}
      checked={history !== null}
      onToggle={history === null ? onShow : onHide}
    />
  );
}

/**
 * One form, laid out by `Sheet`: a bottom sheet on a phone, centred on a desk.
 * It stays open on a refusal, with the reason where the hint was, so the draft
 * is there to send again.
 */
function RenameDialog(props: {
  account: AccountCard;
  /** This account's rename is in flight. */
  saving: boolean;
  /** Another account's rename is: the store takes one at a time, so Save waits. */
  blocked: boolean;
  notice: string | null;
  onSave: (text: string) => void;
  onClose: () => void;
}): JSX.Element {
  const { account, saving, blocked, notice, onSave, onClose } = props;
  const [draft, setDraft] = useState(account.alias ?? "");
  const input = useRef<HTMLInputElement>(null);
  const noticeId = useId();
  const inputId = useId();
  // An effect, not a layout effect: `Sheet` focuses its panel in one, after its children's.
  // Again after a save: disabling the field dropped its focus.
  useEffect(() => {
    if (!saving) input.current?.focus();
  }, [saving]);

  return (
    <Sheet title="Rename account" variant="dialog" onClose={onClose}>
      <form
        className="rename"
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving && !blocked) onSave(draft);
        }}
      >
        <p className="rename-account">
          {account.plainName} · {account.exclaves}
        </p>
        <label className="rename-label" htmlFor={inputId}>
          Account name
        </label>
        <input
          ref={input}
          id={inputId}
          type="text"
          className="rename-input"
          placeholder="Name this account"
          maxLength={ACCOUNT_ALIAS_MAX_LENGTH}
          value={draft}
          disabled={saving}
          aria-invalid={notice !== null}
          aria-describedby={notice === null ? undefined : noticeId}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        {notice === null ? (
          <p className="rename-hint">
            <span>
              {blocked
                ? "Another account's name is still saving. Save is on hold until it lands."
                : `Shown as the card title. Leave it empty to go back to “${account.exclaves}”.`}
            </span>
            <span className="rename-count">
              {draft.length}/{ACCOUNT_ALIAS_MAX_LENGTH}
            </span>
          </p>
        ) : (
          <p id={noticeId} className="rename-error" role="alert">
            {notice}
          </p>
        )}
        <div className="rename-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving || blocked}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** Lines made unique for keys: two panes can read the same ("Not a task: close it yourself"). */
function keyed(lines: readonly string[]): { readonly key: string; readonly line: string }[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const nth = (seen.get(line) ?? 0) + 1;
    seen.set(line, nth);
    return { key: `${line}#${nth}`, line };
  });
}

const DRAIN_LABELS: Record<DrainAction, string> = { drain: "Drain", now: "Drain now" };

interface DialogAction {
  readonly label: string;
  readonly onClick: () => void;
}

interface CloseDialogContent {
  readonly title: string;
  readonly lines: readonly string[];
  /** Quieter actions, before the primary one. */
  readonly quiet: readonly DialogAction[];
  readonly primary: DialogAction;
}

/**
 * Which sheet an act opens. Closing a soft-capable machine: Close is soft and primary, with Close and drain and Drain
 * now (where its daemon asks its sessions) as quieter choices; otherwise Close drains, as before. Drain on a
 * soft-closed machine offers Drain now beside it; Drain now while draining cuts the ask's grace.
 */
function closeDialog(
  act: "close" | DrainAction,
  card: MachineCard,
  machine: Machine,
  closeSheet: (machine: Machine, soft: boolean) => readonly string[],
  drainSheet: (machine: Machine) => readonly string[],
  confirm: (close: CloseKind) => () => void,
): CloseDialogContent {
  const asks = canDrainNow(machine);
  const drainNow: DialogAction = { label: "Drain now", onClick: confirm("now") };
  if (act === "close") {
    return {
      title: `Close ${card.name}?`,
      lines: closeSheet(machine, card.softClose),
      quiet: card.softClose
        ? [{ label: "Close and drain", onClick: confirm("drain") }, ...(asks ? [drainNow] : [])]
        : asks
          ? [drainNow]
          : [],
      primary: { label: "Close", onClick: confirm(card.softClose ? "soft" : "drain") },
    };
  }
  if (act === "drain") {
    return {
      title: `Drain ${card.name}?`,
      lines: drainSheet(machine),
      quiet: card.drainActions.includes("now") ? [drainNow] : [],
      primary: { label: "Drain", onClick: confirm("drain") },
    };
  }
  // A soft close offers Drain beside Drain now; a drain under way offers Drain now alone. The lines say what this act
  // does, not the Drain sheet's 5-minute wording: the interrupt is at once, and a session waiting on you is cut off too.
  const soft = card.drainActions.includes("drain");
  return {
    title: `Drain ${card.name} now?`,
    lines: [
      soft
        ? `${card.name} is closed. Drain now moves its running work off it, and interrupts its sessions' turns at once instead of 5 minutes after the drain began.`
        : `${card.name} is draining. Drain now interrupts its sessions' turns at once instead of 5 minutes after the drain began.`,
      "A session waiting on you is interrupted too.",
    ],
    quiet: [],
    primary: drainNow,
  };
}

/** A close or a drain needs a yes: one stops the scheduler's new work landing there, the other moves what runs. Reopening needs none. */
function CloseMachineDialog(props: CloseDialogContent & { onClose: () => void }): JSX.Element {
  const { title, lines, quiet, primary, onClose } = props;
  return (
    <Sheet title={title} variant="dialog" onClose={onClose}>
      <div className="rename">
        {keyed(lines).map(({ key, line }) => (
          <p key={key} className="rename-hint">
            {line}
          </p>
        ))}
        <div className="rename-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
          {quiet.map((action) => (
            <button key={action.label} type="button" className="quiet" onClick={action.onClick}>
              {action.label}
            </button>
          ))}
          <button type="button" className="primary" onClick={primary.onClick}>
            {primary.label}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function DrainIcon(): JSX.Element {
  return (
    <StrokeIcon size={18}>
      <path d="M4 12h12" />
      <path d="M12 7l5 5-5 5" />
      <path d="M20 5v14" />
    </StrokeIcon>
  );
}

function WorkIcon(): JSX.Element {
  return (
    <StrokeIcon size={18}>
      <path d="M5 8h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <path d="M9 8V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M4 13h16" />
    </StrokeIcon>
  );
}

function RoundIcon(): JSX.Element {
  return (
    <StrokeIcon size={18}>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v4h-4" />
    </StrokeIcon>
  );
}

function PauseIcon(): JSX.Element {
  return (
    <StrokeIcon size={18}>
      <path d="M9 6v12" />
      <path d="M15 6v12" />
    </StrokeIcon>
  );
}

/** A clock, for the pause that ends on its own. */
function TimerIcon(): JSX.Element {
  return (
    <StrokeIcon size={18}>
      <path d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z" />
      <path d="M12 8v4l2.5 2.5" />
    </StrokeIcon>
  );
}

function ResumeIcon(): JSX.Element {
  return (
    <StrokeIcon size={18}>
      <path d="M8 5l11 7-11 7z" />
    </StrokeIcon>
  );
}

function HistoryIcon(): JSX.Element {
  return (
    <StrokeIcon size={18}>
      <path d="M4 19h16" />
      <path d="M4 15l5-5 4 3 7-8" />
    </StrokeIcon>
  );
}

function PencilIcon(): JSX.Element {
  return (
    <StrokeIcon size={18}>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </StrokeIcon>
  );
}

/** The count carries the weight; its unit stays muted, so a column of rows scans by number. */
function SessionCount(props: { count: number }): JSX.Element {
  const { count } = props;
  return (
    <>
      <b>{count}</b>
      <span>{count === 1 ? "session" : "sessions"}</span>
    </>
  );
}

/**
 * A quota bar's reset is its own column, not part of the value: the percent
 * then shares one edge with every other percent on the screen. `undefined`
 * leaves the column out entirely (a pressure gauge); `null` keeps it, empty,
 * so a window without a reset stamp stays in line with its siblings.
 */
function Bar(props: { gauge: Gauge; note?: Timed | null }): JSX.Element {
  const { gauge, note } = props;
  return (
    <div className={note === undefined ? "bar" : "bar bar-resets"}>
      <span className="bar-label">{gauge.label}</span>
      {gauge.icon !== undefined && (
        <svg className="bar-icon" viewBox="0 0 24 24" aria-hidden="true">
          {GAUGE_ICONS[gauge.icon]}
        </svg>
      )}
      <span className="bar-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={gauge.pct}>
        <span className={`bar-fill bar-${gauge.level}`} style={{ width: `${gauge.pct}%` }} />
      </span>
      <span className="bar-value">{gauge.pct}%</span>
      {note !== undefined && <span className="bar-reset">{note !== null && <TimedText line={note} />}</span>}
    </div>
  );
}

/**
 * Lucide's cpu / memory-stick / hard-drive outlines on a 24-unit grid. An
 * ornament between label and bar, in its own column: the bars keep one left
 * edge and the label column stays shared with the exclave rows beneath.
 */
const GAUGE_ICONS: Record<GaugeIcon, JSX.Element> = {
  cpu: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
    </>
  ),
  mem: (
    <path d="M6 19v-3M10 19v-3M14 19v-3M18 19v-3M8 11V9M16 11V9M12 11V9M2 15h20M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.837V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.1a2 2 0 0 0 0-3.837Z" />
  ),
  disk: (
    <path d="M22 12H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11zM6 16h.01M10 16h.01" />
  ),
};

function HistoryChart(props: {
  history: HistoryView;
  /** Offered ranges: the archive's only while it serves this chart; the store falls back to 24h when it stops. */
  ranges: readonly HistoryRange[];
  onPick: (range: HistoryRange) => void;
}): JSX.Element {
  const { history, ranges, onPick } = props;
  const { result, from, to, step } = history;
  const series = result.kind === "ok" ? result.series : null;
  // The screen re-renders on every status beat; the geometry changes only with the reply or its window.
  const lines = useMemo(
    () =>
      series === null
        ? []
        : chartLines(series, { from, to, step }, { width: CHART_WIDTH, height: CHART_HEIGHT }).filter(
            (line) => line.d !== "",
          ),
    [series, from, to, step],
  );

  // Every state fills the same frame, axis and legend row, so a range pick can't collapse the card mid-load.
  return (
    <div className="chart">
      <div className="chart-controls">
        <Seg label="Range" options={ranges} value={history.range} render={(range) => range} onChange={onPick} />
      </div>
      <div className="chart-frame">
        {result.kind === "loading" && <p className="chart-status">Loading…</p>}
        {result.kind === "failed" && <p className="chart-status chart-failed">{result.message}</p>}
        {result.kind === "ok" && lines.length === 0 && <p className="chart-status">Nothing recorded in this range.</p>}
        {lines.length > 0 && <ChartPlot history={history} lines={lines} />}
      </div>
      <div className="chart-axis">
        <span>{history.range} ago</span>
        <span>now</span>
      </div>
      <ul className="chart-legend">
        {lines.map((line, index) => (
          <li key={line.key}>
            <span className={`chart-swatch chart-c${index % PALETTE_SIZE}`} aria-hidden="true" />
            {line.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChartPlot(props: { history: HistoryView; lines: readonly ChartLine[] }): JSX.Element {
  const { history, lines } = props;
  return (
    <svg
      className="chart-plot"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${TARGET_LABELS[history.target.kind]} over the last ${history.range}`}
    >
      {[25, 50, 75].map((pct) => (
        <line
          key={pct}
          className="chart-grid"
          x1="0"
          x2={CHART_WIDTH}
          y1={CHART_HEIGHT - (pct / 100) * CHART_HEIGHT}
          y2={CHART_HEIGHT - (pct / 100) * CHART_HEIGHT}
        />
      ))}
      {lines.map((line, index) =>
        line.gaps === "" ? null : (
          <path key={`${line.key}/gaps`} className={`chart-gap chart-c${index % PALETTE_SIZE}`} d={line.gaps} />
        ),
      )}
      {lines.map((line, index) => (
        <path key={line.key} className={`chart-line chart-c${index % PALETTE_SIZE}`} d={line.d} />
      ))}
    </svg>
  );
}

const CUSTODIAN_STATE_WORDS = { idle: "Idle", running: "Running", paused: "Paused", failing: "Failing" } as const;

/** A pause behind a running round or a failing host (`cu.p`), or one just asked, shows beside the state. */
function custodianWord(state: CustodianRow["state"], paused: boolean): string {
  if (state === null) return "no report yet";
  if (!paused || state === "paused") return CUSTODIAN_STATE_WORDS[state];
  return state === "idle" ? CUSTODIAN_STATE_WORDS.paused : `${CUSTODIAN_STATE_WORDS[state]}, paused`;
}

/**
 * Each part is one unbreakable span, so a narrow card wraps between parts, never inside one. The ` · ` leads each
 * later part inside its span (it wraps with its part), and a text space between the spans keeps `textContent` and
 * screen readers from running the words together; flex layout ignores that whitespace.
 */
function CustodianLine({ row, paused }: { readonly row: CustodianRow; readonly paused: boolean }): JSX.Element {
  return (
    <p className={`fleet-note custodian-row${row.warn ? " fleet-warn" : ""}`}>
      <span>Custodian · {custodianWord(row.state, paused)}</span>
      {row.ended !== null && (
        <>
          {" "}
          <span>· {row.ended}</span>
        </>
      )}
      {row.counts !== null && (
        <>
          {" "}
          <span>· {row.counts}</span>
        </>
      )}
      {row.link !== null && (
        <>
          {" "}
          <span>
            ·{" "}
            <a href={row.link} target="_blank" rel="noreferrer">
              Open round
            </a>
          </span>
        </>
      )}
    </p>
  );
}
