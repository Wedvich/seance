import type { JSX } from "preact";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { type ChartLine, chartLines } from "../chart.ts";
import type { AccountCard, ArchivistCard, Gauge, GaugeIcon, MachineCard, MachinesView } from "../machines-view.ts";
import {
  type AccountsState,
  type AvailabilityState,
  type HistoryRange,
  type HistoryTarget,
  type HistoryView,
} from "../state.ts";
import { ACCOUNT_ALIAS_MAX_LENGTH, type Machine } from "@seance/shared";
import type { ConnectionState } from "../view.ts";
import { StrokeIcon } from "./icons.tsx";
import { Menu, MenuDivider, MenuItem, MenuSwitchItem, MoreTrigger, useMenu } from "./menu.tsx";
import { RelayDot } from "./relay-dot.tsx";
import { Seg } from "./seg.tsx";
import { Sheet } from "./sheet.tsx";

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
  /** Asks a machine to close (false) or reopen (true); the confirm sheet for a close is this screen's. */
  onSetOpen: (deviceId: string, open: boolean) => void;
  /** The registry, which the confirm sheet's words are derived from (`closeSheet`). */
  machines: readonly Machine[];
  /** The confirm sheet's lines for a machine (`deriveCloseSheet`). */
  closeSheet: (machine: Machine) => readonly string[];
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
    onSetOpen,
    machines,
    closeSheet,
    onReadDrain,
    onDismiss,
    onShowHistory,
    onHideHistory,
    onOpenRename,
    onCloseRename,
    onRename,
  } = props;
  const { renaming } = accounts;
  const [closing, setClosing] = useState<string | null>(null);
  const closingCard = closing === null ? undefined : view.cards.find((card) => card.deviceId === closing);
  const closingMachine = closing === null ? undefined : machines.find((machine) => machine.deviceId === closing);
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
            onShowHistory={onShowHistory}
            onHideHistory={onHideHistory}
            onToggleOpen={(open) => {
              if (open) return onSetOpen(card.deviceId, true);
              onReadDrain(card.deviceId);
              setClosing(card.deviceId);
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
      {closingCard !== undefined && closingMachine !== undefined && (
        <CloseMachineDialog
          name={closingCard.name}
          lines={closeSheet(closingMachine)}
          onClose={() => setClosing(null)}
          onConfirm={() => {
            setClosing(null);
            onSetOpen(closingCard.deviceId, false);
          }}
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
  onShowHistory: (target: HistoryTarget, range?: HistoryRange) => void;
  onHideHistory: () => void;
  /** The switch's new state: true reopens at once, false asks for confirmation first. */
  onToggleOpen: (open: boolean) => void;
}): JSX.Element {
  const { card, history, ranges, availability, onShowHistory, onHideHistory, onToggleOpen } = props;
  // The asked state shows while the request is out and until the status agrees, so neither the switch nor the badge bounces back.
  const here = availability[card.deviceId] ?? null;
  const asked = here?.kind === "sending" || here?.kind === "sent" ? here.open : null;
  const switchOn = asked ?? card.openSwitch === "on";
  const closed = here?.kind === "sent" ? !here.open : card.closed;
  const offersMenu = card.charts || history !== null || card.openSwitch !== null;
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
          <p className="fleet-meta">{card.meta}</p>
          {card.build !== null && <p className="fleet-meta fleet-build">{card.build}</p>}
        </div>
        {offersMenu && (
          <>
            <MoreTrigger menu={menu} label={`More actions for ${card.name}`} />
            <Menu menu={menu} label={`Actions for ${card.name}`}>
              {card.openSwitch !== null && (
                <MenuSwitchItem
                  label="Open for work"
                  checked={switchOn}
                  closesMenu={switchOn}
                  onToggle={() => onToggleOpen(!switchOn)}
                />
              )}
              {card.openSwitch !== null && offersHistory && <MenuDivider />}
              {offersHistory && (
                <HistoryItem history={history} onShow={() => onShowHistory(target)} onHide={onHideHistory} />
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
          <p>Draining: {card.drain.summary}</p>
          {keyed(card.drain.stuck).map(({ key, line }) => (
            <p key={key} className="fleet-warn">
              {line}
            </p>
          ))}
        </div>
      )}
      {card.note !== null && <p className="fleet-note">{card.note}</p>}
      {card.updateNote !== null && <p className="fleet-note fleet-warn">{card.updateNote}</p>}

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
          <p className="fleet-meta">{card.meta}</p>
          {card.build !== null && <p className="fleet-meta fleet-build">{card.build}</p>}
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
      <p className="fleet-note">{card.note}</p>
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
      <p className="fleet-note">{account.observed}</p>
      {history !== null && target !== null && (
        <HistoryChart history={history} ranges={ranges} onPick={(range) => onShowHistory(target, range)} />
      )}
    </section>
  );
}

/** A switch, so the chart can be flipped on and off with the menu still open. */
function HistoryItem(props: { history: HistoryView | null; onShow: () => void; onHide: () => void }): JSX.Element {
  const { history, onShow, onHide } = props;
  return (
    <MenuSwitchItem
      label="History"
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

/** A close needs a yes: it stops the scheduler's new work landing there. Reopening needs none. */
function CloseMachineDialog(props: {
  name: string;
  lines: readonly string[];
  onClose: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const { name, lines, onClose, onConfirm } = props;
  return (
    <Sheet title={`Close ${name}?`} variant="dialog" onClose={onClose}>
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
          <button type="button" className="primary" onClick={onConfirm}>
            Close
          </button>
        </div>
      </div>
    </Sheet>
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
function Bar(props: { gauge: Gauge; note?: string | null }): JSX.Element {
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
      {note !== undefined && <span className="bar-reset">{note ?? ""}</span>}
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
