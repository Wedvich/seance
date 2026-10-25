/*
 * Web Push handlers, pulled into the generated worker by `importScripts` (vite.config.ts) so
 * the precache and the update path stay the plugin's. Plain classic script: no imports, only `self`.
 *
 * A push always shows a notification, even for a payload it cannot read: Chrome shows its own
 * "updated in the background" one otherwise, and WebKit revokes a subscription after a few
 * silent pushes. The text is fixed per kind, a spill's window label shown only as one of the known
 * `5h`/`7d`; the payload carries ids and state, never a title or a prompt, and this worker holds no
 * PSK to open anything more.
 */

// A function scope, so nothing here lands in the global scope the generated worker shares.
(() => {
  "use strict";

  /** `ROUTING_ID_PATTERN` (shared/src/types.ts), as `isTaskId` applies it. Copied: this file imports nothing; push-sw.test.ts holds the two together. */
  const TASK_ID = /^[A-Za-z0-9._-]{1,64}$/u;

  /** The only targets a click opens, built here from a validated id. The app reads them in main.tsx. */
  const TASK_URL = /^\/\?task=[A-Za-z0-9._-]{1,64}$/u;
  const MACHINES_URL = "/?screen=machines";

  const FALLBACK = { body: "Something needs your attention.", tag: "seance", url: null };

  /**
   * The quota windows the scheduler labels a spill with (`windowsOf`, scheduler/src/route.ts): `5h`, `7d`,
   * and a per-model weekly `7d <model>`. Only these are shown, as the fixed `5h` or `7d`: a label is the
   * payload's, and the text stays this file's. Anything else is left out of the text.
   */
  function windowShown(label) {
    if (typeof label !== "string") return "";
    if (label === "5h" || label === "7d") return label;
    return label.startsWith("7d ") ? "7d" : "";
  }

  /** What a push says, or null for one this worker cannot read: unknown kind or version, a bad id. */
  function describe(alert) {
    if (alert === null || typeof alert !== "object" || alert.v !== 1) return null;
    if (alert.kind === "disk") {
      if (typeof alert.deviceId !== "string" || !TASK_ID.test(alert.deviceId)) return null;
      return { body: "A machine's disk is nearly full.", tag: `disk:${alert.deviceId}`, url: MACHINES_URL };
    }
    if (typeof alert.taskId !== "string" || !TASK_ID.test(alert.taskId)) return null;
    const url = `/?task=${encodeURIComponent(alert.taskId)}`;
    if (alert.kind === "needs-input") {
      const body =
        alert.escalated === true ? "A task is still waiting for input (30 min)." : "A task is waiting for input.";
      return { body, tag: `needs-input:${alert.taskId}`, url };
    }
    if (alert.kind === "spill") {
      const window = windowShown(alert.window);
      const pct = Number.isFinite(alert.projectedPct) ? Math.round(alert.projectedPct) : null;
      const where = pct === null ? window : window === "" ? `${pct}%` : `${window} at ${pct}%`;
      return {
        body: where === "" ? "A task is spending credits." : `A task is spending credits (${where}).`,
        tag: `spill:${alert.taskId}`,
        url,
      };
    }
    return null;
  }

  function readAlert(event) {
    try {
      return describe(event.data?.json()) ?? FALLBACK;
    } catch {
      return FALLBACK;
    }
  }

  self.addEventListener("push", (event) => {
    const { body, tag, url } = readAlert(event);
    // A tag replaces the notification already shown under it, silently unless `renotify`: the 30-minute
    // escalation and a repeated disk alert reuse their first alert's tag and must still be heard.
    event.waitUntil(
      self.registration.showNotification("Séance", {
        body,
        tag,
        renotify: true,
        ...(url === null ? {} : { data: { url } }),
      }),
    );
  });

  /** The notification's own target, re-checked: a path this file built, never anything else. */
  function targetOf(notification) {
    const url = notification.data?.url;
    if (typeof url !== "string") return null;
    return url === MACHINES_URL || TASK_URL.test(url) ? url : null;
  }

  async function openTarget(url) {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (open === undefined) return self.clients.openWindow(url ?? "/");
    await open.focus();
    // A running app has no boot to read the query from; it is told instead. The empty
    // transfer list is Client.postMessage's second argument; no origin check applies to a Client.
    if (url !== null) open.postMessage({ t: "open", url }, []);
    return undefined;
  }

  self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(openTarget(targetOf(event.notification)));
  });
})();
