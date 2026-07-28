/**
 * Service worker registration, done here rather than by vite-plugin-pwa's injected
 * script for two reasons. An installed PWA can be resumed for days without a
 * navigation, so the update check has to be tied to resume; and when a new build
 * does take over, the reload has to wait for a moment the screen is not in use.
 * A module also keeps the CSP free of a second inline script hash.
 *
 * `registerType: "autoUpdate"` alone is not enough: the plugin only applies its
 * skipWaiting/clientsClaim defaults when `injectRegister` is left at "auto", so
 * vite.config.ts sets those two workbox flags itself. Without them a new worker
 * installs and then waits forever behind the old one, which is the whole reason a
 * deployed fix never reached the phone.
 */

/** Must match vite-plugin-pwa's `filename`, whose default this relies on. */
const SW_URL = "/sw.js";

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  const container = navigator.serviceWorker;

  // A fresh install claims a page that loaded uncontrolled, which is not an update
  // and must not reload. Every controller swap after that one is: the document is
  // then running a build the active worker has already replaced. Tracked mutably
  // rather than snapshotted, or an install and an update in the same session read
  // the same and the update is swallowed.
  let controlled = container.controller !== null;
  let stale = false;

  const registration = container.register(SW_URL, { scope: "/" }).catch(() => {
    // A failed registration costs offline launch, not the session in front of you.
    return undefined;
  });

  container.addEventListener("controllerchange", () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    stale = true;
    // Backgrounded already: reload now so the next resume is the new build. A frozen
    // page never gets here, which the visibilitychange below covers.
    if (document.visibilityState === "hidden") location.reload();
  });

  document.addEventListener("visibilitychange", () => {
    // Either direction is a safe moment: going away nobody is looking, coming back
    // nothing has been typed yet, and both read as a cold launch rather than a jump.
    if (stale) {
      location.reload();
      return;
    }
    if (document.visibilityState !== "visible") return;
    void registration.then((active) => active?.update());
  });
}
