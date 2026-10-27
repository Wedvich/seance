export type MenuDirection = "down" | "up";

/** Gap between a menu and its anchor, px. */
export const MENU_OFFSET = 6;

export interface MenuPlacement {
  /** px from the viewport's top; null when pinned by `bottom`. */
  readonly top: number | null;
  /** px from the viewport's bottom; null when pinned by `top`. */
  readonly bottom: number | null;
  /** px from the viewport's right: the menu's right edge meets the anchor's. */
  readonly right: number;
}

/**
 * Where a fixed-position menu sits against its anchor's viewport rect. Pinned
 * on the anchor's side (`bottom` when opening up) so the menu's own height,
 * unknown before it lays out, never enters the sum.
 */
export function menuPlacement(
  direction: MenuDirection,
  anchor: { readonly top: number; readonly bottom: number; readonly right: number },
  viewport: { readonly width: number; readonly height: number },
): MenuPlacement {
  const right = viewport.width - anchor.right;
  if (direction === "up") return { top: null, bottom: viewport.height - anchor.top + MENU_OFFSET, right };
  return { top: anchor.bottom + MENU_OFFSET, bottom: null, right };
}

/**
 * The side a menu opens on. An `up` request is kept as is; a `down` one flips
 * up when the panel overruns the viewport below the anchor and fits above, or
 * when neither side fits and above has more room.
 */
export function menuDirection(
  requested: MenuDirection,
  anchor: { readonly top: number; readonly bottom: number },
  viewport: { readonly height: number },
  panelHeight: number,
): MenuDirection {
  if (requested === "up") return "up";
  const below = viewport.height - anchor.bottom - MENU_OFFSET;
  if (panelHeight <= below) return "down";
  const above = anchor.top - MENU_OFFSET;
  if (panelHeight <= above) return "up";
  return above > below ? "up" : "down";
}
