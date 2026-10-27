import { createContext, type ComponentChildren, type JSX, type RefObject } from "preact";
import { useCallback, useContext, useEffect, useId, useRef, useState } from "preact/hooks";
import { menuPlacement, type MenuDirection } from "../menu-placement.ts";

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
 * it, right edges aligned either way.
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

  const place = (newState: string): void => {
    const anchor = menu.anchor.current;
    const el = node.current;
    if (newState !== "open" || anchor === null || el === null) return;
    // Width from clientWidth so `right` excludes a scrollbar; height from
    // innerHeight because `position: fixed; bottom` resolves against the
    // viewport, which clientHeight diverges from under a collapsing toolbar.
    const at = menuPlacement(direction, anchor.getBoundingClientRect(), {
      width: document.documentElement.clientWidth,
      height: window.innerHeight,
    });
    el.style.top = at.top === null ? "" : `${at.top}px`;
    el.style.bottom = at.bottom === null ? "" : `${at.bottom}px`;
    el.style.right = `${at.right}px`;
  };

  const close = useCallback((): void => node.current?.hidePopover(), []);

  // Placed once on open, so it would detach from a scrolled anchor. Closing on
  // scroll is what native Android menus do. Capture catches nested scrollers.
  useEffect(() => {
    if (!menu.open) return;
    const dismiss = (): void => close();
    window.addEventListener("scroll", dismiss, { capture: true, passive: true });
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, { capture: true });
      window.removeEventListener("resize", dismiss);
    };
  }, [menu.open, close]);

  const onToggle = (newState: string): void => {
    menu.onToggle(newState);
    // Focus moves only for a keyboard open; a tap shows no highlighted row.
    if (newState !== "open" || !menu.anchor.current?.matches(":focus-visible")) return;
    enabledItems(node.current)[0]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const items = enabledItems(node.current);
    if (items.length === 0) return;
    const at = items.findIndex((item) => item === document.activeElement);
    const next = nextIndex(event.key, at, items.length);
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
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
      onBeforeToggle={(event) => place(event.newState)}
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
