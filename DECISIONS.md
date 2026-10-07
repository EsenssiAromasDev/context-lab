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

## D-010 — Observers record in the background

Measured live on 2.1.291: awaiting the work inside `tool.call` held a Read's result back
~1.1 s (the usage breakdown, ~0.9 s, serialized the plugin's other calls). Observers now
return `next(e)`'s result at once and track their work; `/context-lab` awaits it before
drawing. Result: tool.call 1155 → 86 ms (incl. the Read), prompt.attachment 621 → 2 ms,
session.measure 938 → 12 ms. The breakdown is fetched after a turn only when the context
has files it has not been asked about.

## D-011 — Weaker evidence never overwrites a delivery's measurements

A file read from disk (inferred) and the same file as the engine attached it hash
differently, which produced false `contentChanges`. Inferred/available updates keep an
observed node's hash and sizes; content changes are only counted between two deliveries.

## D-013 — Analyzers read the delivered text, from memory

What Claude is sent (comments and frontmatter stripped, imports separate) is what is analyzed.
That text is kept in the hooks module's memory (`delivered`, never `$.state`/`$.store`); after a
reload it is gone and the file is read from disk, flagged "Read from disk". Line numbers are
located in the file on disk so they match what the person edits. Analysis runs only on
`/context-lab` and `/context-lab issues` (fixtures ~1 ms; a 235k-char CLAUDE.md ~115 ms).

## D-014 — Stale paths must be anchored

Dogfooding on 8 local repositories, the first version reported 15+ "stale paths" in one file
that were prose (`width/height/fps`), alternatives (`system_a/b/c`, `.ttf/.otf`), elisions,
build output (`apps/cli/dist/`) or paths relative to another base. Now a path is reported only
when its first segment exists; generated/env paths, alternatives and elisions are excluded.
Result on that file: 3 findings, each a real missing file. Cost: a reference to a wholly
removed top-level folder is missed.

## D-015 — Redundant fixture is a near-duplicate

SPEC §44 expects lexical overlap for `redundant-project`; with identical sections it would be
an exact duplicate instead. Its rule file differs by one word (overlap ~94%, HIGH); exact
duplicates are covered by unit tests.

## D-016 — Skills are context nodes; subagents are session topology

A skill's instructions are context delivered on activation, so they are graph nodes
(observed, counted per activation, persisted as counts/hashes like files). Subagents are not
context of the main conversation: their records live in `$.state` for the session only, and
keep structure, never the task prompt or description (conversation content, SPEC §39).
Verified live: `skill.prompt` 20 ms (keybindings-help body ~3.7k tokens), `agent.spawn`
121 ms including the subagent's start.

## D-017 — The pane keeps the profile out of the model's context

A command's `text` is a transcript row the model also reads. Printing a context profile there
would add context to measure context. With a surface, `/context-lab` opens the pane and
returns one line; only headless runs (no surface to draw on) get the full text. The pane's
tabs are hotkeyed Buttons; analysis runs on open, on `r`, and the first time `i` is pressed,
never inside a render (render hooks may not write state).

## D-018 — One eval harness, two hosts

`hooks/eval/*` talks to an `EvalHost` (run argv, read/write/list files, clock). The Mod's host
wraps `$`; `scripts/eval.ts` wraps Node. Reason: `claude -p` does not resolve a Mod's command as
its prompt (verified on 2.1.291), so unattended experiments — and Phase 8's dogfood — need a
CLI, and the harness can be end-to-end tested in Node against real git.

## D-019 — Trials cannot read their graders

Each trial's worktree has `.context-lab/` removed (`git rm -r`) before Claude runs and the
graders copied in only after it finishes. Worktrees sit outside the repository so the main
checkout's CLAUDE.md is never an ancestor of a trial. Every trial records the SHA it started
from; all of a run's trials share it.

## D-020 — `.context-lab/` does not make the tree dirty

Eval definitions and results are not what is measured; requiring a commit for each tweak of a
task file would only slow iteration. Everything else must be committed or stashed.

## D-021 — Windows: the npm shim is resolved, not run through a shell

`claude` on Windows is often `claude.cmd`, which a shell-less spawn cannot start. The harness
asks `where claude.cmd`, reads the shim and runs the executable it names; `claude` in
config.json overrides. No shell is ever used.

## D-012 — Evidence marks are per context

`node.evidence` is the strongest level ever seen (history across sessions). What the tree
marks comes from the context's `current` / `nested` / `inferred` / `available` lists, reset
at each `prompt.context`, so last week's attachment never shows as ● today.
