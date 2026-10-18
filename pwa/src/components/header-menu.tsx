import type { JSX } from "preact";
import { useRef } from "preact/hooks";
import type { ConnectionState } from "../view.ts";
import { CogIcon, RelayDot } from "./relay-dot.tsx";

const MENU_ID = "header-menu";

/**
 * The phone's header pill: relay dot on the track, as on a desk, but the face
 * opens a menu of the screens a desk shows as columns, plus Settings. A native
 * `popover="auto"`: outside taps and Escape close it, and so does Android's
 * back, which Chrome routes to an open popover before history — so the menu
 * needs no history entry of its own.
 */
export function HeaderMenu(props: {
  state: ConnectionState;
  queueAttention: boolean;
  onQueue: () => void;
  onMachines: () => void;
  onSettings: () => void;
}): JSX.Element {
  const { state, queueAttention } = props;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // The top layer lifts the menu out of the header, so it is pinned under the
  // pill by hand; CSS anchor positioning isn't in every browser this runs in.
  const place = (newState: string): void => {
    const button = trigger.current;
    const node = menu.current;
    if (newState !== "open" || button === null || node === null) return;
    const rect = button.getBoundingClientRect();
    node.style.top = `${rect.bottom + 6}px`;
    node.style.right = `${document.documentElement.clientWidth - rect.right}px`;
  };

  const pick = (open: () => void) => (): void => {
    menu.current?.hidePopover();
    open();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="relay-group"
        popovertarget={MENU_ID}
        aria-label={queueAttention ? "Menu, a queued task needs you" : "Menu"}
        title={`Relay: ${state}`}
      >
        <span className="relay-status">
          <RelayDot state={state} />
        </span>
        <span className="relay-cog" aria-hidden="true">
          <MenuIcon />
          {queueAttention && <span className="menu-badge dot dot-err" />}
        </span>
      </button>
      <div
        ref={menu}
        id={MENU_ID}
        className="header-menu"
        popover="auto"
        onBeforeToggle={(event) => place(event.newState)}
      >
        <MenuItem label="Queue" onClick={pick(props.onQueue)} attention={queueAttention}>
          <QueueIcon />
        </MenuItem>
        <MenuItem label="Machines" onClick={pick(props.onMachines)}>
          <MachinesIcon />
        </MenuItem>
        <MenuItem label="Settings" onClick={pick(props.onSettings)}>
          <CogIcon size={18} />
        </MenuItem>
      </div>
    </>
  );
}

function MenuItem(props: {
  label: string;
  onClick: () => void;
  attention?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button type="button" className="header-menu-item" onClick={props.onClick}>
      <span className="header-menu-icon">{props.children}</span>
      {props.label}
      {props.attention === true && <span className="dot dot-err" role="img" aria-label="needs you" />}
    </button>
  );
}

/** Feather-weight strokes throughout, to sit beside the cog. */
function Icon(props: { size: number; children: JSX.Element[] }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={props.size}
      height={props.size}
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

function MenuIcon(): JSX.Element {
  return (
    <Icon size={17}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </Icon>
  );
}

/** A list with bullets: tasks waiting in order. */
function QueueIcon(): JSX.Element {
  return (
    <Icon size={18}>
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <path d="M4.5 6h.01" />
      <path d="M4.5 12h.01" />
      <path d="M4.5 18h.01" />
    </Icon>
  );
}

/** Feather's server: two racked boxes, each with a status light. */
function MachinesIcon(): JSX.Element {
  return (
    <Icon size={18}>
      <rect x="3" y="3" width="18" height="7.5" rx="2" />
      <rect x="3" y="13.5" width="18" height="7.5" rx="2" />
      <path d="M7 6.75h.01" />
      <path d="M7 17.25h.01" />
    </Icon>
  );
}
