# Copilot Studio entitlement for a durable demo (read before you build the agent)

The handoff backend invokes your **published Copilot Studio agent** programmatically over the
**Bot Framework Direct Line API** (it copies a **Direct Line secret** from the agent's channel
settings). Publishing to the **Direct Line / custom website / native (mobile) app** channels is
**premium Copilot Studio usage**. In a tenant with no Copilot Studio entitlement, Copilot Studio
shows a gate instead of the channel:

```text
Get the premium experience
Start a 60-days free trial to access premium Microsoft Copilot Studio features
```

**The 60-day trial is not a durable answer.** This demo is meant to be reused for many months
across partners/customers, so it must not depend on a trial that expires. This page documents the
durable options and the one we recommend.

> There is **no separate "Direct Line" SKU** for this channel path. The durable requirement is that
> the agent's environment has **licensed/billed Copilot Studio capacity**; every interaction and
> action then consumes **Copilot Credits**. Get that capacity once and the trial prompt goes away.

---

## TL;DR / quickstart (validate in this order)

Most demo setups (your own demo tenant where you are admin, with an Azure subscription already
linked) only need this:

1. **Test first — you may already be entitled.** In Copilot Studio, open the agent ->
   **Settings -> Security -> Channels -> Direct Line**.
   - **PASS:** the channel opens and shows **Secret keys** (no "60-days free trial" prompt) ->
     you are already entitled. **Skip the rest of this page** and continue at
     [build-the-agent.md step 6](build-the-agent.md#6-publish-then-copy-the-direct-line-secret).
   - **FAIL:** you see *"Start a 60-days free trial"* -> set up pay-as-you-go (step 2).
2. **Set up pay-as-you-go billing** (one-time, ~5 min): follow
   [Recommended: pay-as-you-go](#recommended-copilot-studio-pay-as-you-go-payg-billed-to-an-azure-subscription)
   below. This links your environment to an Azure subscription so the channel is no longer gated.
3. **Re-test step 1.** It should now **PASS**. If it still fails, work the
   [troubleshooting checklist](#if-the-channel-still-shows-the-trial-prompt).

**Cost at your volume** (2-3 demos/month, a few hours each): a few **dollars per month at most** in
Copilot Credits - comfortably inside a typical MSDN/Visual Studio Azure monthly credit. Set an Azure
budget alert and you never have to think about it.

---

## Recommended: Copilot Studio pay-as-you-go (PAYG), billed to an Azure subscription

This is the recommended durable path because it **preserves the verified architecture** (Durable
Functions -> published agent -> Direct Line), has **no upfront commitment and no trial**, and costs
only **cents per demo run** at demo volume. You link the agent's **Power Platform environment** to
an **Azure subscription** with a *billing plan*; Copilot Credits are then billed per use (about
**$0.01 / credit**) on your normal Azure bill.

### Before you start (prerequisites the billing plan does NOT cover)

PAYG covers **usage billing only**. You still need all of the following, or the channel can stay
gated even after billing is linked:

- The **agent lives in the environment you are about to link** (not the `default` environment, and
  the same environment you built the agent in - see [build-the-agent.md](build-the-agent.md)).
- That environment is a **production or sandbox** environment (PAYG is not available for the
  default/Teams environments).
- You can create/link a **billing plan**: you are an **Environment admin**, **Power Platform
  admin**, **Dynamics 365 admin**, or **Global admin**.
- The **maker** account that publishes the agent has **Copilot Studio author access** in that
  environment.
- You have an **Azure subscription in the same tenant** and enough Azure permission (Owner/
  Contributor on a resource group, and the ability to register resource providers).

### Steps (one-time, ~5 minutes)

1. Sign in to the **Power Platform admin center**: <https://admin.powerplatform.microsoft.com>.
2. In the left nav, select **Licensing** -> **Pay-as-you-go plans** -> **New billing plan**.
3. Choose **Azure subscription**, give the plan a **name**, then pick the **Azure subscription** and
   a **resource group** to bill against. (Create a resource group in the
   [Azure portal](https://portal.azure.com) first if the subscription has none.)
4. Under **Power Platform products**, include the **Copilot Studio** meter.
5. **Next** -> select your **region** -> tick the **environment that holds your agent** -> **Save**.
6. Back in **Copilot Studio**, reopen the agent and go to **Settings -> Security -> Channels**.
   Allow a few minutes for the change to propagate. The **Direct Line / Web / Mobile app** channel
   should now be available **without** the 60-day-trial prompt, so you can publish and copy the
   **Direct Line secret** (see [build-the-agent.md step 6](build-the-agent.md#6-publish-then-copy-the-direct-line-secret)).

### If the channel still shows the trial prompt

After linking PAYG, if the channel still shows the trial prompt: confirm you linked **the same
environment** that contains the agent, that it is **production/sandbox**, that your maker has
**Copilot Studio author access**, and **wait for admin-center propagation** (re-open Copilot
Studio / sign out and back in).

### What it costs (Copilot Studio credits only)

Billing rates (Microsoft Learn, *Billing rates and management*): a **generative answer** is
**2 credits**, and an **agent action - which is how the Computer Use / computer-using agent is
billed - is 5 credits**. A single demo claim is on the order of tens of credits, i.e. **cents**; a
month of demos is typically a **few dollars**.

> This estimate is **Copilot Studio credits only**. It **excludes** the separate costs of the
> **Windows 365 for Agents Cloud PC pool**, **Azure Functions / Storage / monitoring**, and any
> preview/program entitlement. Set an **Azure budget / spending limit + alert** on the subscription
> so demo usage can never surprise you.

---

## Also required: a Windows 365 for Agents **pool billing policy** (separate meter, issue #77)

The Copilot Studio entitlement above unblocks the **Direct Line channel**. It does **not** pay for
the **Computer Use Cloud PC pool** that actually drives `claims.exe`. These are **two different
meters and you need both** — getting the trial prompt to disappear does *not* mean the pool can run.

Without a **Windows 365 for Agents pay-as-you-go billing policy** attached to the environment, the
pool runs as a **Trial**:

- the machine group shows **0 machines / 0 runs**,
- Computer Use **never launches a session** (it fails with a generic `SystemError` before it queues
  a run), and
- the handoff connects, the agent fires, but it **times out at `ready`** with no result.

**M365 E5 / Copilot licensing does not cover this.** Per Microsoft Learn,
[Use a Cloud PC pool](https://learn.microsoft.com/en-us/microsoft-copilot-studio/use-cloud-pc-pool),
the pool "uses a **consumptive pay-as-you-go meter that bills your Azure subscription**." The free
eval (up to two pools / **50 hours** for published agents, not billable from the embedded test chat)
is **not durable** for a reusable demo. (For the MCS Declarative Agent path this demo uses,
**billing is attached through a billing policy**; the Agent 365 SDK path attaches it via Intune
provisioning-policy linkage instead.)

### Attach it (admin/billing action — commits Azure spend)

1. **Power Platform admin center** → **Licensing** → **Pay-as-you-go plans** → your billing plan
   (reuse the plan from the Copilot Studio steps above, or create one the same way).
2. Under **Power Platform products**, include the **Windows 365 / Hosted RPA (Windows 365 for
   Agents)** meter in addition to Copilot Studio, then bind the **environment that holds the agent**
   → **Save**. It bills the **linked Azure subscription** (PAYG: **$0.40/hr** of agent runtime).
3. **Set always-available in Intune (not Copilot Studio).** The always-available count lives in the
   **Windows 365 provisioning policy**, not the Power Platform billing screen: **Intune admin center →
   Devices → Provision Cloud PCs → Provisioning policies (Agents) → Create policy → General** → pick the
   **Billing plan** and set **"Always available Cloud PCs"** = **1** (range 1–200; ~$5/Cloud PC/month).
   A live demo cannot tolerate cold start, so keep at least one always-available Cloud PC rather than
   scale-to-zero. Provisioning a Cloud PC takes ~20–30 min. See
   [`w365a-pool.md` → Cost](w365a-pool.md#cost).
4. Re-run a **real (non-simulated)** handoff and confirm the machine group now shows a
   **queued/running** session and the handoff reaches **`submitted`**.

> Symptom-to-fix: a healthy/Ready pool with **0 runs ever** + `SystemError` is the Trial-pool
> signature — see [`w365a-pool.md` → pool healthy but Computer Use never runs](w365a-pool.md#if-the-pool-is-healthy-but-computer-use-never-runs-handoff-times-out-at-ready).

---

## Alternative durable paths

### Copilot Studio capacity pack (prepaid subscription)

If you prefer **predictable monthly billing** over consumption billing, buy a Copilot Studio
**capacity pack** (about **$200 / month / tenant** for 25,000 Copilot Credits, prepaid, no
rollover). It satisfies the same premium requirement as PAYG. For a demo that runs intermittently,
PAYG is usually far cheaper; choose a pack only if you also have steady production usage.

### Visual Studio / MSDN subscription with monthly Azure credits

A Visual Studio / MSDN subscription provides monthly Azure credits on a dev/test Azure subscription,
and that subscription may appear as a selectable target when you create the PAYG billing plan above.
Two caveats:

- **Don't assume the credits offset the Copilot Studio meter.** Azure credit eligibility varies by
  meter and offer; Power Platform / Copilot Studio PAYG may bill against the monthly credit, or it
  may not be credit-eligible and bill out-of-pocket (which also means hitting the subscription's
  monthly spending limit can suspend services). After a test run, **verify in Azure Cost
  Management** which it was, and keep an **Azure budget alert** in place.
- **Visual Studio Azure credits are for the subscriber's own dev/test**, per the subscription use
  terms - not for production or customer-facing workloads. Using them to *build and test* the demo
  is fine; if the demo becomes a durable, customer/partner-facing fixture, switch that billing plan
  to an Azure subscription approved for ongoing billing in your organization (a standard
  pay-as-you-go subscription, or a sponsored/internally-billed one where permitted) to stay within
  terms and avoid surprise suspensions. The cost is only cents per run either way.

### Internal / partner demo entitlement

Some Microsoft or partner **demo tenants and internal programs** already include suitable Copilot
Studio entitlement (so the premium gate may simply not appear). This repo **cannot validate or
document those programs** - confirm availability, the request path, and the duration with your
tenant or program owner. If your demo tenant already has entitlement, you can skip PAYG entirely.

---

## Last-resort fallback: avoid the premium channel (changes the architecture)

If you genuinely cannot obtain any durable entitlement, you can still **show the agent** without a
premium channel by driving it from the Copilot Studio **Test chat** or a **Teams** channel instead
of Direct Line.

> **Important:** this only unblocks *demonstrating the agent*. It does **not** preserve the verified
> **web-app -> orchestrator -> Direct Line** handoff: the Test chat is not a stable programmatic
> invocation surface, and Teams changes the channel/identity behavior the orchestrator relies on.
> Treat this as a fallback you adopt only if you accept changing the invocation surface. The
> orchestrator already anticipates a different surface via `HANDOFF_CHANNEL` - see
> [handoff-architecture-decision.md](handoff-architecture-decision.md).

---

## Verification checklist (since this can't be lab-tested here)

After setting up PAYG, confirm:

- [ ] The agent **requires authentication** via **Authenticate manually** (Settings → Security →
  Authentication → *Authenticate manually*, **not** *No authentication* and **not** *Authenticate with
  Microsoft* — which disconnects Direct Line) **with *Require users to sign in* = OFF** (so the headless
  orchestrator isn't sent an OAuth card), and the **Computer Use tool set to *Maker-provided
  credentials*** — **Computer Use is disabled for unauthenticated agents**.
- [ ] The billing plan links the **same environment** that contains the agent.
- [ ] The **trial prompt is gone** when you reopen **Settings -> Security -> Channels**.
- [ ] You can open the **Direct Line / Web / Mobile app** channel and copy a **Direct Line secret**.
- [ ] A **Windows 365 for Agents pool billing policy** is attached to the environment (issue #77),
      **always-available (min 1 Cloud PC, ~$5/mo)** is selected, and the machine group shows **≥1
      machine** (not the **Trial** "0 machines / 0 runs" state).
- [ ] The orchestrator can **start a Direct Line conversation** against the **published** agent
      (the build's smoke test, or `apps/handoff-orchestrator` locally).
- [ ] After a test run, **Azure Cost Management** shows Power Platform / Copilot Studio meter
      activity (and, if relevant, whether credits covered it).
- [ ] An **Azure budget / spending alert** is configured on the subscription.

---

*Sources: Microsoft Learn - "Set up a pay-as-you-go plan" (Power Platform admin) and "Billing rates
and management" (Copilot Studio). Public licensing docs only.*
