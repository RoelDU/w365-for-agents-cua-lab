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
 *        Returns { status, claimId, activity, release, steps:[{ index,
 *        explanation, action, application, at, screenshotUrl }] }. Reads the
 *        Computer Use advanced logs (flowsession / flowlog / flowsessionbinary)
 *        of the session attributed to this handoff and exposes them as a feed the
 *        app polls (~2.5s): a NEAR-LIVE view a few seconds behind real time.
 *        CUA_PROGRESS_MOCK=1 serves a labelled offline simulation instead.
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
//       CLM-2024-007005). With CUA_REQUIRE_REAL_RESULT=1 the only result source is
//       the receipt the trigger flow saves on this exact row (readReceipt).
//   * flowlogs (Computer Use advanced logs): per-action model explanation,
//       action, application, time, exact screenshot id and conversationId. Read
//       ONLY via flowsessions(<id>)/flowsession_flowlog_parentobjectid.
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
    lang: process.env.CUA_TRIGGER_FIELD_LANG || "crcce_lang",
    handoffContext: process.env.CUA_TRIGGER_FIELD_HANDOFF_CONTEXT || "crcce_handoffcontext"
  },
  // Result columns the agent (or a reconciliation job) writes back. When the agent is
  // given a Dataverse "Update a row" action that sets crcce_claimid at the end of the
  // run, the orchestrator reads the REAL claim id here near-real-time (preferred). See
  // docs/option-a-inapp-near-live.md "Surfacing the real claim id".
  resultFields: {
    claimId: process.env.CUA_RESULT_FIELD_CLAIMID || "crcce_claimid",
    receipt: process.env.CUA_RESULT_FIELD_RECEIPT || "crcce_handoffreceipt",
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

// In-memory run registry. Maps our runId → { startedAt, correlation, triggerRowId, ... }.
// It is only a cache: a Consumption app can restart, or answer a poll from another
// instance, mid-run. A live runId therefore carries its trigger row id
// (`run-<startedAtMs>-<rand>~<rowId>`), so any instance can rebuild the run from Dataverse.
const RUNS = new Map();
const RUN_ID = /^run-(\d{10,})-[a-z0-9]+(?:~([0-9A-Za-z-]{1,64}))?$/;
const ROW_ID = /^[0-9A-Za-z-]{1,64}$/;

/** A result that cannot be attributed to, or verified for, this handoff. Ends the run. */
class Unverifiable extends Error {}

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
    const region = (process.env.CUA_REGION || "").trim();
    if (region && body.regionId !== region) {
      context.error("cua-run rejected: selected region does not match this service.");
      return json(409, {
        code: "REGION_MISMATCH",
        error: "The selected region does not match this service. Refresh the app and select its available region before transferring."
      });
    }
    const ctx = body.callContext || {};
    const lang = body.lang === "ja" ? "ja" : "en";
    const correlation = ctx.request_id || `cua-${Date.now()}`;
    const startedAt = Date.now();
    let runId = `run-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;

    if (dv.isMock()) {
      RUNS.set(runId, { startedAt, correlation, lang });
      context.log(`cua-run(mock): ${runId} corr=${correlation}`);
      return json(202, { runId, mode: "mock" });
    }

    try {
      const row = {
        [SCHEMA.triggerFields.policyNumber]: ctx.policy_number || "",
        [SCHEMA.triggerFields.summary]: ctx.summary || "",
        [SCHEMA.triggerFields.correlation]: correlation,
        [SCHEMA.triggerFields.lang]: lang,
        [SCHEMA.triggerFields.handoffContext]: JSON.stringify({
          ...ctx,
          request_id: correlation,
          language: lang
        })
      };
      const created = await dv.create(SCHEMA.triggerEntitySet, row);
      // Remember the trigger row's id so progress reads this exact row's receipt, and put
      // it in the runId so another instance (or this one after a restart) can rebuild the run.
      const triggerRowId = created && created[SCHEMA.triggerIdAttr];
      if (typeof triggerRowId === "string" && ROW_ID.test(triggerRowId)) runId += `~${triggerRowId}`;
      RUNS.set(runId, {
        startedAt,
        correlation,
        lang,
        triggerRowId,
        // Dataverse's own creation time bounds which Computer Use sessions can belong to this row.
        rowCreatedAt: created && created.createdon ? Date.parse(created.createdon) : null
      });
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
    // The RUNS registry is in-memory, so a Function App restart, or a poll answered by
    // another instance, finds no entry. Rebuild it from the runId: the start time, and
    // for live runs the trigger row id, whose creation time and correlation are re-read
    // from Dataverse. Attribution is then re-derived from the logs and the row's receipt.
    let run = RUNS.get(runId);
    if (!run) {
      const m = RUN_ID.exec(runId || "");
      if (m) {
        run = { startedAt: Number(m[1]), correlation: null, lang: "en", triggerRowId: m[2] || null };
        if (run.triggerRowId) run.restored = true;
        RUNS.set(runId, run);
      }
    }
    if (!run) return json(404, { error: `Unknown run ${runId}.` });

    if (dv.isMock()) {
      return json(200, mockProgress(run, runId));
    }

    try {
      if (run.restored) await restoreRow(run);
      const progress = await liveProgress(run, runId);
      return json(200, progress);
    } catch (err) {
      context.error("cua-run progress failed", err);
      if (process.env.CUA_REQUIRE_REAL_RESULT === "1" && err instanceof Unverifiable) {
        return json(200, { ...uncertain(`Could not verify this handoff's result: ${err.message}`), steps: [] });
      }
      // A read that failed (network, throttling, a service restart) proves nothing about
      // this handoff: keep the client polling, with no new steps.
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
 * LIVE path: project the Computer Use session that belongs to THIS handoff.
 *
 * Source: Computer Use advanced logs (Dataverse flowlog, read through the
 * documented flowsessions(<id>)/flowsession_flowlog_parentobjectid relationship).
 * Each action row carries the model's own explanation
 * (actionContext.llmInstruction.output), the action, the application, the time,
 * the exact screenshot (actionContext.screenshot.flowSessionBinaryId) and the
 * session's conversationId. Nothing is invented: a missing explanation is null.
 *
 * Attribution: while running, a session is shown only when it is the sole
 * conversation started since this row and no other handoff is pending. The
 * binding is sticky. Once the receipt arrives, its conversation_id must equal the
 * shown conversation; otherwise the activity is withdrawn as unverified.
 * Release is reported from the session record, separately from the claim.
 */
