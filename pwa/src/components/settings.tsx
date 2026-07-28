import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { readPref, setPref, THEME_PREFS, type ThemePref } from "../theme.ts";
import { Sheet, SheetItem } from "./sheet.tsx";

const THEME_LABELS: Record<ThemePref, string> = {
  system: "System",
  dark: "Dark",
  light: "Light",
};

/**
 * Reached from the relay chip. Deliberately has no "Forget machine": DESIGN.md
 * keeps the registry append-only so the bearer token authorizes nothing
 * destructive, and adding one here would quietly undo that.
 */
export function SettingsSheet(props: {
  relayUrl: string;
  relayStatus: string;
  onClose: () => void;
  onOpenSetup: () => void;
  onReconnect: () => void;
}): JSX.Element {
  const { relayUrl, relayStatus, onClose, onOpenSetup, onReconnect } = props;
  const [theme, setTheme] = useState<ThemePref>(readPref);

  return (
    <Sheet title="Settings" onClose={onClose}>
      <SheetItem label="Relay & keys" sub={relayUrl} onClick={onOpenSetup} />
      <SheetItem label="Reconnect now" sub={relayStatus} onClick={onReconnect} />
      {/* Inline segmented control rather than a nested sheet: two scrims on a
          phone is worse than three always-visible options. */}
      <div className="sheet-item theme-row">
        <span className="sheet-item-label">Theme</span>
        <ThemeSeg
          value={theme}
          onChange={(pref) => {
            setPref(pref);
            setTheme(pref);
          }}
        />
      </div>
    </Sheet>
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
