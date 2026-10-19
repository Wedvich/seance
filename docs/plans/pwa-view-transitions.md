# Plan: the PWA's screen and layer transitions on the View Transition API

## Context

The PWA's screen motion is hand-built in `pwa/src/app.tsx`, and every effect costs the same scaffolding:

- **`useScreenTransition`** keeps both screens mounted while classes play. That means `shown()`, `panelClass()`, `.stage-animating` to swallow taps, `onAnimationEnd` filtering on the `screen-` name prefix (which is why the dim keyframes are named `panel-*`), and a 600ms backstop timer.
- **`useDepthOne`** exists only so a pop keeps rendering the screen that is leaving after its flag has cleared.
- **`useVerdictExit`** keeps the verdict mounted through its exit (`closing`/`onExited`/`entering`, timers of 300ms and 300ms). `reusePrompt`/`retrySpawn` take the *rendered* verdict because of that lingering mount.
- **`SettingsDialog`** "stays open while its panel is still on stage".

Same-document view transitions (`document.startViewTransition`) do this in the browser. The old state is a snapshot, so the outgoing screen never has to stay mounted, and the browser composites the motion. Firefox on Android has had it since 144, and Chrome has it too. The goal is less code per effect and better motion on mobile, plus the one shared-element win: the `DecisionCard` keeps its place from the form's placement preview to the verdict.

Not in scope, by the owner's decision: the verdict's in-place `SwapText` and stage-track animations driven by network polls. They stay as they are.

**Sequencing.** The verdict rework (`worktree-session-3`) is not in this clone; `git branch -a` doesn't list it. Implementation starts after it merges, and steps 3–4 get re-checked against the merged `verdict.tsx`, because its mounting and key (now the task id) decide what counts as a verdict change.

**Worktree setup.** The repo has no worktree-setup section. The main checkout has only `pwa/.env.example` and `relay/.dev.vars.example`, so there is no `.env` to copy. `node_modules` is missing here, so step 0 is `bun install` at the root. Plan mode blocked that, and nothing else needed doing.

## What moves to the API and what stays

| Transition                                              | Today                                       | Decision                                                               |
| ------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| Phone push/pop: form ↔ Queue, Machines, Settings        | `panel-push/pop-*` slides, both mounted     | **Moves**                                                              |
| Form → verdict                                          | Per-element `verdict-in` stagger on mount   | **Moves** (adds the shared card); the stagger CSS stays as the entrance |
| Verdict → form                                          | `useVerdictExit` fade-through, `form-enter` | **Moves**                                                              |
| Desk Settings modal in/out                              | `layer-modal-in/out` + `::backdrop` anims   | **Moves** (its exit depended on the lingering mount being deleted)     |
| Bottom sheets                                           | `sheet-in/out`, `scrim-*`, `useSheetExit`   | **Stays**                                                              |
| Verdict in-place swaps (`SwapText`, stage track)        | opacity/transform, poll-driven              | **Stays** (owner decision)                                             |
| Verdict → a different verdict, without a form between   | remount, stagger                            | **Stays** (no transition: classifier returns null)                     |
| Skill picker, prompt action, `<details>`, spinner, sheen, sonar | CSS                                 | **Stays**                                                              |
| Desk columns (Queue/Machines beside the form)           | no motion                                   | **Stays**                                                              |

### Where the API would NOT be an improvement (the owner should weigh these)

1. **Sheets.** Only one view transition runs at a time, and starting a new one skips the running one to its end. Sheets open and close constantly, so a sheet transition would cut short a screen push and vice versa. During every transition the snapshot overlay also swallows taps, and the page stops rendering for the capture frame. The sheet's exit today deliberately leaves the form tappable (`sheet.tsx`'s focus-return comment). A sheet is also one element entering and leaving, which plain CSS already does well. `useSheetExit` keeps its lingering mount, and that is the honest cost of this choice.
2. **Network-driven changes in general.** Every view transition freezes the page for a frame and blocks input for its duration. A poll that lands while the user is typing must never cause one. This is why the classifier keys only on screen identity, never on content.
3. **Interruption.** A view transition can't be reversed mid-flight: a back during a push snaps the push to its end and then pops. Today's code restarts too, so this is no regression, but don't count it as a gain.
4. **Gesture-driven motion.** If an edge-swipe back that follows the finger is ever wanted, view transitions are the wrong tool: there is no scrubbable timeline we can rely on in Firefox. That would be its own design.
5. **Reduced motion and unsupported browsers** get no animation at all. That is today's behaviour under reduced motion, but under the fallback it is a downgrade (see Fallback).
6. **Absolutely nothing for the desk columns.**

