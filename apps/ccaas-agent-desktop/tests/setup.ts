import "@testing-library/jest-dom/vitest";
import { afterEach, beforeAll, afterAll, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom doesn't ship matchMedia — provide a permissive shim so
// `prefers-reduced-motion` checks don't blow up in tests.
beforeAll(() => {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false
      })
    });
  }
});

// Reset between tests so persisted Zustand stores don't bleed state.
beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  /* no-op */
});
