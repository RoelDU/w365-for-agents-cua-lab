"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const childProcess = require("node:child_process");
const { app, HttpRequest } = require("@azure/functions");

const callContext = {
  request_id: "REQ-2024-0042",
  handoff_id: "handoff-test-42",
  caller_phone: "(555) 123-4567",
  policy_number: "POL-2024-008341",
  intent: "auto_collision",
  summary: 'Rear-ended at "5th and Main".\nNo injuries; sign says \\STOP.',
  transcript_excerpt: "\u8ffd\u7a81\u3055\u308c\u307e\u3057\u305f\u3002",
  requested_by: { agent_id: "csr-test", display_name: "Test CSR" },
  timestamp: "2024-04-15T18:32:11Z",
  target_backend: "mcs",
  task: "File a First Notice of Loss (FNOL) claim in the Zava Mutual Claims Workstation."
};

function loadStart(t, env = {}, respond = () => ({ crcce_claimrequestid: "row-test-42" })) {
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    DATAVERSE_ORG_URL: "https://dataverse.example.test",
    CUA_REGION: "",
    CUA_REQUIRE_REAL_RESULT: "",
    CUA_PROGRESS_MOCK: "0",
    IDENTITY_ENDPOINT: "",
    IDENTITY_HEADER: ""
  };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CUA_TRIGGER_")) delete process.env[key];
  }
  Object.assign(process.env, env);
  t.after(() => { process.env = originalEnv; });

  // Exercise the real handler and Dataverse serializer; replace only runtime
  // registration, credential acquisition, and the outbound network boundary.
  const handlers = {};
  t.mock.method(app, "http", (name, options) => { handlers[name] = options.handler; });
  t.mock.method(childProcess, "execFile", (_file, _args, _options, callback) => {
    callback(null, "offline-test-token");
  });

  const requests = [];
  t.mock.method(https, "request", (options, callback) => {
    const request = new EventEmitter();
    let payload = "";
    request.write = (chunk) => { payload += chunk; };
    request.end = () => {
      requests.push({ ...options, body: payload ? JSON.parse(payload) : null });
      const response = new EventEmitter();
      const reply = respond(options);
      // A reply may set __status to simulate a Dataverse error status.
      const { __status, ...body } = reply || {};
      response.statusCode = __status || 201;
      callback(response);
      response.emit("data", JSON.stringify(body));
      response.emit("end");
    };
    return request;
  });

  const modulePath = require.resolve("../src/functions/cuaRun");
  const load = () => {
    delete require.cache[modulePath];
    require(modulePath);
  };
  load();
  t.after(() => { delete require.cache[modulePath]; });

  const errors = [];
  return {
    requests,
    errors,
    // A fresh module load is a new instance: its in-memory run registry is empty.
    newInstance: load,
    progress: (runId) => handlers.cuaRunProgress(
      new HttpRequest({
        method: "GET",
        url: `https://orchestrator.example.test/api/cua-run/${runId}/progress`,
        params: { runId }
      }),
      { log() {}, error: (...args) => { errors.push(args); } }
    ),
    start: (body) => handlers.cuaRunStart(
      new HttpRequest({
        method: "POST",
        url: "https://orchestrator.example.test/api/cua-run",
        body: { string: JSON.stringify(body) }
      }),
      { log() {}, error: (...args) => { errors.push(args); } }
    )
  };
}

test("cua-run sends the complete Japanese handoff as JSON without changing existing row fields", async (t) => {
  const { start, requests, errors } = loadStart(t);
  const response = await start({ callContext, lang: "ja" });

  assert.equal(response.status, 202);
  assert.equal(response.jsonBody.mode, "dataverse");
  assert.match(response.jsonBody.runId, /^run-\d+-/);
  assert.deepEqual(errors, []);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.hostname, "dataverse.example.test");
  assert.equal(request.path, "/api/data/v9.2/crcce_claimrequests");

  const { crcce_handoffcontext: handoff, ...existingFields } = request.body;
  assert.equal(typeof handoff, "string", "the flow requires a nonempty serialized handoff");
  assert.ok(handoff.length > 0);
  assert.deepEqual(JSON.parse(handoff), { ...callContext, language: "ja" });
  assert.deepEqual(existingFields, {
    crcce_policynumber: "POL-2024-008341",
    crcce_summary: 'Rear-ended at "5th and Main".\nNo injuries; sign says \\STOP.',
    crcce_correlationid: "REQ-2024-0042",
    crcce_lang: "ja"
  });
});

for (const lang of ["en", undefined, "fr"]) {
  test(`cua-run keeps the existing English selection for lang=${lang}`, async (t) => {
    const { start, requests } = loadStart(t);
    const response = await start({ callContext, lang });

    assert.equal(response.status, 202);
    assert.equal(requests[0].body.crcce_lang, "en");
    assert.deepEqual(JSON.parse(requests[0].body.crcce_handoffcontext), {
      ...callContext,
      language: "en"
    });
  });
}

