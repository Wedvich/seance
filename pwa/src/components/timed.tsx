import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { formatStamp, type Moment, type Timed } from "../timed.ts";
import { hideTip, showTip } from "../tooltip.ts";

/** A relative time that shows its full timestamp on hover. */
export function Time(props: { moment: Moment }): JSX.Element {
  const { moment } = props;
  const node = useRef<HTMLTimeElement>(null);
  // A row that leaves while hovered gets no pointerleave to take its tip down.
  useEffect(
    () => () => {
      if (node.current !== null) hideTip(node.current);
    },
    [],
  );
  return (
    <time
      ref={node}
      className="reltime"
      dateTime={new Date(moment.at).toISOString()}
      // Mouse only: a touch has no hover, and its tap belongs to whatever row the time sits in.
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") showTip(event.currentTarget, formatStamp(moment.at));
      }}
      onPointerLeave={(event) => hideTip(event.currentTarget)}
    >
      {moment.text}
    </time>
  );
}

export function TimedText(props: { line: Timed }): JSX.Element {
  return <>{props.line.map((part) => (typeof part === "string" ? part : <Time key={part.at} moment={part} />))}</>;
}
