/**
 * The archivist never runs as root (docs/archivist.md, A12): it holds the PSK
 * and a plaintext history, and nothing it does needs privilege — PID 1 unseals
 * its key for it. uid and gid both, as `assertUnprivileged` in
 * `daemon/src/target-user.ts` checks a unit's user: gid 0 reaches as far as
 * uid 0 over what the service writes. Undefined (no POSIX ids, Windows) is not
 * root. Null when unprivileged, otherwise why not.
 */
export function rootRefusal(uid: number | undefined, gid: number | undefined): string | null {
  if (uid !== 0 && gid !== 0) return null;
  return `seance-archivist must never run as root (uid ${uid ?? "?"}, gid ${gid ?? "?"}) — run it as its own unprivileged user`;
}
