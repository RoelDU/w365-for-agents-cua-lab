/*
 * directLineAdapter.js - the Zava CUSTOM channel adapter to a published
 * Microsoft Copilot Studio agent, over Bot Framework Direct Line 3.0.
 *
 * This is the only place that talks to Direct Line. It is deliberately thin and
 * its message-construction logic is PURE (buildContextActivity /
 * buildTriggerActivity / buildUser) so it can be unit-tested with an injected
 * fetch, no network required.
 *
 * Auth: for server-to-server REST we use the Direct Line SECRET directly as the
 * bearer token (valid for trusted backends; avoids token-expiry churn). The
 * secret is NEVER exposed to the browser - it lives only in server settings /
 * Key Vault. If you ever hand a token to a client, exchange the secret for a
 * single-conversation token instead; never ship the secret.
 *
 * Token-endpoint mode: newer Copilot Studio channels (e.g. the 60-day premium
 * trial / Microsoft 365 Agents SDK) no longer expose a classic Direct Line
 * secret. Instead they expose a token endpoint that returns
 * { token, expires_in, conversationId }. When `tokenEndpoint` is configured (and
 * no secret), we GET it to obtain a conversation-bound token and reuse the
 * returned conversationId. Because activities are stateless, the token is
 * threaded from openConversation to pollConversation via orchestrator state; the
 * static secret is never threaded.
 *
 * Context passing follows Copilot Studio's documented mechanism: a `pvaSetContext`
 * EVENT activity whose value is the neutral context envelope (mapped into Global
 * variables marked "external sources can set values"), sent FIRST, then an
 * explicit trigger MESSAGE to start the FNOL business logic. The two sends are
 * strictly sequential (await the context POST before the trigger POST).
 */

"use strict";

const { parseActivities, buildTriggerText } = require("../contract");
const { describeChannelError } = require("./channelErrors");

const CONTEXT_EVENT_NAME = "pvaSetContext";

class DirectLineAdapter {
  /**
   * @param {object} opts
   * @param {string} [opts.secret]    Direct Line secret (server-side only).
   * @param {string} [opts.tokenEndpoint] Copilot Studio Direct Line token endpoint
   *   (returns { token, expires_in, conversationId }). Used when no secret exists.
   * @param {string} [opts.baseUrl]   Direct Line base URL.
   * @param {string} [opts.triggerText]
   * @param {Function} [opts.fetchImpl] injected fetch (defaults to global fetch).
   */
  constructor({ secret, tokenEndpoint, baseUrl, triggerText, fetchImpl } = {}) {
    if (!secret && !tokenEndpoint) {
      throw new Error(
        "DirectLineAdapter requires either a Direct Line secret or a directLineTokenEndpoint."
      );
    }
    this.secret = secret || "";
    this.tokenEndpoint = tokenEndpoint || "";
    this.baseUrl = (baseUrl || "https://directline.botframework.com").replace(/\/+$/, "");
    this.triggerText = buildTriggerText(triggerText);
    this.fetch = fetchImpl || globalThis.fetch;
    // Auth resolved lazily: a static secret, or a token fetched from the Copilot
    // Studio / Power Platform Direct Line token endpoint.
    this._bearer = this.secret || null;
    this._tokenConversationId = null;
    this._tokenExpiresAt = 0;
  }

  _headers(extra) {
    return {
      authorization: `Bearer ${this._bearer}`,
      ...(extra || {})
    };
  }

  /**
   * Direct Line surfaces a misconfigured Copilot Studio agent as an opaque HTTP
   * error. Map the known signatures to a clear, actionable message so the cause
   * is unmistakable in the orchestrator logs (instead of a generic
   * "Direct Line ... failed"). Returns { code, message } or null.
   */
  static describeChannelError(body) {
    return describeChannelError(body);
  }

