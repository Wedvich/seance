import { createContext, type ComponentChildren, type JSX, type RefObject } from "preact";
import { useCallback, useContext, useEffect, useId, useRef, useState } from "preact/hooks";
import { menuDirection, menuPlacement, type MenuDirection } from "../menu-placement.ts";

export type { MenuDirection } from "../menu-placement.ts";

/** What a menu's trigger wires up: `ref={anchor}`, `popovertarget={id}`, `aria-expanded={open}`. */
export interface MenuHandle<T extends HTMLElement> {
  readonly id: string;
  readonly open: boolean;
  /** What the menu is pinned to; the trigger, or a group around it (a split button). */
  readonly anchor: RefObject<T | null>;
  readonly onToggle: (newState: string) => void;
}

/** One per menu; `useId` keeps ids unique when a list renders a menu per row. */
export function useMenu<T extends HTMLElement = HTMLButtonElement>(): MenuHandle<T> {
  const id = `menu-${useId()}`;
  const anchor = useRef<T>(null);
  const [open, setOpen] = useState(false);
  return { id, open, anchor, onToggle: (newState) => setOpen(newState === "open") };
}

/** An `aria-disabled` item stays in the roving focus: its sub-line may be the only place that says why. */
function menuItems(panel: HTMLElement | null): HTMLElement[] {
  if (panel === null) return [];
  return [...panel.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')];
}

/** Long enough for a layout shift's scroll anchoring to land, which is a frame or two after the render. */
const LAYOUT_SETTLE_MS = 250;

/** Roving-focus target for a menu key; null for keys that aren't navigation. */
function nextIndex(key: string, at: number, count: number): number | null {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return at < 0 ? 0 : (at + 1) % count;
  if (key === "ArrowUp") return at < 0 ? count - 1 : (at - 1 + count) % count;
  return null;
}

const CloseMenu = createContext<() => void>(() => {});
/** Called by an item that changes the page around the menu without closing it. */
const HoldMenuOpen = createContext<() => void>(() => {});

/**
 * A short command menu: 1–6 commands. A list to pick from, or anything long
 * enough to scroll, is a sheet (`sheet.tsx`) instead.
 *
 * A native `popover="auto"`: outside taps and Escape close it, and so does
 * Android's back, which Chrome routes to an open popover before history — so a
 * menu needs no history entry of its own. The top layer lifts it out of its
 * anchor's box, so it is pinned there by hand on open; CSS anchor positioning
 * isn't in every browser this runs in. Opens down under the anchor or up above
 * it, right edges aligned either way; a `down` menu flips up when it would run
 * past the viewport and fits better above (an `up` one never flips).
 */
export function Menu<T extends HTMLElement>(props: {
  menu: MenuHandle<T>;
  label: string;
  direction?: MenuDirection;
  children: ComponentChildren;
}): JSX.Element {
  const { menu } = props;
  const direction = props.direction ?? "down";
  const node = useRef<HTMLDivElement>(null);

  const { anchor: anchorRef } = menu;
  // `panelHeight` is null at beforetoggle, where the panel is still display:none
  // and unmeasurable: the requested side stands, and the toggle that follows
  // re-places with the real height. data-direction is set by hand to match so
  // the CSS transform-origin follows the side actually used.
  const place = useCallback(
    (panelHeight: number | null): void => {
      const anchor = anchorRef.current;
      const el = node.current;
      if (anchor === null || el === null) return;
      const rect = anchor.getBoundingClientRect();
      // Width from clientWidth so `right` excludes a scrollbar; height from
      // innerHeight because `position: fixed; bottom` resolves against the
      // viewport, which clientHeight diverges from under a collapsing toolbar.
      const viewport = { width: document.documentElement.clientWidth, height: window.innerHeight };
      const used = panelHeight === null ? direction : menuDirection(direction, rect, viewport, panelHeight);
      const at = menuPlacement(used, rect, viewport);
      el.dataset.direction = used;
      el.style.top = at.top === null ? "" : `${at.top}px`;
      el.style.bottom = at.bottom === null ? "" : `${at.bottom}px`;
      el.style.right = `${at.right}px`;
    },
    [anchorRef, direction],
  );

  const close = useCallback((): void => node.current?.hidePopover(), []);
  // For a close the page's own movement causes: the panel is fixed, so its fade
  // would stay put while the anchor leaves. Cleared at the next open.
  const cut = useCallback((): void => {
    if (node.current !== null) node.current.dataset.close = "cut";
    close();
  }, [close]);

  // A flipped switch can shift the content under the anchor (a chart above it
  // closing); the scroll that follows is the page moving, not the person.
  // Scrolls are ignored until it settles, then the menu is pinned to its trigger again.
  const settling = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdOpen = useCallback((): void => {
    if (settling.current !== null) clearTimeout(settling.current);
    settling.current = setTimeout(() => {
      settling.current = null;
      place(node.current?.offsetHeight ?? null);
    }, LAYOUT_SETTLE_MS);
  }, [place]);

  // Placed once on open, so it would detach from a scrolled anchor. Closing on
  // scroll is what native Android menus do. Capture catches nested scrollers.
  // A height-only resize is the soft keyboard leaving as the trigger takes
  // focus from a textarea (Firefox resizes the layout viewport for it): closing
  // there would shut the menu as it opens, so it re-pins instead.
  useEffect(() => {
    if (!menu.open) return;
    const width = document.documentElement.clientWidth;
    const dismiss = (): void => {
      if (settling.current === null) cut();
    };
    const onResize = (): void => {
      if (document.documentElement.clientWidth !== width) return cut();
      place(node.current?.offsetHeight ?? null);
    };
    window.addEventListener("scroll", dismiss, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", dismiss, { capture: true });
      window.removeEventListener("resize", onResize);
      if (settling.current !== null) clearTimeout(settling.current);
      settling.current = null;
    };
  }, [menu.open, cut, place]);

  const beforeOpen = (): void => {
    delete node.current?.dataset.close;
    place(null);
  };

  const onToggle = (newState: string): void => {
    menu.onToggle(newState);
    if (newState === "open") place(node.current?.offsetHeight ?? null);
    // Focus moves only for a keyboard open; a tap shows no highlighted row. A
    // group anchor holds its trigger, so the focused element inside it counts too.
    // Not `:has(:focus-visible)`: it throws where `:has` is missing.
    const focused = document.activeElement;
    const keyboard =
      focused instanceof HTMLElement &&
      menu.anchor.current?.contains(focused) === true &&
      focused.matches(":focus-visible");
    if (newState !== "open" || !keyboard) return;
    // preventScroll: a scroll here would trip the close-on-scroll listener.
    menuItems(node.current)[0]?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const items = menuItems(node.current);
    if (items.length === 0) return;
    const at = items.findIndex((item) => item === document.activeElement);
    const next = nextIndex(event.key, at, items.length);
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={node}
      id={menu.id}
      className="menu"
      data-direction={direction}
      popover="auto"
      role="menu"
      aria-label={props.label}
      onBeforeToggle={(event) => event.newState === "open" && beforeOpen()}
      onToggle={(event) => onToggle(event.newState)}
      onKeyDown={onKeyDown}
    >
      <CloseMenu.Provider value={close}>
        <HoldMenuOpen.Provider value={holdOpen}>{props.children}</HoldMenuOpen.Provider>
      </CloseMenu.Provider>
    </div>
  );
}

/** A card's ⋯: opens `menu`, which it anchors. `label` names the card ("More actions for …"). */
export function MoreTrigger(props: { menu: MenuHandle<HTMLButtonElement>; label: string }): JSX.Element {
  const { menu } = props;
  return (
    <button
      ref={menu.anchor}
      type="button"
      className="queue-more"
      popovertarget={menu.id}
      aria-haspopup="menu"
      aria-expanded={menu.open}
      aria-label={props.label}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="1.8" />
        <circle cx="12" cy="12" r="1.8" />
        <circle cx="19" cy="12" r="1.8" />
      </svg>
    </button>
  );
}

/** The panel takes taps through its fade-out; a second tap must not re-run. */
function inOpenMenu(event: Event): boolean {
  if (event.currentTarget instanceof Element && event.currentTarget.closest(":popover-open")) return true;
  event.preventDefault();
  return false;
}

/**
 * A pick closes the menu before its handler runs; `keepOpen` skips that for a
 * tap that only changes the item, such as arming a two-tap command that
 * relabels in place.
 */
export function MenuItem(props: {
  label: string;
  icon?: JSX.Element;
  sub?: string;
  href?: string;
  /** With `href`: opens in a new tab, without handing the page a reference back. */
  external?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  attention?: boolean;
  keepOpen?: boolean;
}): JSX.Element {
  const close = useContext(CloseMenu);
  const className = [
    "menu-item",
    props.sub !== undefined && "menu-item-with-sub",
    props.destructive === true && "menu-item-destructive",
  ]
    .filter(Boolean)
    .join(" ");
  const disabled = props.disabled === true;
  const pick = (event: Event): void => {
    if (!inOpenMenu(event) || disabled) return;
    if (props.keepOpen !== true) close();
    props.onClick?.();
  };
  const body = (
    <>
      {props.icon !== undefined && <span className="menu-icon">{props.icon}</span>}
      <span className="menu-text">
        <span className="menu-label">{props.label}</span>
        {props.sub !== undefined && <span className="menu-sub">{props.sub}</span>}
        {props.href !== undefined && props.external === true && <span className="sr-only"> (opens in a new tab)</span>}
      </span>
      {props.attention === true && <span className="dot dot-err" role="img" aria-label="needs you" />}
    </>
  );

  if (props.href !== undefined) {
    // An anchor has no `disabled`; dropping `href` makes it inert.
    return (
      <a
        className={className}
        role="menuitem"
        href={disabled ? undefined : props.href}
        tabIndex={disabled ? -1 : undefined}
        target={props.external === true ? "_blank" : undefined}
        rel={props.external === true ? "noopener noreferrer" : undefined}
        aria-disabled={disabled ? "true" : undefined}
        onClick={disabled ? undefined : pick}
      >
        {body}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={className}
      role="menuitem"
      aria-disabled={disabled ? "true" : undefined}
      onClick={pick}
    >
      {body}
    </button>
  );
}

export function MenuDivider(): JSX.Element {
  return <div className="menu-divider" role="separator" />;
}

/** A setting the menu shows and flips in place: it stays open, so the item can be flipped back. */
export function MenuSwitchItem(props: {
  label: string;
  icon?: JSX.Element;
  checked: boolean;
  onToggle: () => void;
  /** This flip opens a dialog over the menu, so the menu closes instead of staying open beneath it. */
  closesMenu?: boolean;
}): JSX.Element {
  const { checked } = props;
  const holdOpen = useContext(HoldMenuOpen);
  const close = useContext(CloseMenu);
  const toggle = (event: Event): void => {
    if (!inOpenMenu(event)) return;
    if (props.closesMenu === true) close();
    else holdOpen();
    props.onToggle();
  };
  return (
    <button type="button" className="menu-item" role="menuitemcheckbox" aria-checked={checked} onClick={toggle}>
      {props.icon !== undefined && <span className="menu-icon">{props.icon}</span>}
      <span className="menu-text">{props.label}</span>
      <span className={checked ? "menu-switch menu-switch-on" : "menu-switch"} aria-hidden="true">
        <span className="menu-switch-knob" />
      </span>
    </button>
  );
}
