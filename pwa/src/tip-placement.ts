/** Gap between the anchor and the tip, and the tip's floor from a viewport edge. */
const GAP = 6;
const EDGE = 8;

export interface TipPlacement {
  readonly left: number;
  readonly top: number;
  readonly side: "above" | "below";
}

/**
 * Where the fixed-position tip sits against its anchor's viewport rect: centred
 * above it, below when there is no room above, and slid sideways rather than
 * clipped at a viewport edge.
 */
export function tipPlacement(
  anchor: { readonly left: number; readonly top: number; readonly bottom: number; readonly width: number },
  tip: { readonly width: number; readonly height: number },
  viewportWidth: number,
): TipPlacement {
  const centred = anchor.left + anchor.width / 2 - tip.width / 2;
  const left = Math.max(EDGE, Math.min(centred, viewportWidth - tip.width - EDGE));
  const above = anchor.top - GAP - tip.height;
  if (above >= EDGE) return { left, top: above, side: "above" };
  return { left, top: anchor.bottom + GAP, side: "below" };
}
