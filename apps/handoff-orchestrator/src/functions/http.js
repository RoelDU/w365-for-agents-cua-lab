/*
 * http.js - HTTP surface for the handoff orchestrator.
 *
 *   POST /api/handoff
 *        Body: CallContext. Validates, derives a DETERMINISTIC instance id from
 *        the idempotency key, and starts (or reuses) the durable orchestration.
 *        Idempotency policy:
 *          - in-flight (Running/Pending/ContinuedAsNew) or Completed-SUCCESS ->
 *            reuse id (double-click / retry-while-running returns the same
 *            handoff_id).
 *          - terminal Failed/Terminated/Canceled OR Completed-but-failed/
 *            timed_out -> start a FRESH attempt (handoff-...-rN) so an operator's
 *            "retry" after a failure really retries instead of returning the
 *            stale failure forever.
 *        Returns 202 { handoff_id, status:"queued", status_url }.
 *
 *   GET  /api/handoff/{handoffId}/status
 *        Durable client getStatus -> mapJobToStatus -> HandoffStatusPayload.
 *        The browser polls THIS (our durable id); the backend owns the Direct
 *        Line conversation / watermark / token.
 *
 *   POST /api/handoff/{handoffId}/result
 *        Structured-completion callback from the typed Power Automate result
 *        flow. Auth via x-handoff-key; correlation_id must match the original
 *        envelope. Raises the "handoffResult" external event. Late/duplicate
 *        callbacks after completion are accepted idempotently (202).
 *
 *   GET  /api/health
 */

"use strict";

const { app } = require("@azure/functions");
const df = require("durable-functions");
const {
  validateCallContext,
  buildContextEnvelope,
  instanceIdFor,
  mapJobToStatus
} = require("../contract");
const { getTiming, getCallbackKey, isInsecureCallbackAllowed } = require("../config");

const ACTIVE = new Set(["Running", "Pending", "ContinuedAsNew"]);

function json(status, body) {
  return { status, headers: { "content-type": "application/json" }, jsonBody: body };
}

/**
 * A prior instance is REUSABLE (return the same handoff_id, don't start a fresh
 * attempt) only when it is still in-flight OR completed SUCCESSFULLY. A Durable
 * orchestration returns runtime "Completed" even for a business failure/timeout
 * (the custom status carries the real outcome), so a Completed instance is only
 * reusable when its custom status says it succeeded - otherwise an operator's
 * retry after a failure would get the stale failure forever.
 */
function isReusable(existing) {
  if (!existing || !existing.runtimeStatus) return false;
  if (ACTIVE.has(existing.runtimeStatus)) return true;
  if (existing.runtimeStatus === "Completed") {
    const cs = existing.customStatus;
    if (!cs || typeof cs !== "object") return false;
    const state = cs.state;
    const resultStatus = cs.result && cs.result.status;
    return state === "succeeded" || resultStatus === "succeeded";
  }
  return false;
}

/**
 * client.getStatus throws (not returns null) when the Durable extension has no
 * record of an instance - it surfaces the raw "HTTP 404 response" from the
 * extension. For idempotency probing and status reads we want "unknown instance"
 * to be a normal null, not a 502. Re-throw anything that is not a 404.
 */
async function safeGetStatus(client, id, ...args) {
  try {
    return await client.getStatus(id, ...args);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : "";
    if (/\b404\b/.test(msg)) return null;
    throw err;
  }
}

app.http("handoffStart", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "handoff",
  extraInputs: [df.input.durableClient()],
  handler: async (request, context) => {
    const client = df.getClient(context);

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

    const envelope = buildContextEnvelope(body);
    const baseId = instanceIdFor(body);
    const input = { envelope, timing: getTiming() };

    // Find a usable instance id honouring the idempotency policy above.
    let instanceId = baseId;
    try {
      const existing = await safeGetStatus(client, baseId);

      // In-flight or already-succeeded -> return the same handoff_id.
      if (isReusable(existing)) {
        return accepted(request, baseId, "reused");
      }

      // A terminal NON-reusable instance (failed / timed_out / Failed /
      // Terminated) exists at the base id -> allocate the next FREE attempt
      // suffix. Never start over a slot that already has history.
      if (existing && existing.runtimeStatus) {
        let claimed = null;
        for (let attempt = 2; attempt <= 6; attempt += 1) {
          const candidate = `${baseId}-r${attempt}`;
          const ex = await safeGetStatus(client, candidate);
          if (isReusable(ex)) {
            return accepted(request, candidate, "reused");
          }
          if (!ex || !ex.runtimeStatus) {
            claimed = candidate;
            break;
          }
        }
        if (!claimed) {
          return json(409, {
            error: "All retry attempts for this handoff are exhausted.",
            handoff_id: baseId
          });
        }
        instanceId = claimed;
      }

      await client.startNew("handoffOrchestrator", { instanceId, input });
      context.log(`handoff: started ${instanceId} for ${envelope.correlation_id}`);
      return accepted(request, instanceId, "started");
    } catch (err) {
      context.error("handoff start failed", err);
      return json(502, {
        error: "Could not start the handoff orchestration.",
        details: err instanceof Error ? err.message : String(err)
      });
    }
  }
});

