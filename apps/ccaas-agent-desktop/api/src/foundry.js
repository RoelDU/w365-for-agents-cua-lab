/*
 * foundry.js - thin Azure AI Foundry Agent Service (data-plane) REST client.
 *
 * Uses the SAME conventions as scripts/Deploy-Agent.ps1:
 *   base = FOUNDRY_PROJECT_ENDPOINT = https://<res>.services.ai.azure.com/api/projects/<proj>
 *   every path begins with '/' and gets '?api-version=<FOUNDRY_API_VERSION>'.
 *   token audience = https://ai.azure.com (client-credentials on the reused app reg).
 *
 * No SDK: Static Web Apps managed Functions are lightweight, and the OpenAI-
 * compatible threads/runs/messages surface is a handful of REST calls.
 */

const TOKEN_SKEW_MS = 60 * 1000;
let cachedToken = null; // { value, expiresAt }

function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required app setting: ${name}`);
  }
  return v;
}

async function getToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - TOKEN_SKEW_MS > now) {
    return cachedToken.value;
  }
  const tenant = env("AZURE_TENANT_ID");
  const clientId = env("AZURE_CLIENT_ID");
  const clientSecret = env("AZURE_CLIENT_SECRET");
  const audience = env("FOUNDRY_TOKEN_AUDIENCE", "https://ai.azure.com");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: `${audience.replace(/\/+$/, "")}/.default`
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token request failed (HTTP ${res.status}): ${text}`);
  }
  const json = await res.json();
  cachedToken = {
    value: json.access_token,
    expiresAt: now + (Number(json.expires_in || 3600) * 1000)
  };
  return cachedToken.value;
}

async function foundryFetch(method, path, body) {
  const base = env("FOUNDRY_PROJECT_ENDPOINT").replace(/\/+$/, "");
  const apiVersion = env("FOUNDRY_API_VERSION", "2025-05-15-preview");
  const sep = path.includes("?") ? "&" : "?";
  const url = `${base}${path}${sep}api-version=${apiVersion}`;
  const token = await getToken();
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Foundry ${method} ${path} failed (HTTP ${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Fire-and-forget: create a thread, add the handoff message, create a run.
 * Returns { threadId, runId, run }. The caller returns these to the SPA so the
 * status endpoint can stay stateless across SWA Function instances.
 */
async function startRun(messageContent) {
  const agentId = env("FOUNDRY_AGENT_ID");
  const thread = await foundryFetch("POST", "/threads", {});
  await foundryFetch("POST", `/threads/${thread.id}/messages`, {
    role: "user",
    content: messageContent
  });
  const run = await foundryFetch("POST", `/threads/${thread.id}/runs`, {
    assistant_id: agentId
  });
  return { threadId: thread.id, runId: run.id, run };
}

async function getRun(threadId, runId) {
  return foundryFetch("GET", `/threads/${threadId}/runs/${runId}`);
}

/** Return the most recent assistant message's text, or "" if none yet. */
async function getLastAssistantText(threadId) {
  const list = await foundryFetch("GET", `/threads/${threadId}/messages?order=desc&limit=10`);
  const items = (list && list.data) || [];
  const assistant = items.find((m) => m.role === "assistant");
  if (!assistant) return "";
  const parts = Array.isArray(assistant.content) ? assistant.content : [];
  return parts
    .map((p) => (p && p.text && p.text.value) || (typeof p === "string" ? p : ""))
    .join("\n")
    .trim();
}

module.exports = { getToken, foundryFetch, startRun, getRun, getLastAssistantText };