test("cua-run includes the generated correlation when no request id was supplied", async (t) => {
  const { start, requests } = loadStart(t);
  t.mock.method(Date, "now", () => 1713205931000);
  const response = await start({
    callContext: { caller_phone: "(555) 123-4567", intent: "auto_collision", summary: "No injuries." }
  });

  assert.equal(response.status, 202);
  const { crcce_handoffcontext: handoff, ...existingFields } = requests[0].body;
  assert.deepEqual(JSON.parse(handoff), {
    caller_phone: "(555) 123-4567",
    intent: "auto_collision",
    summary: "No injuries.",
    request_id: "cua-1713205931000",
    language: "en"
  });
  assert.deepEqual(existingFields, {
    crcce_policynumber: "",
    crcce_summary: "No injuries.",
    crcce_correlationid: "cua-1713205931000",
    crcce_lang: "en"
  });
});

test("cua-run honors configured table and column names for the outgoing handoff", async (t) => {
  const { start, requests } = loadStart(t, {
    CUA_TRIGGER_ENTITYSET: "custom_requests",
    CUA_TRIGGER_FIELD_POLICY: "custom_policy",
    CUA_TRIGGER_FIELD_SUMMARY: "custom_summary",
    CUA_TRIGGER_FIELD_CORRELATION: "custom_correlation",
    CUA_TRIGGER_FIELD_LANG: "custom_lang",
    CUA_TRIGGER_FIELD_HANDOFF_CONTEXT: "custom_context"
  });
  const response = await start({ callContext, lang: "ja" });

  assert.equal(response.status, 202);
  assert.equal(requests[0].path, "/api/data/v9.2/custom_requests");
  const { custom_context: handoff, ...existingFields } = requests[0].body;
  assert.deepEqual(JSON.parse(handoff), { ...callContext, language: "ja" });
  assert.deepEqual(existingFields, {
    custom_policy: "POL-2024-008341",
    custom_summary: 'Rear-ended at "5th and Main".\nNo injuries; sign says \\STOP.',
    custom_correlation: "REQ-2024-0042",
    custom_lang: "ja"
  });
});

test("cua-run mock mode still creates no Dataverse request", async (t) => {
  const { start, requests } = loadStart(t, { CUA_PROGRESS_MOCK: "1" });
  const response = await start({ callContext, lang: "ja" });

  assert.equal(response.status, 202);
  assert.equal(response.jsonBody.mode, "mock");
  assert.deepEqual(requests, []);
});

test("cua-run still reports and logs a failed Dataverse write", async (t) => {
  const { start, errors } = loadStart(t);
  t.mock.method(https, "request", () => { throw new Error("Offline write failure"); });
  const response = await start({ callContext, lang: "ja" });

  assert.equal(response.status, 502);
  assert.equal(response.jsonBody.error, "Could not start the run.");
  assert.equal(response.jsonBody.details, "Offline write failure");
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], "cua-run start failed");
  assert.equal(errors[0][1].message, "Offline write failure");
});

test("an Australian service rejects a US-labelled handoff before creating a request", async (t) => {
  const { start, requests, errors } = loadStart(t, { CUA_REGION: "au" });
  const response = await start({ callContext, lang: "en", regionId: "us" });

  assert.equal(response.status, 409);
  assert.equal(response.jsonBody.code, "REGION_MISMATCH");
  assert.match(response.jsonBody.error, /region.*refresh/i);
  assert.deepEqual(requests, []);
  assert.equal(errors.length, 1);
});

test("a region-bound service rejects an old app without a region before creating a request", async (t) => {
  const { start, requests } = loadStart(t, { CUA_REGION: "au" });
  const response = await start({ callContext, lang: "en" });

  assert.equal(response.status, 409);
  assert.equal(response.jsonBody.code, "REGION_MISMATCH");
  assert.deepEqual(requests, []);
});

test("an Australian service accepts its matching region with the complete handoff unchanged", async (t) => {
  const { start, requests } = loadStart(t, { CUA_REGION: "au" });
  const response = await start({ callContext, lang: "en", regionId: "au" });

  assert.equal(response.status, 202);
  assert.deepEqual(JSON.parse(requests[0].body.crcce_handoffcontext), {
    ...callContext,
    language: "en"
  });
});

function completedRunResponse(options, row = {}) {
  if (options.method === "POST") return { crcce_claimrequestid: "row-test-42" };
  if (options.path.includes("/flowsession_flowlog_parentobjectid")) return { value: [] };
  if (options.path.includes("/flowsessions?")) {
    return { value: [{ flowsessionid: "session-42", completedon: "2026-10-01T07:00:00Z" }] };
  }
  if (options.path.includes("/crcce_claimrequests(")) return row;
  if (options.path.includes("/crcce_claimrequests?")) return { value: [] };
  if (options.path.includes("/flowsessionbinaries?") || options.path.includes("/conversationtranscripts?")) {
    return { value: [] };
  }
  throw new Error(`Unexpected offline request: ${options.path}`);
}

