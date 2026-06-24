# Contributing — CCaaS Agent Desktop

Thanks for taking a look! This app is part of the
[`RoelDU/w365-for-agents-cua-lab`](../../) monorepo and is intentionally
demo-shaped — focused on the inbound-call → handoff-to-AI flow.

## Ground rules

1. **Don't break the demo flow.** Acceptance criteria 1-9 in
   [`PROMPT.md`](./PROMPT.md) must continue to pass on every PR. CI runs
   `npm test` and `npm run build` to enforce that.
2. **Don't modify the shared JSON schemas** at `../../schemas/`. They are
   the contract between this app, the orchestrator, and the legacy app.
   If you need a schema change, open an issue first.
3. **Keep the surface small.** This is a demo — no Storybook, no design
   system extraction, no feature flag service. Prefer co-located simple
   code over abstraction.

## Development loop

```powershell
cd C:\Dev\Work\CCaaSDemoApp\apps\ccaas-agent-desktop
npm install
npm run dev      # iterate
npm test         # before commit
npm run build    # before push
```

## Code style

- TypeScript strict mode is on. No `any` unless interfacing with untyped
  third-party libraries.
- Tailwind utility classes only — no `.module.css` files.
- Stable `data-testid` and meaningful `aria-label` on every interactive
  control (this app may itself be CUA-driven; see PROMPT.md §CUA).
- Zustand stores live in `src/stores/`. One store per domain. Persist via
  `zustand/middleware/persist` only when the value should survive reloads.
- Schema-bound payloads (`CallContext`, `Prefill`, `Ready`, `Result`,
  `Error`) MUST be validated via `src/lib/schemas.ts` at every boundary.

## Tests

Tests live in `tests/` (not co-located, to keep the source tree visually
clean). Use Vitest + React Testing Library, with MSW for HTTP mocking
(see `tests/mockOrchestrator.ts` for the canonical mock). Aim for tests
that exercise behavior, not implementation detail.

## Commits

- Conventional Commits are appreciated but not required.
- Run `npm run format` and `npm test` before pushing.

## Reporting issues

Use the [monorepo issue tracker](https://github.com/RoelDU/w365-for-agents-cua-lab/issues).
