import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { storeBearer, storePsk, storeRelayUrl } from "../relay/keys.ts";

/** Stands in for a secret that is already stored: the PSK cannot be read back, and the bearer is not worth showing. */
const MASK = "************";

/**
 * First run, and the way back in after a rejected token. Field names and
 * autocomplete hints are chosen so a 1Password Login item fills both secrets in
 * one tap: the bearer token takes the username slot (it is anti-junk hygiene and
 * authorizes nothing destructive) and the PSK the password slot (it is the trust
 * boundary). A real <form> with a submit button is required for the extension's
 * heuristics to fire at all; the same attributes drive iOS Password AutoFill.
 *
 * Reached again from Settings on a configured install, where neither secret can be
 * prefilled — the PSK is non-extractable by design. A masked placeholder says
 * "configured" where a blank field would read as "lost", and a field left blank
 * keeps what is stored, so the screen is editable without being a re-entry chore.
 */
export function Setup(props: {
  relayUrl: string;
  hasBearer: boolean;
  hasPsk: boolean;
  onSaved: () => void;
  onCancel?: (() => void) | undefined;
}): JSX.Element {
  const { hasBearer, hasPsk, onCancel } = props;
  const [relayUrl, setRelayUrl] = useState(props.relayUrl);
  const [bearer, setBearer] = useState("");
  const [psk, setPsk] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    // Scheme matters, not just parseability: a WebSocket cannot be opened to http://.
    if (!URL.canParse(relayUrl) || !/^wss?:$/u.test(new URL(relayUrl).protocol)) {
      setError("The relay URL must start with wss:// (or ws:// locally).");
      return;
    }
    const nextBearer = bearer.trim();
    const nextPsk = psk.trim();
    if (nextBearer === "" && !hasBearer) {
      setError("The bearer token is required.");
      return;
    }
    if (nextPsk === "" && !hasPsk) {
      setError("The pre-shared key is required.");
      return;
    }
    if (nextPsk !== "") {
      try {
        // Only proves the base64 decodes to 32 bytes. A wrong key imports fine and
        // shows up later as a registry that will not decrypt.
        await storePsk(nextPsk);
      } catch {
        setError("The pre-shared key must be 32 bytes of base64.");
        return;
      }
    }
    storeRelayUrl(relayUrl.trim());
    if (nextBearer !== "") storeBearer(nextBearer);
    void navigator.storage?.persist?.();
    props.onSaved();
  };

  return (
    <>
      <header className="header">
        <div className="header-lead">
          {onCancel !== undefined && (
            <button type="button" className="header-back" onClick={onCancel} aria-label="Back">
              ‹
            </button>
          )}
          <div>
            <h1 className="header-title">Séance</h1>
            <p className="header-meta">{hasBearer && hasPsk ? "update your keys" : "paste your keys once"}</p>
          </div>
        </div>
      </header>

      <form
        id="setup-form"
        className="setup"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="setup-card card">
          <label className="field" htmlFor="relay-url">
            <span className="label">RELAY URL</span>
            <input
              id="relay-url"
              name="relay-url"
              type="url"
              autoComplete="off"
              inputMode="url"
              value={relayUrl}
              onInput={(event) => setRelayUrl(event.currentTarget.value)}
            />
          </label>

          <label className="field" htmlFor="username">
            <span className="label">BEARER TOKEN</span>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellcheck={false}
              placeholder={hasBearer ? MASK : undefined}
              value={bearer}
              onInput={(event) => setBearer(event.currentTarget.value)}
            />
            {hasBearer && <span className="field-hint">Stored on this device. Leave blank to keep it.</span>}
          </label>

          <label className="field" htmlFor="password">
            <span className="label">PRE-SHARED KEY</span>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder={hasPsk ? MASK : undefined}
              value={psk}
              onInput={(event) => setPsk(event.currentTarget.value)}
            />
            <span className="field-hint">
              32 bytes of base64. It is stored as a non-extractable key and never shown again — keep 1Password as the
              source of truth.
              {hasPsk && " Leave blank to keep the stored key."}
            </span>
          </label>

          {error !== null && <span className="field-error">{error}</span>}
        </div>
      </form>

      <footer className="footer">
        {/* Associated by id so the pinned footer button still submits the form,
            which is also what 1Password's heuristics look for. */}
        <button type="submit" form="setup-form" className="primary">
          Connect
        </button>
      </footer>
    </>
  );
}