const LOG_ACTION_TYPES = new Set([100000401, 100000402]);
const PENDING_WINDOW_MS = 20 * 60_000;
// How long a replied receipt may wait for its Computer Use session before the run is
// reported as not filed. Live, the session appeared about 16 s after an early receipt.
const noActivityGraceMs = () => {
  const ms = Number(process.env.CUA_NO_ACTIVITY_GRACE_MS);
  return Number.isFinite(ms) && ms >= 0 && process.env.CUA_NO_ACTIVITY_GRACE_MS !== "" ? ms : 3 * 60_000;
};

async function liveProgress(run, runId) {
  const requireRealResult = process.env.CUA_REQUIRE_REAL_RESULT === "1";
  // Only the receipt on the original trigger row may finish a real-result run.
  const receipt = requireRealResult ? await readReceipt(run) : null;

  const since = new Date(run.rowCreatedAt || run.startedAt - 90_000).toISOString();
  const fs = await dv.get(
    `${SCHEMA.flowSessionSet}` +
      `?$orderby=createdon asc` +
      `&$filter=parentworkflowid eq ${SCHEMA.agentBotId} and createdon ge ${since}` +
      `&$select=flowsessionid,createdon,statecode,statuscode,completedon,errorcode,errormessage`
  );
  const sessions = (fs && fs.value) || [];
  for (const s of sessions) await refreshLogs(run, s.flowsessionid);
  const conversationOf = (s) => run.logs[s.flowsessionid].conversation;

  let activity;
  let shown = [];
  if (receipt) {
    const owned = sessions.filter((s) => conversationOf(s) === receipt.conversationId);
    if (run.boundConversation && run.boundConversation !== receipt.conversationId) {
      activity = { state: "mismatch", message: "The activity shown did not belong to this handoff's conversation and has been withdrawn." };
    } else if (owned.length) {
      run.boundConversation = receipt.conversationId;
      shown = owned;
      activity = { state: "verified", conversationId: receipt.conversationId };
    } else {
      run.unownedSince = run.unownedSince || Date.now();
      activity = { state: "unavailable", message: "No Computer Use activity log was found for this handoff's conversation." };
    }
  } else if (run.boundConversation) {
    shown = sessions.filter((s) => conversationOf(s) === run.boundConversation);
    activity = { state: "attributed", conversationId: run.boundConversation };
  } else {
    const conversations = [...new Set(sessions.map(conversationOf).filter(Boolean))];
    if (!conversations.length) {
      activity = { state: "waiting" };
    } else if (conversations.length > 1 || (await otherPendingHandoffs(run, since))) {
      activity = { state: "unattributed", message: "Another Computer Use run is active, so its activity cannot be attributed to this handoff yet." };
    } else {
      run.boundConversation = conversations[0];
      shown = sessions.filter((s) => conversationOf(s) === run.boundConversation);
      activity = { state: "attributed", conversationId: run.boundConversation };
    }
  }

  const steps = stepsFrom(shown.flatMap((s) => run.logs[s.flowsessionid].rows), runId);
  const release = releaseOf(shown[shown.length - 1]);

  if (requireRealResult) {
    if (!receipt) return { status: "running", steps, activity, release, claimId: null };
    // The receipt on this row names the conversation; only that conversation's own log counts.
    const owned = sessions.filter((s) => conversationOf(s) === receipt.conversationId);
    const evidence = submissionEvidence(owned.flatMap((s) => run.logs[s.flowsessionid].rows));
    return { ...realResult(run, receipt, evidence, owned), steps, activity, release };
  }
  // Legacy demo-result mode (CUA_REQUIRE_REAL_RESULT unset): unchanged result tiers,
  // including completion from the agent's latest session. Never the live AU path.
  const legacy = releaseOf(shown[shown.length - 1] || sessions[sessions.length - 1]);
  const status = legacy.state === "ended-with-error" ? "error"
    : legacy.state === "released" || legacy.state === "ended" ? "succeeded" : "running";
  const claimId = status === "succeeded" ? await resolveClaimId(run) : null;
  return { status, steps, activity, release, claimId };
}

