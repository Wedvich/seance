import { tipPlacement } from "./tip-placement.ts";

/** Long enough that sweeping the pointer across a list of times opens nothing. */
const SHOW_DELAY_MS = 350;

let tip: HTMLDivElement | null = null;
let owner: Element | null = null;
let pending: ReturnType<typeof setTimeout> | undefined;

function open(anchor: Element, text: string): void {
  if (!anchor.isConnected) return;
  // One node for every tip: a popover in the top layer, so no card's overflow
  // or stacking context clips it. `manual` — it must not close an open menu.
  if (tip === null) {
    tip = document.createElement("div");
    tip.className = "tip";
    tip.popover = "manual";
    tip.setAttribute("role", "tooltip");
    document.body.append(tip);
  }
  tip.textContent = text;
  tip.showPopover();
  const at = tipPlacement(
    anchor.getBoundingClientRect(),
    { width: tip.offsetWidth, height: tip.offsetHeight },
    document.documentElement.clientWidth,
  );
  tip.dataset.side = at.side;
  tip.style.left = `${at.left}px`;
  tip.style.top = `${at.top}px`;
}

/** Shows `text` over `anchor` after the hover delay; a later call for another anchor replaces it. */
export function showTip(anchor: Element, text: string): void {
  clearTimeout(pending);
  owner = anchor;
  // Already showing one: the pointer is reading down a column, so the next follows at once.
  if (tip?.matches(":popover-open") === true) {
    open(anchor, text);
    return;
  }
  pending = setTimeout(() => open(anchor, text), SHOW_DELAY_MS);
}

/** Hides the tip if `anchor` owns it; a stale leave from an earlier anchor is ignored. */
export function hideTip(anchor: Element): void {
  if (owner !== anchor) return;
  clearTimeout(pending);
  owner = null;
  tip?.hidePopover();
}

// The tip is pinned once, on open: anything that moves or replaces the anchor retires it.
const dismiss = (): void => {
  if (owner !== null) hideTip(owner);
};
document.addEventListener("scroll", dismiss, { capture: true, passive: true });
document.addEventListener("pointerdown", dismiss, { capture: true, passive: true });
document.addEventListener("keydown", dismiss, { capture: true });
