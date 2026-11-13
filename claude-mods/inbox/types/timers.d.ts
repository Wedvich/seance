// For the tests only: the mod itself waits with the engine's `$.clock.sleep`, never a timer of its own (a hot
// reload cancels the engine's waits, not a raw one). The test runtime has timers, but the kit's type root
// (es2023, no DOM or node) declares none.
declare function setTimeout(handler: () => void, ms: number): unknown;