test("real-result mode waits after machine release rather than returning a preset claim number", async (t) => {
  const { start, progress } = loadStart(t, {
    CUA_REQUIRE_REAL_RESULT: "1",
    CUA_DEMO_CLAIM_ID: "CLM-2024-999999"
  }, completedRunResponse);
  const started = await start({ callContext, lang: "en" });
  const result = await progress(started.jsonBody.runId);

  assert.equal(result.status, 200);
  assert.equal(result.jsonBody.status, "running");
  assert.equal(result.jsonBody.claimId, null);
});

test("real-result mode returns the agent receipt saved to this exact handoff row", async (t) => {
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, (options) =>
    completedRunResponse(options, {
      crcce_handoffreceipt: JSON.stringify({
        definition_version: "2.0.0",
        trigger_row_id: "row-test-42",
        conversation_id: "conversation-42",
        flow_run_id: "flow-run-42",
        responses: ["Claim CLM-2026-001234 has been filed.", "Workstation released."]
      })
    }));
  const started = await start({ callContext, lang: "en" });
  const result = await progress(started.jsonBody.runId);

  assert.equal(result.status, 200);
  assert.equal(result.jsonBody.status, "succeeded");
  assert.equal(result.jsonBody.claimId, "CLM-2026-001234");
});

for (const [name, changes] of [
  ["another handoff", { trigger_row_id: "other-row" }],
  ["conflicting filed claims", { responses: ["Claim CLM-2026-001234 has been filed", "Claim CLM-2026-005678 has been filed"] }],
  ["malformed responses", { responses: [42] }],
  ["no conversation", { conversation_id: "" }]
]) {
  test(`real-result mode reports ${name} instead of a preset or uncertain result`, async (t) => {
    const receipt = {
      definition_version: "2.0.0", trigger_row_id: "row-test-42",
      conversation_id: "conversation-42", flow_run_id: "flow-run-42",
      responses: ["Claim CLM-2026-001234 has been filed."], ...changes
    };
    const { start, progress, errors } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, (options) =>
      completedRunResponse(options, { crcce_handoffreceipt: JSON.stringify(receipt) }));
    const started = await start({ callContext, lang: "en" });
    const result = await progress(started.jsonBody.runId);

    assert.equal(result.jsonBody.status, "failed");
    assert.equal(result.jsonBody.claimId, null);
    assert.match(result.jsonBody.errorMessage, /do not submit another handoff/);
    assert.equal(errors.length, 1);
  });
}

test("legacy demo-result behavior stays available when real-result mode is not enabled", async (t) => {
  const { start, progress } = loadStart(t, { CUA_DEMO_CLAIM_ID: "CLM-2024-999999" }, completedRunResponse);
  const started = await start({ callContext, lang: "en" });
  const result = await progress(started.jsonBody.runId);

  assert.equal(result.jsonBody.status, "succeeded");
  assert.equal(result.jsonBody.claimId, "CLM-2024-999999");
});

test("real-result mode does not terminate this handoff from an uncorrelated machine failure", async (t) => {
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, (options) => {
    if (options.path.includes("/flowsessions?")) {
      return { value: [{ flowsessionid: "session-42", completedon: "2026-10-01T07:00:00Z", errorcode: "NoCandidateMachine" }] };
    }
    return completedRunResponse(options);
  });
  const started = await start({ callContext, lang: "en" });
  const result = await progress(started.jsonBody.runId);

  assert.equal(result.jsonBody.status, "running");
  assert.equal(result.jsonBody.claimId, null);
});

test("a previous failed session cannot prevent the new handoff's receipt reaching the interaction", async (t) => {
  let receiptReady = false;
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, (options) => {
    if (options.path.includes("/flowsessions?")) {
      return { value: [{
        flowsessionid: "previous-session", completedon: "2026-10-01T07:00:00Z",
        errorcode: "NoCandidateMachine"
      }] };
    }
    return completedRunResponse(options, receiptReady ? {
      crcce_handoffreceipt: JSON.stringify({
        definition_version: "2.0.0", trigger_row_id: "row-test-42",
        conversation_id: "new-conversation", flow_run_id: "new-flow-run",
        responses: ["Claim CLM-2026-001234 has been filed."]
      })
    } : {});
  });
  const started = await start({ callContext, lang: "en" });
  const pending = await progress(started.jsonBody.runId);
  assert.equal(pending.jsonBody.status, "running");
  assert.equal(pending.jsonBody.claimId, null);

  receiptReady = true;
  const completed = await progress(started.jsonBody.runId);
  assert.equal(completed.jsonBody.status, "succeeded");
  assert.equal(completed.jsonBody.claimId, "CLM-2026-001234");
});

test("the exact-row receipt returns the result even when machine-session history is not visible yet", async (t) => {
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, (options) => {
    if (options.path.includes("/flowsessions?")) return { value: [] };
    return completedRunResponse(options, {
      crcce_handoffreceipt: JSON.stringify({
        definition_version: "2.0.0", trigger_row_id: "row-test-42",
        conversation_id: "new-conversation", flow_run_id: "new-flow-run",
        responses: ["Claim CLM-2026-001234 has been filed."]
      })
    });
  });
  const started = await start({ callContext, lang: "en" });
  const completed = await progress(started.jsonBody.runId);
  assert.equal(completed.jsonBody.status, "succeeded");
  assert.equal(completed.jsonBody.claimId, "CLM-2026-001234");
});

