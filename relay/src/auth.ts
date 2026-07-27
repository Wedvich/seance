import { APP_PATH, DAEMON_PATH, TOKEN_PARAM } from "@seance/shared";

/** Fixed by upgrade path, so the DO knows what a socket is before any frame arrives. */
export type Role = "daemon" | "app";

export function roleForPath(pathname: string): Role | null {
  if (pathname === DAEMON_PATH) return "daemon";
  if (pathname === APP_PATH) return "app";
  return null;
}

/** Daemons send an Authorization header; browsers cannot set one on a WebSocket, so the app uses `?t=`. */
export function presentedToken(req: Request, role: Role): string | null {
  if (role === "app") {
    const token = new URL(req.url).searchParams.get(TOKEN_PARAM);
    return token === "" ? null : token;
  }
  const match = /^Bearer +(.+)$/iu.exec(req.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

export function tokenMatches(presented: string | null, expected: string | undefined): boolean {
  if (presented === null || expected === undefined || expected === "") return false;
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  // Bailing on length discloses only what a length check already would.
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}