// What the Computer Use log itself recorded under each click (actionItems[].context), from the
// Claims app's fixed control IDs (apps/legacy-claims-workstation/src/resource.h):
// IDC_FNOL_SUBMIT "Submit Claim", and the controls of IDD_CONFIRM_CLAIM ("FNOL Submitted"),
// the dialog Claims shows only after a successful submission.
const CLAIMS_PROCESS = "claims";
const SUBMIT_CLAIM = "7604";
const CONFIRMATION_DIALOG = new Set(["5900", "5901", "5902"]);
const CLAIM_ID = /\bCLM-\d{4}-\d{6}\b/g;

/**
 * Whether this conversation's own Computer Use log shows that it submitted a claim, and which.
 * The platform records the controls clicked: "Submit Claim", then a control of the "FNOL
 * Submitted" dialog. The claim number is the only one the agent stated from that Submit up to
 * and including its first action on the dialog, i.e. while the dialog was on screen. A number
 * already mentioned before the Submit cannot be the claim that Submit created.
 */
function submissionEvidence(rows) {
  const before = new Set();
  const atConfirmation = new Set();
  let submitted = false;
  let confirmed = false;
  for (const row of rows) {
    const action = row.data && row.data.actionContext;
    if (!LOG_ACTION_TYPES.has(row.type) || !action) continue;
    const said = action.llmInstruction && typeof action.llmInstruction.output === "string" ? action.llmInstruction.output : "";
    const named = said.match(CLAIM_ID) || [];
    const controls = (Array.isArray(action.actionItems) ? action.actionItems : [])
      .flatMap((item) => (Array.isArray(item.context) ? item.context : []))
      .filter((c) => c && String(c.processName || "").toLowerCase() === CLAIMS_PROCESS)
      .map((c) => String(c.automationId || ""));
    if (!submitted) {
      named.forEach((id) => before.add(id));
      submitted = controls.includes(SUBMIT_CLAIM);
      continue;
    }
    named.forEach((id) => atConfirmation.add(id));
    if (controls.some((c) => CONFIRMATION_DIALOG.has(c))) {
      confirmed = true;
      break;
    }
  }
  const ids = [...atConfirmation];
  const reused = ids.filter((id) => before.has(id));
  if (!confirmed || !ids.length) return { submitted, confirmed, claimId: null, conflict: null };
  if (reused.length) {
    return { submitted, confirmed, claimId: null, conflict: `The number at this run's confirmation (${reused.join(", ")}) was already mentioned before its Submit, so it is not the new claim.` };
  }
  if (ids.length > 1) {
    return { submitted, confirmed, claimId: null, conflict: `The agent named more than one claim number at this run's confirmation (${ids.join(", ")}).` };
  }
  return { submitted, confirmed, claimId: ids[0], conflict: null };
}

