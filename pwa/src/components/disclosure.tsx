import type { JSX } from "preact";

/**
 * A card head's top-right toggle for what opens under the card. A button
 * rather than `<summary>`: the panel it opens sits below the card's other
 * rows, not right after the toggle.
 */
export function Disclosure(props: { open: boolean; label: string; onToggle: () => void }): JSX.Element {
  const { open, label, onToggle } = props;
  return (
    <button type="button" className="disclosure" aria-expanded={open} onClick={onToggle}>
      <span className="disclosure-chevron" aria-hidden="true">
        ▶
      </span>
      {label}
    </button>
  );
}