// ---------------------------------------------------------------------------
// A poll answered by another instance, or after a restart (6 October MCS run: the
// interaction showed "Could not verify this handoff's result" 9 s after Confirm while
// the agent went on to file the claim).
// ---------------------------------------------------------------------------
const exactReceipt = {
  crcce_handoffreceipt: JSON.stringify({
    definition_version: "2.0.0", trigger_row_id: "row-test-42",
    conversation_id: "conversation-42", flow_run_id: "flow-run-42",
    responses: ["Claim CLM-2026-001234 has been filed."]
  })
};

test("a live runId carries its trigger row so any instance can find this exact handoff", async (t) => {
  const { start } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, completedRunResponse);
  const started = await start({ callContext, lang: "en" });
  assert.match(started.jsonBody.runId, /^run-\d+-[a-z0-9]+~row-test-42$/);
});

test("a progress poll on a new instance rebuilds the run and returns this row's receipt", async (t) => {
  let receipt = {};
  const world = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, (options) =>
    completedRunResponse(options, receipt));
  const started = await world.start({ callContext, lang: "en" });
  world.newInstance();

  const waiting = await world.progress(started.jsonBody.runId);
  assert.equal(waiting.jsonBody.status, "running");
  assert.ok(world.requests.some((r) => r.path.includes("crcce_claimrequests(row-test-42)?$select=createdon,crcce_correlationid")));

  receipt = exactReceipt;
  const done = await world.progress(started.jsonBody.runId);
  assert.equal(done.jsonBody.status, "succeeded");
  assert.equal(done.jsonBody.claimId, "CLM-2026-001234");
  assert.deepEqual(world.errors, []);
});

test("a rebuilt run whose request row no longer exists is reported as unverifiable", async (t) => {
  const world = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, (options) =>
    options.method === "GET" && options.path.includes("/crcce_claimrequests(")
      ? { __status: 404, error: { message: "Does Not Exist" } }
      : completedRunResponse(options));
  const started = await world.start({ callContext, lang: "en" });
  world.newInstance();
  const result = await world.progress(started.jsonBody.runId);

  assert.equal(result.jsonBody.status, "failed");
  assert.equal(result.jsonBody.claimId, null);
  assert.match(result.jsonBody.errorMessage, /no longer exists.*do not submit another handoff/);
});

test("a failed Dataverse read keeps the handoff running instead of ending it", async (t) => {
  let throttled = true;
  const world = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, (options) => {
    if (throttled && options.path.includes("/flowsessions?")) return { __status: 503, error: { message: "Service unavailable" } };
    return completedRunResponse(options, exactReceipt);
  });
  const started = await world.start({ callContext, lang: "en" });

  const blip = await world.progress(started.jsonBody.runId);
  assert.equal(blip.jsonBody.status, "running");
  assert.equal(blip.jsonBody.errorMessage, undefined);

  throttled = false;
  const done = await world.progress(started.jsonBody.runId);
  assert.equal(done.jsonBody.status, "succeeded");
  assert.equal(done.jsonBody.claimId, "CLM-2026-001234");
});

test("a run id without its request row still cannot be finished on a new instance", async (t) => {
  const world = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, (options) =>
    completedRunResponse(options, exactReceipt));
  const result = await world.progress(`run-${Date.now()}-abc123`);

  assert.equal(result.jsonBody.status, "failed");
  assert.match(result.jsonBody.errorMessage, /row is unavailable/);
});

// ---------------------------------------------------------------------------
// Truthful progress (ticket 06): explanations and actions come only from the
// Computer Use action log of the session attributed to this exact handoff.
// ---------------------------------------------------------------------------
function actionLog({ conversation = "conv-42", at, explanation, action = "LeftClick", app = "Claims", shot, message, type = 100000401 }) {
  return {
    type,
    createdon: at,
    data: JSON.stringify({
      eventContext: { timestamp: at },
      sessionContext: { conversationId: conversation },
      actionContext: {
        id: message || `msg-${at}`,
        requestPrompt: "Fixed tool instruction that must never be shown as an explanation.",
        actionItems: [{ type: action, name: action }],
        target: { processName: app },
        llmInstruction: explanation === undefined ? {} : { output: explanation },
        ...(shot ? { screenshot: { flowSessionBinaryId: shot } } : {})
      }
    })
  };
}

