/*
 * cuaRun.js — "autonomous trigger + Dataverse poll" endpoints (Option A).
 *
 *   POST /api/cua-run
 *        Body: { callContext, lang }. Starts a Computer Use run by writing a row
 *        to the Dataverse TRIGGER table whose "row created" event is an
 *        autonomous trigger on the agent. Returns { runId }. Because the run is
 *        started by an autonomous trigger, it appears in Copilot Studio Activity
 *        (Session replay / audit trail) — unlike the Direct Line path.
 *
 *   GET  /api/cua-run/{runId}/progress
 *        Returns { status, steps:[{ index, reasoning, screenshotUrl, claimId }] }.
 *        Reads the Computer Use logs from Dataverse (flowsession /
 *        flowsessionbinary) for the run and exposes them as a progress feed the
 *        app polls (~2.5s) to render a NEAR-LIVE view (a few seconds behind real
 *        time). Set CUA_PROGRESS_MOCK=1 to serve canned progress so the in-app UX
 *        can be demoed/tested without a live Dataverse grant.
 *
 * SCHEMA NOTE: the exact Dataverse table + column names for the trigger row and
 * the flowsession/flowsessionbinary screenshots+reasoning MUST be confirmed
 * against the live org with discover-cua-schema.ps1 before the non-mock path is
 * trusted. The constants in SCHEMA below are the integration points to set from
 * that script's output.
 */

"use strict";

const { app } = require("@azure/functions");
const dv = require("../dataverse/client");

function json(status, body) {
  return { status, headers: { "content-type": "application/json" }, jsonBody: body };
}

// ---------------------------------------------------------------------------
// SCHEMA — column/table names for the Option A trigger + Computer Use logs. The
// flowsessions / flowsessionbinaries / conversationtranscripts tables are standard
// Dataverse; the crcce_* names are the demo's trigger table (recreate with your own
// publisher prefix and override via the CUA_TRIGGER_* env vars). Set the REQUIRED
// CUA_AGENT_BOTID and DATAVERSE_ORG_URL for your environment.
//
// VERIFIED FACTS (do not re-guess):
//   * flowsessions: one row per Computer Use run. Locate ours by
//       parentworkflowid eq <agent botId>. Useful columns: flowsessionid,
//       statecode, statuscode, startedon, completedon, outputs, errorcode,
//       errormessage, context. NOTE: real runs terminate with statuscode=8
//       (SessionHasLoggedOff) yet still produce screenshots + file the claim, so
//       completion is signalled by completedon being non-null — NOT by statuscode.
//   * flowsessionbinaries: the screenshots. Filter by _flowsessionid_value eq
//       <flowsessionid> and type eq 'CuaScreenshot'; each has createdon (capture
//       time, enabling near-live polling) and the image bytes at
//       flowsessionbinaries(<id>)/data/$value (mimetype image/jpeg).
//   * The CLAIM ID is NOT in flowsession.outputs (null even on the run that filed
//       CLM-2024-007005); resolveClaimId() recovers the real id from the agent's
//       Dataverse write-back (crcce_claimid) or the bot transcript, else falls back
//       to CUA_DEMO_CLAIM_ID. Per-step AI reasoning is NOT stored in Dataverse
//       binaries; narration is overlaid from NARRATION.
// ---------------------------------------------------------------------------
const SCHEMA = {
  // The custom table whose "When a row is added" event is the agent's autonomous
  // trigger. Recreate it in your environment (any publisher prefix) and override the
  // CUA_TRIGGER_* env vars to match; these defaults use the demo's crcce_ prefix.
  triggerEntitySet: process.env.CUA_TRIGGER_ENTITYSET || "crcce_claimrequests",
  // Columns written on the trigger row (the agent reads these in its instructions).
  triggerFields: {
    policyNumber: process.env.CUA_TRIGGER_FIELD_POLICY || "crcce_policynumber",
    summary: process.env.CUA_TRIGGER_FIELD_SUMMARY || "crcce_summary",
    correlation: process.env.CUA_TRIGGER_FIELD_CORRELATION || "crcce_correlationid",
    lang: process.env.CUA_TRIGGER_FIELD_LANG || "crcce_lang"
  },
  // Result columns the agent (or a reconciliation job) writes back. When the agent is
  // given a Dataverse "Update a row" action that sets crcce_claimid at the end of the
  // run, the orchestrator reads the REAL claim id here near-real-time (preferred). See
  // docs/option-a-inapp-near-live.md "Surfacing the real claim id".
  resultFields: {
    claimId: process.env.CUA_RESULT_FIELD_CLAIMID || "crcce_claimid",
    status: process.env.CUA_RESULT_FIELD_STATUS || "crcce_status"
  },
  triggerIdAttr: process.env.CUA_TRIGGER_ID_ATTR || "crcce_claimrequestid",
  // VERIFIED set names.
  flowSessionSet: process.env.CUA_FLOWSESSION_SET || "flowsessions",
  flowSessionBinarySet: process.env.CUA_FLOWSESSIONBINARY_SET || "flowsessionbinaries",
  // Bot transcript table — holds the agent's final "Claim ID: CLM-..." message, but is
  // flushed ~30 min after the conversation goes idle, so it is only a best-effort
  // (eventual) fallback for the real claim id, not a near-real-time source.
  conversationTranscriptSet: process.env.CUA_TRANSCRIPT_SET || "conversationtranscripts",
  // The agent's bot id (parentworkflowid on its CUA flowsessions). REQUIRED: set
  // CUA_AGENT_BOTID to your published agent's bot id (a GUID).
  agentBotId: process.env.CUA_AGENT_BOTID || "",
  // Dataverse org base URL (for building authenticated screenshot file URLs).
  // REQUIRED: set DATAVERSE_ORG_URL, e.g. https://your-org.crm.dynamics.com
  orgUrl: (process.env.DATAVERSE_ORG_URL || "").replace(/\/$/, "")
};

