# Set up the demo with an AI desktop agent (optional accelerator)

Several steps in this demo are **portal/admin actions** that the build scripts deliberately do not
automate (Power Platform admin toggles, Copilot Studio agent settings, Intune checks, Entra app
registrations). If you use an **AI desktop agent that can drive your browser and shell under your own
signed-in session** — for example **Microsoft Scout** — you can hand most of these off and review the
result, instead of clicking through every blade yourself.

This guide is **optional**. Everything here can be done by hand with the linked docs. It exists
because, in practice, an agent that already has an authenticated admin browser session can knock out
the repetitive portal toggles in a couple of minutes.

> **How it works / why it's safe.** The agent acts **as you**, in **your** already-signed-in browser
> and shell — it is not given your password and gets no standing admin credential of its own. You stay
> in the loop: it shows you what it changed, with screenshots, and you do the final review. Treat it
> like a very fast pair of hands, not an unattended service account.

---

## What an agent can realistically do for you

| Task | Agent can do it? | Notes |
|---|---|---|
| **Computer Use auditability toggles** (Store logs in Dataverse, verbosity = All data, retention = Forever, Send audit logs to Purview) | ✅ Yes | Power Platform admin center → environment → Settings → Product → Features → Computer Use. See [`cua-auditability.md`](./cua-auditability.md) §2. Do it for **each** environment that hosts the agent. |
| **Verify the agent's auth setting** (Authenticate manually, Require users to sign in = OFF) | ✅ Read/verify; ⚠️ changing it is sensitive | Copilot Studio → agent → Settings → Security. The agent can confirm the current state and walk you through any change. |
| **Confirm the Computer Use tool points at your W365A pool** | ✅ Yes | Copilot Studio → agent → Tools → Computer Use. |
| **Check Intune delivery** (claims.exe Win32 app assigned + installed on the pool; CCaaS Edge web app assigned to the human) | ✅ Yes | Intune admin center, or via Microsoft Graph if the agent has Intune app permissions. |
| **Run the build/deploy scripts** (`Build-DemoFromScratch.ps1`, etc.) | ✅ Yes | The agent can run these in your shell and read back the output/errors. |
| **Create the Entra app registrations** (desktop SPA sign-in; agent "Authenticate manually" app) | ⚠️ Only if you grant it rights | Creating app registrations needs Entra admin. Usually faster for you to create them and hand the agent the client/tenant ids. |
| **Flip the GitHub repo to public, billing/licensing purchases, anything spending money or with broad blast radius** | ❌ Leave to a human | Keep these as explicit human decisions. |

---

## A good prompt to give the agent

Paste something like this, then **review what it reports before each save**. Replace the bracketed
values.

```text
You are helping me set up the CCaaS / Windows 365 for Agents demo (repo: CCaaSDemoApp). Act as me in
my already-signed-in browser and shell — do not ask me for a password, and show me what you change.

Context:
- My demo runs in the Power Platform environment(s): [e.g. "Zava CCaaS Demo" (AU) and "Zava CCaaS Demo US"].
- The Copilot Studio agent is: [e.g. "Zava Claims Intake (CUA)"].
- Reference docs are in the repo under docs/ — especially docs/cua-auditability.md and docs/build-the-agent.md.

Please do the following, pausing to show me the state before you save each change:

1. Computer Use auditability — in the Power Platform admin center, for EACH environment above:
   Manage > Environments > [env] > Settings > Product > Features > Computer Use. Set:
     - Store logs in Dataverse = On
     - "Allow conversation transcripts ... saved in Dataverse" = checked
     - Computer use logs verbosity = All data
     - Log retention time = Forever
     - Send audit logs to Microsoft Purview = On
   Save, then re-read the page and confirm each value persisted. Capture a screenshot of each env.

2. Verify (read-only) the Copilot Studio agent's Settings > Security:
   Authentication = "Authenticate manually", and "Require users to sign in" = Off.
   Report the current values; do NOT change them without checking with me first.

3. Verify the Computer Use tool is pointed at my Windows 365 for Agents Cloud PC pool, and that
   claims.exe is assigned + installed on that pool via Intune. Report findings.

Give me a short summary table of what you found, what you changed, and anything that needs my
attention (e.g. app registrations, billing, or anything you couldn't safely do yourself).
```

Tighten or loosen the scope to taste. Keeping "pause and show me before each save" in the prompt is
what keeps you in control.

---

## What to keep for yourself

- **App registrations and consent** (the desktop SPA app, the agent's "Authenticate manually" app) —
  these need Entra admin; it's usually cleaner to create them yourself and hand the agent the ids.
- **Anything that spends money** (Copilot Studio / Windows 365 for Agents billing policies).
- **Making the repo public** and other one-way doors.

Everything else in the [setup runbook](./demo-environment-setup.md) and
[build-the-agent](./build-the-agent.md) guide is fair game to delegate, with your review.
