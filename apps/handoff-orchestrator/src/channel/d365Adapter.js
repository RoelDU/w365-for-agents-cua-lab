/*
 * d365Adapter.js - placeholder for the FUTURE Dynamics 365 Contact Center swap.
 *
 * IMPORTANT: when the CCaaS layer is Dynamics 365 Contact Center, there is NO
 * custom adapter to build. D365 CC connects to the SAME published Copilot Studio
 * agent through its first-class NATIVE Omnichannel channel: routing, hold/resume,
 * the conversation timeline, and wrap-up are all native, and context arrives as
 * msdyn_* variables mapped onto the agent's neutral global variables. Most of the
 * Zava custom plumbing (this orchestrator's Direct Line conversation, durable job
 * store, status polling) is replaced by D365 native capabilities.
 *
 * This stub exists so the factory can name the option and fail loudly with a
 * pointer to the design doc, rather than silently behaving like Direct Line.
 * See docs/handoff-architecture-decision.md (D13).
 */

"use strict";

class D365ChannelAdapter {
  constructor() {
    throw new Error(
      "Dynamics 365 Contact Center uses its NATIVE Copilot Studio Omnichannel " +
        "channel - there is no custom Direct Line adapter to run here. Connect the " +
        "same published agent to the D365 CC workstream and map msdyn_* context to " +
        "the agent's global variables. See docs/handoff-architecture-decision.md."
    );
  }
}

module.exports = { D365ChannelAdapter };
