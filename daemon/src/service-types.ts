// Leaf module so the service.ts dispatcher and its per-platform backends can
// share these shapes without importing each other.

export interface InstallResult {
  readonly target: string;
  /** Non-fatal steps that need a hand — each carries the manual command. */
  readonly notes: readonly string[];
}

export interface ServiceCheck {
  readonly ok: boolean;
  readonly message: string;
}
