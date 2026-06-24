# Security

## Reporting security vulnerabilities

This repository is a **demonstration** project with fictional data only.
It does not connect to real customer systems, real CCaaS providers, real
telephony, real identity backends, or process real personal data.

That said, if you believe you have found a security vulnerability in
this repository — for example, a way the local orchestrator could be
abused, a way the simulated authentication could be bypassed in a way
that would mislead a demo audience about real product security, or any
issue with the released artifacts (`*.zip`, `*.intunewin`) that could
affect machines they are installed on — please report it responsibly.

### How to report

**Do not file a public GitHub issue** for a security report.

Open a [private security advisory](https://github.com/RoelDU/w365-for-agents-cua-lab/security/advisories/new)
on this repository, OR email the maintainer directly (see the GitHub
profile for the repository owner).

If the vulnerability concerns underlying Microsoft products
(Windows 365 Agentic, Agent365, Foundry, Copilot Studio, Computer Use)
rather than this demonstration code, report it to the
[Microsoft Security Response Center (MSRC)](https://msrc.microsoft.com/)
instead.

### What to include

- A clear description of the issue.
- Steps to reproduce, with the smallest possible repro.
- The affected version / commit hash.
- Your assessment of severity and exploitability.
- Optional: a suggested fix or mitigation.

### What to expect

- An acknowledgement within 5 business days.
- A triage decision (accept / decline / need more info) within
  10 business days.
- Coordinated disclosure on a timeline that depends on severity and
  complexity, typically 30–90 days for accepted reports.

## Out of scope

The following are intentional design choices of the demonstration and
are **not** considered security vulnerabilities:

- The PIN-based login in the legacy app is simulated and trivially
  bypassable. This is documented and intentional — the app is a demo,
  not a production system.
- The seed data (customers, policies, claims, transcripts) is
  intentionally realistic-looking but entirely fictional.
- The local orchestrator has no authentication on its HTTP endpoints
  because it is designed to run only on localhost during a demo. The
  documentation explicitly warns against exposing it to the public
  internet.
- The CCaaS desktop's simulated-auth mode does not enforce any real
  identity check. This is the documented default for friction-free
  demos.
