# Shared JSON schemas

Both apps in this monorepo MUST conform to these schemas. They are the
contract between the CCaaS Agent Desktop, the local orchestrator, the
Foundry agent driving CUA, and the legacy Zava Mutual Claims
Workstation.

| File | Producer | Consumer | When |
|---|---|---|---|
| `call-context.schema.json` | CCaaS Agent Desktop | Local orchestrator (or Agent365 webhook) | Human agent clicks "Hand off to AI Agent" |
| `prefill.schema.json` | Local orchestrator / Agent365 | Legacy Claims Workstation (file in handoff `in\` folder) | Just before launching `claims.exe` |
| `ready.schema.json` | Legacy Claims Workstation | Foundry agent (file in handoff `out\` folder) | After legacy auth + prefill load complete |
| `result.schema.json` | Legacy Claims Workstation | Foundry agent → orchestrator → CCaaS desktop | After FNOL is submitted |
| `error.schema.json` | Legacy Claims Workstation | Foundry agent → orchestrator → CCaaS desktop | On any unrecoverable error |

## Versioning

All schemas declare `"$id"` with a version segment (`v1`). Breaking changes
bump to `v2` and BOTH apps must support both versions for one release before
`v1` is dropped.

## Hero record examples

The hero records used in `call-context.schema.json` and
`prefill.schema.json` examples are seeded identically in both apps. See the
top-level `README.md` for the canonical hero record list.
