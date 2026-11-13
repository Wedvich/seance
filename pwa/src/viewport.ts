export interface ViewportInsets {
  readonly top: number;
  readonly bottom: number;
}

/** How far the visual viewport sits inside the layout viewport, top and bottom, or null when it covers it. */
export function viewportInsets(
  visual: { readonly offsetTop: number; readonly height: number },
  layoutHeight: number,
): ViewportInsets | null {
  // iOS rubber-banding can report a negative offsetTop.
  const top = Math.max(0, visual.offsetTop);
  const bottom = Math.max(0, layoutHeight - top - visual.height);
  // Sub-pixel noise: nothing to adjust.
  if (top < 1 && bottom < 1) return null;
  return { top, bottom };
}

/** The height a sheet locks to on open: its content, capped at the share of the layout viewport an unlocked sheet may take. */
export function lockedSheetHeight(contentHeight: number, layoutHeight: number): number {
  return Math.min(contentHeight, layoutHeight * 0.74);
}
