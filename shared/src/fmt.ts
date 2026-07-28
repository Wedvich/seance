/**
 * Quoted, never bare: these values arrive over the wire or off a command line,
 * and an unescaped newline in one would let a caller forge whole log lines.
 * Shared by all three tiers so a daemon line, a relay line, and an app line
 * describing the same message are greppable with one expression.
 */
export const quote = (value: string): string => JSON.stringify(value);
