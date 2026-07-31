// Leaf module so every `doctor` producer — the session backend, the service
// manager, the key stores — reports in one shape and cli.ts renders them with
// one loop.

/** `doctor`'s three outcomes; `fail` is what makes it exit nonzero. */
export interface Check {
  readonly level: "ok" | "warn" | "fail";
  readonly message: string;
}