## Integration: one hook at the store boundary

Every screen change already reaches the app through one place, the store subscription in `useStoreState`. That covers clicks, `popstate`, because `dismissLayer` is `history.back()` and closing therefore arrives asynchronously from `onPopState`, and network replies (`#showVerdict`). So the transition starts there, not in click handlers.

**New `pwa/src/transition.ts`** holds pure logic plus a runner with injected seams, so it is testable without a DOM. This follows `pwa/test`'s existing pure-module style.

- `screenKey(state, wide)` → `{ depth: 0|1, layer: "settings"|"queue"|"machines"|null, verdict: string|null, wide }`. The verdict identity uses the task id or the verdict object after session-3; content is never part of the key.
- `transitionKind(prev, next)` → `"push" | "pop" | "verdict-in" | "verdict-out" | "modal-in" | "modal-out" | null`.
  - A change in `wide` gives null.
  - A depth change wins over a verdict change, so a multi-close `popstate` gives `pop`.
  - On a desk, Settings gives `modal-*`, and Queue and Machines (columns) give null.
  - Verdict → different verdict gives null.
- `TransitionRunner`, constructed with `{ start?: (options: { update, types }) => ViewTransitionLike, reducedMotion: () => boolean, hidden: () => boolean, shareCard: () => boolean, apply: (state) => Promise<void> }`. It runs in this order:
  1. **Offer.** `offer(next)` computes the kind. If the kind is null, or `start` is absent, or reduced motion is on, or the page is hidden, it calls `apply(next)` and returns.
  2. **Start.** Otherwise it calls `start({ update, types })`. `types` is `[kind]`, plus `"shared-card"` when `shareCard()` says the card should carry over (see the name scheme). Types belong to the transition object: the browser activates them before the old capture and drops them when the transition ends, so there is no attribute to set or clear and no race between overlapping transitions.
  3. **Wait for the callback.** It holds `next` as `pending` and does **not** apply it. The update callback runs only after the browser captures the old state, a frame later, and applying early would put the new state into the "old" snapshot. Further offers while the callback is pending only replace `pending` (latest wins), so a keystroke in that frame isn't lost, just a frame late.
  4. **Commit.** `update` applies the latest `pending` and returns the commit promise.
  5. **Belt and braces.** If `updateCallbackDone` rejects, it makes sure the latest `pending` was applied. The browser calls `update` even when it skips a transition, so the state is never lost without this; the check is a backstop.
- **Feature test.** `start` is wired only when `CSS.supports("selector(:active-view-transition-type(x))")` is true. That one test proves the object form of `startViewTransition` and the type selectors both exist; the CSS depends on both, so a browser with only the Level 1 callback form gets the fallback rather than unstyled default crossfades.
- **Typing.** If TS 7's `lib.dom` lacks `StartViewTransitionOptions`/`ViewTransition`, declare a minimal `ViewTransitionLike` interface in the module, with no `as`.

**Waiting for Preact's committed DOM.** Preact defers renders to a microtask and has no `flushSync`. The hook in `app.tsx` turns `apply` into "the DOM is committed":

```ts
// in useStoreState's replacement
const [snap, setSnap] = useState({ state: store.getState(), seq: 0 });
const committed = useRef<(() => void) | null>(null);
useLayoutEffect(() => {
  committed.current?.();
  committed.current = null;
}, [snap.seq]);
const apply = (state) =>
  new Promise<void>((resolve) => {
    committed.current = resolve;
    setSnap((s) => ({ state, seq: s.seq + 1 }));
    setTimeout(resolve, 100); // backstop: never leave the screen frozen waiting
  });
```

