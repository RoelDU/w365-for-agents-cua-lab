/*
 * directLineAdapter.test.js - tests the Direct Line adapter with an INJECTED
 * fetch (no network). Covers the pure activity builders and the
 * open/poll sequences (incl. strict context-before-trigger ordering).
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DirectLineAdapter, CONTEXT_EVENT_NAME } = require("../src/channel/directLineAdapter");
const { getAdapter } = require("../src/channel");

const envelope = {
  correlation_id: "REQ-2024-0042",
  agent_display_name: "A. Carter",
  caller_phone: "(555) 123-4567",
  policy_number: "POL-2024-008341"
};

function jsonRes(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

test("buildUser id starts with dl_ and carries the agent name", () => {
  const u = DirectLineAdapter.buildUser(envelope);
  assert.ok(u.id.startsWith("dl_"));
  assert.equal(u.name, "A. Carter");
});

test("buildContextActivity is a pvaSetContext event carrying the envelope", () => {
  const a = DirectLineAdapter.buildContextActivity(envelope);
  assert.equal(a.type, "event");
  assert.equal(a.name, CONTEXT_EVENT_NAME);
  assert.equal(a.value.correlation_id, "REQ-2024-0042");
  assert.ok(a.from.id.startsWith("dl_"));
});

test("buildTriggerActivity is a message with the configured trigger text", () => {
  const a = DirectLineAdapter.buildTriggerActivity(envelope, "go now");
  assert.equal(a.type, "message");
  assert.equal(a.text, "go now");
});

test("openConversation sends context BEFORE trigger (strict order)", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (opts.method === "POST" && url.endsWith("/v3/directline/conversations")) {
      return jsonRes({ conversationId: "conv-1" });
    }
    return jsonRes({ id: "act-1" });
  };
  const adapter = new DirectLineAdapter({ secret: "s", baseUrl: "https://dl.test", fetchImpl });
  const out = await adapter.openConversation(envelope);
  assert.equal(out.conversationId, "conv-1");

  // 1) start conversation, 2) pvaSetContext event, 3) trigger message.
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.endsWith("/v3/directline/conversations"));
  assert.equal(calls[1].body.name, CONTEXT_EVENT_NAME);
  assert.equal(calls[1].body.type, "event");
  assert.equal(calls[2].body.type, "message");
});

test("openConversation sends the Direct Line secret as a bearer token", async () => {
  let auth;
  const fetchImpl = async (url, opts) => {
    auth = opts.headers.authorization;
    if (url.endsWith("/conversations")) return jsonRes({ conversationId: "c" });
    return jsonRes({});
  };
  const adapter = new DirectLineAdapter({ secret: "super-secret", baseUrl: "https://dl.test", fetchImpl });
  const out = await adapter.openConversation(envelope);
  assert.equal(auth, "Bearer super-secret");
  // The static secret is NEVER threaded through orchestrator state.
  assert.equal(out.auth, null);
});

test("token-endpoint mode fetches a token, starts a conversation, and threads it", async () => {
  const calls = [];
  const tokenEndpoint = "https://env.api.powerplatform.com/.../directline/token?api-version=2022-03-01-preview";
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || "GET", auth: opts && opts.headers && opts.headers.authorization });
    if (url === tokenEndpoint) {
      return jsonRes({ token: "tok-123", expires_in: 3600, conversationId: "conv-from-token" });
    }
    if (opts && opts.method === "POST" && url.endsWith("/v3/directline/conversations")) {
      // The Copilot Studio token endpoint's conversationId is NOT started; the
      // start call returns the live conversation (and may mint a fresh token).
      return jsonRes({ conversationId: "conv-started", token: "tok-conv" });
    }
    return jsonRes({ id: "act-1" });
  };
  const adapter = new DirectLineAdapter({ tokenEndpoint, baseUrl: "https://dl.test", fetchImpl });
  const out = await adapter.openConversation(envelope);

  // Auth comes from the token endpoint; the conversation is then started
  // (posting an activity to the unstarted token conversationId returns 404).
  assert.equal(calls[0].url, tokenEndpoint);
  assert.ok(calls.some((c) => c.url.endsWith("/v3/directline/conversations") && c.method === "POST"));
  // Uses the started conversation id, not the (unstarted) token-endpoint one.
  assert.equal(out.conversationId, "conv-started");
  // The conversation-bound token from the start call is threaded onward.
  assert.equal(out.auth, "tok-conv");
  // Activity POSTs use that conversation token as the bearer.
  const postActivity = calls.find((c) => c.url.includes("/activities"));
  assert.equal(postActivity.auth, "Bearer tok-conv");
});

test("pollConversation reuses the threaded token instead of refetching", async () => {
  let usedAuth;
  let tokenFetches = 0;
  const tokenEndpoint = "https://env/token?api-version=2022-03-01-preview";
  const fetchImpl = async (url, opts) => {
    if (url === tokenEndpoint) {
      tokenFetches += 1;
      return jsonRes({ token: "fresh", conversationId: "x" });
    }
    usedAuth = opts && opts.headers && opts.headers.authorization;
    return jsonRes({ activities: [] });
  };
  const adapter = new DirectLineAdapter({ tokenEndpoint, baseUrl: "https://dl.test", fetchImpl });
  await adapter.pollConversation({ conversationId: "c", watermark: null, auth: "threaded-token" });
  assert.equal(usedAuth, "Bearer threaded-token");
  assert.equal(tokenFetches, 0);
});

test("constructor throws when neither a secret nor a token endpoint is given", () => {
  assert.throws(() => new DirectLineAdapter({}), /secret or a directLineTokenEndpoint/);
});

test("maps IntegratedAuthenticationNotSupportedInChannel from the token endpoint to a clear error", async () => {
  const tokenEndpoint = "https://env/token?api-version=2022-03-01-preview";
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ error: { code: "IntegratedAuthenticationNotSupportedInChannel" } }),
    json: async () => ({})
  });
  const adapter = new DirectLineAdapter({ tokenEndpoint, baseUrl: "https://dl.test", fetchImpl });
  await assert.rejects(adapter.openConversation(envelope), (err) => {
    assert.equal(err.code, "AUTH_CHANNEL_UNSUPPORTED");
    assert.match(err.message, /Authenticate manually/);
    assert.match(err.message, /token endpoint HTTP 403/);
    return true;
  });
});

test("maps IntegratedAuthenticationNotSupportedInChannel from POST /conversations to a clear error", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    text: async () => "IntegratedAuthenticationNotSupportedInChannel",
    json: async () => ({})
  });
  const adapter = new DirectLineAdapter({ secret: "s", baseUrl: "https://dl.test", fetchImpl });
  await assert.rejects(adapter.openConversation(envelope), (err) => {
    assert.equal(err.code, "AUTH_CHANNEL_UNSUPPORTED");
    assert.match(err.message, /Require users to sign in.*OFF/);
    assert.match(err.message, /conversations HTTP 403/);
    return true;
  });
});

test("pollConversation URL-encodes the opaque watermark and returns a terminal result", async () => {
  let calledUrl;
  const fetchImpl = async (url) => {
    calledUrl = url;
    return jsonRes({
      watermark: "0002a-7",
      activities: [
        { type: "message", from: { id: "bot", role: "bot" }, text: "Filed CLM-2024-000123." }
      ]
    });
  };
  const adapter = new DirectLineAdapter({ secret: "s", baseUrl: "https://dl.test", fetchImpl });
  const out = await adapter.pollConversation({
    conversationId: "conv 1",
    watermark: "0001a-5",
    correlationId: "REQ-2024-0042"
  });
  assert.ok(calledUrl.includes("conv%201"));
  assert.ok(calledUrl.includes("watermark=0001a-5"));
  assert.equal(out.watermark, "0002a-7");
  assert.equal(out.result.claim_id, "CLM-2024-000123");
});

test("pollConversation keeps the previous watermark when the response omits one", async () => {
  const fetchImpl = async () => jsonRes({ activities: [] });
  const adapter = new DirectLineAdapter({ secret: "s", baseUrl: "https://dl.test", fetchImpl });
  const out = await adapter.pollConversation({ conversationId: "c", watermark: "keep-me" });
  assert.equal(out.watermark, "keep-me");
  assert.equal(out.result, null);
});

test("adapter throws a helpful error on non-2xx", async () => {
  const fetchImpl = async () => jsonRes({ error: "nope" }, false, 403);
  const adapter = new DirectLineAdapter({ secret: "s", baseUrl: "https://dl.test", fetchImpl });
  await assert.rejects(() => adapter.openConversation(envelope), /HTTP 403/);
});

test("getAdapter returns DirectLine for directline/zava and throws for d365", () => {
  assert.ok(getAdapter({ channel: "directline", secret: "s" }) instanceof DirectLineAdapter);
  assert.ok(getAdapter({ channel: "zava", secret: "s" }) instanceof DirectLineAdapter);
  assert.ok(
    getAdapter({ channel: "directline", tokenEndpoint: "https://env/token" }) instanceof DirectLineAdapter
  );
  assert.throws(() => getAdapter({ channel: "d365" }), /native/i);
  assert.throws(() => getAdapter({ channel: "bogus" }), /Unknown HANDOFF_CHANNEL/);
});
