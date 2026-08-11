# Repository instructions

## Source of truth

- Read `docs/implementation-spec.md` before changing architecture.
- Record intentional deviations in `docs/decisions.md`.

## Product boundaries

- Never add an in-app AI chat or Ask feature.
- The product never launches Codex or Claude.
- Agent integration is CLI + Skill only.
- Comment state is unresolved/resolved only.
- Git commits are the code-history source of truth.
- PR title and body always represent the latest successfully synchronized GitHub state.

## Stack

- Node 24 LTS, TypeScript strict, pnpm 11.
- React/Vite, Hono, node:sqlite, native git/gh.
- No ORM and no monorepo without a documented reason.

## Commands

- `pnpm check`
- `pnpm test`
- `pnpm test:e2e`
- `pnpm build`

## Working agreement

- Keep each change vertically integrated and tested.
- Do not stop at a spike.
- Prefer explicit errors over silent fallbacks.
- Do not introduce Skill-less prompt support.
- Do not publish to npm during Phase 1.
