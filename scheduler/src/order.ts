/** UTF-16 code-unit order, never locale: every leader sorts ties the same way. */
export function codeUnitOrder(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
