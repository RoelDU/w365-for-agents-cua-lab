# Contributing to CCaaS Demo App

Thanks for your interest in contributing! This repo is a working
demonstration of an end-to-end pattern (CCaaS handoff → Agent365 → CUA →
W365A Cloud PC → legacy desktop app). Contributions that make the
demonstration clearer, more reliable, or applicable to additional
verticals are very welcome.

## Repository model

This repo is organized in two phases:

1. **Spec phase** — each app is described by a `PROMPT.md` build brief
   that a coding agent (Copilot CLI / Copilot Workspace / Claude Code /
   Cursor) uses to generate the implementation. The spec is the source
   of truth.
2. **Generated phase** — the coding agent produces the actual source
   code under each app's folder. The code is committed alongside the
   spec.

This split keeps the demonstration intentional: every behavior in the
app traces back to a line in the spec.

## How to contribute

### To the specs (`PROMPT.md` files)

This is the most impactful kind of contribution.

1. Open an issue describing what behavior you'd like to add, change, or
   remove, and why. Reference the partner conversation or use case that
   motivates it.
2. Once aligned, open a PR editing the relevant `PROMPT.md`. Keep the
   diff surgical — add a new bullet or section rather than rewriting
   existing content unless necessary.
3. Note in the PR description **what behavior should change in the
   generated app** as a result of your spec edit, so a reviewer can
   verify that the rebuild will pick it up.

### To the generated code (after v1.0 ships)

Two acceptable workflows:

**A) Edit the code, then sync the spec.**
For small fixes (typos, regressions, performance) — fix the code
directly, then update the relevant `PROMPT.md` to reflect the new
intent so a future rebuild won't undo your fix.

**B) Edit the spec, then rebuild.**
For larger behavioral changes — update the `PROMPT.md` first, then
either re-run the coding agent on the affected app or apply the
implied code changes by hand. Document the change in both places.

### To the supporting docs

- `docs/demo-flow.md` — the narrated partner walkthrough. PRs welcome
  for clearer phrasing, alternate cadences (30-second cut, deep-dive
  variant), or new failure-mode talking tracks.
- `docs/BUILD.md` — the build-from-source guide. PRs welcome for
  prerequisite changes (newer Node/MinGW versions), clearer
  troubleshooting tips, or additional smoke tests.
- `schemas/` — the JSON contract. **Breaking changes require a new
  schema version** (`v2/…`) and BOTH apps must continue to accept the
  old version for at least one release.

### To the agent-side assets

The `apps/legacy-claims-workstation/samples/foundry-agent/` files
(`KNOWLEDGE.md`, `AGENT-INSTRUCTIONS.md`, `CUA-TOOL-INSTRUCTIONS.md`,
`evaluations/*.csv`) are tuned for Foundry/Copilot Studio with
CUA-capable models. Welcome contributions:
- Additional evaluation test cases.
- Alternate Instructions for other agent platforms (with a `README.md`
  in the new folder explaining the platform).
- Performance-tuning notes for different models.

## Pull request process

1. **Fork the repo** and create a feature branch:
   `feat/add-telco-billing-vertical`,
   `fix/handoff-folder-race-condition`,
   `docs/clarify-cua-tool-instructions`.
2. **Keep PRs focused.** One thematic change per PR. Several small PRs
   are easier to review than one big one.
3. **Include a clear PR description** stating:
   - What changed and why.
   - What the impact is on the generated app behavior (if any).
   - How you tested (smoke-tested the app, ran the evaluation batch,
     re-ran the build agent on the spec, etc.).
4. **Update docs.** Any user-visible change should update either the
   top-level `README.md`, `docs/demo-flow.md`, or `docs/BUILD.md`.
5. **Run the linters and tests** for the app you're changing:
   - Legacy app: `build.bat` should produce a warning-free build and
     `claims.exe --test` should pass.
   - CCaaS desktop: `npm run lint && npm test && npm run build`
     should all pass.
6. **One reviewer** approves the PR before merge. Roel and any
   designated maintainers are listed in `CODEOWNERS` (once created).

## Testing requirements

| Change scope | Required verification |
|---|---|
| `PROMPT.md` edit (spec only) | None — but note in the PR what should change post-rebuild |
| Code change to legacy app | `build.bat` + `claims.exe --test` clean; manual smoke test of the affected workflow |
| Code change to CCaaS desktop | `npm run lint && npm test && npm run build` clean; manual smoke test in Edge/Chrome |
| Change to schemas | Both apps' tests pass against the new schema; the schema's own examples validate |
| Change to agent KNOWLEDGE / INSTRUCTIONS / CUA-TOOL | Run `evaluation-1-smoke.csv` against a real W365A Cloud PC + legacy app; all 5 tests pass |
| Change to evaluation CSVs | Run the modified batch; document the expected pass rate |
| Docs-only change | None |

## Coding style

- **Legacy app (C99):** Hungarian notation OK; mixed-case
  PascalCase/camelCase per the existing code's choices once it's
  generated; `-Wall -Wextra` clean.
- **CCaaS desktop (TypeScript):** Strict mode on; the generated
  `.eslintrc.cjs` and `.prettierrc` are the source of truth — run
  `npm run lint -- --fix` before committing.
- **Markdown:** Wrap at ~80 chars where practical for diff readability.
- **Commit messages:** Imperative mood, capitalized first word, no
  trailing period (`Add fraud-pattern evaluation tests`).

## Reporting bugs and proposing features

See [`SUPPORT.md`](./SUPPORT.md) for how to get help, file bug
reports, and propose new features.

## Code of Conduct

This project follows the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## Licensing

By contributing, you agree your contributions will be licensed under
the [MIT License](./LICENSE).
