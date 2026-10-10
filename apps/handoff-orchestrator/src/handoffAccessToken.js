/*
 * handoffAccessToken.js - validate the CCaaS user's existing Entra access token for the
 * handoff API (api://<clientId>/Handoff.Access), the token the Agent Desktop already
 * acquires with acquireHandoffAccessToken(). Same rules as the new-harness request host:
 * RS256 signature from the tenant's published keys, v2 issuer, audience, tenant, the
 * calling app (azp), the Handoff.Access scope and a non-empty oid. Returns "tid:oid".
 * Uses only node:crypto; no new dependency.
 */

"use strict";

const crypto = require("node:crypto");

const SCOPE = "Handoff.Access";
const SKEW_SECONDS = 60;
const KEY_CACHE_MS = 60 * 60 * 1000;
const keyCache = new Map();

async function tenantKeys(tenantId, fetchImpl = fetch) {
  const cached = keyCache.get(tenantId);
  if (cached && Date.now() - cached.at < KEY_CACHE_MS) return cached.keys;
  const res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/discovery/v2.0/keys`);
  if (!res.ok) throw new Error("signing_keys_unavailable");
  const body = await res.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];
  keyCache.set(tenantId, { at: Date.now(), keys });
  return keys;
}

function part(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/**
 * @param {string|undefined} header  the Authorization header value
 * @param {{tenantId: string, clientId: string, getKeys?: (tenantId: string) => Promise<object[]>}} cfg
 * @returns {Promise<string>} "tid:oid"
 */
async function verifyHandoffAccessToken(header, { tenantId, clientId, getKeys = tenantKeys }) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) throw new Error("authorization_header_missing");
  const segments = header.slice(7).trim().split(".");
  if (segments.length !== 3) throw new Error("malformed_token");
  let head;
  let claims;
  try {
    head = part(segments[0]);
    claims = part(segments[1]);
  } catch {
    throw new Error("malformed_token");
  }
  if (head.alg !== "RS256" || typeof head.kid !== "string") throw new Error("unsupported_algorithm");
  const jwk = (await getKeys(tenantId)).find((k) => k && k.kid === head.kid);
  if (!jwk) throw new Error("signing_key_unknown");
  const publicKey = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
  const signed = Buffer.from(`${segments[0]}.${segments[1]}`);
  if (!crypto.verify("RSA-SHA256", signed, publicKey, Buffer.from(segments[2], "base64url"))) {
    throw new Error("invalid_signature");
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < now) throw new Error("expired_token");
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_SECONDS > now) throw new Error("token_not_yet_valid");
  if (claims.iss !== `https://login.microsoftonline.com/${tenantId}/v2.0`) throw new Error("invalid_issuer");
  if (claims.aud !== clientId && claims.aud !== `api://${clientId}`) throw new Error("invalid_audience");
  if (claims.tid !== tenantId) throw new Error("tenant_not_allowed");
  if (claims.azp !== clientId) throw new Error("client_not_allowed");
  if (!String(claims.scp || "").split(" ").includes(SCOPE)) throw new Error("required_scope_missing");
  if (typeof claims.oid !== "string" || !claims.oid) throw new Error("invalid_subject");
  return `${claims.tid}:${claims.oid}`;
}

module.exports = { verifyHandoffAccessToken, SCOPE };
