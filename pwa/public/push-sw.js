/*
 * Web Push handlers, pulled into the generated worker by `importScripts` (vite.config.ts) so
 * the precache and the update path stay the plugin's. Plain classic script: no imports, only `self`.
 *
 * A push always shows a notification, even for a payload it cannot read: Chrome shows its own
 * "updated in the background" one otherwise, and WebKit revokes a subscription after a few
 * silent pushes. The text is generic on purpose; the payload carries ids and state, never a
 * title or a prompt.
 */

const BODIES = {
  spill: "An account is close to its usage limit.",
  "needs-input": "A task is waiting for input.",
  disk: "A machine is low on disk.",
};
const FALLBACK_BODY = "Something needs your attention.";

/** The alert's kind and id when the payload parses, else null: a tag only collapses repeats of one alert. */
function readAlert(event) {
  try {
    const alert = event.data?.json();
    if (alert === null || typeof alert !== "object" || typeof alert.kind !== "string") return null;
    if (!Object.hasOwn(BODIES, alert.kind)) return null;
    const id = alert.kind === "disk" ? alert.deviceId : alert.taskId;
    return { kind: alert.kind, id: typeof id === "string" ? id : "" };
  } catch {
    return null;
  }
}

self.addEventListener("push", (event) => {
  const alert = readAlert(event);
  event.waitUntil(
    self.registration.showNotification("Séance", {
      body: alert === null ? FALLBACK_BODY : BODIES[alert.kind],
      tag: alert === null ? "seance" : `${alert.kind}:${alert.id}`,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      return open === undefined ? self.clients.openWindow("/") : open.focus();
    }),
  );
});