function liveWorld(overrides = {}) {
  const world = {
    rowCreated: "2026-10-02T01:00:00Z",
    sessions: [{ flowsessionid: "session-42", createdon: "2026-10-02T01:00:20Z", completedon: null }],
    pendingRows: [],
    logs: {
      "session-42": [
        { type: 100000400, createdon: "2026-10-02T01:00:21Z", data: JSON.stringify({ sessionContext: { conversationId: "conv-42" } }) },
        actionLog({ at: "2026-10-02T01:00:30Z", explanation: "I can see the Claims Workstation sign-in screen. I'll click Sign in.", shot: "shot-1" }),
        actionLog({ at: "2026-10-02T01:00:40Z", explanation: undefined, action: "Type", shot: "shot-2" })
      ]
    },
    receipt: null,
    requests: [],
    ...overrides
  };
  world.respond = (options) => {
    const path = decodeURIComponent(options.path);
    world.requests.push(path);
    if (options.method === "POST") return { crcce_claimrequestid: "row-test-42", createdon: world.rowCreated };
    const nav = /flowsessions\(([^)]+)\)\/flowsession_flowlog_parentobjectid/.exec(path);
    if (nav) return { value: world.logs[nav[1]] || [] };
    if (path.includes("/flowsessions?")) return { value: world.sessions };
    if (path.includes("/crcce_claimrequests?")) return { value: world.pendingRows };
    if (path.includes("/crcce_claimrequests(")) {
      return world.receipt ? { crcce_handoffreceipt: JSON.stringify(world.receipt) } : {};
    }
    throw new Error(`Unexpected offline request: ${path}`);
  };
  return world;
}

const receiptFor = (conversation, responses = ["Claim CLM-2026-001234 has been filed."]) => ({
  definition_version: "2.0.0", trigger_row_id: "row-test-42",
  conversation_id: conversation, flow_run_id: "flow-run-42", responses
});

test("live progress shows the agent's own logged explanations and exact screenshots, never scripted narration", async (t) => {
  const world = liveWorld();
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, world.respond);
  const started = await start({ callContext, lang: "en", regionId: undefined });
  const result = (await progress(started.jsonBody.runId)).jsonBody;
  const runId = encodeURIComponent(started.jsonBody.runId);

  assert.equal(result.status, "running");
  assert.equal(result.activity.state, "attributed");
  assert.deepEqual(result.steps, [
    {
      index: 0,
      explanation: "I can see the Claims Workstation sign-in screen. I'll click Sign in.",
      action: "LeftClick",
      application: "Claims",
      at: "2026-10-02T01:00:30Z",
      screenshotUrl: `/api/cua-run/${runId}/shot/shot-1`
    },
    {
      index: 1,
      explanation: null,
      action: "Type",
      application: "Claims",
      at: "2026-10-02T01:00:40Z",
      screenshotUrl: `/api/cua-run/${runId}/shot/shot-2`
    }
  ]);
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /secure Windows 365 Cloud PC is starting|Fixed tool instruction/);
});

test("activity is not attributed while another handoff is still pending", async (t) => {
  const world = liveWorld({ pendingRows: [{ crcce_claimrequestid: "row-other" }] });
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, world.respond);
  const started = await start({ callContext, lang: "en" });
  const result = (await progress(started.jsonBody.runId)).jsonBody;

  assert.equal(result.status, "running");
  assert.equal(result.activity.state, "unattributed");
  assert.match(result.activity.message, /cannot be attributed/);
  assert.deepEqual(result.steps, []);
});

test("activity is not attributed when two conversations started after this handoff", async (t) => {
  const world = liveWorld();
  world.sessions.push({ flowsessionid: "session-other", createdon: "2026-10-02T01:00:25Z", completedon: null });
  world.logs["session-other"] = [actionLog({ conversation: "conv-other", at: "2026-10-02T01:00:35Z", explanation: "Someone else's run." })];
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, world.respond);
  const started = await start({ callContext, lang: "en" });
  const result = (await progress(started.jsonBody.runId)).jsonBody;

  assert.equal(result.activity.state, "unattributed");
  assert.deepEqual(result.steps, []);
});

test("a later competing run does not change an attribution already made", async (t) => {
  const world = liveWorld();
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, world.respond);
  const started = await start({ callContext, lang: "en" });
  await progress(started.jsonBody.runId);
  world.pendingRows = [{ crcce_claimrequestid: "row-later" }];
  world.sessions.push({ flowsessionid: "session-later", createdon: "2026-10-02T01:02:00Z", completedon: null });
  world.logs["session-later"] = [actionLog({ conversation: "conv-later", at: "2026-10-02T01:02:05Z", explanation: "Another run." })];
  const result = (await progress(started.jsonBody.runId)).jsonBody;

  assert.equal(result.activity.state, "attributed");
  assert.deepEqual(result.steps.map((s) => s.explanation), [
    "I can see the Claims Workstation sign-in screen. I'll click Sign in.", null
  ]);
});

test("the receipt verifies the shown conversation and reports release separately from the claim", async (t) => {
  const world = liveWorld();
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, world.respond);
  const started = await start({ callContext, lang: "en" });
  await progress(started.jsonBody.runId);

  world.receipt = receiptFor("conv-42");
  const submitted = (await progress(started.jsonBody.runId)).jsonBody;
  assert.equal(submitted.status, "succeeded");
  assert.equal(submitted.claimId, "CLM-2026-001234");
  assert.equal(submitted.activity.state, "verified");
  assert.equal(submitted.steps.length, 2);
  assert.deepEqual(submitted.release, { state: "pending" });

  world.sessions[0] = { ...world.sessions[0], completedon: "2026-10-02T01:08:00Z", errorcode: "SessionHasLoggedOff", statuscode: 8 };
  const released = (await progress(started.jsonBody.runId)).jsonBody;
  assert.deepEqual(released.release, { state: "released", at: "2026-10-02T01:08:00Z" });
});

