import { openLaunchLink, openMessage } from "./deep-link.ts";
import type { Store } from "./store.ts";

/**
 * Opens what the launch URL names and what the service worker later posts. The query is
 * stripped first, with the history entry's state kept: the layers an open pushes carry
 * their own, and a reload must not reopen the link.
 */
export function watchDeepLinks(store: Store): void {
  const { search, pathname } = location;
  if (search !== "") history.replaceState(history.state, "", pathname);
  openLaunchLink(store, search);

  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => openMessage(store, event.data));
}
