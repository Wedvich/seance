/**
 * scrollTop that centres `item` in its scroll container, clamped so the item
 * stays fully visible at either end of the list. Tops are viewport-space rects,
 * so ancestor translations (the sheet's slide-in) cancel out.
 */
export function centeredScrollTop(
  container: { top: number; height: number; scrollTop: number; scrollHeight: number },
  item: { top: number; height: number },
): number {
  const itemTop = item.top - container.top + container.scrollTop;
  const centred = itemTop - (container.height - item.height) / 2;
  const max = Math.max(0, container.scrollHeight - container.height);
  return Math.min(max, Math.max(0, centred));
}