test("a session that ends without a logged sign-out is not reported as released", async (t) => {
  const world = liveWorld();
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, world.respond);
  const started = await start({ callContext, lang: "en" });
  await progress(started.jsonBody.runId);

  world.receipt = receiptFor("conv-42");
  world.sessions[0] = { ...world.sessions[0], completedon: "2026-10-02T01:08:00Z", errorcode: null, statuscode: 4 };
  const ended = (await progress(started.jsonBody.runId)).jsonBody;
  assert.deepEqual(ended.release, { state: "ended", at: "2026-10-02T01:08:00Z" });
});

test("a receipt for a different conversation withdraws the shown activity but keeps the claim", async (t) => {
  const world = liveWorld();
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, world.respond);
  const started = await start({ callContext, lang: "en" });
  assert.equal((await progress(started.jsonBody.runId)).jsonBody.steps.length, 2);

  world.receipt = receiptFor("conv-somewhere-else");
  const result = (await progress(started.jsonBody.runId)).jsonBody;
  assert.equal(result.status, "succeeded");
  assert.equal(result.claimId, "CLM-2026-001234");
  assert.equal(result.activity.state, "mismatch");
  assert.deepEqual(result.steps, []);
  assert.deepEqual(result.release, { state: "unknown" });
});

test("an unattributed run is attributed exactly by the receipt's conversation", async (t) => {
  const world = liveWorld({ pendingRows: [{ crcce_claimrequestid: "row-other" }] });
  world.sessions.push({ flowsessionid: "session-other", createdon: "2026-10-02T01:00:25Z", completedon: null });
  world.logs["session-other"] = [actionLog({ conversation: "conv-other", at: "2026-10-02T01:00:35Z", explanation: "Someone else's run." })];
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, world.respond);
  const started = await start({ callContext, lang: "en" });
  assert.equal((await progress(started.jsonBody.runId)).jsonBody.activity.state, "unattributed");

  world.receipt = receiptFor("conv-42");
  const result = (await progress(started.jsonBody.runId)).jsonBody;
  assert.equal(result.activity.state, "verified");
  assert.equal(result.steps.length, 2);
  assert.ok(result.steps.every((s) => s.explanation !== "Someone else's run."));
});

// "Execute Agent and wait" can return before a Computer Use run finishes, with no
// responses yet (seen live 2026-10-02). The receipt then only identifies the conversation.

test("a receipt saved before the agent replies verifies the conversation and keeps the run going", async (t) => {
  const world = liveWorld({ receipt: receiptFor("conv-42", []) });
  const { start, progress, errors } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, world.respond);
  const started = await start({ callContext, lang: "en" });
  const result = (await progress(started.jsonBody.runId)).jsonBody;

  assert.equal(result.status, "running");
  assert.equal(result.claimId, null);
  assert.equal(result.activity.state, "verified");
  assert.equal(result.steps.length, 2);
  assert.equal(errors.length, 0);
});

test("the claim number comes from the verified conversation's own logged confirmation when the receipt has none", async (t) => {
  const world = liveWorld({ receipt: receiptFor("conv-42", []) });
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, world.respond);
  const started = await start({ callContext, lang: "en" });
  assert.equal((await progress(started.jsonBody.runId)).jsonBody.status, "running");

  world.logs["session-42"].push(filedLine("CLM-2026-004321"), filedLine("CLM-2026-004321", "2026-10-02T01:05:10Z"));
  const result = (await progress(started.jsonBody.runId)).jsonBody;
  assert.equal(result.status, "succeeded");
  assert.equal(result.claimId, "CLM-2026-004321");
  assert.equal(result.activity.state, "verified");
  assert.deepEqual(result.release, { state: "pending" });
});

test("a claim number in activity not yet verified by the receipt is not reported", async (t) => {
  const world = liveWorld();
  world.logs["session-42"].push(filedLine("CLM-2026-004321"));
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, world.respond);
  const started = await start({ callContext, lang: "en" });
  const result = (await progress(started.jsonBody.runId)).jsonBody;

  assert.equal(result.status, "running");
  assert.equal(result.claimId, null);
  assert.equal(result.activity.state, "attributed");
});

