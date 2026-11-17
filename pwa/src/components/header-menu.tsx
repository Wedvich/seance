import type { JSX } from "preact";
import type { Screen } from "../transition.ts";
import type { ConnectionState } from "../view.ts";
import { Menu, MenuItem, useMenu } from "./menu.tsx";
import { CogIcon, RelayDot } from "./relay-dot.tsx";

/**
 * The phone's header pill: relay dot on the track, as on a desk, but the face
 * opens a menu of the three screens a desk shows as columns, plus Settings.
 * It stands in the one header every screen shares; the current screen's row is
 * marked, and picking it only closes the menu.
 */
export function HeaderMenu(props: {
  state: ConnectionState;
  current: Screen;
  queueAttention: boolean;
  onPrompt: () => void;
  onQueue: () => void;
  onMachines: () => void;
  onSettings: () => void;
}): JSX.Element {
  const { state, current } = props;
  // The Queue on screen shows what needs you; a dot pointing at it would point at the page itself.
  const queueAttention = props.queueAttention && current !== "queue";
  const menu = useMenu();
  const go = (screen: Screen, open: () => void): (() => void) | undefined => (screen === current ? undefined : open);

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
        <MenuItem
          label="Prompt"
          icon={<PromptIcon />}
          current={current === "prompt"}
          onClick={go("prompt", props.onPrompt)}
        />
        <MenuItem
          label="Queue"
          icon={<QueueIcon />}
          current={current === "queue"}
          onClick={go("queue", props.onQueue)}
          attention={queueAttention}
        />
        <MenuItem
          label="Machines"
          icon={<MachinesIcon />}
          current={current === "machines"}
          onClick={go("machines", props.onMachines)}
        />
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

/** Feather's edit-3: a pen over a line, the prompt being written. */
function PromptIcon(): JSX.Element {
  return (
    <Icon size={18}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
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
