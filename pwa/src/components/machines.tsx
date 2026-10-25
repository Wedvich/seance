import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import { type ChartLine, chartLines } from "../chart.ts";
import type { AccountCard, Gauge, GaugeIcon, MachineCard, MachinesView } from "../machines-view.ts";
import {
  HISTORY_RANGES,
  type AccountsState,
  type HistoryRange,
  type HistoryTarget,
  type HistoryView,
} from "../state.ts";
import { ACCOUNT_ALIAS_MAX_LENGTH } from "@seance/shared";
import type { ConnectionState } from "../view.ts";
import { Disclosure } from "./disclosure.tsx";
import { RelayDot } from "./relay-dot.tsx";
import { Seg } from "./seg.tsx";

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
  relayLine: string;
  relayState: ConnectionState;
  /** The registry is authoritative (`RelayState.registrySettled`). */
  settled: boolean;
  history: HistoryView | null;
  accounts: AccountsState;
  /** Absent in the desktop layout, where the screen is a column rather than a layer. */
  onDismiss?: () => void;
  onShowHistory: (target: HistoryTarget, range?: HistoryRange) => void;
  onHideHistory: () => void;
  /** Resolves once the rename has settled, however it ended. */
  onRename: (accountId: string, text: string) => Promise<void>;
  onDismissAccountNotice: () => void;
}): JSX.Element {
  const {
    view,
    relayLine,
    relayState,
    settled,
    history,
    accounts,
    onDismiss,
    onShowHistory,
    onHideHistory,
    onRename,
    onDismissAccountNotice,
  } = props;

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
            onShowHistory={onShowHistory}
            onHideHistory={onHideHistory}
          />
        ))}

        {view.accounts.length > 0 && <h2 className="label fleet-heading">Accounts</h2>}
        {view.accounts.length > 0 && !accounts.nameable && (
          <p className="fleet-note">Re-enter the pre-shared key in Settings to name accounts</p>
        )}
        {accounts.notice !== null && (
          <div className="banner card banner-err" role="alert">
            <span className="banner-rule" />
            <span className="banner-text">
              <span className="banner-body">{accounts.notice}</span>
            </span>
            <button type="button" className="queue-resume" onClick={onDismissAccountNotice}>
              Dismiss
            </button>
          </div>
        )}
        {view.accounts.map((account) => (
          <AccountCardView
            key={account.accountId}
            account={account}
            nameable={accounts.nameable}
            busy={accounts.saving !== null}
            onRename={onRename}
            history={
              history?.target.kind === "account" && history.target.accountId === account.accountId ? history : null
            }
            onShowHistory={onShowHistory}
            onHideHistory={onHideHistory}
          />
        ))}
      </div>
    </>
  );
}

function MachineCardView(props: {
  card: MachineCard;
  history: HistoryView | null;
  onShowHistory: (target: HistoryTarget, range?: HistoryRange) => void;
  onHideHistory: () => void;
}): JSX.Element {
  const { card, history, onShowHistory, onHideHistory } = props;
  const target: HistoryTarget = { kind: "machine", deviceId: card.deviceId };

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
          </div>
          <p className="fleet-meta">{card.meta}</p>
          {card.build !== null && <p className="fleet-meta fleet-build">{card.build}</p>}
        </div>
        <HistoryToggle
          available={card.charts}
          history={history}
          onShow={() => onShowHistory(target)}
          onHide={onHideHistory}
        />
      </div>

      {card.gauges.length > 0 && (
        <div className="bars">
          {card.gauges.map((entry) => (
            <Bar key={entry.label} gauge={entry} />
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
            </li>
          ))}
        </ul>
      )}

      {history !== null && <HistoryChart history={history} onPick={(range) => onShowHistory(target, range)} />}
    </section>
  );
}

function AccountCardView(props: {
  account: AccountCard;
  nameable: boolean;
  /** Some rename is in flight; one at a time. */
  busy: boolean;
  history: HistoryView | null;
  onRename: (accountId: string, text: string) => Promise<void>;
  onShowHistory: (target: HistoryTarget, range?: HistoryRange) => void;
  onHideHistory: () => void;
}): JSX.Element {
  const { account, nameable, busy, history, onRename, onShowHistory, onHideHistory } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const { historyFrom } = account;
  // Pinned to the host it was opened against: a range change re-asks that one,
  // and a host gone since leaves the chart to say so rather than switch sources.
  const host = history?.target.kind === "account" ? history.target.deviceId : historyFrom;
  const target: HistoryTarget | null =
    host === null ? null : { kind: "account", accountId: account.accountId, deviceId: host };

  return (
    <section className="fleet-card card">
      <div className="fleet-card-head">
        <div className="fleet-card-title">
          <h2 className="fleet-name">{account.title}</h2>
          <p className="fleet-meta">{account.detail}</p>
        </div>
        <HistoryToggle
          available={target !== null}
          history={history}
          onShow={() => target !== null && onShowHistory(target)}
          onHide={onHideHistory}
        />
      </div>
      {account.bars.length > 0 && (
        <div className="bars">
          {account.bars.map((bar) => (
            <Bar key={bar.label} gauge={bar} note={bar.note} />
          ))}
        </div>
      )}
      <p className="fleet-note">{account.observed}</p>
      {nameable && !editing && (
        <button
          type="button"
          className="fleet-rename"
          onClick={() => {
            setDraft(account.alias ?? "");
            setEditing(true);
          }}
        >
          Rename
        </button>
      )}
      {nameable && editing && (
        <form
          className="fleet-rename-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onRename(account.accountId, draft).then(() => setEditing(false));
          }}
        >
          <input
            type="text"
            aria-label="Account name"
            placeholder="Name this account"
            maxLength={ACCOUNT_ALIAS_MAX_LENGTH}
            value={draft}
            disabled={busy}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
          <button type="submit" className="queue-resume" disabled={busy}>
            Save
          </button>
          <button type="button" className="queue-resume" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      )}
      {history !== null && target !== null && (
        <HistoryChart history={history} onPick={(range) => onShowHistory(target, range)} />
      )}
    </section>
  );
}

function HistoryToggle(props: {
  available: boolean;
  history: HistoryView | null;
  onShow: () => void;
  onHide: () => void;
}): JSX.Element | null {
  const { available, history, onShow, onHide } = props;
  // Kept while a chart is open even if its source drops: it is the chart's only close.
  if (!available && history === null) return null;
  return (
    <Disclosure
      open={history !== null}
      label={history === null ? "History" : "Hide"}
      onToggle={history === null ? onShow : onHide}
    />
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

function HistoryChart(props: { history: HistoryView; onPick: (range: HistoryRange) => void }): JSX.Element {
  const { history, onPick } = props;
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
        <Seg label="Range" options={HISTORY_RANGES} value={history.range} render={(range) => range} onChange={onPick} />
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
