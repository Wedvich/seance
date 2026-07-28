/**
 * Runtime half of the theme. The inline boot script in index.html has already
 * resolved and applied one before first paint; this only handles changes.
 */

export const THEME_PREFS = ["system", "dark", "light"] as const;

export type ThemePref = (typeof THEME_PREFS)[number];

const STORAGE_KEY = "seance:theme";

/** Matches `sur`, so the status bar continues the header rather than cutting it off. */
const THEME_COLOR = { dark: "#1c1a22", light: "#ffffff" } as const;

const darkMedia = (): MediaQueryList => window.matchMedia("(prefers-color-scheme: dark)");

function isThemePref(value: string | null): value is ThemePref {
  return value !== null && (THEME_PREFS as readonly string[]).includes(value);
}

export function readPref(): ThemePref {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemePref(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyPref(pref: ThemePref): void {
  const resolved = pref === "system" ? (darkMedia().matches ? "dark" : "light") : pref;
  const root = document.documentElement;
  root.dataset["themePref"] = pref;
  root.dataset["theme"] = resolved;
  root.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[resolved]);
}

export function setPref(pref: ThemePref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Storage may be blocked; the attributes on <html> still hold for this session.
  }
  applyPref(pref);
}

/** Live OS changes only matter while the pref is `system`, but the listener stays attached. */
export function watchSystemTheme(): () => void {
  const media = darkMedia();
  const onChange = (): void => {
    if (readPref() === "system") applyPref("system");
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
