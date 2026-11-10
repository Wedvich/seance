import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { PUSH_MAX_SUBSCRIPTIONS, type PushDevice } from "@seance/shared";
import {
  deviceRows,
  disablePush,
  enablePush,
  inspectPush,
  readDevices,
  removeDevice,
  type PushClient,
  type PushOffOutcome,
  type PushOutcome,
  type PushPrepared,
  type PushRemoveOutcome,
} from "../push.ts";
import { browserPushEnv, pushSupported } from "../push-browser.ts";
import { readPref, setPref, THEME_PREFS, type ThemePref } from "../theme.ts";
import type { ConnectionState } from "../view.ts";
import { RelayDot } from "./relay-dot.tsx";
import { Seg } from "./seg.tsx";
import { CredentialFields, useCredentials } from "./setup.tsx";

/** Matches the client's settle hold-back: a dial that hasn't resolved by then has failed. */
const RECONNECT_HOLD_MS = 1_500;

/** A Remove tap arms for this long; a second tap inside it confirms. */
const ARM_MS = 4_000;

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

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
  /** A full-screen layer goes back; a centred modal closes from the far corner. */
  closeStyle: "back" | "close";
  onDismiss: () => void;
  onReconnect: () => void;
  push: PushClient;
}): JSX.Element {
  const { relayLine, relayState, connected, closeStyle, onDismiss, onReconnect } = props;
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
          {closeStyle === "back" && (
            <button type="button" className="header-back" onClick={onDismiss} aria-label="Back">
              ‹
            </button>
          )}
          <div>
            <h1 className="header-title">Settings</h1>
            <p className="header-meta header-status">
              <RelayDot state={relayState} />
              {relayLine}
            </p>
          </div>
        </div>
        {closeStyle === "close" && (
          <button type="button" className="header-close" onClick={onDismiss} aria-label="Close">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </button>
        )}
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

        <NotificationsCard push={props.push} />
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

type PushView =
  | { readonly kind: "unsupported" | "denied" | "on" | "off" | "checking" | "working" | "stopping" }
  /** `retry`: what the button does again. An inspection that failed is read again; a click that failed is run again. */
  | { readonly kind: "failed"; readonly message: string; readonly retry: "inspect" | "enable" | "disable" };

function initialPushView(): PushView {
  if (!pushSupported()) return { kind: "unsupported" };
  return browserPushEnv.permission() === "denied" ? { kind: "denied" } : { kind: "checking" };
}

/** Null where the button says it all. */
const PUSH_LINES = {
  unsupported:
    "This browser can't do push. On iOS, add Séance to the Home Screen first (Share, then Add to Home Screen), then open it from there.",
  denied: "Notifications are blocked for Séance. Allow them in the browser's site settings, then come back.",
  on: null,
  off: null,
  checking: "Checking…",
  working: "Setting up…",
  stopping: "Turning off…",
} as const;

function NotificationsCard(props: { push: PushClient }): JSX.Element {
  const { push } = props;
  const [view, setView] = useState<PushView>(initialPushView);
  // What `inspectPush` read ahead of the click: the key and the push manager, so the click subscribes at once.
  const prepared = useRef<PushPrepared | null>(null);
  // What the last turn-off left behind: the leader still holding this browser's slot. Cleared by the next click or retry.
  const [note, setNote] = useState<string | null>(null);
  // The note lands after the card shows off, so a later click must outrank it: each clear starts a new generation.
  const noteGeneration = useRef(0);
  const clearNote = (): number => {
    noteGeneration.current += 1;
    setNote(null);
    return noteGeneration.current;
  };
  // Cancels the slot-freeing retries of the last turn-off. Not aborted on unmount: freeing the slot is still wanted after the person leaves Settings.
  const turnOff = useRef<AbortController | null>(null);
  const cancelTurnOff = (): void => {
    turnOff.current?.abort();
    turnOff.current = null;
  };
  // Null until an inspection succeeds: the list shows only when the record was read.
  const [devices, setDevices] = useState<readonly PushDevice[] | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [removeLine, setRemoveLine] = useState<string | null>(null);
  // Indices may shift whenever the list is replaced, so an armed tap must not outlive it.
  const replaceDevices = (next: readonly PushDevice[]): void => {
    setArmed(null);
    setDevices(next);
  };
  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  const checking = view.kind === "checking";
  // "On" is what this browser really holds, so permission alone never shows it: the browser is asked.
  useEffect(() => {
    if (!checking) return;
    let current = true;
    void inspectPush(push, browserPushEnv).then((result) => {
      if (!current) return;
      prepared.current = result.kind === "off" ? result.prepared : null;
      if (result.kind === "off" || result.kind === "on") {
        replaceDevices(result.devices);
        setView({ kind: result.kind });
      } else setView({ kind: "failed", message: result.message, retry: "inspect" });
    });
    return () => {
      current = false;
    };
  }, [push, checking]);

  // Called from the click itself, with no await before it: iOS grants permission only to a gesture.
  const enable = (): void => {
    const ready = prepared.current;
    prepared.current = null;
    cancelTurnOff();
    clearNote();
    setView({ kind: "working" });
    // `enablePush` never rejects; the catch is for a throw it did not foresee, so the card cannot stick on "Setting up…".
    enablePush(push, browserPushEnv, ready)
      .catch((): PushOutcome => ({ kind: "failed", message: "Couldn't set up notifications.", retryable: false }))
      .then((outcome) => {
        setView(outcome.kind === "enabled" ? { kind: "on" } : outcomeView(outcome));
        if (outcome.kind !== "enabled") return;
        // So the new row appears. `readDevices`, not `inspectPush`: that one clears the opt-out mark, which a Turn off started meanwhile has just set.
        void readDevices(push, browserPushEnv).then((list) => {
          if (list !== null) replaceDevices(list);
        });
      });
  };
  // Re-inspected after, so a later Enable has what it needs ready for the gesture. Not after the note: the
  // browser holds no subscription by then (or the op already answered), so the leader's answer changes nothing it reads.
  const disable = (): void => {
    prepared.current = null;
    cancelTurnOff();
    const controller = new AbortController();
    turnOff.current = controller;
    const generation = clearNote();
    setView({ kind: "stopping" });
    disablePush(push, browserPushEnv, {}, controller.signal)
      .catch((): PushOffOutcome => ({ kind: "failed", message: "Couldn't turn notifications off.", retryable: false }))
      .then((outcome) => {
        if (outcome.kind === "failed") {
          setView({ kind: "failed", message: outcome.message, retry: "disable" });
          return;
        }
        void outcome.note.then((line) => {
          if (noteGeneration.current === generation) setNote(line);
        });
        // The turn-off worked, so a failing read is still "off": Enable prepares after the prompt when it has nothing ready.
        void inspectPush(push, browserPushEnv).then((result) => {
          prepared.current = result.kind === "off" ? result.prepared : null;
          if (result.kind === "on" || result.kind === "off") replaceDevices(result.devices);
          setView({ kind: result.kind === "on" ? "on" : "off" });
        });
      });
  };
  const retry = (): void => {
    if (view.kind !== "failed") return;
    cancelTurnOff();
    clearNote();
    if (view.retry === "inspect") setView({ kind: "checking" });
    else if (view.retry === "disable") disable();
    else enable();
  };

  // The endpoint is read only here, into a local: nothing rendered, keyed or logged carries it.
  const remove = (index: number): void => {
    if (removing !== null || devices === null) return;
    if (armed !== index) {
      setArmed(index);
      return;
    }
    const device = devices[index];
    if (device === undefined) return;
    setArmed(null);
    setRemoving(index);
    setRemoveLine(null);
    removeDevice(push, device.endpoint)
      .catch((): PushRemoveOutcome => ({ kind: "failed", message: "Couldn't remove the device.", retryable: false }))
      .then((outcome) => {
        // By endpoint, not index: the list may have been replaced while this ran. Cleared with the row, so the
        // device that slides into `index` does not read "Removing…" during the re-read.
        if (outcome.kind === "removed") {
          setDevices((held) => held?.filter((d) => d.endpoint !== device.endpoint) ?? null);
          setRemoving(null);
        } else setRemoveLine(outcome.message);
        return readDevices(push, browserPushEnv);
      })
      .then((list) => {
        if (list !== null) replaceDevices(list);
      })
      .finally(() => setRemoving(null));
  };

  const busy = view.kind === "working" || view.kind === "stopping";
  const canEnable = view.kind === "off" || view.kind === "failed" || view.kind === "working";
  const canDisable = view.kind === "on" || view.kind === "stopping";
  const line = view.kind === "failed" ? view.message : PUSH_LINES[view.kind];
  return (
    <div className="push-card card">
      <div className="push-head">
        <span className="theme-title">Notifications</span>
        {canEnable && (
          <button type="button" className="push-button" disabled={busy} onClick={view.kind === "off" ? enable : retry}>
            {view.kind === "failed" ? "Try again" : "Enable"}
          </button>
        )}
        {canDisable && (
          <button type="button" className="push-button" disabled={busy} onClick={disable}>
            Turn off
          </button>
        )}
      </div>
      {line !== null && <p className="push-line">{line}</p>}
      {note !== null && <p className="push-line">{note}</p>}
      {devices !== null && (
        <div className="push-devices">
          <span className="push-devices-title">
            Devices ({devices.length} of {PUSH_MAX_SUBSCRIPTIONS})
          </span>
          {deviceRows(devices).map((row, index) => (
            // The index, never the endpoint: nothing rendered may carry one.
            // oxlint-disable-next-line react/no-array-index-key
            <div key={index} className="push-device">
              <span className="push-device-title">{row.title}</span>
              {row.addedAt !== undefined && <span className="push-device-meta">Added {DATE.format(row.addedAt)}</span>}
              {row.self && <span className="push-device-meta">This device</span>}
              {!row.self && (
                <button
                  type="button"
                  className="push-device-remove"
                  disabled={removing !== null}
                  onClick={() => remove(index)}
                >
                  {removing === index ? "Removing…" : armed === index ? "Tap again to remove" : "Remove"}
                </button>
              )}
            </div>
          ))}
          {removeLine !== null && <p className="push-line">{removeLine}</p>}
        </div>
      )}
    </div>
  );
}

function outcomeView(outcome: Exclude<PushOutcome, { readonly kind: "enabled" }>): PushView {
  return outcome.kind === "denied" ? { kind: "denied" } : { kind: "failed", message: outcome.message, retry: "enable" };
}

function ThemeSeg(props: { value: ThemePref; onChange: (pref: ThemePref) => void }): JSX.Element {
  return (
    <Seg
      label="Theme"
      options={THEME_PREFS}
      value={props.value}
      render={(pref) => (
        <>
          <ThemeIcon pref={pref} />
          {THEME_LABELS[pref]}
        </>
      )}
      onChange={props.onChange}
    />
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
