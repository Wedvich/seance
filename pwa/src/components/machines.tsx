import type { JSX } from "preact";
import { useMemo } from "preact/hooks";
import { chartLines } from "../chart.ts";
import type { AccountCard, Gauge, MachineCard, MachinesView, QuotaBar } from "../machines-view.ts";
import { HISTORY_RANGES, type HistoryRange, type HistoryTarget, type HistoryView } from "../state.ts";
import type { ConnectionState } from "../view.ts";
import { RelayDot } from "./relay-dot.tsx";
import { Seg } from "./seg.tsx";

const TARGET_LABELS: Record<HistoryTarget["kind"], string> = { machine: "Pressure", account: "Quota" };

/** Opens on a day: long enough to show a working pattern, on the tier that fits it. */
const DEFAULT_RANGE: HistoryRange = "24h";

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
  onDismiss: () => void;
  onShowHistory: (target: HistoryTarget, range: HistoryRange) => void;
  onHideHistory: () => void;
}): JSX.Element {
  const { view, relayLine, relayState, settled, history, onDismiss, onShowHistory, onHideHistory } = props;

  return (
    <>
      <header className="header">
        <div className="header-lead">
          <button type="button" className="header-back" onClick={onDismiss} aria-label="Back">
            ‹
          </button>
          <div>
            <h1 className="header-title">Machines</h1>
            <p className="header-meta header-status">
              <RelayDot state={relayState} />
              {relayLine}
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
        {view.accounts.map((account) => (
          <AccountCardView
            key={account.accountId}
            account={account}
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
  onShowHistory: (target: HistoryTarget, range: HistoryRange) => void;
  onHideHistory: () => void;
}): JSX.Element {
  const { card, history, onShowHistory, onHideHistory } = props;
  const target: HistoryTarget = { kind: "machine", deviceId: card.deviceId };

  return (
    <section className="fleet-card card">
      <div className="fleet-card-head">
        <span className={card.connected ? "dot dot-ok" : "dot"} aria-hidden="true" />
        <div className="fleet-card-title">
          <h2 className="fleet-name">{card.name}</h2>
          <p className="fleet-meta">{card.meta}</p>
        </div>
        <HistoryToggle
          available={card.charts}
          history={history}
          onShow={() => onShowHistory(target, DEFAULT_RANGE)}
          onHide={onHideHistory}
        />
      </div>

      {card.gauges.length > 0 && (
        <div className="bars">
          {card.gauges.map((entry) => (
            <Bar key={entry.label} gauge={entry} trailing={`${entry.pct}%`} />
          ))}
        </div>
      )}

      {card.note !== null && <p className="fleet-note">{card.note}</p>}

      {card.exclaves.length > 0 && (
        <ul className="exclaves">
          {card.exclaves.map((row) => (
            <li key={row.id} className="exclave">
              <span className="exclave-id">{row.id}</span>
              <span className="exclave-account">{row.account}</span>
              <span className="exclave-sessions">
                {row.sessions === null ? "–" : `${row.sessions} ${row.sessions === 1 ? "session" : "sessions"}`}
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
  history: HistoryView | null;
  onShowHistory: (target: HistoryTarget, range: HistoryRange) => void;
  onHideHistory: () => void;
}): JSX.Element {
  const { account, history, onShowHistory, onHideHistory } = props;
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
          onShow={() => target !== null && onShowHistory(target, DEFAULT_RANGE)}
          onHide={onHideHistory}
        />
      </div>
      {account.bars.length > 0 && (
        <div className="bars">
          {account.bars.map((bar) => (
            <Bar key={bar.label} gauge={bar} trailing={quotaTrailing(bar)} />
          ))}
        </div>
      )}
      <p className="fleet-note">{account.observed}</p>
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
    <button
      type="button"
      className="prompt-action fleet-toggle"
      aria-expanded={history !== null}
      onClick={history === null ? onShow : onHide}
    >
      {history === null ? "HISTORY" : "HIDE"}
    </button>
  );
}

function quotaTrailing(bar: QuotaBar): string {
  return bar.resets === null ? `${bar.pct}%` : `${bar.pct}% · ${bar.resets}`;
}

function Bar(props: { gauge: Gauge; trailing: string }): JSX.Element {
  const { gauge, trailing } = props;
  return (
    <div className="bar">
      <span className="bar-label">{gauge.label}</span>
      <span className="bar-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={gauge.pct}>
        <span className={`bar-fill bar-${gauge.level}`} style={{ width: `${gauge.pct}%` }} />
      </span>
      <span className="bar-value">{trailing}</span>
    </div>
  );
}

function HistoryChart(props: { history: HistoryView; onPick: (range: HistoryRange) => void }): JSX.Element {
  const { history, onPick } = props;
  const { result } = history;

  return (
    <div className="chart">
      <div className="chart-controls">
        <Seg label="Range" options={HISTORY_RANGES} value={history.range} render={(range) => range} onChange={onPick} />
      </div>
      {result.kind === "loading" && <p className="chart-status">Loading…</p>}
      {result.kind === "failed" && <p className="chart-status chart-failed">{result.message}</p>}
      {result.kind === "ok" && <ChartPlot history={history} series={result.series} />}
    </div>
  );
}

function ChartPlot(props: { history: HistoryView; series: Parameters<typeof chartLines>[0] }): JSX.Element {
  const { history, series } = props;
  const { from, to, step } = history;
  // The screen re-renders on every status beat; the geometry changes only with the reply or its window.
  const lines = useMemo(
    () =>
      chartLines(series, { from, to, step }, { width: CHART_WIDTH, height: CHART_HEIGHT }).filter(
        (line) => line.d !== "",
      ),
    [series, from, to, step],
  );
  if (lines.length === 0) return <p className="chart-status">Nothing recorded in this range.</p>;

  return (
    <>
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
    </>
  );
}