/**
 * The result of a real-result run from this row's receipt and its conversation's log.
 * Succeeded only with submission evidence; the agent's reply, if any, must name the same
 * claim. Once established, the claim is kept even if the Cloud PC session later fails.
 * A run that clicked Submit is never reported as a definite (retryable) failure.
 */
function realResult(run, receipt, evidence, owned) {
  if (run.confirmedClaim) return { status: "succeeded", claimId: run.confirmedClaim };
  const ended = owned.length > 0 && owned.every((s) => s.completedon);
  if (evidence.claimId) {
    if (receipt.reply !== "none" && !(receipt.reply === "filed" && receipt.claimId === evidence.claimId)) {
      return uncertain(`This run's confirmation shows claim ${evidence.claimId}, but the agent's reply does not report that claim as filed.`);
    }
    run.confirmedClaim = evidence.claimId;
    return { status: "succeeded", claimId: evidence.claimId };
  }
  if (evidence.conflict) return uncertain(evidence.conflict);
  if (evidence.submitted) {
    if (receipt.reply !== "none" || ended) {
      return uncertain(evidence.confirmed
        ? "This run clicked Submit Claim and the confirmation appeared, but the agent did not name its claim number there."
        : "This run clicked Submit Claim, but its log shows no confirmation dialog.");
    }
    return { status: "running", claimId: null };
  }
  if (receipt.reply === "failed") {
    return {
      status: "failed", claimId: null,
      errorMessage: `The agent reported "Filing failed: ${receipt.failure}" and its log shows no Submit Claim, so no claim was filed.`
    };
  }
  // The agent has replied but no Computer Use session ever appeared for its conversation.
  if (!owned.length && receipt.replied) {
    run.unownedSince = run.unownedSince || Date.now();
    if (Date.now() - run.unownedSince < noActivityGraceMs()) return { status: "running", claimId: null };
    if (receipt.reply === "filed") return uncertain("The agent reported a filed claim, but no Computer Use activity was found for its conversation.");
    return {
      status: "failed", claimId: null,
      errorMessage: "The agent replied without using Computer Use, so no claim was filed. Check its run record; do not submit another handoff."
    };
  }
  if (receipt.reply === "uncertain" && owned.length) {
    return uncertain("The agent's reply does not confirm a filed claim" +
      (receipt.mentioned.length ? ` (it mentions ${receipt.mentioned.join(", ")}).` : "."));
  }
  if (ended) {
    return uncertain(receipt.reply === "filed"
      ? `The agent reported claim ${receipt.claimId} as filed, but its log shows no Submit Claim followed by the confirmation.`
      : "The agent's session ended without a Submit Claim followed by the confirmation.");
  }
  return { status: "running", claimId: null };
}

/** A claim may or may not have been filed: Zava offers no retry for this handoff. */
function uncertain(reason) {
  return {
    status: "failed", outcome: "uncertain", claimId: null,
    errorMessage: `${reason} A claim may or may not have been filed. Check its run record; do not submit another handoff.`
  };
}

