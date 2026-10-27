import type { JSX } from "preact";
import type { ConnectionState } from "../view.ts";
import { Menu, MenuItem, useMenu } from "./menu.tsx";
import { CogIcon, RelayDot } from "./relay-dot.tsx";

/**
 * The phone's header pill: relay dot on the track, as on a desk, but the face
 * opens a menu of the screens a desk shows as columns, plus Settings.
 */
export function HeaderMenu(props: {
  state: ConnectionState;
  queueAttention: boolean;
  onQueue: () => void;
  onMachines: () => void;
  onSettings: () => void;
}): JSX.Element {
  const { state, queueAttention } = props;
  const menu = useMenu();

  return (
    <>
      <button
        ref={menu.anchor}
        type="button"
        className="relay-group"
        popovertarget={menu.id}
        aria-haspopup="menu"
        aria-expanded={menu.open}
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
      <Menu menu={menu} label="Menu">
        <MenuItem label="Queue" icon={<QueueIcon />} onClick={props.onQueue} attention={queueAttention} />
        <MenuItem label="Machines" icon={<MachinesIcon />} onClick={props.onMachines} />
        <MenuItem label="Settings" icon={<CogIcon size={18} />} onClick={props.onSettings} />
      </Menu>
    </>
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
