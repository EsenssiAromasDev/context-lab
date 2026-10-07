# Decisions

## D-001 — Pivot from ClaudeOS to Context Lab (2026-10-07)

This repository previously held ClaudeOS (persistent project state / evidence / ship gate).
Its last state is kept on branch `feat/claude-code-adapter` (commit `aba0547`, WIP included).
Context Lab starts on `feat/context-lab` with the ClaudeOS sources removed. Lessons about the
Mods host carried over (no Node in the sandbox, `*.test.ts` vs `*.spec.ts`, `$.process.run`).

## D-002 — Pure modules + thin register

The hooks module runs with no Node and no DOM, and `claude plugin validate` restricts how
`$` may be passed. All logic is pure TypeScript over plain data (Node-tested); only
`hooks/register.tsx` touches `$`. Atoms must be declared in register.tsx itself (the
validator reads state references from the module that uses them).

## D-003 — Node ids exclude the content hash

The draft spec suggested `sha256(kind + path + contentHash)`. That would mint a new node on
every edit, breaking "same file observed twice does not duplicate node" and per-file load
counts. Ids are `sha256(kind \0 canonicalPath)`; the hash is an attribute and changes are
counted in `metadata.contentChanges`.

## D-004 — Pure-TS SHA-256

No `crypto` in the sandbox. `hooks/metrics/hash.ts` is verified against `node:crypto`.

## D-005 — Two token tiers by default, one opt-in

Local `~chars/4` always; the engine's own `summary` breakdown (`memoryFiles[].tokens`)
preferred when present — both local, no network. The `full` breakdown (exact, network) is
opt-in only (SPEC §10).

## D-006 — State contract is duplicated, not imported

The validator requires `types/index.d.ts` to be self-contained. Its shapes mirror
`hooks/graph/graph.ts` and `hooks/metrics/usage.ts`; `npm run typecheck:plugin` fails if
they drift because register.tsx assigns one to the other.

## D-007 — Cross-session telemetry in `$.store`, keyed by project root

`$.state` is per session. Load/session counts across sessions go to `$.store` under
`graph:v1:<canonical root>`. A restored graph keeps history but clears `current`: an earlier
session's context is not this session's. Writing to the repository only happens after
`/context-lab init` / `report` (SPEC §25).

## D-008 — Session identity = `usage.startedAt`

No session id is exposed to `prompt.context`; `$.session.usage().startedAt` identifies the
conversation (it restarts on `/clear`), which is the unit `sessionCount` needs.

## D-009 — Fixture test files are not named `*.test.ts`

`claude plugin test .` runs every `*.test.ts` in the tree, fixtures included.
