/*
 * activities.js - Durable Functions ACTIVITIES. All Direct Line I/O happens here
 * (activities may be non-deterministic; orchestrators may not). Each activity
 * builds the channel adapter from server-side config, so the secret is read here
 * - never passed through orchestrator state.
 */

"use strict";

const df = require("durable-functions");
const { getChannelConfig } = require("../config");
const { getAdapter } = require("../channel");

df.app.activity("openConversation", {
  handler: async (input, context) => {
    const adapter = getAdapter(getChannelConfig());
    const { conversationId, watermark, auth } = await adapter.openConversation(input.envelope);
    context.log(
      `openConversation: started ${conversationId} for ${input.envelope.correlation_id}`
    );
    return {
      conversationId,
      watermark: watermark == null ? null : String(watermark),
      auth: auth || null
    };
  }
});

df.app.activity("pollConversation", {
  handler: async (input, context) => {
    const adapter = getAdapter(getChannelConfig());
    const { watermark, result } = await adapter.pollConversation({
      conversationId: input.conversationId,
      watermark: input.watermark,
      correlationId: input.correlationId,
      auth: input.auth
    });
    if (result) {
      context.log(
        `pollConversation: terminal result for ${input.correlationId}: ${result.status}`
      );
    }
    return { watermark: watermark == null ? null : String(watermark), result: result || null };
  }
});