// In-memory run registry (single-instance; fine for the demo). Maps our runId →
// { startedAt, correlation }. The mock animates from startedAt; the live path
// uses correlation to find the matching flowsession.
const RUNS = new Map();

app.http("cuaRunStart", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "cua-run",
  handler: async (request, context) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "Body must be JSON { callContext, lang }." });
    }
    const ctx = body.callContext || {};
    const lang = body.lang === "ja" ? "ja" : "en";
    const correlation = ctx.request_id || `cua-${Date.now()}`;
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    RUNS.set(runId, { startedAt: Date.now(), correlation, lang });

    if (dv.isMock()) {
      context.log(`cua-run(mock): ${runId} corr=${correlation}`);
      return json(202, { runId, mode: "mock" });
    }

    try {
      const row = {
        [SCHEMA.triggerFields.policyNumber]: ctx.policy_number || "",
        [SCHEMA.triggerFields.summary]: ctx.summary || "",
        [SCHEMA.triggerFields.correlation]: correlation,
        [SCHEMA.triggerFields.lang]: lang
      };
      const created = await dv.create(SCHEMA.triggerEntitySet, row);
      // Remember the trigger row's id so progress can read the agent's write-back
      // (crcce_claimid) for the real claim id near-real-time.
      const run = RUNS.get(runId);
      if (run) run.triggerRowId = created && created[SCHEMA.triggerIdAttr];
      context.log(`cua-run: wrote trigger row corr=${correlation} -> ${runId}`);
      return json(202, { runId, mode: "dataverse" });
    } catch (err) {
      context.error("cua-run start failed", err);
      return json(502, { error: "Could not start the run.", details: String(err && err.message || err) });
    }
  }
});