  /**
   * Resolve the bearer token. With a static secret this is a no-op. With a token
   * endpoint we GET it (returns { token, expires_in, conversationId }) and cache
   * the token until shortly before it expires, recording any returned
   * conversationId so we don't start a second, empty conversation.
   */
  async _ensureAuth() {
    if (this.secret) {
      this._bearer = this.secret;
      return;
    }
    if (this._bearer && Date.now() < this._tokenExpiresAt) return;
    const res = await this.fetch(this.tokenEndpoint, { method: "GET" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const channel = DirectLineAdapter.describeChannelError(text);
      const err = new Error(
        channel
          ? `${channel.message} (token endpoint HTTP ${res.status})`
          : `Direct Line token endpoint failed (HTTP ${res.status}): ${text}`
      );
      err.status = res.status;
      if (channel) err.code = channel.code;
      throw err;
    }
    const data = await res.json();
    if (!data || !data.token) {
      throw new Error("Direct Line token endpoint did not return a token.");
    }
    this._bearer = data.token;
    this._tokenConversationId = data.conversationId || null;
    // Refresh 60s early; default to 30 min when the endpoint omits expires_in.
    const ttlMs = (Number(data.expires_in) > 0 ? Number(data.expires_in) : 1800) * 1000;
    this._tokenExpiresAt = Date.now() + Math.max(ttlMs - 60000, 0);
  }

  async _json(method, path, body) {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this._headers(body !== undefined ? { "content-type": "application/json" } : undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const channel = DirectLineAdapter.describeChannelError(text);
      const err = new Error(
        channel
          ? `${channel.message} (${method} ${path} HTTP ${res.status})`
          : `Direct Line ${method} ${path} failed (HTTP ${res.status}): ${text}`
      );
      err.status = res.status;
      if (channel) err.code = channel.code;
      throw err;
    }
    return res.json();
  }

  /**
   * Start a conversation, set context, then trigger. Returns
   * { conversationId, watermark, auth }. Sequential by design - the trigger must
   * not race the context set. `auth` is the conversation-bound token in
   * token-endpoint mode (threaded to pollConversation), or null in secret mode.
   *
   * NOTE on exactly-once: Durable activities run at-least-once, so on a worker
   * crash between the trigger POST and the activity checkpoint this could send a
   * duplicate turn. The defence is downstream (agent does a pre-create duplicate
   * check in claims.exe keyed on correlation_id, plus human review); see
   * docs/handoff-architecture-decision.md.
   */
  async openConversation(envelope) {
    await this._ensureAuth();
    // ALWAYS start the conversation with POST /conversations. In token-endpoint
    // mode the token endpoint returns a conversationId, but that conversation is
    // NOT yet started - posting an activity straight to it returns HTTP 404
    // "Conversation not found" (verified against Copilot Studio Direct Line).
    // Starting it (the bearer is the token-endpoint token) returns the live
    // conversationId and, when present, a fresh conversation-bound token to use
    // for the subsequent activity posts and polling.
    const conv = await this._json("POST", "/v3/directline/conversations");
    const conversationId = conv.conversationId || this._tokenConversationId;
    if (!conversationId) throw new Error("Direct Line did not return a conversationId.");
    if (!this.secret && conv.token) {
      this._bearer = conv.token;
    }

    const user = DirectLineAdapter.buildUser(envelope);
    await this._postActivity(
      conversationId,
      DirectLineAdapter.buildContextActivity(envelope, user)
    );
    await this._postActivity(
      conversationId,
      DirectLineAdapter.buildTriggerActivity(envelope, this.triggerText, user)
    );
    // In token-endpoint mode the conversation is bound to this short-lived token,
    // so thread it to pollConversation. In secret mode return null - the secret
    // is never placed in orchestrator state.
    const auth = this.secret ? null : this._bearer;
    return { conversationId, watermark: null, auth };
  }

  async _postActivity(conversationId, activity) {
    return this._json(
      "POST",
      `/v3/directline/conversations/${encodeURIComponent(conversationId)}/activities`,
      activity
    );
  }

  /**
   * Poll for new activities since `watermark` (opaque string). Returns
   * { watermark, result } where result is a terminal result object or null.
   * Watermark is treated as opaque and is NOT advanced when the response omits
   * one.
   */
  async pollConversation({ conversationId, watermark, correlationId, auth }) {
    if (auth) {
      // Reuse the conversation-bound token threaded from openConversation.
      this._bearer = auth;
    } else {
      await this._ensureAuth();
    }
    const wm = watermark ? `?watermark=${encodeURIComponent(watermark)}` : "";
    const data = await this._json(
      "GET",
      `/v3/directline/conversations/${encodeURIComponent(conversationId)}/activities${wm}`
    );
    const activities = (data && data.activities) || [];
    const result = parseActivities(activities, correlationId);
    return {
      watermark: data && data.watermark != null ? String(data.watermark) : watermark,
      result
    };
  }

  // ---- pure builders (unit-tested) ----

  static buildUser(envelope) {
    // Direct Line user ids must start with "dl_".
    const cid = (envelope && envelope.correlation_id) || "anon";
    return { id: `dl_${cid}`, name: (envelope && envelope.agent_display_name) || "Zava CCaaS" };
  }

  static buildContextActivity(envelope, user) {
    return {
      type: "event",
      name: CONTEXT_EVENT_NAME,
      from: user || DirectLineAdapter.buildUser(envelope),
      value: envelope
    };
  }

  static buildTriggerActivity(envelope, triggerText, user) {
    return {
      type: "message",
      text: buildTriggerText(triggerText),
      from: user || DirectLineAdapter.buildUser(envelope)
    };
  }
}

module.exports = { DirectLineAdapter, CONTEXT_EVENT_NAME };
