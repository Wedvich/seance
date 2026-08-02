import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";

const FOCUSABLE = 'button:not([disabled]), [href], input, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Bottom sheet with dialog semantics. Escape and focus return are here for
 * keyboard use in a desktop browser as much as for assistive tech — the sheet
 * replaces the screen's focus context, so leaving focus behind it strands you.
 */
export function Sheet(props: {
  title: string;
  /** True while the exit animation plays; unmount follows via onExited. */
  closing?: boolean;
  onExited?: () => void;
  onClose: () => void;
  children: ComponentChildren;
}): JSX.Element {
  const { title, closing = false, onExited, onClose, children } = props;
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || panel.current === null) return;
      const targets = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = targets[0];
      const last = targets.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className={closing ? "scrim scrim-closing" : "scrim"}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="sheet card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panel}
        tabIndex={-1}
        onAnimationEnd={(event) => {
          if (event.animationName === "sheet-out") onExited?.();
        }}
      >
        <div className="sheet-head">
          <h2 className="sheet-title">{title}</h2>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="sheet-items">{children}</div>
      </div>
    </div>
  );
}

/**
 * Eye-off, in the same feather-weight stroke as the header cog. A ✕ would read as
 * the sheet's own close button one row above it, and a bin would overstate what the
 * action does — the machine is hidden until it connects, not forgotten.
 */
function HideIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="m1 1 22 22" />
    </svg>
  );
}

export function SheetItem(props: {
  label: string;
  sub?: string | null;
  selected?: boolean;
  disabled?: boolean;
  mono?: boolean;
  /** Command row (does something) rather than option row (picks something). */
  action?: boolean;
  dot?: "ok" | "off" | null;
  /** Trailing hide button. A nested button would be invalid, so this splits the row in two. */
  onRemove?: (() => void) | null;
  removeLabel?: string;
  onClick: () => void;
}): JSX.Element {
  const {
    label,
    sub = null,
    selected = false,
    disabled = false,
    mono = false,
    action = false,
    dot = null,
    onRemove = null,
    removeLabel = `Remove ${label}`,
    onClick,
  } = props;
  const classes = ["sheet-item"];
  if (selected) classes.push("sheet-item-selected");
  if (disabled) classes.push("sheet-item-disabled");
  if (action) classes.push("sheet-item-action");

  const item = (
    <button type="button" className={classes.join(" ")} onClick={onClick} disabled={disabled} aria-current={selected}>
      {dot !== null && <span className={dot === "ok" ? "dot dot-ok" : "dot"} />}
      <span className="sheet-item-text">
        <span className={mono ? "sheet-item-label sheet-item-mono" : "sheet-item-label"}>{label}</span>
        {sub !== null && <span className="sheet-item-sub">{sub}</span>}
      </span>
      {selected && (
        <span className="sheet-check" aria-hidden="true">
          ✓
        </span>
      )}
    </button>
  );

  if (onRemove === null) return item;
  return (
    <div className="sheet-item-row">
      {item}
      <button type="button" className="sheet-item-remove" onClick={onRemove} aria-label={removeLabel}>
        <HideIcon />
      </button>
    </div>
  );
}
