/*
 * engineDirectAdapter.js - the CUA-SUPPORTED channel adapter to a published
 * Microsoft Copilot Studio agent, over the Copilot Studio "Direct to Engine"
 * conversations API (channel `pva-engine-direct`).
 *
 * WHY THIS EXISTS (issue #112): the Computer Use tool only runs on a fixed set of
 * channels - msteams, pva-engine-direct, pva-studio, pva-maker-evaluation,
 * pva-autonomous. Classic Bot Framework Direct Line ("directline",
 * https://directline.botframework.com) is NOT in that list, so the Direct Line
 * adapter reaches the Cloud PC ('ready') but Computer Use never executes; the
 * turn ends with "...requires one of the following supported channels...". The
 * Test pane works because it is itself a supported channel. Direct-to-Engine
 * (pva-engine-direct) is a supported, server-to-server channel, so this adapter
 * is the working replacement for the unattended orchestrator.
 *
 * CONTRACT IS UNCHANGED. This adapter speaks the SAME envelope contract as the
 * Direct Line adapter: a `pvaSetContext` EVENT activity (mapped into Global
 * variables marked "External sources can set values") sent FIRST, then an
 * explicit natural-language trigger MESSAGE that routes via generative
 * orchestration to the Computer Use tool (#69). The two sends are strictly
 * sequential. The terminal result is read by the orchestrator EITHER from the
 * typed result-flow callback (authoritative) OR by polling the conversation
 * transcript here (fallback) - both use the shared contract.parseActivities.
 *
 * WIRE SHAPE. Direct-to-Engine is Direct-Line-shaped (conversations + activities
 * + watermark), but hosted on the Power Platform / Copilot Studio endpoint rather
 * than directline.botframework.com:
 *   start :  POST {conversationsUrl}                 -> { conversationId, watermark }
 *   send  :  POST {conversationsUrl}/{conversationId} -> activities
 *   poll  :  GET  {conversationsUrl}/{conversationId}?watermark=... -> { activities, watermark }
 * `conversationsUrl` is the full per-environment endpoint, e.g.
 *   https://{env}.environment.api.powerplatform.com/powervirtualagents/botsbyschema/{schema}/conversations?api-version=2022-03-01-preview
 * It is configured verbatim (ENGINE_CONVERSATIONS_URL) because the host segment is
 * environment-specific; do not try to compute it here.
 *
 * AUTH. Direct-to-Engine requires an Entra ID bearer token (no anonymous secret).
 * Two unattended modes, in priority order:
 *   1. client credentials  - mint an app-only token from Entra
 *      (ENGINE_TENANT_ID / ENGINE_CLIENT_ID / ENGINE_CLIENT_SECRET, scope
 *      ENGINE_SCOPE, default https://api.powerplatform.com/.default).
 *   2. token endpoint / static token - GET ENGINE_TOKEN_ENDPOINT (returns
 *      { token, expires_in }) or use a pre-obtained ENGINE_TOKEN. Use this when a
 *      delegated token must be injected (e.g. if app-only is not permitted on the
 *      tenant - the M365 Agents SDK path is delegated-only).
 * The token is NEVER exposed to the browser. The conversation-bound auth is
 * threaded from openConversation to pollConversation via orchestrator state.
 */

"use strict";

const { parseActivities, buildTriggerText } = require("../contract");
const { describeChannelError } = require("./channelErrors");

const CONTEXT_EVENT_NAME = "pvaSetContext";
const DEFAULT_SCOPE = "https://api.powerplatform.com/.default";

