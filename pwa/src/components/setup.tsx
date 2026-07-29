import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { storeBearer, storePsk, storeRelayUrl } from "../relay/keys.ts";

/** Stands in for a secret that is already stored: the PSK cannot be read back, and the bearer is not worth showing. */
const MASK = "************";

export interface Credentials {
  readonly relayUrl: string;
  readonly bearer: string;
  readonly psk: string;
  readonly error: string | null;
  /** True once any field differs from what is stored; blank secrets are not edits. */
  readonly dirty: boolean;
  readonly hasBearer: boolean;
  readonly hasPsk: boolean;
  readonly setRelayUrl: (value: string) => void;
  readonly setBearer: (value: string) => void;
  readonly setPsk: (value: string) => void;
  /** Validates and writes the edited fields; false leaves `error` set to show. */
  readonly save: () => Promise<boolean>;
}

/**
 * The credential fields' state and save semantics, shared between first-run
 * setup and the settings screen: a field left blank keeps what is stored, so
 * only fields actually typed into are written.
 */
export function useCredentials(stored: { relayUrl: string; hasBearer: boolean; hasPsk: boolean }): Credentials {
  const [relayUrl, setRelayUrl] = useState(stored.relayUrl);
  const [bearer, setBearer] = useState("");
  const [psk, setPsk] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<boolean> => {
    setError(null);
    // Scheme matters, not just parseability: a WebSocket cannot be opened to http://.
    if (!URL.canParse(relayUrl) || !/^wss?:$/u.test(new URL(relayUrl).protocol)) {
      setError("The relay URL must start with wss:// (or ws:// locally).");
      return false;
    }
    const nextBearer = bearer.trim();
    const nextPsk = psk.trim();
    if (nextBearer === "" && !stored.hasBearer) {
      setError("The bearer token is required.");
      return false;
    }
    if (nextPsk === "" && !stored.hasPsk) {
      setError("The pre-shared key is required.");
      return false;
    }
    if (nextPsk !== "") {
      try {
        // Only proves the base64 decodes to 32 bytes. A wrong key imports fine and
        // shows up later as a registry that will not decrypt.
        await storePsk(nextPsk);
      } catch {
        setError("The pre-shared key must be 32 bytes of base64.");
        return false;
      }
    }
    storeRelayUrl(relayUrl.trim());
    if (nextBearer !== "") storeBearer(nextBearer);
    void navigator.storage?.persist?.();
    return true;
  };

  return {
    relayUrl,
    bearer,
    psk,
    error,
    dirty: relayUrl.trim() !== stored.relayUrl || bearer.trim() !== "" || psk.trim() !== "",
    hasBearer: stored.hasBearer,
    hasPsk: stored.hasPsk,
    setRelayUrl,
    setBearer,
    setPsk,
    save,
  };
}

/**
 * Field names and autocomplete hints are chosen so a 1Password Login item fills
 * both secrets in one tap: the bearer token takes the username slot (it is
 * anti-junk hygiene and authorizes nothing destructive) and the PSK the
 * password slot (it is the trust boundary). A real <form> with a submit button
 * is required for the extension's heuristics to fire at all; the same
 * attributes drive iOS Password AutoFill.
 *
 * On a configured install neither secret can be prefilled — the PSK is
 * non-extractable by design. A masked placeholder says "configured" where a
 * blank field would read as "lost".
 */
export function CredentialFields(props: { creds: Credentials }): JSX.Element {
  const { creds } = props;

  return (
    <>
      <label className="field" htmlFor="relay-url">
        <span className="label">RELAY URL</span>
        <input
          id="relay-url"
          name="relay-url"
          type="url"
          autoComplete="off"
          inputMode="url"
          value={creds.relayUrl}
          onInput={(event) => creds.setRelayUrl(event.currentTarget.value)}
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
          placeholder={creds.hasBearer ? MASK : undefined}
          value={creds.bearer}
          onInput={(event) => creds.setBearer(event.currentTarget.value)}
        />
      </label>

      <label className="field" htmlFor="password">
        <span className="label">PRE-SHARED KEY</span>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder={creds.hasPsk ? MASK : undefined}
          value={creds.psk}
          onInput={(event) => creds.setPsk(event.currentTarget.value)}
        />
      </label>

      {creds.error !== null && <span className="field-error">{creds.error}</span>}
    </>
  );
}

/**
 * First run, and the way back in after a rejected token: main.tsx renders this
 * instead of the app until both secrets exist. Editing them later lives on the
 * settings screen, which shares the fields above.
 */
export function Setup(props: {
  relayUrl: string;
  hasBearer: boolean;
  hasPsk: boolean;
  onSaved: () => void;
}): JSX.Element {
  const creds = useCredentials({ relayUrl: props.relayUrl, hasBearer: props.hasBearer, hasPsk: props.hasPsk });

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
          void creds.save().then((saved) => {
            if (saved) props.onSaved();
          });
        }}
      >
        <div className="setup-card card">
          <CredentialFields creds={creds} />
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
