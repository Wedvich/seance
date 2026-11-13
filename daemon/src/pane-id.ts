/**
 * tmux's own pane-id form, and the only target a wire-supplied id may name:
 * `-t` would also resolve `main:1.0`, `{marked}` or `=name`, none of which a
 * session list ever handed out. Its own module so `state.ts`, which the archivist loads, can validate a pane
 * id without loading the despawn path (`archivist/test/layering.test.ts`).
 */
export const PANE_ID = /^%\d+$/u;
