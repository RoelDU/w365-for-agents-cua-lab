/*
 * index.js - Azure Functions (v4 programming model) HTTP endpoints for the
 * Static Web Apps managed API. Two routes:
 *
 *   POST /api/handoff
 *        Body: CallContext (schemas/call-context.schema.json).
 *        Validates, starts a Foundry agent run (fire-and-forget), returns 202
 *        with { request_id, status:"queued", thread_id, run_id, status_url }.
 *
 *   GET  /api/handoff/{requestId}/status?thread_id=..&run_id=..
 *        Polls the Foundry run + last assistant message and returns a
 *        HandoffStatusPayload. STATELESS by design: thread_id/run_id travel in
 *        the query so any Function instance can answer (SWA managed Functions
 *        have no shared store and no managed identity; ~45s execution cap, so we
 *        never block on the run - the SPA polls).
 *
 * Secrets (AZURE_CLIENT_SECRET etc.) live ONLY in SWA app settings, never in code.
 */

const { app } = require("@azure/functions");
const { validateCallContext, buildHandoffMessage, mapRunToStatus } = require("./contract");
const foundry = require("./foundry");

app.http("handoff", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "handoff",
  handler: async (request, context) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "Request body must be valid JSON." });
    }

    const { valid, errors } = validateCallContext(body);
    if (!valid) {
      return json(400, { error: "Invalid CallContext payload.", details: errors });
    }

    try {
      const message = buildHandoffMessage(body);
      const { threadId, runId } = await foundry.startRun(message);
      const requestId = body.request_id;
      return json(202, {
        request_id: requestId,
        status: "queued",
        thread_id: threadId,
        run_id: runId,
        status_url:
          `/api/handoff/${encodeURIComponent(requestId)}/status` +
          `?thread_id=${encodeURIComponent(threadId)}&run_id=${encodeURIComponent(runId)}`
      });
    } catch (err) {
      context.error("handoff failed", err);
      return json(502, {
        error: "Could not start the Foundry agent run.",
        details: err instanceof Error ? err.message : String(err)
      });
    }
  }
});

app.http("handoffStatus", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "handoff/{requestId}/status",
  handler: async (request, context) => {
    const requestId = request.params.requestId;
    const threadId = request.query.get("thread_id");
    const runId = request.query.get("run_id");
    if (!threadId || !runId) {
      return json(400, {
        error: "thread_id and run_id query parameters are required.",
        hint: "Use the status_url returned by POST /api/handoff."
      });
    }

    try {
      const run = await foundry.getRun(threadId, runId);
      let lastText = "";
      if (["completed", "failed", "cancelled", "expired"].includes(run.status)) {
        lastText = await foundry.getLastAssistantText(threadId);
      }
      return json(200, mapRunToStatus(requestId, run, lastText));
    } catch (err) {
      context.error("status failed", err);
      if (err && err.status === 404) {
        return json(404, { error: `Unknown thread/run for request ${requestId}.` });
      }
      return json(502, {
        error: "Could not read the Foundry run status.",
        details: err instanceof Error ? err.message : String(err)
      });
    }
  }
});

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: async () => json(200, { status: "ok" })
});

function json(status, payload) {
  return {
    status,
    headers: { "content-type": "application/json" },
    jsonBody: payload
  };
}
