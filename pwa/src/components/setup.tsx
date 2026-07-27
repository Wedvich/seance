import { useState } from "react";
import { storeBearer, storePsk, storeRelayUrl } from "../relay/keys.ts";

/**
 * First run, and the way back in after a rejected token. Field names and
 * autocomplete hints are chosen so a 1Password Login item fills both secrets in
 * one tap: the bearer token takes the username slot (it is anti-junk hygiene and
 * authorizes nothing destructive) and the PSK the password slot (it is the trust
 * boundary). A real <form> with a submit button is required for the extension's
 * heuristics to fire at all; the same attributes drive iOS Password AutoFill.
 */
export function Setup(props: { relayUrl: string; onSaved: () => void }): React.JSX.Element {
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
    if (bearer.trim() === "") {
      setError("The bearer token is required.");
      return;
    }
    try {
      // Only proves the base64 decodes to 32 bytes. A wrong key imports fine and
      // shows up later as a registry that will not decrypt.
      await storePsk(psk.trim());
    } catch {
      setError("The pre-shared key must be 32 bytes of base64.");
      return;
    }
    storeRelayUrl(relayUrl.trim());
    storeBearer(bearer.trim());
    void navigator.storage?.persist?.();
    props.onSaved();
  };

  return (
    <>
      <header className="header">
        <div>
          <h1 className="header-title">Séance</h1>
          <p className="header-meta">paste your keys once</p>
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
              onChange={(event) => setRelayUrl(event.target.value)}
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
              spellCheck={false}
              value={bearer}
              onChange={(event) => setBearer(event.target.value)}
            />
          </label>

          <label className="field" htmlFor="password">
            <span className="label">PRE-SHARED KEY</span>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={psk}
              onChange={(event) => setPsk(event.target.value)}
            />
            <span className="field-hint">
              32 bytes of base64. It is stored as a non-extractable key and never shown again — keep 1Password as the
              source of truth.
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
