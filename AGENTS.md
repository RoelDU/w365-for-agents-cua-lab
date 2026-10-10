# AGENTS.md

Guidance for any AI coding agent working in this repository. People installing or presenting
the lab do not need anything here: start at [`docs/install/README.md`](docs/install/README.md).

## Agent skills

This repo uses the Matt Pocock engineering skills. Read these before starting work:

### Issue tracker

Optional, local to each developer: issues and specs can be kept as markdown under `.scratch/` (git-ignored, so a fresh clone has none). Installation, presenting and the apps never read it. See `docs/agents/issue-tracker.md`.

### Triage labels

Standard five-role vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.

## How work is run here (non-negotiable)

This repo is worked in a supervised loop. A QA/guardian agent reviews every commit
against a locked spec before the next ticket starts.

1. **Work only the ticket you were given.** Do exactly what the current ticket
   specifies. Nothing more.
2. **If you believe other changes are needed, STOP and report.** Do not make them.
   Scope creep is the failure mode this process exists to prevent.
3. **One small, single-purpose commit per ticket**, message prefixed with the goal
   tag (e.g. `[G1]`). The baseline must build after every commit.
4. **Never push to the public remote without explicit human approval.** Commit
   locally only.
5. **Do not rewrite the apps, change the demo flow, remove the Foundry backend
   path, or hide the visible CUA reasoning** unless a ticket explicitly says so.

## What this project is

A hands-on lab: a Copilot Studio (MCS) agent with Computer Use (CUA) picks up a
contact-center handoff from the CCaaS Agent Desktop and drives a legacy Win32
claims app on a Windows 365 for Agents Cloud PC. A pro-code Foundry hosted agent is a
first-class alternative behind the same handoff contract; the presenter picks either one
when transferring the call.
