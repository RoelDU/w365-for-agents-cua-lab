/*
 * channel/index.js - channel-adapter factory. The adapter is the swappable seam
 * that lets the SAME Copilot Studio agent + Computer Use logic + result contract
 * serve different CCaaS layers. Today: Direct Line (Zava custom app). Future:
 * Dynamics 365 Contact Center native channel. See docs/handoff-architecture-decision.md.
 */

"use strict";

const { DirectLineAdapter } = require("./directLineAdapter");
const { EngineDirectAdapter } = require("./engineDirectAdapter");
const { D365ChannelAdapter } = require("./d365Adapter");

/**
 * @param {object} cfg channel config from config.getChannelConfig()
 * @param {Function} [fetchImpl] injected fetch for tests
 */
function getAdapter(cfg, fetchImpl) {
  const channel = (cfg && cfg.channel) || "directline";
  switch (channel) {
    case "directline":
    case "zava":
      return new DirectLineAdapter({
        secret: cfg.secret,
        tokenEndpoint: cfg.tokenEndpoint,
        baseUrl: cfg.baseUrl,
        triggerText: cfg.triggerText,
        fetchImpl
      });
    case "engine":
    case "directtoengine":
    case "pva-engine-direct":
      return new EngineDirectAdapter({
        conversationsUrl: cfg.engine && cfg.engine.conversationsUrl,
        token: cfg.engine && cfg.engine.token,
        tokenEndpoint: cfg.engine && cfg.engine.tokenEndpoint,
        tenantId: cfg.engine && cfg.engine.tenantId,
        clientId: cfg.engine && cfg.engine.clientId,
        clientSecret: cfg.engine && cfg.engine.clientSecret,
        scope: cfg.engine && cfg.engine.scope,
        triggerText: cfg.triggerText,
        fetchImpl
      });
    case "d365":
    case "dynamics365":
      return new D365ChannelAdapter();
    default:
      throw new Error(
        `Unknown HANDOFF_CHANNEL "${channel}". Use "directline", "engine" (Direct-to-Engine), or "d365".`
      );
  }
}

module.exports = { getAdapter };
