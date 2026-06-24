# Agent platform decision — Copilot Studio auto-pool vs. Agent 365 / Intune-provisioned Agents pool

**Status:** Historical decision note — superseded by GA documentation. **Date:** 2026-06-11.
**Relates to:** the decision that **Agent 365 is optional governance (Entra Agent ID + audit), not a hard
dependency**, and issues #84 (preview-era IME observation), #82 (ESP hang), #93 (cold boot), #85 (browser blocked).

> [!IMPORTANT]
> **Resolution (GA product):** the platform question in this note is now resolved. Microsoft
> Learn GA documentation confirms Copilot Studio / Windows 365 for Agents Cloud PC pools are
> **Entra-joined and Intune-enrolled**, so **IME works** and `claims.exe` should be delivered
> via **Intune as a required Win32 app**. The `no IME` / self-provision conclusions below were
> based on preview-era observations and are no longer the standing architecture. Read the rest
> of this file as historical context only.

> **Why this doc exists.** Feedback (Scout) is that the solution "should have been built on
> **Agent 365 (A365)**." That is a fair challenge: several recurring pain points trace directly to
> the **Cloud PC pool SKU** the current path uses. This note records *why* the current platform was
> chosen, *what* A365 / an Intune-provisioned Agents pool would change, and the **one open question**
> that decides whether a rebuild is even warranted. It does not, by itself, change the
> implementation — it exists so the owner + PM can make an informed go/stay call.

> **Strategic priority (owner, 2026-06-11, updated):**
> - **W365A (Windows 365 for Agents) is MANDATORY.** The demo must show the agent working on a
>   **W365A Cloud PC**. Without W365A the demo is obsolete — so the platform question below is
>   really "which runtime can cleanly drive a **W365A Cloud PC**," not whether to use one.
> - **Agent 365 (A365) is nice-to-have** (downgraded from the earlier "central/required" framing).
>   It strengthens the governance story but is **not** the gating constraint. The owner has observed
>   that the **agent does show up in A365**, so A365 enrollment is working; it is no longer a blocker.

---

## 1. What was actually built, and why

The demo runs on the **lightweight Copilot Studio path**:

1. Build the agent in **Copilot Studio**.
2. Add the **Computer Use** tool.
3. Let Computer Use **auto-create its own Windows 365 for Agents (W365A) Cloud PC pool**
   (`managedBy = rpaBox`) — every binding is a click *inside Copilot Studio*; **no** Intune
   provisioning policy is created.

This was a **deliberate, documented decision**: the goal
was the simplest thing to stand up and demo, with **Agent 365 treated as an optional identity /
governance layer (Entra Agent ID + audit), not the compute substrate.** A minimal Copilot Studio
computer-use demo runs without any A365 wiring, so A365 was scoped out of the critical path.

## 2. Where that choice bites — the cost of the auto-pool

The `rpaBox` auto-pool is exactly the SKU behind the recurring issues:

| Limitation of the Copilot Studio auto-pool | Symptom / issue |
|---|---|
| **Preview-era assumption: no Intune Management Extension (IME)** on the agent machines | Historical rationale for a self-provision workaround (#84); no longer current in the GA product |
| **A *required* Win32 assignment blocks Windows ESP** | OOBE hang at "Account setup" until timeout (#82) |
| **No "always available" toggle** (pool not surfaced in the Intune provisioning policy) | First session **cold-boots from image** → unusable for a live CCaaS call (#93) |
| **Resets to the provisioned image after each session; no custom image** | The one-time `claims.exe` stage doesn't persist unless a machine is warm |
| **Browser automation blocked** (missing extension) | Historical note only; browser limits do not change the current Intune app-delivery path (#85) |

## 3. What "build on A365" would change

The **Intune-provisioned "Agents" pool** (the A365 path) exposes precisely the capabilities the
auto-pool lacks:

- **IME enrollment** → Intune **required-app** delivery of `claims.exe` works (this is now the confirmed GA path).
- **`Always available Cloud PCs` count** → a **warm** machine, **no cold start** (resolves #93).
- **Entra Agent ID + governance/audit** as a first-class control plane (D8's "optional" layer
  becomes the foundation).

In short, Scout's critique is substantively correct: an A365 / Intune-Agents-pool foundation would
have **sidestepped** #84, #82, and #93 rather than working around them.

## 4. The one open question that decides everything

**Can Copilot Studio's Computer Use tool *bind* to an Intune-provisioned Agents pool (with IME +
always-available), or is Computer Use locked to the `rpaBox` auto-pool it creates?**

- **If it can bind** → keep the Copilot Studio CUA experience *and* get the warm/IME pool. Minimal
  rework (re-point the Computer Use tool's *Machines* setting). This is the only currently-identified
  path to a clean A365-native foundation that still drives a **W365A Cloud PC**.
- **If it cannot bind** → there is **no confirmed alternative A365-native runtime** for driving a
  W365A Cloud PC. ⚠️ **The Azure AI Foundry path does NOT support W365A** (owner correction,
  2026-06-11) — so the `-AgentBackend foundry` / [`samples/foundry-w365a-runner`](../samples/foundry-w365a-runner)
  material in this repo is **contradicted and must be verified or removed** (tracked separately). Do
  **not** treat Foundry as a fallback until that is resolved. If the binding also fails, this is a
  **platform gap to escalate to Microsoft**, not a solution to claim.

This binding question must be answered **live** (owner/Scout lane — read-only Graph/portal check)
**before** any rebuild is scoped. It is tracked as a dedicated issue.

> **Confidence note.** Earlier revisions of this doc asserted a Foundry+W365A fallback as fact; that
> was an unverified assumption and was wrong. Statements about backend↔W365A support in this repo
> should be treated as **unverified** until confirmed live and labelled accordingly.

## 5. Recommendation

**Because W365A is mandatory, the target is a single, coherent runtime that cleanly drives a W365A
Cloud PC — not capabilities stitched onto the auto-pool.** (A365 is nice-to-have and already enrolling
the agent, so it is not the gating factor.) The current `rpaBox` auto-pool + preview-era
`claims.exe` self-provision workaround is exactly the kind of **workaround stack** we should retire,
not extend. The clean replacement is now confirmed by GA documentation: Intune required-app delivery
to the pool, with the agent simply launching the pre-installed app. This historical note remains
useful context, but the workaround itself should not be extended.

1. **Answer §4 live first** (read-only check). The cold-boot pain (#93) is independently fixable today
   by setting **always-available = 1** — see
   [`handoff-runbook.md` §8 + §10](handoff-runbook.md#8-pre-demo-checklist) — so the demo is not
   blocked while this is decided. Treat that as a stopgap.
2. **If Computer Use can bind to an Intune-provisioned Agents pool:** adopt that pool as the **single**
   A365-native foundation — IME-delivered `claims.exe`, always-available (no cold boot), Entra Agent
   ID governance.
3. **If it cannot:** do **not** assume Foundry (it does not support W365A — see §4). At that point
   there is no verified A365-native runtime for a W365A Cloud PC and the gap must be **escalated to
   Microsoft**; the only path that works today remains the Copilot Studio auto-pool, which conflicts
   with the "no workarounds" requirement. That tension is real and must be surfaced, not hidden.

> No environment-specific data appears in this note by design.
