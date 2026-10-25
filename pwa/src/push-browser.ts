import type { RelayClient } from "@seance/shared";
import { resyncPush, type PushClient, type PushEnv } from "./push.ts";

/** The browser's Notification and PushManager as `PushEnv`; kept apart from push.ts so tests need no DOM. */
export const browserPushEnv: PushEnv = {
  permission: () => Notification.permission,
  requestPermission: () => Notification.requestPermission(),
  manager: async () => (await navigator.serviceWorker.ready).pushManager,
};

/** False on a browser without the three APIs, and on iOS outside a Home Screen install. */
export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/**
 * Re-sends this browser's subscription once per page load, when permission was already
 * granted and a leader is verified. It waits for that moment rather than asking at boot,
 * when the socket is still dialling and every request would fail.
 */
export function watchPushResync(client: RelayClient, push: PushClient = client): void {
  if (!pushSupported() || Notification.permission !== "granted") return;
  const ready = (): boolean => {
    const state = client.getState();
    return state.status === "open" && state.scheduler.kind === "ready";
  };
  const run = (): void => void resyncPush(push, browserPushEnv);
  if (ready()) {
    run();
    return;
  }
  const unsubscribe = client.subscribe(() => {
    if (!ready()) return;
    unsubscribe();
    run();
  });
}
