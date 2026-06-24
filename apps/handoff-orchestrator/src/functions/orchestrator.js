/*
 * orchestrator.js - the durable handoff lifecycle. DETERMINISTIC: no env, no I/O,
 * no Date.now(); all wall-clock comes from context.df.currentUtcDateTime and all
 * side effects go through activities.
 *
 * Lifecycle: queued -> working -> succeeded | failed | timed_out.
 * Terminal result is reported two ways, whichever arrives first:
 *   1. STRUCTURED callback: the typed Power Automate result flow calls
 *      POST /api/handoff/{id}/result, which raises the "handoffResult" external
 *      event (authoritative).
 *   2. POLLING fallback: Computer Use has no proactive completion, so between
 *      timer ticks we poll Direct Line by watermark for a sentinel/structured
 *      activity (parseActivities).
 * The external-event task is created ONCE and re-raced against a fresh per-tick
 * timer (the documented human-interaction-with-timeout pattern). The terminal
 * custom status is authoritative for the frontend - never inferred from the
 * Durable runtime status alone.
 */

"use strict";

const df = require("durable-functions");
const { normalizeResult } = require("../contract");

function* handoffOrchestrator(context) {
  const input = context.df.getInput() || {};
  const envelope = input.envelope || {};
  const correlationId = envelope.correlation_id;
  const timing = input.timing || {};
  const pollIntervalMs = timing.pollIntervalMs > 0 ? timing.pollIntervalMs : 5000;
  const executionTimeoutMs =
    timing.executionTimeoutMs > 0 ? timing.executionTimeoutMs : 15 * 60 * 1000;

  context.df.setCustomStatus({ state: "queued", correlationId });

  // Stamp the REAL durable instance id into the envelope so the agent receives
  // it as Global.handoff_id and can build its result-callback URL
  // (POST /api/handoff/{handoff_id}/result). instanceId is deterministic, so
  // this stays replay-safe.
  const agentEnvelope = { ...envelope, handoff_id: context.df.instanceId };

  const conv = yield context.df.callActivity("openConversation", { envelope: agentEnvelope });
  const conversationId = conv.conversationId;
  let watermark = conv.watermark;
  const auth = conv.auth || null;

  const deadlineMs = context.df.currentUtcDateTime.getTime() + executionTimeoutMs;
  context.df.setCustomStatus({
    state: "working",
    correlationId,
    conversationId,
    startedAt: context.df.currentUtcDateTime.toISOString()
  });

  // Subscribe to the structured-completion callback once; re-race it each tick.
  const resultEvent = context.df.waitForExternalEvent("handoffResult");
  let result = null;

  for (;;) {
    // The result callback can land in the SAME replay turn a poll timer wins.
    // When that happens the timer takes the Task.any race and the event's
    // completion is orphaned against the already-resolved race; the reused
    // event task stays Completed but never re-fires (bug #73, observed live as
    // a 15-minute hang at 'ready'). Consume that resolved value at the loop top
    // before re-racing so a delivered result is never silently dropped.
    if (resultEvent.isCompleted) {
      result = normalizeResult(resultEvent.result);
      break;
    }

    const nowMs = context.df.currentUtcDateTime.getTime();
    if (nowMs >= deadlineMs) {
      result = {
        status: "error",
        error_code: "UNKNOWN",
        message: "Handoff timed out before the agent returned a result.",
        timed_out: true
      };
      break;
    }

    const nextPollMs = Math.min(nowMs + pollIntervalMs, deadlineMs);
    const timer = context.df.createTimer(new Date(nextPollMs));
    const winner = yield context.df.Task.any([timer, resultEvent]);

    if (winner === resultEvent) {
      if (!timer.isCompleted) timer.cancel();
      result = normalizeResult(resultEvent.result);
      break;
    }

    // Timer fired - poll Direct Line once for a terminal activity.
    const poll = yield context.df.callActivity("pollConversation", {
      conversationId,
      watermark,
      correlationId,
      auth
    });
    if (poll.watermark != null) watermark = poll.watermark;
    if (poll.result) {
      result = poll.result;
      break;
    }
  }

  const finalState =
    result.status === "succeeded" ? "succeeded" : result.timed_out ? "timed_out" : "failed";
  context.df.setCustomStatus({ state: finalState, correlationId, conversationId, result });
  return result;
}

df.app.orchestration("handoffOrchestrator", handoffOrchestrator);

module.exports = { handoffOrchestrator };
