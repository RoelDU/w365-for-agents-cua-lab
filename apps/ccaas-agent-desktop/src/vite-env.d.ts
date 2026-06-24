/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AZURE_CLIENT_ID?: string;
  readonly VITE_AZURE_TENANT_ID?: string;
  readonly VITE_AZURE_REDIRECT_URI?: string;
  readonly VITE_ORCHESTRATOR_URL?: string;
  readonly VITE_FOUNDRY_ORCHESTRATOR_URL?: string;
  readonly VITE_DEFAULT_BACKEND?: "mcs" | "foundry";
  readonly VITE_BUILD_VERSION?: string;
  /** Copilot Studio Direct Line token endpoint. When set, the Transfer button
   * streams the live agent desktop in-app via a browser-direct Direct Line
   * conversation (no orchestrator, no test pane). Unset = legacy orchestrator path. */
  readonly VITE_DIRECTLINE_TOKEN_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.json" {
  const value: any;
  export default value;
}
