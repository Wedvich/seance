/**
 * The runtime half of globals.d.ts (which says why it isn't named after it):
 * the browser globals pwa/src/store.ts touches (visibilitychange in attach(),
 * history for layer symmetry), stubbed rather than injected because they are an
 * external boundary Bun does not provide. No-ops suffice — tests read verdicts
 * from getState() and never dismiss layers.
 *
 * One module rather than a copy per test file: a shard loads its files in no
 * particular order and a narrowed run loads only one, so every file that builds
 * a Store has to install these itself, and two hand-kept copies would silently
 * let the first-loaded one win with a shape the other never wrote.
 */
export function installBrowserGlobals(): void {
  Object.defineProperty(globalThis, "document", {
    value: { visibilityState: "visible", addEventListener(): void {}, removeEventListener(): void {} },
    configurable: true,
  });
  Object.defineProperty(globalThis, "history", {
    value: { pushState(): void {}, replaceState(): void {}, back(): void {} },
    configurable: true,
  });
}
