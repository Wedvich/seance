import type { ComponentChildren, JSX } from "preact";

/** Same stroke vocabulary as the header's icons; colour comes from the parent's `currentColor`. */
export function StrokeIcon(props: { size: number; className?: string; children: ComponentChildren }): JSX.Element {
  return (
    <svg
      className={props.className}
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
