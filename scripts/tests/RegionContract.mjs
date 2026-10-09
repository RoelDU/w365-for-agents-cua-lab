// Offline region contract check for the guided setup (QA S1).
//
// Feeds a generated region-config.json to Zava's real region parser
// (apps/ccaas-agent-desktop/src/lib/regionConfig.ts, run by Node's TypeScript type stripping),
// then sends the region Zava would select to the real cuaRunStart handler
// (apps/handoff-orchestrator/src/functions/cuaRun.js) with the generated Function app settings.
// CUA_PROGRESS_MOCK=1 is set only to stop the handler before Dataverse, after its region check:
// nothing leaves this computer.
//
// Usage: node RegionContract.mjs <repo> <region-config.json or ""> <settings.json>
// Prints {"regionId": ..., "status": ..., "code": ...}.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const [, , repo, regionFile, settingsFile] = process.argv;

globalThis.fetch = async (url) => {
  if (url === "/region-config.json" && regionFile && fs.existsSync(regionFile)) {
    const text = fs.readFileSync(regionFile, "utf8").replace(/^\uFEFF/, "");
    return { ok: true, json: async () => JSON.parse(text) };
  }
  return { ok: false, json: async () => ({}) };
};

const parser = pathToFileURL(path.join(repo, "apps/ccaas-agent-desktop/src/lib/regionConfig.ts")).href;
const { getRegionConfig } = await import(parser);
const resolved = await getRegionConfig();
// The store sends its activeRegionId, which hydration sets from the resolved config
// (apps/ccaas-agent-desktop/src/stores/useSettingsStore.ts hydrateRegions); none when no region.
const regionId = resolved.regions.length ? resolved.activeRegionId : "";

const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8").replace(/^\uFEFF/, ""));
for (const key of Object.keys(process.env)) if (key.startsWith("CUA_")) delete process.env[key];
Object.assign(process.env, settings, { CUA_PROGRESS_MOCK: "1" });

const require = createRequire(path.join(repo, "apps/handoff-orchestrator/package.json"));
const functions = require("@azure/functions");
const handlers = {};
functions.app.http = (name, options) => { handlers[name] = options.handler; };
require(path.join(repo, "apps/handoff-orchestrator/src/functions/cuaRun.js"));

const request = { json: async () => ({ callContext: { request_id: "REQ-OFFLINE-1" }, lang: "en", regionId }) };
const response = await handlers.cuaRunStart(request, { log() {}, error() {} });
console.log(JSON.stringify({ regionId, status: response.status, code: response.jsonBody?.code ?? null }));
