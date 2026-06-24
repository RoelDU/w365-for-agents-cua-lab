/*
 * config.js - reads server-side settings (env / Key Vault references) ONCE so
 * the rest of the app never touches process.env directly. Timing values are
 * passed into the orchestrator as input (orchestrators must stay deterministic
 * and not read env); secrets/URLs are read inside activities only.
 */

"use strict";

function intEnv(name, fallback) {
  const raw = process.env[name];
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Timing + channel selection - safe to embed in orchestrator input. */
function getTiming() {
  return {
    pollIntervalMs: intEnv("HANDOFF_POLL_INTERVAL_MS", 5000),
    executionTimeoutMs: intEnv("HANDOFF_EXECUTION_TIMEOUT_MS", 15 * 60 * 1000)
  };
}

/** Channel + secret config - read inside activities / http handlers only. */
function getChannelConfig() {
  return {
    channel: (process.env.HANDOFF_CHANNEL || "engine").toLowerCase(),
    secret: process.env.DIRECTLINE_SECRET || "",
    tokenEndpoint: process.env.DIRECTLINE_TOKEN_ENDPOINT || "",
    baseUrl: (process.env.DIRECTLINE_BASE_URL || "https://directline.botframework.com").replace(
      /\/+$/,
      ""
    ),
    triggerText: process.env.HANDOFF_TRIGGER_TEXT || "start handoff",
    // Direct-to-Engine (channel pva-engine-direct) - the CUA-supported invocation
    // path (#112). Only read when HANDOFF_CHANNEL=engine.
    engine: {
      conversationsUrl: process.env.ENGINE_CONVERSATIONS_URL || "",
      token: process.env.ENGINE_TOKEN || "",
      tokenEndpoint: process.env.ENGINE_TOKEN_ENDPOINT || "",
      tenantId: process.env.ENGINE_TENANT_ID || "",
      clientId: process.env.ENGINE_CLIENT_ID || "",
      clientSecret: process.env.ENGINE_CLIENT_SECRET || "",
      scope: process.env.ENGINE_SCOPE || ""
    }
  };
}

/**
 * Shared secret the typed Power Automate result flow must present on the
 * structured-completion callback. When unset, the callback is open (local dev
 * only) and a warning should be logged.
 */
function getCallbackKey() {
  return process.env.HANDOFF_CALLBACK_KEY || "";
}

/**
 * Whether an UNAUTHENTICATED result callback is permitted (no HANDOFF_CALLBACK_KEY
 * configured). Defaults to FALSE so a missing key fails CLOSED in any deployed
 * environment - set HANDOFF_ALLOW_INSECURE_CALLBACK=true ONLY for local dev.
 */
function isInsecureCallbackAllowed() {
  return String(process.env.HANDOFF_ALLOW_INSECURE_CALLBACK || "").toLowerCase() === "true";
}

module.exports = { getTiming, getChannelConfig, getCallbackKey, isInsecureCallbackAllowed };