app.http("cuaRunProgress", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "cua-run/{runId}/progress",
  handler: async (request, context) => {
    const runId = request.params.runId;
    // The RUNS registry is in-memory, so a Function App restart/scale (Consumption
    // plans recycle) can lose it mid-run. Reconstruct a minimal run from the runId,
    // which encodes the start time as `run-<startedAtMs>-<rand>`, so polling survives
    // a restart. correlation/triggerRowId are lost (only used by the claim-id fallback
    // tiers), but startedAt — what liveProgress needs to find the flowsession — is not.
    let run = RUNS.get(runId);
    if (!run) {
      const m = /^run-(\d{10,})-/.exec(runId || "");
      if (m) {
        run = { startedAt: Number(m[1]), correlation: null, lang: "en" };
        RUNS.set(runId, run);
      }
    }
    if (!run) return json(404, { error: `Unknown run ${runId}.` });

    if (dv.isMock()) {
      return json(200, mockProgress(run, runId));
    }

    try {
      const progress = await liveProgress(run, runId);
      return json(200, progress);
    } catch (err) {
      context.error("cua-run progress failed", err);
      // Don't fail the client's poll loop — report running with no new steps.
      return json(200, { status: "running", steps: [] });
    }
  }
});

// Authenticated screenshot proxy: the Dataverse file endpoint needs the MI token,
// so the browser cannot load it directly. The app's screenshotUrl points here.
app.http("cuaRunShot", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "cua-run/{runId}/shot/{binId}",
  handler: async (request, context) => {
    const binId = request.params.binId;
    if (!/^[0-9a-fA-F-]{36}$/.test(binId || "")) return json(400, { error: "Bad binary id." });
    try {
      const { buffer, contentType } = await dv.getRaw(
        `${SCHEMA.flowSessionBinarySet}(${binId})/data/$value`
      );
      // CuaScreenshots are JPEG; Dataverse may report application/octet-stream, which
      // some browsers won't render in <img>. Force image/jpeg unless it's already an image.
      const ct = /^image\//i.test(contentType || "") ? contentType : "image/jpeg";
      return {
        status: 200,
        headers: { "content-type": ct, "cache-control": "public, max-age=31536000, immutable" },
        body: buffer
      };
    } catch (err) {
      context.error("cua-run shot failed", err);
      return json(404, { error: "Screenshot not available." });
    }
  }
});

/**
 * LIVE path: find the flowsession started for this run and project its real
 * screenshots into the progress contract, overlaying scripted narration.
 *
 * VERIFIED field mapping (see SCHEMA): locate the run by parentworkflowid =
 * agent botId within the start window; completion = completedon non-null;
 * screenshots = flowsessionbinaries (type CuaScreenshot) by createdon, each image
 * served via our /cua-run/{runId}/shot/{binId} proxy (Dataverse file endpoint
 * needs the MI token, so the browser cannot load it directly). Narration text and
 * claimId are overlaid by the orchestrator because Dataverse exposes neither.
 */
