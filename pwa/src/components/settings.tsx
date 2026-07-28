import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { nextPref, readPref, setPref, type ThemePref } from "../theme.ts";
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
      {/* Cycles rather than opening a nested sheet: two scrims on a phone is worse
          than a three-value tap target. */}
      <SheetItem
        label="Theme"
        sub={THEME_LABELS[theme]}
        onClick={() => {
          const next = nextPref(theme);
          setPref(next);
          setTheme(next);
        }}
      />
    </Sheet>
  );
}
