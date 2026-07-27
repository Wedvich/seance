export type Level = "info" | "warn" | "error";

/** Exported so the CLI's audit sink writes bytes identical to the daemon's. */
export function formatLine(level: Level, msg: string): string {
  return `${new Date().toISOString()} ${level} ${msg}`;
}

function write(level: Level, msg: string): void {
  const line = formatLine(level, msg);
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string): void => write("info", msg),
  warn: (msg: string): void => write("warn", msg),
  error: (msg: string): void => write("error", msg),
} as const;
