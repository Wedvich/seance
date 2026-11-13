// The mod runtime has timers, but the kit's type root (es2023, no DOM or node) declares none.
declare function setTimeout(handler: () => void, ms: number): unknown;
