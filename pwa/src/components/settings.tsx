import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { readPref, setPref, THEME_PREFS, type ThemePref } from "../theme.ts";
import type { ConnectionState } from "../view.ts";
import { RelayDot } from "./relay-dot.tsx";
import { CredentialFields, useCredentials } from "./setup.tsx";

/** Matches the client's settle hold-back: a dial that hasn't resolved by then has failed. */
const RECONNECT_HOLD_MS = 1_500;

const THEME_LABELS: Record<ThemePref, string> = {
  system: "System",
  dark: "Dark",
  light: "Light",
};

/**
 * Reached from the relay chip: credentials, connection status and theme in one
 * place. Deliberately has no "Forget machine": DESIGN.md keeps the registry
 * append-only so the bearer token authorizes nothing destructive, and adding
 * one here would quietly undo that.
 */
export function Settings(props: {
  relayUrl: string;
  relayLine: string;
  relayState: ConnectionState;
  connected: boolean;
  onDismiss: () => void;
  onReconnect: () => void;
}): JSX.Element {
  const { relayLine, relayState, connected, onDismiss, onReconnect } = props;
  // Both secrets are known to exist: the app only mounts once they load.
  const creds = useCredentials({ relayUrl: props.relayUrl, hasBearer: true, hasPsk: true });
  const [theme, setTheme] = useState<ThemePref>(readPref);
  const [reconnecting, setReconnecting] = useState(false);

  // The client never reports a dial as failed — it just backs off and retries —
  // so the settle window is the honest bound on how long a tap can claim to be
  // doing something.
  useEffect(() => {
    if (!reconnecting) return;
    if (connected) {
      setReconnecting(false);
      return;
    }
    const timer = setTimeout(() => setReconnecting(false), RECONNECT_HOLD_MS);
    return () => clearTimeout(timer);
  }, [reconnecting, connected]);

  const submit = async (): Promise<void> => {
    if (creds.dirty) {
      // New credentials mean a new socket and a new key, so the cheapest correct
      // move is to boot from scratch. The form is persisted, so nothing is lost.
      if (await creds.save()) location.reload();
      return;
    }
    if (connected) {
      onDismiss();
      return;
    }
    if (reconnecting) return;
    setReconnecting(true);
    onReconnect();
  };

  return (
    <>
      <header className="header">
        <div className="header-lead">
          <button type="button" className="header-back" onClick={onDismiss} aria-label="Back">
            ‹
          </button>
          <div>
            <h1 className="header-title">Settings</h1>
            <p className="header-meta header-status">
              <RelayDot state={relayState} />
              {relayLine}
            </p>
          </div>
        </div>
      </header>

      <form
        id="settings-form"
        className="setup"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="setup-card card">
          <CredentialFields creds={creds} />
        </div>

        {/* Inline segmented control rather than a picker: three always-visible
            options beat another layer on a phone. */}
        <div className="theme-card card">
          <span className="theme-title">Theme</span>
          <ThemeSeg
            value={theme}
            onChange={(pref) => {
              setPref(pref);
              setTheme(pref);
            }}
          />
        </div>
      </form>

      <footer className="footer">
        {/* One bottom action: saves edits, retries the relay when it is down,
            and otherwise just returns — a separate "Reconnect now" row would
            duplicate it. */}
        <button type="submit" form="settings-form" className="primary">
          {reconnecting ? "Reconnecting…" : connected ? "Connect" : "Reconnect"}
        </button>
      </footer>
    </>
  );
}

function ThemeSeg(props: { value: ThemePref; onChange: (pref: ThemePref) => void }): JSX.Element {
  const { value, onChange } = props;
  const index = THEME_PREFS.indexOf(value);

  return (
    <div className="seg" role="radiogroup" aria-label="Theme">
      <span className="seg-thumb" style={{ transform: `translateX(${index * 100}%)` }} aria-hidden="true" />
      {THEME_PREFS.map((pref) => (
        <button
          key={pref}
          type="button"
          role="radio"
          aria-checked={pref === value}
          className="seg-btn"
          onClick={() => onChange(pref)}
        >
          <ThemeIcon pref={pref} />
          {THEME_LABELS[pref]}
        </button>
      ))}
    </div>
  );
}

const ICONS: Record<ThemePref, JSX.Element> = {
  // Half-filled circle: follows the OS, whichever half that lands on.
  system: (
    <>
      <circle cx="8" cy="8" r="5.7" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M8 2.3a5.7 5.7 0 0 1 0 11.4Z" fill="currentColor" stroke="none" />
    </>
  ),
  dark: (
    <path
      d="M13.4 10.1A5.7 5.7 0 1 1 5.9 2.6a4.7 4.7 0 0 0 7.5 7.5Z"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linejoin="round"
    />
  ),
  light: (
    <>
      <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path
        d="M8 .9v1.9M8 13.2v1.9M.9 8h1.9M13.2 8h1.9M3 3l1.3 1.3M11.7 11.7 13 13M13 3l-1.3 1.3M4.3 11.7 3 13"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </>
  ),
};

function ThemeIcon(props: { pref: ThemePref }): JSX.Element {
  return (
    <svg className="seg-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      {ICONS[props.pref]}
    </svg>
  );
}
