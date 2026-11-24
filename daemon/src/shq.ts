/** One POSIX-shell single-quoted word: what every wire value and path in a pane's shell string goes through. */
export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
