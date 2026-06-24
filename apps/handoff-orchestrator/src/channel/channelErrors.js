/*
 * channelErrors.js - shared mapping of opaque Copilot Studio / channel HTTP error
 * bodies to clear, actionable orchestrator errors. Used by every channel adapter
 * (Direct Line + Direct-to-Engine) so a misconfigured agent surfaces the SAME
 * unmistakable message regardless of the invocation channel.
 */

"use strict";

/**
 * Map a known error signature in a channel HTTP error body to { code, message }.
 * Returns null when the body matches nothing we recognise.
 */
function describeChannelError(body) {
  const b = String(body || "");

  if (/IntegratedAuthenticationNotSupportedInChannel/i.test(b)) {
    return {
      code: "AUTH_CHANNEL_UNSUPPORTED",
      message:
        'Copilot Studio agent auth is incompatible with this channel: the agent uses ' +
        '"Authenticate with Microsoft" (integrated Teams/M365 auth), which the channel ' +
        'does not support (IntegratedAuthenticationNotSupportedInChannel). Fix on the ' +
        'agent: Settings -> Security -> Authentication -> "Authenticate manually" with ' +
        '"Require users to sign in" OFF, remove the Teams + Microsoft 365 channel, ' +
        'republish, then re-copy the channel token endpoint/secret into the ' +
        'orchestrator settings. See docs/handoff-runbook.md section 10 (auth-vs-channel, #81).'
    };
  }

  // Computer Use refuses to run on a channel that is not in its supported list
  // (it names msteams, pva-engine-direct, pva-studio, pva-maker-evaluation,
  // pva-autonomous). Classic Bot Framework Direct Line ("directline") is NOT in
  // that list, so an orchestrator on Direct Line reaches the Cloud PC but the
  // tool never executes (#112). Tell the operator to switch channels.
  if (
    /Computer-use-ExecuteCUA/i.test(b) ||
    /(supported channels|requires one of the following supported channels)/i.test(b)
  ) {
    return {
      code: "CUA_CHANNEL_UNSUPPORTED",
      message:
        "The Computer Use tool is not supported on this channel. Computer Use only runs " +
        "on msteams, pva-engine-direct, pva-studio, pva-maker-evaluation, or pva-autonomous - " +
        'classic Bot Framework Direct Line ("directline") is NOT supported. Set ' +
        'HANDOFF_CHANNEL=engine (Direct-to-Engine, channel pva-engine-direct) so the ' +
        "orchestrator invokes the agent over a CUA-supported channel. See " +
        "docs/handoff-runbook.md section 10 and issue #112."
    };
  }

  return null;
}

module.exports = { describeChannelError };
