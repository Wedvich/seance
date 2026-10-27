import { createContext, type ComponentChildren, type JSX, type RefObject } from "preact";
import { useCallback, useContext, useId, useRef, useState } from "preact/hooks";
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
    const root = document.documentElement;
    const at = menuPlacement(direction, anchor.getBoundingClientRect(), {
      width: root.clientWidth,
      height: root.clientHeight,
    });
    el.style.top = at.top === null ? "" : `${at.top}px`;
    el.style.bottom = at.bottom === null ? "" : `${at.bottom}px`;
    el.style.right = `${at.right}px`;
  };

  const close = useCallback((): void => node.current?.hidePopover(), []);

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
      onToggle={(event) => menu.onToggle(event.newState)}
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
  const pick = (): void => {
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
