/**
 * Returns true when running under Vitest (`import.meta.vitest` or NODE_ENV)
 * OR when Vite is in dev mode. Used to toggle strict-vs-lenient schema
 * validation behavior.
 */
export function isDevMode(): boolean {
  try {
    // import.meta.env is set by Vite. In Node-only contexts (e.g. unit tests
    // without Vite transform) it will be undefined; fall back to NODE_ENV.
    if (typeof import.meta !== "undefined" && (import.meta as any).env) {
      return Boolean((import.meta as any).env.DEV);
    }
  } catch {
    /* ignore */
  }
  return process.env.NODE_ENV !== "production";
}

export function buildVersion(): string {
  try {
    if (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_BUILD_VERSION) {
      return String((import.meta as any).env.VITE_BUILD_VERSION);
    }
  } catch {
    /* ignore */
  }
  return "3.2.0";
}
