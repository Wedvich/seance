type Level = "info" | "warn" | "error";

function write(level: Level, msg: string): void {
  const line = `${new Date().toISOString()} ${level} ${msg}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string): void => write("info", msg),
  warn: (msg: string): void => write("warn", msg),
  error: (msg: string): void => write("error", msg),
} as const;
