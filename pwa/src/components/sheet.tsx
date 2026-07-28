import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";

const FOCUSABLE = 'button:not([disabled]), [href], input, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Bottom sheet with dialog semantics. Escape and focus return are here for
 * keyboard use in a desktop browser as much as for assistive tech — the sheet
 * replaces the screen's focus context, so leaving focus behind it strands you.
 */
export function Sheet(props: { title: string; onClose: () => void; children: ComponentChildren }): JSX.Element {
  const { title, onClose, children } = props;
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
      className="scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sheet card" role="dialog" aria-modal="true" aria-label={title} ref={panel} tabIndex={-1}>
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

export function SheetItem(props: {
  label: string;
  sub?: string | null;
  selected?: boolean;
  disabled?: boolean;
  mono?: boolean;
  /** Command row (does something) rather than option row (picks something). */
  action?: boolean;
  dot?: "ok" | "off" | null;
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
    onClick,
  } = props;
  const classes = ["sheet-item"];
  if (selected) classes.push("sheet-item-selected");
  if (disabled) classes.push("sheet-item-disabled");
  if (action) classes.push("sheet-item-action");

  return (
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
}