for (const [name, change] of [
  ["ends without a logged claim number", (world) => {
    world.sessions[0] = { ...world.sessions[0], completedon: "2026-10-02T01:08:00Z", errorcode: "SessionHasLoggedOff" };
  }],
  ["logs conflicting claim numbers", (world) => {
    world.logs["session-42"].push(filedLine("CLM-2026-004321"), filedLine("CLM-2026-009999", "2026-10-02T01:05:10Z"));
  }]
]) {
  test(`a verified session that ${name} is reported as unverifiable, not guessed`, async (t) => {
    const world = liveWorld({ receipt: receiptFor("conv-42", []) });
    change(world);
    const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, world.respond);
    const started = await start({ callContext, lang: "en" });
    const result = (await progress(started.jsonBody.runId)).jsonBody;

    assert.equal(result.status, "failed");
    assert.equal(result.claimId, null);
    assert.match(result.errorMessage, /do not submit another handoff/);
  });
}

// Seen live 2026-10-02 08:11 UTC: the agent answered with a text summary and never
// called Computer Use, so no session ever appeared for its conversation.
test("an agent reply with no claim and no Computer Use session is reported as not filed", async (t) => {
  const world = liveWorld({ sessions: [], receipt: receiptFor("conv-42", ["Here is a structured summary of the claim."]) });
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1", CUA_NO_ACTIVITY_GRACE_MS: "0" }, world.respond);
  const started = await start({ callContext, lang: "en" });
  const result = (await progress(started.jsonBody.runId)).jsonBody;

  assert.equal(result.status, "failed");
  assert.equal(result.claimId, null);
  assert.equal(result.activity.state, "unavailable");
  assert.match(result.errorMessage, /without using Computer Use/);
  assert.match(result.errorMessage, /do not submit another handoff/);
});

for (const [name, overrides, env] of [
  ["within the grace period", { receipt: receiptFor("conv-42", ["Here is a structured summary of the claim."]) }, {}],
  ["when the receipt has no reply yet", { receipt: receiptFor("conv-42", []) }, { CUA_NO_ACTIVITY_GRACE_MS: "0" }]
]) {
  test(`a receipt with no Computer Use session yet keeps waiting ${name}`, async (t) => {
    const world = liveWorld({ sessions: [], ...overrides });
    const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1", ...env }, world.respond);
    const started = await start({ callContext, lang: "en" });
    const result = (await progress(started.jsonBody.runId)).jsonBody;

    assert.equal(result.status, "running");
    assert.equal(result.activity.state, "unavailable");
  });
}

test("repeated log rows for the same model message appear once and keep their order across polls", async (t) => {
  const world = liveWorld();
  const last = actionLog({ at: "2026-10-02T01:07:00Z", explanation: "Signing out to release the Cloud PC.", message: "msg-final", type: 100000401 });
  world.logs["session-42"].push(last, { ...last, type: 100000402, createdon: "2026-10-02T01:07:01Z" });
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1" }, world.respond);
  const started = await start({ callContext, lang: "en" });
  const first = (await progress(started.jsonBody.runId)).jsonBody.steps;
  const second = (await progress(started.jsonBody.runId)).jsonBody.steps;

  assert.equal(first.length, 3);
  assert.deepEqual(second, first);
  assert.equal(first[2].explanation, "Signing out to release the Cloud PC.");
});

test("the offline simulation is labelled and never presents its script as an explanation", async (t) => {
  const { start, progress } = loadStart(t, { CUA_PROGRESS_MOCK: "1" });
  const started = await start({ callContext, lang: "en" });
  t.mock.method(Date, "now", () => Number(/^run-(\d+)-/.exec(started.jsonBody.runId)[1]) + 80_000);
  const result = (await progress(started.jsonBody.runId)).jsonBody;

  assert.equal(result.simulated, true);
  assert.ok(result.steps.length > 0);
  assert.ok(result.steps.every((s) => s.explanation === null && typeof s.note === "string"));
});

// ---------------------------------------------------------------------------
// Release QA R6 (8 Oct 2026): only the agent's documented completion line,
// "Claim CLM-YYYY-NNNNNN has been filed", from this exact handoff's receipt or
// receipt-verified conversation proves a new claim. A mention of a number does not.
// Anything that cannot be proven is reported as uncertain, so no blind retry.
// ---------------------------------------------------------------------------
const filedLine = (id, at = "2026-10-02T01:05:00Z") => actionLog({
  at, message: `msg-filed-${id}`,
  // Phrasing as logged in the reference runs of 7 October 2026.
  explanation: `**mental_note** Claim ${id} has been filed, now releasing the workstation by signing out.`
});

async function progressFor(t, world, env = {}) {
  const { start, progress } = loadStart(t, { CUA_REQUIRE_REAL_RESULT: "1", ...env }, world.respond);
  const started = await start({ callContext, lang: "en" });
  return (await progress(started.jsonBody.runId)).jsonBody;
}

for (const [name, responses] of [
  ["mentions only an earlier claim on the policy", ["The policy already has claim CLM-2024-000111 on file. Filing status uncertain: check the Claims Workstation before any retry."]],
  ["says the claim was not filed", ["Claim CLM-2026-001234 has not been filed."]],
  ["says Submit was clicked but no number was seen", ["Submit Claim clicked, claim number not seen"]],
  ["both reports a filing and a failure", ["Claim CLM-2026-001234 has been filed", "Filing failed: UNKNOWN"]]
]) {
  test(`an agent reply that ${name} is not a filed claim and is reported as uncertain`, async (t) => {
    const result = await progressFor(t, liveWorld({ receipt: receiptFor("conv-42", responses) }));
    assert.equal(result.status, "failed");
    assert.equal(result.claimId, null);
    assert.equal(result.outcome, "uncertain");
    assert.match(result.errorMessage, /do not submit another handoff/);
  });
}

