/**
 * Names of the Web Share Target (DESIGN.md, "Attachments", Share target): the manifest's
 * `share_target` (vite.config.ts), the drain (share-inbox.ts), and the worker's handler,
 * which spells each out inline instead (share-handler.ts says why; share.test.ts holds
 * the two to each other). No imports: vite.config.ts loads this under Node.
 */

/** Must keep answering, even after the feature goes: an installed WebAPK posts here until Chrome refreshes its manifest. */
export const SHARE_ACTION = "/share";
export const SHARE_FILES_FIELD = "files";
/** A Cache Storage name of its own: `cleanupOutdatedCaches` deletes only workbox precache names. */
export const SHARE_INBOX = "seance-share-inbox";
/** A share's meta entry is `<prefix><id>`, its files `<prefix><id>/<n>`. */
export const SHARE_INBOX_PATH = "/share-inbox/";
/** The redirect's query key; its value is empty, or `unreadable` when the handler threw. */
export const SHARE_MARKER = "shared";
export const SHARE_UNREADABLE = "unreadable";
