import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { StrokeIcon } from "./icons.tsx";

/** Long enough to read a two-sentence refusal; restarts in full once the pointer or focus leaves. */
const TOAST_MS = 10_000;

/**
 * A failure floating over the screen's foot, so it shows wherever the list is
 * scrolled. Key it on its text: a new failure then re-enters and gets its own time.
 */
export function Toast(props: { text: string; onDismiss: () => void }): JSX.Element {
  const { onDismiss } = props;
  // A fresh closure each render: read through a ref, so a re-render never restarts the clock.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  // Held while read or reached by keyboard: the timer must not pull it from under the person.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;

  useEffect(() => {
    if (held) return;
    const timer = setTimeout(() => dismiss.current(), TOAST_MS);
    return () => clearTimeout(timer);
  }, [held]);

  return (
    <div
      className="toast toast-err"
      role="alert"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusIn={() => setFocused(true)}
      onFocusOut={() => setFocused(false)}
    >
      <span className="banner-rule" />
      <p className="toast-text">{props.text}</p>
      <button type="button" className="toast-close" onClick={onDismiss} aria-label="Dismiss">
        <StrokeIcon size={16}>
          <path d="M6 6l12 12M18 6L6 18" />
        </StrokeIcon>
      </button>
    </div>
  );
}
