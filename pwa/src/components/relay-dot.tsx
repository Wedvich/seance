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

/**
 * Segmented pill: the flat track carries passive relay status, the raised face
 * is the settings action. One button, so the whole pill is the hit target —
 * 4px of padding around a 36px face clears 44px without a hit-area hack.
 */
export function RelaySettings(props: { state: ConnectionState; onClick: () => void }): JSX.Element {
  const { state, onClick } = props;
  return (
    <button
      type="button"
      className="relay-group"
      onClick={onClick}
      aria-label="Relay settings"
      title={`Relay: ${state}`}
    >
      <span className="relay-status">
        <RelayDot state={state} />
      </span>
      <span className="relay-cog" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          width="17"
          height="17"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </span>
    </button>
  );
}