async function liveProgress(run, runId) {
  // 1) Locate the flowsession for this run: our agent's most recent run started
  //    at/after we wrote the trigger row (small clock-skew window).
  const since = new Date(run.startedAt - 90_000).toISOString();
  const fs = await dv.get(
    `${SCHEMA.flowSessionSet}` +
      `?$top=1&$orderby=createdon desc` +
      `&$filter=parentworkflowid eq ${SCHEMA.agentBotId} and createdon ge ${since}` +
      `&$select=flowsessionid,statecode,statuscode,startedon,completedon,errorcode,errormessage`
  );
  const session = fs && fs.value && fs.value[0];
  if (!session) return { status: "queued", steps: [], claimId: null };

  const sessionId = session.flowsessionid;
  // Real runs end with statuscode=8 (SessionHasLoggedOff) but still complete the
  // work, so treat any non-null completedon as done; errorcode that is NOT the
  // benign logoff is a genuine failure.
  const completed = !!session.completedon;
  const hardError = session.errorcode && session.errorcode !== "SessionHasLoggedOff";
  const status = hardError ? "error" : completed ? "succeeded" : "running";

  // 2) Pull this session's screenshots (real), newest capture last.
  const bins = await dv.get(
    `${SCHEMA.flowSessionBinarySet}` +
      `?$orderby=createdon asc` +
      `&$filter=_flowsessionid_value eq ${sessionId} and type eq 'CuaScreenshot'` +
      `&$select=flowsessionbinaryid,createdon`
  );
  const shots = (bins && bins.value) ? bins.value : [];

  // 3) Project to steps. screenshotUrl points at our authenticated image proxy.
  //    reasoning is overlaid from NARRATION, paced by how far through the run we
  //    are (real screenshot count vs the narration script length).
  const steps = shots.map((b, i) => ({
    index: i,
    reasoning: narrationFor(i, shots.length, run.lang),
    screenshotUrl: `/api/cua-run/${encodeURIComponent(runId)}/shot/${b.flowsessionbinaryid}`,
    capturedOn: b.createdon
  }));

  // 4) Claim id. Prefer the REAL id (agent write-back / transcript); fall back to the
  //    configured demo id so the in-app view always shows something on success.
  const claimId = status === "succeeded" ? await resolveClaimId(run) : null;

  return { status, steps, claimId, screenshotCount: shots.length };
}

/**
 * Resolve the real claim id for a completed run, in priority order:
 *   1. The agent's write-back on the trigger row (crcce_claimid). Ideal near-real-time
 *      path, but needs the agent's Dataverse "Update a row" action to connect in the
 *      unattended autonomous run; that connection is not configured on the demo agent
 *      today, so this tier is normally null and we fall through. Lights up automatically
 *      if an unattended connection reference is added later.
 *   2. The bot transcript (conversationtranscript) for this run, matched by the
 *      correlation id we wrote: the REAL id, but flushed ~30 min after the run, so it
 *      fills in eventually (the active real-id path; good for audit/reconciliation).
 *   3. The configured demo id (CUA_DEMO_CLAIM_ID) so the view is never blank.
 * Each lookup is best-effort; any failure falls through to the next.
 */
async function resolveClaimId(run) {
  // 1) Agent write-back on the trigger row.
  if (run.triggerRowId) {
    try {
      const r = await dv.get(
        `${SCHEMA.triggerEntitySet}(${run.triggerRowId})?$select=${SCHEMA.resultFields.claimId}`
      );
      const id = r && r[SCHEMA.resultFields.claimId];
      if (id) return id;
    } catch (_) { /* fall through */ }
  }
  // 2) Bot transcript matched by our correlation id (eventual; ~30 min flush delay).
  try {
    const id = await claimIdFromTranscript(run);
    if (id) return id;
  } catch (_) { /* fall through */ }
  // 3) Configured demo id.
  return run.claimId || process.env.CUA_DEMO_CLAIM_ID || "CLM-2024-007004";
}

/** Best-effort: find the agent transcript that contains our correlation id and extract CLM-xxxx-xxxxxx. */
async function claimIdFromTranscript(run) {
  if (!run.correlation) return null;
  const since = new Date(run.startedAt - 120_000).toISOString();
  const res = await dv.get(
    `${SCHEMA.conversationTranscriptSet}` +
      `?$top=10&$orderby=conversationstarttime desc` +
      `&$select=content,conversationstarttime` +
      `&$filter=_bot_conversationtranscriptid_value eq ${SCHEMA.agentBotId} and conversationstarttime ge ${since}`
  );
  const rows = (res && res.value) || [];
  const mine = rows.find((t) => typeof t.content === "string" && t.content.includes(run.correlation));
  if (!mine) return null;
  const m = /CLM-\d{4}-\d{6}/.exec(mine.content);
  return m ? m[0] : null;
}

/** Overlay scripted narration onto the real screenshot timeline. */
function narrationFor(index, total, lang) {
  const script = NARRATION[lang === "ja" ? "ja" : "en"];
  if (!total) return script[0];
  const pos = Math.min(script.length - 1, Math.floor((index / total) * script.length));
  return script[pos];
}

