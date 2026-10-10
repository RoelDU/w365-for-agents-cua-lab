/*
 * cloudPcCapacity.js — whether the Foundry agent's Windows 365 for Agents pool has a
 * Cloud PC free for a NEW start. A readiness indicator and admission check only: it
 * reserves nothing and never acquires a Cloud PC.
 *
 * Source: Microsoft Graph BETA (subject to change, not supported for production)
 *   GET https://graph.microsoft.com/beta/deviceManagement/virtualEndpoint/cloudPcPools/{id}
 *   sessionUsage.availableSessionsCount
 * Only the single-pool GET returns sessionUsage; the pool LIST omits it. A missing or
 * malformed count is "unknown", never zero.
 *
 * Runtime identity: this Function App's managed identity, with the Microsoft Graph
 * application permission CloudPC.Read.All (tenant-wide Cloud PC read; Graph has no
 * pool-scoped grant). No write permission, no stored admin token.
 *
 * Config (app settings):
 *   FOUNDRY_CAPACITY_GATE    "1" turns the gate on. Anything else = previous behaviour.
 *   FOUNDRY_CLOUDPC_POOL_ID  the Foundry agent's Cloud PC pool ID.
 */

"use strict";

const GRAPH_RESOURCE = "https://graph.microsoft.com";
const POOL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_TIMEOUT_MS = 8000;
// Shared reads for the transfer directory only; an admission check always reads fresh.
const SHARED_READ_MS = 5000;

function capacityGateOn(env = process.env) {
  return String(env.FOUNDRY_CAPACITY_GATE || "") === "1";
}

async function managedIdentityGraphToken() {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) throw new Error("No managed identity is available to this service.");
  const res = await fetch(`${endpoint}?resource=${encodeURIComponent(GRAPH_RESOURCE)}&api-version=2019-08-01`, {
    headers: { "X-IDENTITY-HEADER": header }
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Managed identity token request failed (${res.status}).`);
  return j.access_token;
}

function unknown(reason) {
  return { state: "unknown", reason, checked_at: new Date().toISOString() };
}

/** One read of the configured pool: { state: "available" | "none" | "unknown", reason?, checked_at }. */
async function readPoolCapacity({
  env = process.env,
  fetchImpl = fetch,
  getToken = managedIdentityGraphToken,
  timeoutMs = READ_TIMEOUT_MS
} = {}) {
  const poolId = String(env.FOUNDRY_CLOUDPC_POOL_ID || "").trim();
  if (!POOL_ID.test(poolId)) return unknown("pool_not_configured");

  let token;
  try {
    token = await getToken();
  } catch {
    return unknown("identity_token_failed");
  }

  let res;
  try {
    res = await fetchImpl(`${GRAPH_RESOURCE}/beta/deviceManagement/virtualEndpoint/cloudPcPools/${poolId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    return unknown("graph_unreachable");
  }
  if (res.status === 401 || res.status === 403) return unknown("graph_permission_denied");
  if (res.status === 404) return unknown("pool_not_found");
  if (res.status === 429) return unknown("graph_throttled");
  if (!res.ok) return unknown(`graph_http_${res.status}`);

  const body = await res.json().catch(() => null);
  const count = body && body.sessionUsage ? body.sessionUsage.availableSessionsCount : undefined;
  if (!Number.isSafeInteger(count) || count < 0) return unknown("usage_missing");
  return { state: count > 0 ? "available" : "none", checked_at: new Date().toISOString() };
}

/**
 * The transfer directory's view: concurrent callers share one in-flight read, and a
 * result is reused for a few seconds so several open directories do not multiply Graph
 * calls. Failures are not reused.
 */
function sharedCapacityReader(read = readPoolCapacity, now = () => Date.now()) {
  let last = null;
  let inflight = null;
  return async function sharedRead(opts) {
    if (last && now() - last.at < SHARED_READ_MS) return last.result;
    if (!inflight) {
      inflight = read(opts)
        .then((result) => {
          last = result.state === "unknown" ? null : { at: now(), result };
          return result;
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  };
}

module.exports = { capacityGateOn, readPoolCapacity, sharedCapacityReader };