function accepted(request, handoffId, disposition) {
  const origin = originOf(request);
  return json(202, {
    handoff_id: handoffId,
    status: "queued",
    disposition,
    status_url: `${origin}/api/handoff/${encodeURIComponent(handoffId)}/status`
  });
}

function originOf(request) {
  try {
    return new URL(request.url).origin;
  } catch {
    return "";
  }
}

app.http("handoffStatus", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "handoff/{handoffId}/status",
  extraInputs: [df.input.durableClient()],
  handler: async (request, context) => {
    const client = df.getClient(context);
    const handoffId = request.params.handoffId;
    let status;
    try {
      status = await safeGetStatus(client, handoffId, false, false, true);
    } catch (err) {
      context.error("status read failed", err);
      return json(502, { error: "Could not read handoff status." });
    }
    if (!status || !status.runtimeStatus) {
      return json(404, { error: `Unknown handoff ${handoffId}.` });
    }
    const requestId =
      (status.input && status.input.envelope && status.input.envelope.correlation_id) || handoffId;
    return json(200, mapJobToStatus(requestId, status.runtimeStatus, status.customStatus));
  }
});

app.http("handoffResult", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "handoff/{handoffId}/result",
  extraInputs: [df.input.durableClient()],
  handler: async (request, context) => {
    const client = df.getClient(context);
    const handoffId = request.params.handoffId;

    const callbackKey = getCallbackKey();
    if (callbackKey) {
      if (request.headers.get("x-handoff-key") !== callbackKey) {
        return json(401, { error: "Invalid or missing x-handoff-key." });
      }
    } else if (isInsecureCallbackAllowed()) {
      context.warn(
        "HANDOFF_CALLBACK_KEY is not set and HANDOFF_ALLOW_INSECURE_CALLBACK=true - the result callback is UNAUTHENTICATED (local dev only)."
      );
    } else {
      // Fail CLOSED: a missing key in a deployed environment must not become an
      // open completion endpoint.
      context.error(
        "HANDOFF_CALLBACK_KEY is not configured; refusing the result callback. Set the key (or HANDOFF_ALLOW_INSECURE_CALLBACK=true for local dev)."
      );
      return json(503, { error: "Result callback is not configured." });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "Result body must be valid JSON." });
    }

    let status;
    try {
      status = await safeGetStatus(client, handoffId, false, false, true);
    } catch {
      status = null;
    }
    if (!status || !status.runtimeStatus) {
      return json(404, { error: `Unknown handoff ${handoffId}.` });
    }

    // Correlation must match the original envelope (prevents a stray callback
    // completing the wrong handoff). When the orchestration carries a correlation
    // id, the callback MUST present a matching one - a missing/blank correlation
    // id is rejected, not waved through.
    const expected =
      status.input && status.input.envelope && status.input.envelope.correlation_id;
    if (expected && body.correlation_id !== expected) {
      return json(409, {
        error: "correlation_id is required and must match this handoff.",
        expected
      });
    }

    // Late/duplicate callback after the orchestration already finished: accept
    // idempotently instead of erroring.
    if (!ACTIVE.has(status.runtimeStatus)) {
      return json(202, { note: "Handoff already completed; callback ignored." });
    }

    try {
      await client.raiseEvent(handoffId, "handoffResult", body);
      return json(202, { note: "Result accepted." });
    } catch (err) {
      context.error("raiseEvent failed", err);
      return json(202, { note: "Handoff not awaiting a result; callback ignored." });
    }
  }
});

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: async () => json(200, { status: "ok" })
});

// Exported for unit testing the idempotency/404-handling logic in isolation.
// The HTTP handlers above self-register with the Functions runtime and are
// covered end-to-end by the live smoke test; these pure helpers are unit-tested.
module.exports = { isReusable, safeGetStatus };
