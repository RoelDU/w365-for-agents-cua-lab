/*
 * engineDirectAdapter.test.js - tests the Direct-to-Engine adapter (channel
 * pva-engine-direct, the CUA-supported path, #112) with an INJECTED fetch (no
 * network). Covers the pure builders, auth modes (static / token-endpoint /
 * client-credentials), the strict context-before-trigger open sequence, the
 * watermark poll, sub-resource URL building (api-version preserved), and the
 * channel-error mapping.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EngineDirectAdapter, CONTEXT_EVENT_NAME } = require("../src/channel/engineDirectAdapter");
const { getAdapter } = require("../src/channel");

const CONV_URL =
  "https://env.environment.api.powerplatform.com/powervirtualagents/botsbyschema/zava_agent/conversations?api-version=2022-03-01-preview";

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
  const u = EngineDirectAdapter.buildUser(envelope);
  assert.ok(u.id.startsWith("dl_"));
  assert.equal(u.name, "A. Carter");
});

test("buildContextActivity is a pvaSetContext event carrying the envelope", () => {
  const a = EngineDirectAdapter.buildContextActivity(envelope);
  assert.equal(a.type, "event");
  assert.equal(a.name, CONTEXT_EVENT_NAME);
  assert.equal(a.value.correlation_id, "REQ-2024-0042");
  assert.ok(a.from.id.startsWith("dl_"));
});

test("buildTriggerActivity is a message with the configured trigger text", () => {
  const a = EngineDirectAdapter.buildTriggerActivity(envelope, "file the FNOL now");
  assert.equal(a.type, "message");
  assert.equal(a.text, "file the FNOL now");
});

test("constructor requires a conversations URL", () => {
  assert.throws(
    () => new EngineDirectAdapter({ token: "t" }),
    /ENGINE_CONVERSATIONS_URL/
  );
});

test("constructor requires an Entra token source", () => {
  assert.throws(
    () => new EngineDirectAdapter({ conversationsUrl: CONV_URL }),
    /ENGINE_TOKEN|ENGINE_TENANT_ID/
  );
});

test("openConversation: starts, sends context BEFORE trigger, threads the token", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({
      url,
      method: opts.method,
      auth: opts.headers && opts.headers.authorization,
      body: opts.body ? JSON.parse(opts.body) : undefined
    });
    if (opts.method === "POST" && !url.includes("/conv-")) {
      return jsonRes({ conversationId: "conv-7", watermark: "0" });
    }
    return jsonRes({ id: "act-1" });
  };
  const adapter = new EngineDirectAdapter({ conversationsUrl: CONV_URL, token: "static-tok", fetchImpl });
  const out = await adapter.openConversation(envelope);

  assert.equal(out.conversationId, "conv-7");
  assert.equal(out.watermark, "0");
  assert.equal(out.auth, "static-tok");

  // 1) start conversation, 2) pvaSetContext event, 3) trigger message.
  assert.equal(calls.length, 3);
  assert.equal(calls[0].method, "POST");
  assert.ok(calls[0].url.startsWith(CONV_URL.split("?")[0]));
  assert.equal(calls[1].body.name, CONTEXT_EVENT_NAME);
  assert.equal(calls[1].body.type, "event");
  assert.equal(calls[2].body.type, "message");
  // Every call carries the bearer token.
  assert.ok(calls.every((c) => c.auth === "Bearer static-tok"));
});

test("sub-resource URLs append the conversation id to the PATH and keep api-version", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (opts.method === "POST" && !url.includes("/conv-")) {
      return jsonRes({ conversationId: "conv-9" });
    }
    return jsonRes({ id: "a" });
  };
  const adapter = new EngineDirectAdapter({ conversationsUrl: CONV_URL, token: "t", fetchImpl });
  await adapter.openConversation(envelope);
  const activityUrl = calls.find((u) => u.includes("/conv-9"));
  assert.ok(activityUrl.includes("/conversations/conv-9"));
  assert.ok(activityUrl.includes("api-version=2022-03-01-preview"));
});

test("token-endpoint mode fetches a token then uses it as the bearer", async () => {
  const tokenEndpoint = "https://env/token?api-version=2022-03-01-preview";
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || "GET", auth: opts && opts.headers && opts.headers.authorization });
    if (url === tokenEndpoint) return jsonRes({ token: "endpoint-tok", expires_in: 3600 });
    if (opts.method === "POST" && !url.includes("/conv-")) return jsonRes({ conversationId: "conv-1" });
    return jsonRes({ id: "a" });
  };
  const adapter = new EngineDirectAdapter({ conversationsUrl: CONV_URL, tokenEndpoint, fetchImpl });
  const out = await adapter.openConversation(envelope);
  assert.equal(calls[0].url, tokenEndpoint);
  assert.equal(out.auth, "endpoint-tok");
  const postStart = calls.find((c) => c.method === "POST");
  assert.equal(postStart.auth, "Bearer endpoint-tok");
});

test("client-credentials mode mints an Entra app-only token", async () => {
  let tokenForm;
  let tokenUrl;
  const fetchImpl = async (url, opts) => {
    if (url.includes("/oauth2/v2.0/token")) {
      tokenUrl = url;
      tokenForm = opts.body;
      return jsonRes({ access_token: "entra-tok", expires_in: 3599 });
    }
    if (opts.method === "POST" && !url.includes("/conv-")) return jsonRes({ conversationId: "c" });
    return jsonRes({ id: "a" });
  };
  const adapter = new EngineDirectAdapter({
    conversationsUrl: CONV_URL,
    tenantId: "tenant-1",
    clientId: "client-1",
    clientSecret: "shh",
    fetchImpl
  });
  const out = await adapter.openConversation(envelope);
  assert.ok(tokenUrl.includes("/tenant-1/oauth2/v2.0/token"));
  assert.match(tokenForm, /grant_type=client_credentials/);
  assert.match(tokenForm, /scope=https.*api\.powerplatform\.com/);
  assert.equal(out.auth, "entra-tok");
});

test("pollConversation reuses the threaded token and parses a terminal result", async () => {
  let usedAuth;
  let calledUrl;
  const fetchImpl = async (url, opts) => {
    calledUrl = url;
    usedAuth = opts && opts.headers && opts.headers.authorization;
    return jsonRes({
      watermark: "0002a-7",
      activities: [
        { type: "message", from: { id: "bot", role: "bot" }, text: "Filed CLM-2024-000123." }
      ]
    });
  };
  const adapter = new EngineDirectAdapter({ conversationsUrl: CONV_URL, token: "ignored", fetchImpl });
  const out = await adapter.pollConversation({
    conversationId: "conv 1",
    watermark: "0001a-5",
    correlationId: "REQ-2024-0042",
    auth: "threaded-tok"
  });
  assert.equal(usedAuth, "Bearer threaded-tok");
  assert.ok(calledUrl.includes("/conversations/conv%201"));
  assert.ok(calledUrl.includes("watermark=0001a-5"));
  assert.equal(out.watermark, "0002a-7");
  assert.equal(out.result.claim_id, "CLM-2024-000123");
});

test("pollConversation keeps the previous watermark when the response omits one", async () => {
  const fetchImpl = async () => jsonRes({ activities: [] });
  const adapter = new EngineDirectAdapter({ conversationsUrl: CONV_URL, token: "t", fetchImpl });
  const out = await adapter.pollConversation({ conversationId: "c", watermark: "keep-me", auth: "a" });
  assert.equal(out.watermark, "keep-me");
  assert.equal(out.result, null);
});

test("maps the Computer-Use unsupported-channel error to a clear, actionable message", async () => {
  let posts = 0;
  const fetchImpl = async (url, opts) => {
    if (opts.method === "POST") {
      posts += 1;
      if (posts === 1) return jsonRes({ conversationId: "conv-1" }); // start
    }
    return {
      ok: false,
      status: 400,
      text: async () =>
        "The Computer-use-ExecuteCUA tool requires one of the following supported channels to operate: msteams, pva-engine-direct, pva-studio.",
      json: async () => ({})
    };
  };
  const adapter = new EngineDirectAdapter({ conversationsUrl: CONV_URL, token: "t", fetchImpl });
  await assert.rejects(adapter.openConversation(envelope), (err) => {
    assert.equal(err.code, "CUA_CHANNEL_UNSUPPORTED");
    assert.match(err.message, /pva-engine-direct/);
    return true;
  });
});

test("maps IntegratedAuthenticationNotSupportedInChannel from the start call", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ error: { code: "IntegratedAuthenticationNotSupportedInChannel" } }),
    json: async () => ({})
  });
  const adapter = new EngineDirectAdapter({ conversationsUrl: CONV_URL, token: "t", fetchImpl });
  await assert.rejects(adapter.openConversation(envelope), (err) => {
    assert.equal(err.code, "AUTH_CHANNEL_UNSUPPORTED");
    assert.match(err.message, /Authenticate manually/);
    return true;
  });
});

test("getAdapter returns EngineDirect for engine/pva-engine-direct aliases", () => {
  const engineCfg = { channel: "engine", engine: { conversationsUrl: CONV_URL, token: "t" } };
  assert.ok(getAdapter(engineCfg) instanceof EngineDirectAdapter);
  assert.ok(
    getAdapter({ channel: "pva-engine-direct", engine: { conversationsUrl: CONV_URL, token: "t" } }) instanceof
      EngineDirectAdapter
  );
  assert.ok(
    getAdapter({ channel: "directtoengine", engine: { conversationsUrl: CONV_URL, token: "t" } }) instanceof
      EngineDirectAdapter
  );
});
