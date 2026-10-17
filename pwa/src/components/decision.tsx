import type { JSX } from "preact";
import type { DecisionLine, DecisionSummary } from "../decision-view.ts";

function Line(props: { line: DecisionLine; quota: boolean }): JSX.Element {
  const { line, quota } = props;
  const lead = line.outcome === "chosen" ? "Chose" : line.outcome === "scored" ? "Passed over" : "Rejected";
  return (
    <li className={`decision-line decision-${line.outcome}`}>
      <span className="decision-where">
        <span className="decision-lead">{lead}</span> {line.where}
      </span>
      <span className="decision-why">{line.why}</span>
      {quota && line.quota !== null && <span className="decision-quota">{line.quota}</span>}
    </li>
  );
}

/**
 * The record's "chose X because …, rejected Y because …", one row per
 * candidate. Losers sit behind a disclosure: the winner is the answer, the
 * rest is the explanation someone asks for. `quota` adds the reading each
 * candidate was judged on — the placed task's record shows it; the form's
 * preview, read before anything is queued, leaves it out.
 */
export function DecisionCard(props: {
  summary: DecisionSummary;
  title: string;
  quota: boolean;
  /** How long ago the decision was made, for a card that can outlive the fleet it read. */
  age?: string;
}): JSX.Element {
  const { summary, title, quota, age } = props;
  const others = summary.others.length + (summary.omitted?.count ?? 0);
  return (
    <section className="decision card" aria-label={title}>
      <span className="label">
        {title}
        {age !== undefined && <span className="decision-age"> · decided {age}</span>}
      </span>
      <p className="decision-headline">{summary.headline}</p>
      {summary.chosen !== null && (
        <ul className="decision-lines">
          <Line line={summary.chosen} quota={quota} />
        </ul>
      )}
      {others > 0 && (
        <details className="decision-others" open={summary.chosen === null}>
          <summary>
            {others} other {others === 1 ? "candidate" : "candidates"}
          </summary>
          <ul className="decision-lines">
            {summary.others.map((line) => (
              <Line key={line.id} line={line} quota={quota} />
            ))}
            {summary.omitted !== null && <li className="decision-omitted">{summary.omitted.text}</li>}
          </ul>
        </details>
      )}
    </section>
  );
}
