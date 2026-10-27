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

function enabledItems(panel: HTMLElement | null): HTMLElement[] {
  if (panel === null) return [];
  return [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
    (item) => !item.matches(':disabled, [aria-disabled="true"]'),
  );
}

/** Roving-focus target for a menu key; null for keys that aren't navigation. */
function nextIndex(key: string, at: number, count: number): number | null {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return at < 0 ? 0 : (at + 1) % count;
  if (key === "ArrowUp") return at < 0 ? count - 1 : (at - 1 + count) % count;
  return null;
}

const CloseMenu = createContext<() => void>(() => {});

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

  // Placed once on open, so it would detach from a scrolled anchor. Closing on
  // scroll is what native Android menus do. Capture catches nested scrollers.
  // A height-only resize is the soft keyboard leaving as the trigger takes
  // focus from a textarea (Firefox resizes the layout viewport for it): closing
  // there would shut the menu as it opens, so it re-pins instead.
  useEffect(() => {
    if (!menu.open) return;
    const width = document.documentElement.clientWidth;
    const dismiss = (): void => close();
    const onResize = (): void => {
      if (document.documentElement.clientWidth !== width) return close();
      place(node.current?.offsetHeight ?? null);
    };
    window.addEventListener("scroll", dismiss, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", dismiss, { capture: true });
      window.removeEventListener("resize", onResize);
    };
  }, [menu.open, close, place]);

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
    enabledItems(node.current)[0]?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const items = enabledItems(node.current);
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
      onBeforeToggle={(event) => event.newState === "open" && place(null)}
      onToggle={(event) => onToggle(event.newState)}
      onKeyDown={onKeyDown}
    >
      <CloseMenu.Provider value={close}>{props.children}</CloseMenu.Provider>
    </div>
  );
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
    // The panel takes taps through its fade-out; a second tap must not re-run.
    if (!(event.currentTarget instanceof Element) || !event.currentTarget.closest(":popover-open")) {
      event.preventDefault();
      return;
    }
    if (props.keepOpen !== true) close();
    props.onClick?.();
  };
  const body = (
    <>
      {props.icon !== undefined && <span className="menu-icon">{props.icon}</span>}
      <span className="menu-text">
        {props.label}
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
    <button type="button" className={className} role="menuitem" disabled={disabled} onClick={pick}>
      {body}
    </button>
  );
}

export function MenuDivider(): JSX.Element {
  return <div className="menu-divider" role="separator" />;
}
