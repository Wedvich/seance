/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Relay the app dials. Prefilled into setup; the user can override it at runtime. */
  readonly VITE_RELAY_URL?: string;
}
