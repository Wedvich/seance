import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";

/** Past this a cold start is slow enough to say what it is waiting on. */
const SLOW_MS = 2_000;

/**
 * Shown while the key store is read, the one wait before the app can tell Setup
 * from the form. Names the wait once it drags, so a slow launch says where it is
 * stuck; Settings keeps the timings (`launch.ts`).
 */
export function Booting(): JSX.Element {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <main className="screen booting">
      <p className="booting-text">{slow ? "Still reading the stored key…" : "Opening…"}</p>
    </main>
  );
}