// ---------------------------------------------------------------------------
// NARRATION — the per-step text overlaid on the real screenshot timeline (the
// live path) and used to animate the mock. Dataverse does NOT expose the CUA's
// per-step reasoning, so this scripted narration stands in for it. Plain
// punctuation only (no em-dashes), and a real-Japanese variant for lang=ja.
// ---------------------------------------------------------------------------
const NARRATION = {
  en: [
    "A secure Windows 365 Cloud PC is starting for the AI agent.",
    "The Cloud PC desktop is ready. The Zava Claims Workstation is installed.",
    "Opening the Zava Claims Workstation and signing in as the agent.",
    "Searching for policy POL-2024-008341.",
    "Policy found: Jordan Smith, Auto, Active. Selecting the policyholder record.",
    "Opening a new FNOL. Step 1 of 5: entering the incident details.",
    "Step 2 of 5: recording the vehicle and property damage.",
    "Step 3 of 5: adding the parties involved.",
    "Step 4 of 5: confirming the coverage.",
    "Step 5 of 5: reviewing everything, then submitting the claim.",
    "Claim filed successfully.",
    "Closing the app and signing out of Windows to release the Cloud PC."
  ],
  ja: [
    "AIエージェント用に、セキュアなWindows 365クラウドPCを起動しています。",
    "クラウドPCのデスクトップが準備できました。Zava保険金請求ワークステーションがインストールされています。",
    "Zava保険金請求ワークステーションを開き、エージェントとしてサインインしています。",
    "証券番号 POL-2024-008341 を検索しています。",
    "証券が見つかりました。Jordan Smith、自動車、有効。契約者レコードを選択しています。",
    "新しいFNOLを開いています。ステップ1/5：事故の詳細を入力しています。",
    "ステップ2/5：車両と物的損害を記録しています。",
    "ステップ3/5：関係者を追加しています。",
    "ステップ4/5：補償内容を確認しています。",
    "ステップ5/5：すべてを確認し、請求を送信しています。",
    "請求が正常に提出されました。",
    "アプリを閉じ、WindowsからサインアウトしてクラウドPCを解放しています。"
  ]
};

// ---------------------------------------------------------------------------
// MOCK path — animates the narration so the in-app near-live UX can be
// demoed/tested without a live Dataverse grant. Each step reveals after its
// cumulative delay from run start, mimicking a real CUA run's pace.
// ---------------------------------------------------------------------------
const MOCK_STEPS = [
  { ms: 2000, n: 0 },
  { ms: 9000, n: 1 },
  { ms: 14000, n: 2 },
  { ms: 20000, n: 3 },
  { ms: 26000, n: 4 },
  { ms: 32000, n: 5 },
  { ms: 38000, n: 6 },
  { ms: 44000, n: 7 },
  { ms: 50000, n: 8 },
  { ms: 56000, n: 9 },
  { ms: 62000, n: 10, claimId: process.env.CUA_DEMO_CLAIM_ID || "CLM-2024-007004" },
  { ms: 68000, n: 11 }
];
const MOCK_TOTAL_MS = 74000;

function mockProgress(run, runId) {
  const lang = run.lang === "ja" ? "ja" : "en";
  const script = NARRATION[lang];
  const elapsed = Date.now() - run.startedAt;
  const steps = MOCK_STEPS.filter((s) => elapsed >= s.ms).map((s, i) => ({
    index: i,
    reasoning: script[s.n],
    // No real screenshot in mock; the app renders the reasoning + an acquiring
    // placeholder. The live path supplies real flowsessionbinary screenshots.
    screenshotUrl: undefined,
    claimId: s.claimId
  }));
  const claimId = steps.find((s) => s.claimId)?.claimId;
  const status = elapsed >= MOCK_TOTAL_MS ? "succeeded" : "running";
  return { status, steps, claimId };
}

module.exports = { SCHEMA, mockProgress, NARRATION };