test("an agent reply 'Filing failed: CODE' is a definite failure that may be retried", async (t) => {
  const result = await progressFor(t, liveWorld({ receipt: receiptFor("conv-42", ["Filing failed: POLICY_NOT_FOUND"]) }));
  assert.equal(result.status, "failed");
  assert.equal(result.claimId, null);
  assert.equal(result.outcome, undefined);
  assert.match(result.errorMessage, /POLICY_NOT_FOUND/);
});

test("the documented completion line in the reply still returns the claim at once", async (t) => {
  const result = await progressFor(t, liveWorld({ receipt: receiptFor("conv-42", ["Claim CLM-2026-001234 has been filed"]) }));
  assert.equal(result.status, "succeeded");
  assert.equal(result.claimId, "CLM-2026-001234");
});

for (const [name, explanation] of [
  ["an earlier claim on the policy", "The policy history lists claim CLM-2024-000111 from last year."],
  ["a plan to report the number", "After Submit I will report Claim CLM-2026-000000 has been filed? Not yet: the review page is still open."],
  ["a negated filing", "Claim CLM-2026-004321 has not been filed yet; the review page is still open."],
  ["an earlier claim in the documented words", "Claim CLM-2024-000111 has been filed previously on this policy, so I will now file the new one."]
]) {
  test(`with an early receipt, a log line naming ${name} does not finish the run`, async (t) => {
    const world = liveWorld({ receipt: receiptFor("conv-42", []) });
    world.logs["session-42"].push(actionLog({ at: "2026-10-02T01:04:00Z", message: "msg-mention", explanation }));
    const result = await progressFor(t, world);
    assert.equal(result.status, "running");
    assert.equal(result.claimId, null);
  });
}

test("with an early receipt, the verified conversation's completion line returns the claim at once", async (t) => {
  const world = liveWorld({ receipt: receiptFor("conv-42", []) });
  world.logs["session-42"].push(filedLine("CLM-2026-004321"));
  const result = await progressFor(t, world);
  assert.equal(result.status, "succeeded");
  assert.equal(result.claimId, "CLM-2026-004321");
  assert.equal(result.activity.state, "verified");
});

// Spec review of the R6 fix (8 Oct 2026): the documented words inside a condition, a question,
// a plan or a history note are not the agent stating that it filed a claim.
const hedged = [
  "If Claim CLM-2026-000123 has been filed, stop.",
  "Check whether Claim CLM-2026-000123 has been filed.",
  "I will state Claim CLM-2026-000123 has been filed.",
  "Not sure Claim CLM-2026-000123 has been filed.",
  "Policy history: Claim CLM-2025-000123 has been filed."
];
for (const sentence of hedged) {
  test(`a log line "${sentence}" does not finish the run`, async (t) => {
    const world = liveWorld({ receipt: receiptFor("conv-42", []) });
    world.logs["session-42"].push(actionLog({ at: "2026-10-02T01:04:00Z", message: "msg-hedged", explanation: sentence }));
    const result = await progressFor(t, world);
    assert.equal(result.status, "running");
    assert.equal(result.claimId, null);
  });
  test(`a reply "${sentence}" is uncertain, not a filed claim`, async (t) => {
    const result = await progressFor(t, liveWorld({ receipt: receiptFor("conv-42", [sentence]) }));
    assert.equal(result.claimId, null);
    assert.equal(result.outcome, "uncertain");
  });
}

// Every completion line logged in the reference runs of 7 October 2026 still counts.
for (const line of [
  "**mental_note** Claim CLM-2024-007004 has been filed, now releasing the workstation by signing out.",
  "**mental_note**: Claim CLM-2024-007005 has been filed successfully. Confirmation dialog shows claim submitted.",
  "**Claim CLM-2024-007005 has been filed, now releasing the workstation by clicking OK on the confirmation dialog.",
  "The new claim ID is now displayed in the \"Claim ID (after submission)\" field. Claim CLM-2024-007005 has been filed, now releasing the workstation by signing out.",
  "I'll press Windows+R to open the Run dialog.\n\nClaim CLM-2024-007004 has been filed, now releasing the workstation.",
  "Claim CLM-2024-007004 has been filed"
]) {
  test(`the reference completion line "${line.slice(0, 50)}..." returns its claim`, async (t) => {
    const world = liveWorld({ receipt: receiptFor("conv-42", []) });
    world.logs["session-42"].push(actionLog({ at: "2026-10-02T01:05:00Z", message: "msg-real", explanation: line }));
    const result = await progressFor(t, world);
    assert.equal(result.status, "succeeded");
    assert.match(result.claimId, /^CLM-2024-00700[45]$/);
  });
}
