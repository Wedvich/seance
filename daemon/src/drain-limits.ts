/**
 * How long a self-update waits for task launches in flight before it restarts:
 * a spawn's own timeout is 90 s (`OP_TIMEOUT_MS.spawn`), so past this none is
 * still one its leader waits on.
 */
export const UPDATE_DRAIN_MS = 120_000;

/**
 * How long SIGTERM/SIGINT waits for them: under launchd's default `ExitTimeOut`
 * of 20 s (the plist sets none), and far under systemd's `TimeoutStopSec` of
 * 90 s with `KillMode=process`. A launch cut off past it is `interrupted`.
 */
export const SHUTDOWN_DRAIN_MS = 15_000;
