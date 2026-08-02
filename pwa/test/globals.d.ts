/**
 * The two browser globals pwa/src/store.ts touches, declared just far enough
 * to typecheck under this project's DOM-free lib (see tsconfig.json). The
 * matching runtime stubs are installed at the top of client.test.ts. A copy of
 * e2e/globals.d.ts on purpose: a pwa suite has no business importing e2e's.
 */
declare var document: {
  visibilityState: "visible" | "hidden";
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

declare var history: {
  pushState(data: unknown, unused: string): void;
  replaceState(data: unknown, unused: string): void;
  back(): void;
};
