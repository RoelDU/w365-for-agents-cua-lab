# Windows 365 for Agents (W365A) Cloud PC pool — details

This is the deep-dive companion to the short **"How do I create the W365A pool?"** note in
the [README Quick Start](../README.md#quick-start). If you just want the two steps, read that
note. This page explains what each piece is, what the helper automates, and what stays manual.

The pool is where the AI agent's **Computer Use** tool runs — it drives the legacy `claims.exe`
app on a Cloud PC. You create it **inside the agent's Computer Use tool in Copilot Studio (MCS)**.

> **"W365A pool" and "the Cloud PC pool you create in Copilot Studio" are the same thing.**
> You build it in MCS; **Windows 365 for Agents (W365A)** is just the platform powering it. There
> is no separate pool to create elsewhere — in particular, **do not** use the Intune / Agent 365
> "Provisioning policy (Agents)" route, which is a different surface that doesn't match this demo.

> Official Microsoft how-to:
> [Use a Cloud PC pool with Copilot Studio](https://learn.microsoft.com/microsoft-copilot-studio/use-cloud-pc-pool).

> **Step 0 — run the prerequisite checker first (do this before anything else).**
> Community tenant-readiness checker:
> **<https://dweinerhls.github.io/windows365-cua-checker/>** (repo `dweinerhls/windows365-cua-checker`).
> It auto-checks the API-verifiable prereqs (incl. **Pay-As-You-Go billing / Copilot Studio license** —
> an M365 E5 license alone raises a ⚠️ *"no dedicated Copilot Studio license or pay-as-you-go billing
> plan found"* WARN, which is issue **#77**) and lists the **manual** items it *cannot* verify via API:
> cross-geo support, Intune **Allow Windows (MDM)** enrollment restriction, the **Enrollment Status
> Page** (#82), and the **Computer Use tool** bound to the pool. **Re-run it against the *current*
> environment** — toggles set "once" do not survive an environment being recreated or repointed, so a
> prior "verified" note is not proof the live state is still correct. Read what it actually reports
> before debugging anything downstream.

---

## Before you start: a Dataverse environment in your configured geography must exist

The Cloud PC pool is hosted in the **same geography as its Power Platform environment**, so the very
first thing you need is a Dataverse-backed environment in the geography that matches your
`azure.location`. If you have just **deleted an old environment** you may have **zero** environments
and must create one in the right geography before either step below will work:

Power Platform admin center → **Manage → Environments → + New** → set **Region** to the geography that
matches your `azure.location` → add a **Dataverse** data store → **Save**. Build (or import) your
Copilot Studio agent **in that environment**. This is the single decision that determines the pool's
geography — see
[Why the geography may not match your configured region](#why-the-geography-may-not-match-your-configured-region).
Then continue with the two steps.

## The two steps

### 1. Run the prereq helper once (tenant admin)

```powershell
pwsh -File .\scripts\Enable-W365aPrereqs.ps1 -TenantId <your-tenant-id> -CreateDynamicGroup
```

Add `-WhatIf` first to preview without changing anything. This automates the three scriptable
prerequisites (see [What the helper does](#what-the-helper-does) below). If your environment's
geography differs from the tenant's home geography, you also need the **cross-geo support** toggle and
the **Computer Use → Cloud PC** switch enabled for that environment — see
[If the machine drop-down has no "Cloud PC pool" option](#if-the-machine-drop-down-has-no-cloud-pc-pool-option).

### 2. Create the pool in Copilot Studio

In Copilot Studio, open your agent's **Computer Use** tool → **Machines** → machine drop-down →
under **Cloud PC pool** select **Add new** → enter a **Name** + **Description** → **Create**.
Provisioning takes up to ~30 minutes (use **Refresh** to check status).

**Use these demo-friendly values when you create it:**

| Field | Value for this demo |
|---|---|
| **Name** | `Zava Claims Agent Pool` (this is the friendly label you control — see [naming](#what-youll-see-after-provisioning-and-how-to-verify)). |
| **Description** | `Zava CCaaS demo - Computer Use target running claims.exe` |
| **Geography / region** | **Follows your Power Platform environment's geography** — set it to match your `azure.location`. It is **not** a free-form picker: the pool is hosted in the **same geography as its environment**, so pick the geography when you create the environment (see above), not here. W365A/Computer Use is **generally available across Microsoft's regions**, so your configured region is a valid choice. If the pool shows up in a geography you didn't intend, see [geography](#why-the-geography-may-not-match-your-configured-region). |

If the machine drop-down shows only **Hosted browser** and **Bring-your-own machine** — with
**no `Cloud PC pool` section** — the feature is gated by a prerequisite that isn't satisfied yet.
See [If the machine drop-down has no "Cloud PC pool" option](#if-the-machine-drop-down-has-no-cloud-pc-pool-option) below.

---

## What you'll see after provisioning (and how to verify)

This is the **#1 source of confusion** in the demo, so read it before you go looking for the pool
in Intune.

**The `CPCPool_<environmentId>_<groupId>` name is normal and expected.** After provisioning you
will see a backing enrollment profile / Cloud PC with a GUID-heavy name such as:

```text
CPCPool_00000000-0000-0000_11111111-1111-1111-1111-111111111111
```

> The GUIDs above are placeholders. Your pool's name uses your own environment and group
> IDs — read them from your own tenant; they are not recorded here.

That is the **platform-generated** enrollment-profile / pool name that Power Platform assigns to the
Copilot Studio Cloud PC pool. It is **not** something you typed, it is **not** editable, and it is
**not** a defect. The friendly **`Zava Claims Agent Pool`** name you entered in step 2 is the
Copilot Studio pool label; the `CPCPool_*` string is the infrastructure object behind it.

**It is NOT an Intune "Provisioning policies (Agents)" entry — do not verify it there.** Under
Intune → **Devices → Provision Cloud PCs → Provisioning policies (Agents)** you will correctly see
**"No provisioning policies (Agents) found"**. That is expected for this demo: the pool is created in
**Copilot Studio**, not via the Intune/Agent 365 provisioning-policy route (see the warning at the
top of this page). An empty Agents provisioning-policy list does **not** mean the pool is missing.

**Verify the pool the right way:**

1. **Copilot Studio** — the Computer Use tool → **Machines** shows `Zava Claims Agent Pool` with a
   status of **Ready** (use **Refresh**; provisioning can take ~30 min).
2. **Intune** — Devices → **All Cloud PCs** (or **All devices**) and look for the device whose
   **enrollment profile name begins `CPCPool_`**. That is your agent Cloud PC.
3. **Entra** — that device is a member of the dynamic group whose rule is
   `device.enrollmentProfileName -startsWith "CPCPool_"` (created by
   `Enable-W365aPrereqs.ps1 -CreateDynamicGroup`). Membership can take 5-10 min to populate.
4. **Geography checkpoint (do this before you present).** In Power Platform admin center →
   **Environments**, open the environment whose id matches the first GUID of the `CPCPool_*` name and
   confirm its **geography matches your intended demo region** (the one in `azure.location`). If it
   shows a **different geography than you configured**, the demo is in the wrong geography — fix it now
   (see [below](#why-the-geography-may-not-match-your-configured-region)), not in front of the
   audience.

Only once a `CPCPool_*` Cloud PC is **Ready**, in that dynamic group, **and in the expected
geography** is the W365A/CUA environment actually demo-ready — do not report readiness from the
Copilot Studio screen alone.

### Why the geography may not match your configured region

The Cloud PC pool inherits the **Power Platform environment's geography**, not the Azure region you
chose for the rest of the demo. If your agent lives in an environment whose geography differs from
your `azure.location`, the pool provisions in **that environment's** geography. W365A/Computer Use is
**generally available across Microsoft's regions**, so this is never an availability limit — it is a
config detail: the pool follows wherever the environment lives. To put the pool in your configured
region, run the agent in an environment in the **matching geography** with **cross-geo support for
Windows 365-based features** turned on when the environment's geography differs from the tenant home
geography (item 1 of [the troubleshooting list](#if-the-machine-drop-down-has-no-cloud-pc-pool-option)).

> **Geography should be deliberate, not accidental.** Run the demo in an environment whose geography
> matches your `azure.location` so the whole stack is in-region. If you ever present a pool in a
> different geography (for example, an environment that was **already provisioned and Ready** and you
> don't want to re-provision before a demo), say so plainly: *"this component is running in an
> environment that was already set up in another region; it's fictional demo data and would be
> in-region in a real deployment."* Never let the geography happen silently.

**You can confirm which environment a pool belongs to from its name.** The first GUID in
`CPCPool_<environmentId>_<groupId>` is the **Dataverse environment ID**.
Match it in Power Platform admin center → **Environments** to see that environment's geography — that
geography is why the pool is where it is.

**To put the pool in your configured region, create the Dataverse environment in that geography.** Your
`azure.location` is the single source of truth for region, but it governs the **Azure** resources the
build creates — it cannot move a Power Platform environment, because the build doesn't create one. So
before you build the agent, create (or pick) a Dataverse environment whose geography matches
`azure.location`, then build the agent there; the Cloud PC pool then provisions in that geography.
`Build-DemoFromScratch.ps1` runs a Copilot Studio preflight that derives the expected geography from
`azure.location` and **warns** if none of your Dataverse environments match, so you catch a mismatch
*before* the demo rather than after.

**A pool already provisioned in a different geography? Keeping it is a convenience choice, not a
necessity.** If a pool already exists, shows **Ready**, and is visible to the Computer Use tool, you
*may* use it for a demo to avoid re-provisioning. But a correctly configured environment in your
target geography (cross-geo support on where needed, Computer Use + Cloud PC enabled) works just as
well. Recreate it in your configured geography whenever you have time before the demo, or whenever
latency/data residency matters; only keep an out-of-region pool when you're out of time to
re-provision, and explain it as such. See the
[cross-geo guidance](#if-the-machine-drop-down-has-no-cloud-pc-pool-option).

### Which group is which

| Entra group | Holds | Purpose |
|---|---|---|
| `Zava-Demo-Agent-CPCs` (or the `CPCPool_*` dynamic group) | The **agent/CUA Cloud PC device(s)** | Targets the **Zava Claims Workstation** Win32 app to the pool. |
| `Zava-Demo-Agent-Users` | The **human demo user account** | Targets the **Zava Contact Center** managed web link to the person. |

The W365A agent-pool Cloud PC (the `CPCPool_*` device) is the machine that must receive the **Zava
Claims Workstation** app. See [`docs/intune-w365.md`](intune-w365.md#choosing-the-agent-pool-device-group).

---

## If the machine drop-down has no "Cloud PC pool" option

Symptom: in the Computer Use tool → **Machines** → machine drop-down you see only:

```text
Hosted browser
Bring-your-own machine
```

…and there is **no `Cloud PC pool` section / `Add new`**. `Bring-your-own machine` →
**Add new** opens **Power Automate Machines** (`+New machine`, `+New hosted machine`,
`+Hosted machine group`) — that is the Power Automate / hosted-RPA surface, **not** the W365A
Cloud PC pool path. **Do not use it for this demo.** The Cloud PC pool path is still the correct
one; the option only renders once **all** of the following are true. Check them in this order —
(1) is by far the most common cause.

> **"Why did the option appear in one environment but not another?"** **Not** because of
> availability. **Windows 365 for Agents / Computer Use is generally available (GA) across Microsoft's
> regions** — there is no region where you "can't have it yet." The difference is purely
> **configuration**: the working environment already satisfied every prerequisite, while the other one
> is missing one — almost always the **cross-geo support toggle** (step 1 below), or the environment
> isn't in the geography you intended, or a first-party service principal / Computer-Use-Cloud-PC
> setting is off. Fix the prerequisite **in the environment you want to use** and the Cloud PC pool
> option appears there too. This is a config gate (not billing, not the agent, not CUA being "off",
> and not a missing-region/preview limitation). **Do not relocate your demo to a different region to
> work around it** — fix the configuration in the environment that matches your `azure.location`. The
> only time keeping an out-of-region pool is reasonable is when one is **already provisioned and
> Ready** and you simply don't want to re-provision before a demo (see
> [geography](#why-the-geography-may-not-match-your-configured-region)).

1. **Enable cross-geo support for the environment (most common fix).** A Cloud PC pool is hosted
   in the **same geography as its Power Platform environment**. When an environment's home geo
   differs from where the Windows 365 capacity is served, the option stays hidden until you turn on
   cross-geo support:
   Power Platform admin center → **Manage** → **Environments** → select your environment →
   **Settings** → **Features** → under **Hosted RPA & Windows 365 for Agents**, switch on
   **Enable cross-geo support for Windows 365-based features** → **Save**. (This is a **different
   toggle** from the Copilot → Settings → Computer Use **Cloud PC** switch in step 4 below.) The
   related provisioning error is: *"The creation of Cloud PC pool on (us) is disabled outside the
   tenant location."* W365A/Computer Use is **GA across Microsoft's regions**, so if your environment
   is in your intended geography and the option still doesn't appear after enabling cross-geo support,
   the fix is to recheck steps 2-4 **in that same environment** (Computer Use + Cloud PC on, first-party
   SPs present) — **not** to move to a different region. Environment **type** (Sandbox vs Production)
   does **not** matter; only the **geography** and these toggles do.

   **Consequence of using a different geography:** the Copilot Studio agent, Dataverse database,
   tool configuration, connections, run history, transcripts, and related Power Platform metadata
   live in that environment's geography. Keep all of this in the **geography that matches
   `azure.location`** so the whole demo is in-region and you don't have to explain a stray
   out-of-region footprint to the audience. Only consider an alternate geography for a real,
   pre-provisioned pool you can't re-create in time — never as a default — and never for real
   customer data without confirming data residency/compliance requirements.
   The Azure Static Web App, Intune apps, and Entra groups created by `Build-DemoFromScratch.ps1`
   stay in the existing demo subscription/regions regardless.

2. **Confirm Computer Use *and* Cloud PC are On for this exact environment.** Power Platform admin
   center → **Copilot** → **Settings** → **Computer Use** → select the environment → **Add** →
   ensure **Cloud PC** is checked → **Save**. (On per environment, not tenant-wide.)

3. **Make sure the required first-party service principals exist in the tenant.** They are normally
   auto-created, but if any are missing the pool option/provisioning silently fails. Verify (and
   create any that are missing) with the Azure CLI — these are idempotent and safe to re-run:

   ```powershell
   az ad sp create --id 0af06dc6-e4b5-4f28-818e-e78e62d137a5   # Windows 365
   az ad sp create --id 9cdead84-a844-4324-93f2-b2e6bb768d07   # Azure Virtual Desktop
   az ad sp create --id a85cf173-4192-42f8-81fa-777a763e6e2c   # Azure Virtual Desktop Client
   az ad sp create --id 50e95039-b200-4007-bc97-8d5790743a63   # Azure Virtual Desktop ARM Provider
   ```

   (To check first: Azure portal → **Microsoft Entra** → **Enterprise applications** → remove the
   *Application type == Enterprise Applications* filter → search each **Application ID**.)

4. **Set the Intune device-type enrollment restriction.** Intune admin center → device enrollment
   restrictions → **Allow Windows (MDM) platform for corporate enrollment**. (Also listed in
   [What stays manual](#what-stays-manual-and-why).)

5. **It's a preview/staged-rollout feature — refresh your session.** Sign out and back in to
   Copilot Studio and hard-refresh; rollout is staged per tenant/region, so the option can appear
   after enabling the gates above without any further change.

6. **Same-account rule.** The signed-in Microsoft Entra user must be the same account that owns the
   Computer Use connection (only an Entra user — not a service account — can run Computer Use).

> **Licensing note:** you do **not** need a separate Windows license or an M365 Unattended license
> to use the pool — the Cloud PC pool bills **pay-as-you-go to your Azure subscription** (via Power
> Platform PAYG meters). So a missing **option** is a **prerequisite/region gate**, not a licensing
> purchase: enable the gates above and accept PAYG billing. Do **not** rely on any "free tier" — the
> meter is live (see Cost below).

---

## If the pool is healthy but Computer Use never runs (handoff times out at "ready")

Symptom: the handoff connects, the agent fires the `start_fnol_handoff` topic and **calls** Computer
Use, and the contact-center desktop shows *"AI is driving the claim system,"* — but the handoff never
reaches **submitted**, it times out at **ready** and no claim ID comes back. The desktop's *"timed out
before the agent returned a result"* is the orchestrator giving up after polling: nothing actually ran
on a Cloud PC.

This is **not** an orchestrator, Direct Line, binding, or billing bug — those can all be correct and
this still happens. **Confirmed root cause: the agent has authentication set to "No authentication."**

**Root cause — Computer Use is disabled for unauthenticated agents.** Only a **Microsoft Entra user
account** can execute Computer Use, so an agent that doesn't require users to sign in can **never**
launch a session. The topic errors the instant it routes to Computer Use, **before** any Cloud PC run
is queued — which is exactly why the pool shows **0 runs ever**. (This is the same condition as the
agent-overview warning *"Anyone can view this agent's content because it doesn't require users to sign
in."*)

**Diagnose (free, instant, definitive):** In **Copilot Studio → Test** pane, run the trigger (e.g.
`start_fnol_handoff`). The precise error is:

> Test error: **CUA is disabled for unauthenticated agents. Please change your agent security
> settings.**

Earlier this surfaced more generically as `Sorry, something went wrong. Error code: SystemError` (e.g.
from the desktop / via Direct Line); the **Test pane gives the exact message**. Either way it fires
**before** the desktop, Direct Line, the orchestrator, or any Cloud PC run are involved.

**Fix — require authentication, using "Authenticate manually" (not "Authenticate with Microsoft"):**
Copilot Studio → **Settings → Security → Authentication** → switch from **No authentication** to
**Authenticate manually** (a custom Entra app registration) → **Save** → **Publish**. **Do not** pick
the built-in **Authenticate with Microsoft** — it **disconnects custom channels, including the Direct
Line channel** the orchestrator uses, which would break the handoff trigger. *Authenticate manually*
keeps Direct Line connected **and** authenticates the agent so Computer Use runs. **Also set *Require
users to sign in* = OFF** (with it ON the agent returns an OAuth card the headless orchestrator can't
satisfy) and set the **Computer Use tool to *Maker-provided credentials*** (no end user on the
unattended path). App-registration steps + fields:
[`build-the-agent.md` → step 2](build-the-agent.md#2-turn-on-generative-orchestration). Re-test in the
pane; the `CUA is disabled…` error should be gone and the topic should reach Computer Use and queue a
pool run.

> Changing the authentication mode can rotate the agent's **Direct Line secret**. After enabling it,
> **re-copy the secret** and confirm the desktop's handoff still connects.

**If it still fails after authentication is on** (rare — the config is otherwise verified), check, in
order:

1. **Tool binding.** The Computer Use tool is bound to the **Ready** pool + a **Connected** connection;
   if more than one machine group exists (e.g. `Zava Claims Agent Pool` and a second `… CUA Pool`),
   bind to the Ready one. Re-select the pool → reconnect → **Publish** → re-test (free, reversible).
2. **Pool has ≥1 machine.** A **Trial** pool with no PAYG billing policy shows **0 machines** and can't
   run even a correctly-bound, authenticated agent. Attach a **Windows 365 for Agents PAYG billing
   policy**, always-available (~$5/mo):
   [`licensing-and-entitlement.md` → pool billing policy](licensing-and-entitlement.md#also-required-a-windows-365-for-agents-pool-billing-policy-separate-meter-issue-77)
   (issue #77).

**Already verified once (live) — don't re-chase these:** cross-geo support (AU tenant / US pool)
**ON**; Remote Desktop service principal `IsRemoteDesktopProtocolEnabled = True`; consent device groups
present (incl. "Zava W365A Cloud PC Pools"); Computer Use / hosted machines **ON**; generative
orchestration set to **Yes**.

**Escalate** only if authentication is **on**, the tool is correctly bound, and the pool has **machines**
but Computer Use still errors — then capture the Test-pane message + run-history evidence and file a
Microsoft support case / repo bug.

---

## Cost

- **No reliable free tier — the meter is live.** W365A pricing is **pay-as-you-go ($0.40/hr of
  agent runtime)** plus, for an **always-available** Cloud PC, **$5/Cloud PC/month**, billed to your
  Azure subscription via Power Platform PAYG meters. (Any older "2 pools / 50 free hours" language
  came from a Copilot Studio page and is not a billing guarantee — don't plan around it.) Runs from
  the embedded test chat are **not** billable.
- **This demo uses always-available (minimum 1 Cloud PC).** A live demo cannot tolerate cold start,
  so keep at least one always-available Cloud PC (~$5/mo) rather than scale-to-zero, plus $0.40/hr
  while the agent runs.
- **Cold boot is a configuration symptom, not an architecture limit.** On **on-demand / scale-to-zero**
  pools the first session must boot a Cloud PC from image (several minutes) — disqualifying for a live
  CCaaS handoff. **Always-available = 1** keeps a warm machine that never releases/resets, so there is
  **no cold start**. Combine it with a **pre-warm** run before the demo and the **async handoff** (the
  CSR ends the call; the AI files the claim in the background while the desktop polls/SSE for status)
  so any latency sits off the customer's call path. See
  [`handoff-runbook.md` §8 + §10](handoff-runbook.md#8-pre-demo-checklist).
- **Where you set always-available:** it is **not** in Copilot Studio (the agent-pool *Edit details*
  panel only exposes name/description + a locked *Enable for computer use*). It lives in the **Windows
  365 provisioning policy in Intune** — not Power Platform: **Intune admin center → Devices → Provision
  Cloud PCs → Provisioning policies (Agents) → Create policy → General** → pick a **Billing plan** and
  set **"Always available Cloud PCs"** to a count (valid range **1–200**; use **1** for this demo).
  Creating the policy **requires an active W365A billing plan** (issue #77). Provisioning a Cloud PC
  then takes ~20–30 min.
- Separate platform caps: up to **5 pools per environment**, and each pool can scale to **10 Cloud
  PCs**.

---

## What the helper does

`scripts/Enable-W365aPrereqs.ps1` automates the three prerequisites that *can* be scripted, so a
run never fails later with `MSEntraRemoteDesktopAppConsentRequired`:

1. **Enables Entra authentication for RDP** on the *Microsoft Remote Desktop* service principal
   (`a4a365df-50f1-4397-bc59-1a1564b8bb9c`) — sets `isRemoteDesktopProtocolEnabled = true`.
2. **Creates the dynamic Entra device group** that captures the pool's Cloud PCs, with the
   membership rule `device.enrollmentProfileName -startsWith "CPCPool_"`.
3. **Hides the RDP consent prompt** by adding that group as a *target device group* on the same
   Microsoft Remote Desktop service principal.

It is idempotent (safe to re-run), `-WhatIf`-safe, and uses least-privilege Microsoft Graph
scopes. Dynamic-group membership normally populates in 5–10 minutes (up to 24h for large
tenants), and dynamic groups require an **Entra ID P1** (or Intune for Education) license.

---

## What stays manual (and why)

| Step | Why it isn't automated |
| --- | --- |
| **Create the Cloud PC pool** (step 2 above) | Maker-portal gesture; no documented supported public creation API for the Copilot Studio pool object. |
| **Billing selection** | A financial decision (attach a **Windows 365 for Agents PAYG billing policy** to the environment — see [licensing-and-entitlement.md](licensing-and-entitlement.md#also-required-a-windows-365-for-agents-pool-billing-policy-separate-meter-issue-77), #77; **no billing policy = Trial = 0 machines / Computer Use never runs**; choose **always-available (~$5/mo)** vs scale-to-zero). |
| **Intune device-type enrollment restriction** — *Allow Windows (MDM) for corporate enrollment* | Admin portal toggle. |
| **Enable Cloud PC for the environment** — Power Platform admin center → Copilot → Settings → Computer Use | Admin toggle, per environment. |
| **Enable cross-geo support for Windows 365-based features** — environment → Settings → Features | Admin toggle, per environment; required before the Cloud PC pool option appears in geos where W365A isn't GA (see [troubleshooting](#if-the-machine-drop-down-has-no-cloud-pc-pool-option)). |
| **Create + publish the Copilot Studio agent**, bind the pool in its **Machine** field, copy the **Direct Line secret** | Human/maker gate; the signed-in Entra user must own the Computer Use connection. |

---

## Getting `claims.exe` onto the pool

**`claims.exe` is deployed to the agent Cloud PC via Intune as a required Win32 app.**
This is the standard, supported delivery mechanism for Windows 365 for Agents. The app
is pre-installed by the time the Computer Use agent session starts — no runtime download
or self-provisioning is needed.

### How delivery works

1. The CI workflow (`.github/workflows/legacy-claims-build.yml`) builds and optionally
   signs `claims.exe`, then publishes it as a rolling GitHub Release asset (`claims-latest`).
2. The `.intunewin` package in `deploy/intune-packages/` wraps the binary for Intune deployment.
3. The Intune Win32 app is assigned as **required** to the agent-pool device group.
4. On provisioning, IME installs `claims.exe` to
   `%ProgramFiles%\Business Applications\Zava Claims Workstation\claims.exe` (registered in
   Add/Remove Programs) and creates a desktop shortcut (**Zava Claims Workstation**).
5. The Computer Use agent simply launches the pre-installed app with demo flags.

### Prerequisites

- Use an **Intune-provisioned Agents pool** (not the Copilot Studio `rpaBox` auto-pool).
  This pool type has IME, supports always-available machines, and delivers Win32 apps
  reliably.
- Set **Always available Cloud PCs = 1** in the provisioning policy so machines are warm
  and the app persists across sessions (no cold boot, no re-install).
- Ensure the app assignment targets the correct device group for the agent pool.