/** Incrementally read a session's Computer Use log rows into run.logs. */
async function refreshLogs(run, sessionId) {
  run.logs = run.logs || {};
  const cache = run.logs[sessionId] || (run.logs[sessionId] = { rows: [], seen: new Set(), last: null, conversation: null });
  const res = await dv.get(
    `${SCHEMA.flowSessionSet}(${sessionId})/flowsession_flowlog_parentobjectid` +
      `?$select=flowlogid,type,createdon,data&$orderby=createdon asc` +
      (cache.last ? `&$filter=createdon ge ${cache.last}` : "")
  );
  for (const row of (res && res.value) || []) {
    const key = row.flowlogid || `${row.type}|${row.createdon}|${row.data}`;
    if (cache.seen.has(key)) continue;
    cache.seen.add(key);
    let data = null;
    try { data = JSON.parse(row.data || "null"); } catch (_) { /* unreadable row is skipped */ }
    if (!data) continue;
    cache.conversation = cache.conversation || (data.sessionContext && data.sessionContext.conversationId) || null;
    cache.rows.push({ type: row.type, createdon: row.createdon, data });
    if (!cache.last || row.createdon > cache.last) cache.last = row.createdon;
  }
}

/** Project logged actions into progress steps; duplicates of the same model message are dropped. */
function stepsFrom(rows, runId) {
  const seen = new Set();
  const steps = [];
  for (const row of rows) {
    const action = row.data.actionContext;
    if (!LOG_ACTION_TYPES.has(row.type) || !action) continue;
    const items = Array.isArray(action.actionItems) ? action.actionItems : [];
    const key = `${action.id}|${items.map((i) => i.id || i.type).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const explanation = action.llmInstruction && typeof action.llmInstruction.output === "string"
      ? action.llmInstruction.output.trim() : "";
    const shot = action.screenshot && action.screenshot.flowSessionBinaryId;
    steps.push({
      index: steps.length,
      explanation: explanation || null,
      action: items.map((i) => i.type).filter(Boolean).join(" + ") || null,
      application: (action.target && action.target.processName) || null,
      at: (row.data.eventContext && row.data.eventContext.timestamp) || row.createdon,
      screenshotUrl: shot ? `/api/cua-run/${encodeURIComponent(runId)}/shot/${shot}` : null
    });
  }
  return steps;
}

/**
 * Release is evidenced only by the session record ending with a logged sign-out
 * (SessionHasLoggedOff); a claim does not prove it, nor does a plain end of session.
 */
function releaseOf(session) {
  if (!session) return { state: "unknown" };
  if (!session.completedon) return { state: "pending" };
  if (session.errorcode === "SessionHasLoggedOff") return { state: "released", at: session.completedon };
  if (session.errorcode) {
    return { state: "ended-with-error", at: session.completedon, detail: session.errorcode };
  }
  return { state: "ended", at: session.completedon };
}

/** True when another handoff row created around this one has no receipt yet. */
async function otherPendingHandoffs(run, since) {
  if (!run.triggerRowId) return true;
  const from = new Date(Date.parse(since) - PENDING_WINDOW_MS).toISOString();
  const res = await dv.get(
    `${SCHEMA.triggerEntitySet}?$top=1&$select=${SCHEMA.triggerIdAttr}` +
      `&$filter=createdon ge ${from} and ${SCHEMA.resultFields.receipt} eq null` +
      ` and ${SCHEMA.triggerIdAttr} ne ${run.triggerRowId}`
  );
  return !!(res && res.value && res.value.length);
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
  if (process.env.CUA_REQUIRE_REAL_RESULT === "1") {
    const receipt = await readReceipt(run);
    return receipt ? receipt.claimId : null;
  }
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

/**
 * Read and validate the receipt the trigger flow saved on this exact row.
 * Returns null until it exists, { claimId, conversationId } when valid (claimId is
 * null when the agent has not replied yet), and throws when it does not
 * unambiguously identify this handoff or names conflicting claims.
 */
async function readReceipt(run) {
  if (!run.triggerRowId) throw new Unverifiable("the exact handoff row is unavailable after a service restart.");
  const row = await dv.get(
    `${SCHEMA.triggerEntitySet}(${run.triggerRowId})?$select=${SCHEMA.resultFields.receipt}`
  );
  const serialized = row && row[SCHEMA.resultFields.receipt];
  if (!serialized) return null;
  let receipt;
  try { receipt = JSON.parse(serialized); } catch (_) { receipt = null; }
  if (!receipt || receipt.definition_version !== "2.0.0" ||
      receipt.trigger_row_id !== run.triggerRowId ||
      typeof receipt.conversation_id !== "string" || !receipt.conversation_id ||
      typeof receipt.flow_run_id !== "string" || !receipt.flow_run_id ||
      !Array.isArray(receipt.responses) || !receipt.responses.every((text) => typeof text === "string")) {
    throw new Unverifiable("the agent receipt does not identify this handoff.");
  }
  const ids = [...new Set(receipt.responses.flatMap((text) => text.match(/\bCLM-\d{4}-\d{6}\b/g) || []))];
  const filed = filedClaims(receipt.responses);
  if (filed.length > 1) throw new Unverifiable("the agent receipt names more than one filed claim.");
  const failed = receipt.responses.map((text) => /\bFiling failed: ([A-Z][A-Z_]*)\b/.exec(text)).find(Boolean);
  const answered = receipt.responses.some((text) => text.trim());
  // The agent's documented final reply is one line: "Claim CLM-... has been filed", or
  // "Filing failed: CODE", or an uncertain/incomplete report. Only the first proves a claim.
  let reply = "none";
  if (filed.length === 1 && !failed) reply = "filed";
  else if (failed && !filed.length) reply = "failed";
  else if (answered) reply = "uncertain";
  return {
    claimId: reply === "filed" ? filed[0] : null,
    failure: reply === "failed" ? failed[1] : null,
    reply,
    mentioned: ids,
    conversationId: receipt.conversation_id,
    replied: receipt.responses.length > 0
  };
}

/**
 * The claims stated as filed in the agent's documented words, "Claim CLM-YYYY-NNNNNN has
 * been filed" (optionally "successfully"), as a statement of its own: it starts the text,
 * a sentence or a line (optionally after the agent's "**mental_note**" marker) and ends
 * the sentence or clause. A number merely mentioned, negated ("has not been filed"),
 * qualified ("filed previously"), asked about, planned, or inside a condition or a
 * history note ("If Claim ...", "Policy history: Claim ...") is not a filed claim.
 */
function filedClaims(texts) {
  const line = /(?:^|[.!?]\s+|\n\s*)(?:\*\*)?(?:mental_note\*\*:?\s*)?(?:\*\*)?Claim (CLM-\d{4}-\d{6}) has been filed(?: successfully)?(?=\s*(?:[,.!*"]|$))/g;
  return [...new Set(texts.flatMap((text) => [...String(text).matchAll(line)].map((m) => m[1])))];
}

/**
 * Rebuild a run found only by its runId: re-read its trigger row's creation time and
 * correlation. A row that no longer exists cannot be verified.
 */
async function restoreRow(run) {
  let row;
  try {
    row = await dv.get(
      `${SCHEMA.triggerEntitySet}(${run.triggerRowId})?$select=createdon,${SCHEMA.triggerFields.correlation}`
    );
  } catch (err) {
    if (/HTTP 404\b/.test(String(err && err.message))) {
      throw new Unverifiable("this handoff's request row no longer exists.");
    }
    throw err;
  }
  run.rowCreatedAt = row && row.createdon ? Date.parse(row.createdon) : null;
  run.correlation = (row && row[SCHEMA.triggerFields.correlation]) || null;
  run.restored = false;
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

// ---------------------------------------------------------------------------
// NARRATION — scripted text for the offline SIMULATION only (CUA_PROGRESS_MOCK=1).
// It is never used on the live path and is returned as `note`, flagged
// `simulated: true`, so it can never be shown as an agent explanation.
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
    explanation: null,
    note: script[s.n],
    screenshotUrl: null,
    claimId: s.claimId
  }));
  const claimId = steps.find((s) => s.claimId)?.claimId;
  const status = elapsed >= MOCK_TOTAL_MS ? "succeeded" : "running";
  return { status, steps, claimId, simulated: true };
}

module.exports = { SCHEMA, mockProgress, NARRATION, liveProgress };