- The `seq` bump guarantees a render even if `getState()` returned an identical state.
- Preact runs children's layout effects before the parent's, so `SettingsDialog`'s `showModal()` and `Sheet`'s scroll positioning have run by the time `App`'s layout effect resolves.
- The 100ms backstop only matters if a render throws or is dropped. Chrome's own update-callback timeout (~4s) would otherwise freeze the screen.

**Correct a stale claim while there.** The `useStoreState` comment and DESIGN.md's Preact bullet both say "Preact renders synchronously". It doesn't: `setState` renders are microtask-deferred. Fix the wording in both places. The torn-read conclusion still holds, for a different reason: there is no concurrent rendering.

**`app.tsx` after the change.**

- `useScreenTransition`, `useDepthOne`, `useVerdictExit`, `ScreenAnim`, `panelClass` and `shown()` are deleted.
- Only the current depth's screen renders.
- The stage has no `onAnimationEnd` and no `stage-animating`.
- `VerdictView` loses `closing`/`onExited` and its `onAnimationEnd`.
- `SettingsDialog` loses `anim`, and its doc comment loses "stays open while its panel is still on stage".
- `reusePrompt(verdict)`/`retrySpawn(verdict)` can keep their signatures. The rendered verdict and `state.verdict` now coincide, so the comment about outliving state goes. Narrowing the signatures is optional, so it is left for a follow-up.

## `view-transition-name` scheme

Names exist **only while a transition runs**: each is set under `:active-view-transition` or `:active-view-transition-type(…)` on the root, never on an element unconditionally. Idle elements are therefore never stacking contexts because of a name. The queue screen's own `DecisionCard`s can never collide with the shared one, and a duplicate name, which aborts a transition, can only come from these few selectors.

