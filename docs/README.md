# Documentation index

Where to look for what.

| You want to… | Read this |
|---|---|
| **Run the simplest live demo next week — the AI files a claim on W365A, no orchestrator/Direct Line** | **[`demo-minimal-path.md`](./demo-minimal-path.md) — the recommended demo path; the orchestrator/Direct Line handoff is Phase 2** |
| Understand what this repo is and how to use the demo end to end | The top-level [`README.md`](../README.md) |
| **Deploy the whole demo from scratch with one script** (central SWA hosting, no lock-in) | [Top-level README → "Deploy the demo"](../README.md#deploy-the-demo) |
| See the end-to-end solution on slides (partner-ready deck) | [`Zava-CCaaS-Demo.pptx`](./Zava-CCaaS-Demo.pptx) |
| Run the partner demo and have a script to follow | [`demo-flow.md`](./demo-flow.md) — narrated walkthrough with cadence variants and failure-mode talking tracks |
| **Demo the backend machinery** (Intune, Copilot Studio, Agent 365, the W365 endpoint) and replay a prior CUA run | [`demo-backend-walkthrough.md`](./demo-backend-walkthrough.md) — the "show me how it works" deep dive |
| **Make the agent auditable** — show the screenshots and reasoning after a run | [`cua-auditability.md`](./cua-auditability.md) — Copilot Studio Activity/Transcript/Session replay + Entra Agent ID / Agent 365 audit trail |
| Build the apps from source (only needed before v1.0 ships) | [`BUILD.md`](./BUILD.md) — step-by-step build guide for a first-time builder |
| Contribute changes back | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Report a security vulnerability | [`../SECURITY.md`](../SECURITY.md) |
| Get help (bug report, feature request, question) | [`../SUPPORT.md`](../SUPPORT.md) |
| Understand the JSON contract between the apps | [`../schemas/README.md`](../schemas/README.md) and the individual schema files |
| Explain to partners how the CCaaS → agentic-AI handover works and how it maps to real platforms + the Microsoft Agent platform | [`agentic-handover-mechanism.md`](./agentic-handover-mechanism.md) — citation-graded mechanism reference |
| Stand up the full in-tenant demo (W365A + CUA + legacy app) — **and check tenant readiness first** | [`demo-environment-setup.md`](./demo-environment-setup.md) — runbook; starts with the [CUA tenant-readiness check](./demo-environment-setup.md#prerequisites--tenant-readiness-check-run-first) |
| **Speed up the manual setup with an AI desktop agent** (hand the portal/admin toggles to Scout, with your review) | [`setup-with-an-ai-agent.md`](./setup-with-an-ai-agent.md) — optional accelerator + a ready-to-paste prompt |
| Package & deploy the demo apps to Windows 365 Enterprise via Intune | [`intune-w365.md`](./intune-w365.md) — Win32 packaging + Cloud PC assignment |
| Build the AI agent (Copilot Studio) | [`build-the-agent.md`](./build-the-agent.md) — step-by-step |
| **Get past the "60-day trial" prompt** when publishing the agent to Direct Line — durable licensing/entitlement | [`licensing-and-entitlement.md`](./licensing-and-entitlement.md) — starts with a PASS/FAIL test, then pay-as-you-go setup |
| Run the legacy app standalone | [`../apps/legacy-claims-workstation/README.md`](../apps/legacy-claims-workstation/README.md) |
| Run the CCaaS desktop standalone | [`../apps/ccaas-agent-desktop/README.md`](../apps/ccaas-agent-desktop/README.md) |
| Use or extend the local orchestrator | [`../samples/local-orchestrator/README.md`](../samples/local-orchestrator/README.md) |
