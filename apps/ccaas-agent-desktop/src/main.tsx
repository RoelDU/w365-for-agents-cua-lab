import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./index.css";

// Capture the Entra redirect response hash SYNCHRONOUSLY, before React Router
// renders and replaces "/" → "/login" (which would wipe the #code=... fragment
// the auth response carries). msalLogin reads this when completing sign-in.
const initialHash = window.location.hash;
if (initialHash && /[#&](code|error|state)=/.test(initialHash)) {
  (window as unknown as { __entraRedirectHash?: string }).__entraRedirectHash =
    initialHash;
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found in index.html.");
}

// Dev/demo-only: expose the handoff + call stores so an automated demo driver can
// replay a recorded Computer Use session into the app's own live-desktop theater
// view. Tree-shaken out of production builds (import.meta.env.DEV is false there).
if (import.meta.env.DEV) {
  void (async () => {
    const [{ useHandoffStore }, { useCallStore }, { useAuthStore }, { useSettingsStore }, { useLangStore }] = await Promise.all([
      import("./stores/useHandoffStore"),
      import("./stores/useCallStore"),
      import("./stores/useAuthStore"),
      import("./stores/useSettingsStore"),
      import("./stores/useLangStore")
    ]);
    (window as unknown as { __demo?: unknown }).__demo = {
      handoff: useHandoffStore,
      call: useCallStore,
      auth: useAuthStore,
      settings: useSettingsStore,
      lang: useLangStore
    };
  })();
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
