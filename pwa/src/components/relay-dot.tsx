import type { JSX } from "preact";
import type { ConnectionState } from "../view.ts";

/**
 * The live relay indicator, shared by the spawn screen's settings pill and the
 * settings header so the same state never reads two ways. Connecting keeps a
 * steady dot and puts the sonar ring behind it: the ring precedes the dot in
 * the DOM, so it paints under rather than washing it out.
 */
export function RelayDot(props: { state: ConnectionState }): JSX.Element {
  const { state } = props;
  return (
    <span className="relay-dot-wrap" aria-hidden="true">
      {state === "connecting" && <span className="relay-sonar" />}
      <span className={`relay-dot relay-dot-${state}`} />
    </span>
  );
}
