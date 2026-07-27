/**
 * The two browser globals pwa/src/store.ts touches, declared just far enough
 * to typecheck under this project's DOM-free lib (see tsconfig.json). The
 * matching runtime stubs are installed by harness.ts.
 */
declare var document: {
  visibilityState: "visible" | "hidden";
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

declare var history: {
  pushState(data: unknown, unused: string): void;
  back(): void;
};
