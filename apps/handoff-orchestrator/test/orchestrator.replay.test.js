"use strict";

/*
 * REPLAY test for the durable completion path (issue #73). Drives the REAL
 * durable-functions TaskOrchestrationExecutor over a hand-built history that
 * raises the "handoffResult" external event, and asserts the orchestration
 * actually COMPLETES (returns succeeded / sets customStatus submitted) instead
 * of staying parked on WaitForExternalEvent.
 *
 * This exercises the real SDK event-matching (openEvents / Task.any / the
 * re-raced external event in the polling loop) - the exact mechanism the live
 * deployment got stuck on - with no Azure, no storage, no network.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const moment = require("moment");

const {
  TaskOrchestrationExecutor
} = require("durable-functions/lib/src/orchestrations/TaskOrchestrationExecutor");
const {
  DurableOrchestrationContext
} = require("durable-functions/lib/src/orchestrations/DurableOrchestrationContext");
const {
  LatestReplaySchema
} = require("durable-functions/lib/src/orchestrations/ReplaySchema");
const {
  HistoryEventType
} = require("durable-functions/lib/src/history/HistoryEventType");

const { handoffOrchestrator } = require("../src/functions/orchestrator");

const T = HistoryEventType;
let clock = Date.parse("2026-06-10T00:00:00Z");
const ts = () => new Date((clock += 1000));

const started = () => ({ EventType: T.OrchestratorStarted, Timestamp: ts(), IsPlayed: true });
const execStarted = (input) => ({
  EventType: T.ExecutionStarted,
  EventId: -1,
  Timestamp: ts(),
  IsPlayed: true,
  Name: "handoffOrchestrator",
  Input: JSON.stringify(input)
});
const taskCompleted = (taskScheduledId, result) => ({
  EventType: T.TaskCompleted,
  Timestamp: ts(),
  IsPlayed: true,
  TaskScheduledId: taskScheduledId,
  Result: JSON.stringify(result)
});
const timerFired = (timerId) => ({
  EventType: T.TimerFired,
  Timestamp: ts(),
  IsPlayed: true,
  TimerId: timerId
});
const eventRaised = (name, payload) => ({
  EventType: T.EventRaised,
  Timestamp: ts(),
  IsPlayed: false,
  Name: name,
  Input: JSON.stringify(payload)
});

async function runReplay(history, input) {
  const executor = new TaskOrchestrationExecutor();
  const firstStarted = history.find((e) => e.EventType === T.OrchestratorStarted);
  const context = {
    df: new DurableOrchestrationContext(
      history,
      "handoff-test-instance",
      new Date(firstStarted.Timestamp),
      false,
      undefined,
      moment.duration("P3D").toISOString(),
      moment.duration("P6D").toISOString(),
      30000,
      LatestReplaySchema,
      input,
      executor
    )
  };
  return executor.execute(context, history, LatestReplaySchema, handoffOrchestrator);
}

// Sequence-id model (how trackOpenTask assigns ids in THIS orchestrator):
//   0 = openConversation (callActivity)
//   1 = poll timer, tick 1 (createTimer)   [external event task id = "handoffResult"]
//   2 = pollConversation, tick 1 (callActivity)
//   3 = poll timer, tick 2 (createTimer)
const INPUT = {
  envelope: {
    correlation_id: "REQ-1",
    caller_phone: "(555) 123-4567",
    intent: "auto_collision",
    summary: "smoke",
    requested_at: "2026-06-10T00:00:00Z"
  },
  timing: { pollIntervalMs: 5000, executionTimeoutMs: 900000 }
};

test("completion path: a raised handoffResult event completes the orchestration as submitted", async () => {
  const history = [
    started(),
    execStarted(INPUT),
    taskCompleted(0, { conversationId: "c1", watermark: "0", auth: null }),
    started(),
    timerFired(1),
    taskCompleted(2, { watermark: "1", result: null }),
    started(),
    eventRaised("handoffResult", {
      correlation_id: "REQ-1",
      status: "succeeded",
      claim_id: "CLM-2026-000123"
    })
  ];

  const state = await runReplay(history, INPUT);

  assert.equal(state.isDone, true, "orchestration should be DONE, not parked on WaitForExternalEvent");
  assert.equal(state.output.status, "succeeded");
  assert.equal(state.output.claim_id, "CLM-2026-000123");
  assert.equal(state.customStatus.state, "succeeded");
});

test("completion path: the result event wins even after several poll ticks (re-raced event task)", async () => {
  const history = [
    started(),
    execStarted(INPUT),
    taskCompleted(0, { conversationId: "c1", watermark: "0", auth: null }),
    started(),
    timerFired(1),
    taskCompleted(2, { watermark: "1", result: null }),
    started(),
    timerFired(3),
    taskCompleted(4, { watermark: "2", result: null }),
    started(),
    timerFired(5),
    taskCompleted(6, { watermark: "3", result: null }),
    started(),
    eventRaised("handoffResult", {
      correlation_id: "REQ-1",
      status: "succeeded",
      claim_id: "CLM-2026-000777"
    })
  ];

  const state = await runReplay(history, INPUT);

  assert.equal(state.isDone, true, "orchestration must consume the event after many ticks");
  assert.equal(state.output.claim_id, "CLM-2026-000777");
  assert.equal(state.customStatus.state, "succeeded");
});

// Regression for #73 (reproduced from the LIVE durable history): the poll timer
// and the handoffResult event are delivered in the SAME turn, timer FIRST. The
// timer wins the Task.any race and the generator advances to pollConversation;
// the event then resolves against the now-completed race and - with a single
// reused waitForExternalEvent task - was silently dropped, so the orchestration
// polled until the 15-minute timeout instead of completing. It must complete.
test("completion path #73: event raised in the SAME turn a poll timer wins must not be lost", async () => {
  const history = [
    started(),
    execStarted(INPUT),
    taskCompleted(0, { conversationId: "c1", watermark: "0", auth: null }),
    started(),
    timerFired(1),
    eventRaised("handoffResult", {
      correlation_id: "REQ-1",
      status: "succeeded",
      claim_id: "CLM-2026-000999"
    }),
    taskCompleted(2, { watermark: "1", result: null }),
    started()
  ];

  const state = await runReplay(history, INPUT);

  assert.equal(state.isDone, true, "orchestration must consume a same-turn event, not poll to timeout");
  assert.equal(state.output.claim_id, "CLM-2026-000999");
  assert.equal(state.customStatus.state, "succeeded");
});
