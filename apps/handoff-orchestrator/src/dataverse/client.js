/*
 * dataverse/client.js — minimal Dataverse Web API helper for the orchestrator.
 *
 * Token acquisition (no SDK dependency):
 *   - In Azure: the Function App's system-assigned Managed Identity, via the
 *     IDENTITY_ENDPOINT / IDENTITY_HEADER local token service (App Service MI).
 *   - Locally: the Azure CLI (`az account get-access-token`) so a developer can
 *     run against the org with their own / the SP's az login.
 *
 * The Function App's Managed Identity (or the SP used locally) must be added as
 * a Dataverse APPLICATION USER with a role that can read flowsession /
 * flowsessionbinary / flowlog and create rows in the trigger table. That grant
 * is an admin step in Power Platform admin center (Settings → Users +
 * permissions → Application users → New app user).
 *
 * Config (app settings / env):
 *   DATAVERSE_ORG_URL   e.g. https://your-org.crm.dynamics.com   (required)
 *   CUA_PROGRESS_MOCK   "1" to bypass Dataverse and serve canned progress
 *                       (lets the in-app near-live UX be demoed/tested without
 *                       a live Dataverse grant).
 */

"use strict";

const https = require("https");

function orgUrl() {
  const u = process.env.DATAVERSE_ORG_URL || "";
  return u.replace(/\/+$/, "");
}

function isMock() {
  return String(process.env.CUA_PROGRESS_MOCK || "") === "1";
}

/** Acquire a Dataverse access token (MI in Azure, az CLI locally). */
async function getToken() {
  const resource = orgUrl();
  if (!resource) throw new Error("DATAVERSE_ORG_URL is not configured.");

  // App Service / Functions Managed Identity local token service.
  const idEndpoint = process.env.IDENTITY_ENDPOINT;
  const idHeader = process.env.IDENTITY_HEADER;
  if (idEndpoint && idHeader) {
    const url = `${idEndpoint}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01`;
    const body = await httpGet(url, { "X-IDENTITY-HEADER": idHeader });
    const j = JSON.parse(body);
    if (!j.access_token) throw new Error("Managed Identity returned no access_token.");
    return j.access_token;
  }

  // Local fallback: Azure CLI.
  const { execFile } = require("child_process");
  return new Promise((resolve, reject) => {
    execFile(
      "az",
      ["account", "get-access-token", "--resource", resource, "--query", "accessToken", "-o", "tsv"],
      { shell: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`az token failed: ${err.message}`));
        const tok = String(stdout).trim();
        if (!tok) return reject(new Error("az returned an empty token."));
        resolve(tok);
      }
    );
  });
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // Honor the endpoint's scheme + port. The App Service / Functions managed
    // identity endpoint (IDENTITY_ENDPOINT) is an http localhost URL on a specific
    // port; forcing https:443 here causes ECONNREFUSED.
    const mod = u.protocol === "http:" ? require("http") : https;
    const req = mod.request(
      {
        method: "GET",
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        headers
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(d);
          else reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 300)}`));
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function httpJson(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${orgUrl()}/api/data/v9.2/${path}`);
    const headers = {
      Authorization: `Bearer ${token}`,
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json"
    };
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
      headers["Prefer"] = "return=representation";
    }
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(d ? JSON.parse(d) : {});
          } else {
            reject(new Error(`Dataverse ${method} ${path} -> HTTP ${res.statusCode}: ${d.slice(0, 300)}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function get(path) {
  const token = await getToken();
  return httpJson("GET", path, token);
}

/** Fetch raw bytes from a Dataverse path (e.g. a file/image column's /$value). */
async function getRaw(path) {
  const token = await getToken();
  return new Promise((resolve, reject) => {
    const u = new URL(`${orgUrl()}/api/data/v9.2/${path}`);
    const req = https.request(
      {
        method: "GET",
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { Authorization: `Bearer ${token}` }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ buffer: Buffer.concat(chunks), contentType: res.headers["content-type"] || "image/jpeg" });
          } else {
            reject(new Error(`Dataverse GET ${path} -> HTTP ${res.statusCode}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function create(entitySetName, row) {
  const token = await getToken();
  return httpJson("POST", entitySetName, token, row);
}

module.exports = { get, getRaw, create, isMock, orgUrl };
