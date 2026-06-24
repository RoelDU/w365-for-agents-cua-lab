# Support

How to get help with this project.

## Documentation first

Most questions are answered in the docs. Check these before opening
an issue:

- **[`README.md`](./README.md)** — what this is, how to set it up, how
  to run the demo end-to-end (Quick Start, Steps 1–8).
- **[`docs/demo-flow.md`](./docs/demo-flow.md)** — the narrated
  partner-demo walkthrough with timings and failure-mode talking tracks.
- **[`docs/BUILD.md`](./docs/BUILD.md)** — step-by-step build-from-source
  guide (for the current pre-release phase).
- **Per-app `README.md`** in each `apps/*/` folder — app-specific
  details, build commands, smoke tests.
- **`apps/legacy-claims-workstation/samples/foundry-agent/README.md`** —
  agent setup, model recommendations, demo-day tips
  (connection refresh, disabling web search).

## Reporting bugs

Open a [bug report issue](https://github.com/RoelDU/w365-for-agents-cua-lab/issues/new?template=bug_report.md).
Please include:

- The version / commit hash of the repo or release.
- Which app(s) the bug affects.
- Reproduction steps (as small as possible).
- Expected vs actual behavior.
- Logs or screenshots if relevant.
- The agent platform, model, and Cloud PC configuration if the bug
  involves the agent-driven path.

## Proposing features or new verticals

Open a [feature request issue](https://github.com/RoelDU/w365-for-agents-cua-lab/issues/new?template=feature_request.md).

Particularly welcome:
- **New verticals** (telco billing, utility move-in/out, public-sector
  benefits, retail returns) — the same architecture pattern applied to
  a different legacy app and CCaaS workflow.
- **Additional agent platforms** beyond Foundry / Copilot Studio.
- **Hardening for production-adjacent use** (real Agent365 webhook
  patterns, real CCaaS integrations, real audit shipping).
- **Better evaluation coverage** — additional CSV batches for edge
  cases.

## Asking questions

For "how do I…?" questions that aren't bugs or feature requests:

- **GitHub Discussions** (enable on the repo first) — preferred for
  open-ended questions.
- **Microsoft-internal contacts** — if you're inside Microsoft and
  working on a related WCX / CCaaS / Agent365 motion, reach out via
  the usual internal Teams channels.

## Help with hosting the demo

The agent-driven path requires a Microsoft tenant with Foundry or
Copilot Studio and a W365A Cloud PC. The maintainer cannot grant
access to those — see your Microsoft account team or partner manager.

## Response expectations

This is a community-maintained demonstration project, not a supported
Microsoft product. Best-effort response times:

- Security issues: within 5 business days (see [`SECURITY.md`](./SECURITY.md)).
- Bug reports affecting the documented demo flow: within 10 business
  days.
- Feature requests: triaged when convenient, no SLA.
- Questions on Discussions: as time permits.

If you need supported, guaranteed-response help, this is the wrong
repository — engage your Microsoft account team for product-level
support of Foundry, Copilot Studio, Agent365, or Windows 365.
