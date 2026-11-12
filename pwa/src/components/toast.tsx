import type { JSX } from "preact";
import { StrokeIcon } from "./icons.tsx";

/**
 * A failure docked at the screen's foot, so it shows wherever the list is
 * scrolled. No timer: what it says can be an instruction ("Refresh to see
 * whether it did."), a phone has no hover to hold one, and the store already
 * clears it when the next action starts or a read lands. Key it on its text so
 * a new failure re-enters and is announced.
 */
export function Toast(props: { text: string; onDismiss: () => void }): JSX.Element {
  return (
    <div className="toast toast-err" role="alert">
      <span className="banner-rule" />
      <p className="toast-text">{props.text}</p>
      <button type="button" className="toast-close" onClick={props.onDismiss} aria-label="Dismiss">
        <StrokeIcon size={16}>
          <path d="M6 6l12 12M18 6L6 18" />
        </StrokeIcon>
      </button>
    </div>
  );
}