class EngineDirectAdapter {
  /**
   * @param {object} opts
   * @param {string}  opts.conversationsUrl  full Direct-to-Engine conversations URL.
   * @param {string} [opts.token]            pre-obtained bearer token.
   * @param {string} [opts.tokenEndpoint]    GET endpoint returning { token, expires_in }.
   * @param {string} [opts.tenantId]         Entra tenant id (client-credentials mode).
   * @param {string} [opts.clientId]         Entra app id (client-credentials mode).
   * @param {string} [opts.clientSecret]     Entra app secret (client-credentials mode).
   * @param {string} [opts.scope]            OAuth scope (default Power Platform API).
   * @param {string} [opts.authority]        token authority base (default login.microsoftonline.com).
   * @param {string} [opts.triggerText]
   * @param {Function} [opts.fetchImpl]      injected fetch (defaults to global fetch).
   */
  constructor({
    conversationsUrl,
    token,
    tokenEndpoint,
    tenantId,
    clientId,
    clientSecret,
    scope,
    authority,
    triggerText,
    fetchImpl
  } = {}) {
    if (!conversationsUrl) {
      throw new Error(
        "EngineDirectAdapter requires ENGINE_CONVERSATIONS_URL (the Direct-to-Engine conversations endpoint)."
      );
    }
    const hasClientCreds = Boolean(tenantId && clientId && clientSecret);
    if (!token && !tokenEndpoint && !hasClientCreds) {
      throw new Error(
        "EngineDirectAdapter requires an Entra token: set ENGINE_TOKEN, ENGINE_TOKEN_ENDPOINT, " +
          "or ENGINE_TENANT_ID + ENGINE_CLIENT_ID + ENGINE_CLIENT_SECRET."
      );
    }
    this.conversationsUrl = String(conversationsUrl);
    this.staticToken = token || "";
    this.tokenEndpoint = tokenEndpoint || "";
    this.tenantId = tenantId || "";
    this.clientId = clientId || "";
    this.clientSecret = clientSecret || "";
    this.scope = scope || DEFAULT_SCOPE;
    this.authority = (authority || "https://login.microsoftonline.com").replace(/\/+$/, "");
    this.triggerText = buildTriggerText(triggerText);
    this.fetch = fetchImpl || globalThis.fetch;

    this._bearer = this.staticToken || null;
    this._tokenExpiresAt = 0;
  }

  static describeChannelError(body) {
    return describeChannelError(body);
  }

  _headers(extra) {
    return {
      authorization: `Bearer ${this._bearer}`,
      ...(extra || {})
    };
  }

