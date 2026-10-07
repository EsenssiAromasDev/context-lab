# Context Lab

Claude Code Mod that profiles context. SPEC.md is the source of truth; build phases in SPEC §47, in order.

- Only `hooks/register.tsx` touches `$`. Everything else is pure TS over plain data.
- Pure-module tests: `tests/*.spec.ts` (`npm test`). Engine tests: `tests/*.test.ts` (`npm run test:plugin`). Never name any other file `*.test.ts`.
- Before calling something done: `npm test`, `npm run test:plugin`, `npm run validate`, `npm run typecheck`, `npm run typecheck:plugin`.
- Generated API types in `.claude-plugin/types/` are authoritative over the spec; record deviations in DECISIONS.md.
- Never persist file contents. Estimated tokens always render with `~`. Never show inferred context as observed.
- `fixtures/` are test data; their CLAUDE.md files describe the fixture, not this repo.