| Name           | `view-transition-class` | Element                                                                                                  | Set under                                                                |
| -------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `screen-base`  | `screen`                | depth-0 `main` (form or verdict); on a desk, the form column                                             | `:root:active-view-transition`                                           |
| `screen-layer` | `screen`                | depth-1 `main` (Queue, Machines, the phone's Settings `main` inside the dialog); the desk Settings `main` | `:root:active-view-transition`                                           |
| `decision`     | —                       | `.decision-shared`, a class only the form's preview card and the verdict's card carry                    | `:root:active-view-transition-type(shared-card)`                         |

The `screen` class lets the rules both panels share (timing curve, the slide's shadow) be written once against `::view-transition-group(*.screen)` instead of per name.

**Types are the vocabulary.** `push`, `pop`, `verdict-in`, `verdict-out`, `modal-in`, `modal-out`, and the modifier `shared-card`. Every motion rule selects on `:active-view-transition-type(…)`.

**The shared card, in detail.**

- **The class.** `DecisionCard` gets an optional `shared?: boolean` prop that adds `decision-shared`. Only `spawn-screen.tsx`'s preview and `verdict.tsx` pass it; `queue.tsx` doesn't.
- **Off-screen preview.** If the preview card is scrolled out of view at capture time, it shouldn't fly in from off-screen over the header, because a group isn't clipped by its scroller. The runner's `shareCard()` seam checks the preview's rect against its scroller (one `getBoundingClientRect` per verdict transition) and leaves out the `shared-card` type when they don't intersect, so the name is never set. It is injected so the runner stays DOM-free.
- **No card on one side.** When either side has no card (a machine was picked instead of `auto`, or the preview is pending), the name exists only on one side, and that group just fades as part of the default. No special case.

## CSS removed (`pwa/src/screen.css`)

- **Screen transitions section:**
  - `.stage-animating`
  - `.panel-push-in/out`, `.panel-pop-in/out` and their `::after` dims
  - `@keyframes screen-push-in/out`, `screen-pop-in/out`, `panel-dim`, `panel-undim`
  - `.stage` and `.stage-panel` stay: layout and the opaque background.
- **Settings dialog section:**
  - `.layer-modal-in/out` and their `::backdrop` rules
  - `@keyframes screen-modal-in/out`, `modal-backdrop-in/out`
  - `.layer-full`/`.layer-modal` geometry stays.
- **Verdict section:**
  - `.verdict-closing`, `.form-enter`, `@keyframes form-in`
  - `verdict-out` keyframes survive and are reused by the pseudo below.
  - The one-shot `verdict-in` stagger **stays**: it runs live inside `::view-transition-new(screen-base)` and is the verdict's entrance.

## CSS added

This is a new "view transitions" section replacing "screen transitions". The values are carried over from today's rules.

```css
/* Names and classes only while a transition runs; the -host classes sit on the panels' mains. */
:root:active-view-transition .screen-base-host  { view-transition-name: screen-base;  view-transition-class: screen; }
:root:active-view-transition .screen-layer-host { view-transition-name: screen-layer; view-transition-class: screen; }
:root:active-view-transition-type(shared-card) .decision-shared { view-transition-name: decision; }

/* The base layer is an opaque panel; no root crossfade under it (modal types keep it: it carries the backdrop). */
:root:active-view-transition-type(push, pop, verdict-in, verdict-out)::view-transition-old(root),
:root:active-view-transition-type(push, pop, verdict-in, verdict-out)::view-transition-new(root) { animation: none; }

/* Exit-only groups paint after entering ones; the layer must always be on top. */
::view-transition-group(screen-layer) { z-index: 1; }

/* One clock for both panels of a slide, written once through the class. */
:root:active-view-transition-type(push, pop)::view-transition-old(*.screen),
:root:active-view-transition-type(push, pop)::view-transition-new(*.screen) {
  animation-duration: 0.35s;
  animation-timing-function: cubic-bezier(0.32, 0.72, 0, 1);
  animation-fill-mode: both;
}
:root:active-view-transition-type(push, pop)::view-transition-group(screen-layer) { box-shadow: -18px 0 36px rgba(0,0,0,.25); }

/* push: the layer slides in over the base, which gives way by a third and dims (brightness .82 ≈ today's 18% black). */
:root:active-view-transition-type(push)::view-transition-new(screen-layer) { animation-name: vt-from-right; }
:root:active-view-transition-type(push)::view-transition-old(screen-base)  { animation-name: vt-give-way; }
/* pop: mirrored */
:root:active-view-transition-type(pop)::view-transition-old(screen-layer) { animation-name: vt-to-right; }
:root:active-view-transition-type(pop)::view-transition-new(screen-base)  { animation-name: vt-come-back; }

/* verdict-in: the form fades out fast; the verdict's own stagger (opacity 0 → 1) is the entrance, so new is left alone. */
:root:active-view-transition-type(verdict-in)::view-transition-old(screen-base) { animation: vt-fade-out 0.12s ease-in both; }
:root:active-view-transition-type(verdict-in)::view-transition-new(screen-base) { animation: none; }
/* verdict-out: today's sink-out, then the form fades in */
:root:active-view-transition-type(verdict-out)::view-transition-old(screen-base) { animation: verdict-out 0.15s ease-in both; }
:root:active-view-transition-type(verdict-out)::view-transition-new(screen-base) { animation: vt-fade-in 0.18s ease-out 0.1s both; }
/* the shared card morphs; anchor its images top so text doesn't stretch while the card's height changes */
::view-transition-group(decision) { animation-duration: 0.3s; animation-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1); }
::view-transition-old(decision), ::view-transition-new(decision) { height: 100%; object-fit: none; object-position: top; }

/* desk Settings modal: today's in/out; root's default crossfade carries the backdrop */
:root:active-view-transition-type(modal-in)::view-transition-new(screen-layer) { animation: vt-modal-in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
:root:active-view-transition-type(modal-out)::view-transition-old(screen-layer) { animation: vt-modal-out 0.16s ease-in both; }
```

**Reduced motion.** `base.css`'s `*, *::before, *::after` clamp **does not reach `::view-transition-*` pseudos**, so today's guarantee would silently lapse. There are two parts:

1. **Primary:** the runner never starts a transition under `prefers-reduced-motion`, so there is no snapshot, no frozen frame and no swallowed taps.
2. **Belt and braces:** a rule added to `base.css` beside the existing clamp, covering any transition started some other way:

   ```css
   @media (prefers-reduced-motion: reduce) {
     ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) {
       animation-duration: 0.01ms !important; animation-delay: 0.01ms !important;
     }
   }
   ```

**Ongoing animations and frozen snapshots.**

- **Old snapshots.** Only the *old* images are frozen; `::view-transition-new(*)` is live. So the outgoing screen's sonar and stage-track pulse freeze for ≤350ms while it slides or fades away, which is not visible in practice. The incoming screen's sonar, sheen and pulse keep running.
- **Root.** Root's old image is not animated in screen kinds, and the opaque new root covers it at once, so nothing in the root (e.g. an open header-menu popover) lingers frozen. It vanishes as the push starts, which matches what an outside tap does.
- **Sheets opening mid-transition.** The scrim is `position: fixed` inside `screen-base`'s `main`, so it is captured with, and live inside, that group. A sheet that opens during a screen transition plays its own CSS animation inside the moving panel and keeps its z-order.
  - User-initiated cases can't happen, because taps are swallowed during the transition (as `.stage-animating` does today).
  - The real cases are a spawn reply landing with a sheet open, and Forward/back multi-steps. Both are covered by the capture without special code, and both are on the device checklist.

## Fallback path

- **No typed view transitions (the `CSS.supports` test above), reduced motion, or a hidden document:** apply the state at once, in the same frame. **There is an instant swap and no slide.**
- **Old CSS kept as a second path:** rejected. That means two motion systems to keep in step, and the hand-rolled one is exactly what this removes. Browsers affected:
  - Browsers without typed transitions: Firefox and Chromium releases older than their type support. The owner's phone is on Firefox 158, and the PWA's audience is the owner's own devices.
  - Safari has typed transitions in current releases, so the desktop Mac is covered.
- **Failure modes are graceful by construction:**
  - A duplicate name, or a capture failure, makes the browser skip the animation but still run the callback, so the DOM change always lands.
  - The 100ms commit backstop bounds any freeze.
- **API surface.** Level 2 throughout: `startViewTransition({ update, types })`, `:active-view-transition`, `:active-view-transition-type()` and `view-transition-class`, as well as the Level 1 pseudo-elements and `updateCallbackDone`. Not used: `match-element` and nested groups (`view-transition-group`), which nothing here needs. Types replace a hand-managed attribute on `<html>`; that design needed a sequence token so one transition's settlement couldn't clear a newer one's attribute, and types make that bug impossible.

## Tests (`bun:test`, run with `bun run test`)

**New `pwa/test/transition.test.ts`.** No DOM, using the injected seams:

- **`transitionKind` table:**
  - 0→1 → push; 1→0 → pop.
  - Form → verdict → verdict-in; verdict → form → verdict-out.
  - Verdict → different verdict → null.
  - A change only in content (same key) → null.
  - A sheet opening → null.
  - `wide` flipped → null.
  - Desk Settings → modal-in/out; desk Queue/Machines → null.
  - Queue and verdict closed together → pop.
- **Runner:**
  1. Unsupported, reduced or hidden → `apply` is called synchronously and `start` is never called.
  2. Supported → `start` receives `types: [kind]`, and `apply` is **not** called until the fake fires `update`.
  3. Three offers before the callback → one `apply`, with the last state.
  4. A second offer while the first transition is animating (after its `update` ran) → a new `start` with the new kind; the first's state is not re-applied.
  5. `updateCallbackDone` rejects or the transition is skipped → the latest state is still applied.
  6. `shareCard()` false → `types` has no `shared-card`; true on a verdict kind → it does; never on push/pop/modal kinds.

**CSS guard (cheap and structural).** A test reads `screen.css` and asserts:

- every `view-transition-name:` and `view-transition-class:` declaration sits under a `:root:active-view-transition` or `:root:active-view-transition-type(` selector, which guards the duplicate-name and idle-stacking-context invariants;
- every type named in a `:active-view-transition-type(…)` selector is one `transition.ts` can emit, which catches a typo'd type that would silently never match (the module exports its type list for this);
- `base.css` carries the reduced-motion `::view-transition-*` clamp.

**Existing suites.** `store.test.ts` doesn't change; the store is untouched. Run `bun run typecheck` in `pwa/` as well, plus lint and format via the hook.

## Device checklist (manual; the suite can't see motion)

Run it on Firefox Android (the owner's 158) and Chrome Android, with `bun run dev` in `relay/` and `pwa/` per docs/development.md:

1. Push and pop for each of Queue, Machines and Settings, by both the hardware/gesture back and the UI back.
2. Spawn with `auto` and the preview visible → the card glides into the verdict. Then do it again with the preview scrolled off → there is no fly-in.
3. Verdict → "Back to the form", with the card returning.
4. A retry from a failed verdict (verdict → form → verdict, interrupted).
5. A spawn reply landing while a sheet is open.
6. The soft keyboard open when the verdict lands, where the viewport resizes mid-transition.
7. The header-menu popover choosing Queue.
8. The desk modal, in Firefox and Chrome desktop.
9. OS reduced motion on → instant swaps.
10. Firefox: a named `main` inside the phone Settings `<dialog>` (top layer) captures correctly. If it doesn't, name the `dialog` itself instead, a one-line change. This is the riskiest engine-specific point.

## DESIGN.md update (PWA section)

**New bullet: "Screen and layer motion is the View Transition API, started at the store boundary."** It records:

- **The decision:** one runner offered every store change, keyed on screen identity only; transition types as the vocabulary, with names and classes scoped to `:active-view-transition`; the commit promise via `useLayoutEffect` plus a backstop.
- **Rejected alternatives, with reasons:**
  - Keeping the hand-rolled mounted-pair mechanics: timers, the animationend name coupling, lingering mounts.
  - Starting transitions in click handlers: closes arrive via `popstate` and verdicts via the network.
  - Applying state before the callback: it poisons the old snapshot.
  - View transitions for sheets: one transition at a time, swallowed taps, per-open freezes.
  - View transitions for poll-driven swaps: owner decision, and the freeze reason.
  - A `data-vt` attribute on `<html>` instead of types: it has to be set before capture and cleared on `finished`, and overlapping transitions need a token so one can't clear the other's. Types are scoped to their transition by the browser.
  - Level 1 only, for wider reach: the target browsers (Firefox, which the owner runs at 158, and Chrome) both ship Level 2, and a callback-only browser falls back to an instant swap instead of unstyled crossfades.
  - Keeping the CSS as the fallback: two systems; the fallback is an instant swap.
  - Unconditional names: duplicate-name aborts and permanent stacking contexts.
- **The reduced-motion caveat:** the `*` clamp misses the pseudos.

**Amendments:**

- The Settings dialog bullet: "slides in exactly as a pushed screen does" stays true, but the mechanism sentence is updated.
- The Preact bullet's "renders synchronously" wording is corrected.

## Implementation order

1. `bun install`, and confirm the session-3 verdict is merged; rebase onto it.
2. Write `transition.ts` and its tests (red then green).
3. Wire the hook in `app.tsx`, and delete the three hooks and `panelClass`/`shown`.
4. Clean up `verdict.tsx`, `decision.tsx` (the `shared` prop), `spawn-screen.tsx` and `SettingsDialog`.
5. CSS: remove and add as above, plus `base.css`'s clamp, plus the CSS guard test.
6. Update DESIGN.md.
7. Run `bun run test` and the pwa `typecheck`.
8. Go through the device checklist; record any Firefox-specific finding in DESIGN.md.

## Critical files

- `pwa/src/app.tsx`
- `pwa/src/transition.ts` (new)
- `pwa/src/screen.css`
- `pwa/src/base.css`
- `pwa/src/components/verdict.tsx`
- `pwa/src/components/decision.tsx`
- `pwa/src/components/spawn-screen.tsx` (the preview card's `shared` prop only; `useSheetExit` untouched)
- `pwa/test/transition.test.ts` (new)
- `DESIGN.md`