  /**
   * Build the URL for a conversations sub-resource, preserving the api-version
   * (and any other) query string from the configured conversationsUrl.
   * suffix is appended to the PATH (e.g. "/abc123"); extraQuery is merged in.
   */
  _url(suffix, extraQuery) {
    const u = new URL(this.conversationsUrl);
    if (suffix) u.pathname = `${u.pathname.replace(/\/+$/, "")}${suffix}`;
    if (extraQuery) {
      for (const [k, v] of Object.entries(extraQuery)) {
        if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  /**
   * Resolve the bearer token. Static token: no-op. Token endpoint: GET it and
   * cache. Client credentials: POST the Entra token endpoint and cache. Cached
   * tokens refresh 60s before expiry.
   */
  async _ensureAuth() {
    if (this.staticToken) {
      this._bearer = this.staticToken;
      return;
    }
    if (this._bearer && Date.now() < this._tokenExpiresAt) return;

    if (this.tokenEndpoint) {
      await this._fetchTokenFromEndpoint();
      return;
    }
    await this._fetchTokenFromEntra();
  }

  async _fetchTokenFromEndpoint() {
    const res = await this.fetch(this.tokenEndpoint, { method: "GET" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw EngineDirectAdapter._error(text, `token endpoint HTTP ${res.status}`, res.status);
    }
    const data = await res.json();
    if (!data || !data.token) {
      throw new Error("Direct-to-Engine token endpoint did not return a token.");
    }
    this._cacheToken(data.token, data.expires_in);
  }

  async _fetchTokenFromEntra() {
    const tokenUrl = `${this.authority}/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: this.scope
    });
    const res = await this.fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Entra token request failed (HTTP ${res.status}): ${text}`);
    }
    const data = await res.json();
    if (!data || !data.access_token) {
      throw new Error("Entra token endpoint did not return an access_token.");
    }
    this._cacheToken(data.access_token, data.expires_in);
  }

  _cacheToken(token, expiresIn) {
    this._bearer = token;
    const ttlMs = (Number(expiresIn) > 0 ? Number(expiresIn) : 3600) * 1000;
    this._tokenExpiresAt = Date.now() + Math.max(ttlMs - 60000, 0);
  }

  static _error(body, where, status) {
    const channel = describeChannelError(body);
    const err = new Error(
      channel ? `${channel.message} (${where})` : `Direct-to-Engine ${where}: ${body}`
    );
    err.status = status;
    if (channel) err.code = channel.code;
    return err;
  }

  async _request(method, url, body) {
    const res = await this.fetch(url, {
      method,
      headers: this._headers(body !== undefined ? { "content-type": "application/json" } : undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw EngineDirectAdapter._error(text, `${method} HTTP ${res.status}`, res.status);
    }
    return res.json();
  }

  /**
   * Start a conversation, set context, then trigger. Returns
   * { conversationId, watermark, auth }. Sequential by design - the trigger must
   * not race the context set. `auth` is the bearer threaded to pollConversation
   * so the poll reuses the same token without re-minting.
   *
   * NOTE on exactly-once: as with Direct Line, Durable activities run
   * at-least-once; the defence against a duplicate trigger on a worker crash is
   * downstream (agent's pre-create duplicate check in claims.exe keyed on
   * correlation_id, plus human review). See docs/handoff-architecture-decision.md.
   */
  async openConversation(envelope) {
    await this._ensureAuth();

    const conv = await this._request("POST", this._url(), { emitStartConversationEvent: false });
    const conversationId = conv.conversationId || conv.id;
    if (!conversationId) {
      throw new Error("Direct-to-Engine did not return a conversationId.");
    }

    const user = EngineDirectAdapter.buildUser(envelope);
    await this._postActivity(
      conversationId,
      EngineDirectAdapter.buildContextActivity(envelope, user)
    );
    await this._postActivity(
      conversationId,
      EngineDirectAdapter.buildTriggerActivity(envelope, this.triggerText, user)
    );

    return {
      conversationId,
      watermark: conv.watermark != null ? String(conv.watermark) : null,
      auth: this._bearer
    };
  }

  async _postActivity(conversationId, activity) {
    return this._request("POST", this._url(`/${encodeURIComponent(conversationId)}`), activity);
  }

  /**
   * Poll for new activities since `watermark` (opaque string). Returns
   * { watermark, result } where result is a terminal result object or null.
   * Watermark is treated as opaque and is NOT advanced when the response omits
   * one.
   */
  async pollConversation({ conversationId, watermark, correlationId, auth }) {
    if (auth) {
      this._bearer = auth;
    } else {
      await this._ensureAuth();
    }
    const url = this._url(
      `/${encodeURIComponent(conversationId)}`,
      watermark ? { watermark } : undefined
    );
    const data = await this._request("GET", url);
    const activities = (data && data.activities) || [];
    const result = parseActivities(activities, correlationId);
    return {
      watermark: data && data.watermark != null ? String(data.watermark) : watermark,
      result
    };
  }

  // ---- pure builders (shared shape with the Direct Line adapter, unit-tested) ----

  static buildUser(envelope) {
    const cid = (envelope && envelope.correlation_id) || "anon";
    return { id: `dl_${cid}`, name: (envelope && envelope.agent_display_name) || "Zava CCaaS" };
  }

  static buildContextActivity(envelope, user) {
    return {
      type: "event",
      name: CONTEXT_EVENT_NAME,
      from: user || EngineDirectAdapter.buildUser(envelope),
      value: envelope
    };
  }

  static buildTriggerActivity(envelope, triggerText, user) {
    return {
      type: "message",
      text: buildTriggerText(triggerText),
      from: user || EngineDirectAdapter.buildUser(envelope)
    };
  }
}

module.exports = { EngineDirectAdapter, CONTEXT_EVENT_NAME };
