/** What `createShutdown` needs of the process; each a seam so a test can run the sequence without a daemon. */
export interface ShutdownSeams {
  readonly info: (message: string) => void;
  readonly stopPower: () => void;
  /** Holds task launches and waits for those in flight; a rejection is as good as a timeout. */
  readonly drain: () => Promise<unknown>;
  readonly stop: () => void;
  readonly exit: (code: number) => void;
}

/**
 * The SIGTERM/SIGINT handler. The first signal drains task launches *before* `stop`, which keeps the
 * relay leg up so a finishing spawn's reply still reaches its leader; `exit` follows `stop` even when
 * `stop` throws, or the daemon would hang past a signal. A second signal exits at once.
 */
export function createShutdown(seams: ShutdownSeams): (signal: string) => void {
  let stopping = false;
  return (signal) => {
    if (stopping) {
      seams.info(`${signal} again — exiting without waiting for task launches`);
      seams.exit(0);
      return;
    }
    stopping = true;
    seams.info(`${signal} — shutting down`);
    seams.stopPower();
    void seams
      .drain()
      .catch(() => false)
      .finally(() => {
        try {
          seams.stop();
        } catch (err) {
          seams.info(`stop failed (${String(err)}) — exiting anyway`);
        } finally {
          seams.exit(0);
        }
      });
  };
}
