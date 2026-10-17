/**
 * Waits for a condition the client reaches asynchronously, failing with what it
 * waited for rather than the runner's bare timeout. daemon/test/fixtures.ts has
 * its own; pwa tests do not import the daemon's test tree.
 */
export async function pollUntil(ready: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (ready()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await Bun.sleep(5);
  }
}
