# Context Lab

A Claude Code Mod that profiles the context Claude receives: what is loaded, where it comes
from, what looks redundant or stale, and — with controlled evals — whether changing it
actually helps. Measure first, recommend second, never claim improvement without evidence.

The full V1 specification is [SPEC.md](SPEC.md). Design decisions: [DECISIONS.md](DECISIONS.md).

## Status

| Phase | | |
| --- | --- | --- |
| 1 Skeleton (`/context-lab`, doctor, tests) | done | |
| 2 Context observer (`prompt.context` → graph, tree) | done | nested files (2b) pending |
| 3 Usage (`session.measure`, engine per-file estimates) | done | skills/agents pending |
| 4 Analyzers | todo | `/context-lab issues` says so instead of reporting nothing |
| 5 Pane UI · 6 Reports · 7 Eval · 8 Dogfood | todo | |

## Use

```text
/context-lab            overview: context used, always-on instructions with ~sizes
/context-lab tree       architecture by tier, imports nested, ● observed ◐ inferred ○ available
/context-lab doctor     what this Claude Code build exposes, git state, readiness
```

Requires Claude Code >= 2.1.287 (developed on 2.1.291).

## Develop

```text
claude --plugin-dir .        # load it; also lays .claude-plugin/types/ for this build
npm install
npm test                     # pure modules, Node (tests/*.spec.ts)
npm run test:plugin          # through the engine (tests/*.test.ts, no-Node sandbox)
npm run validate             # claude plugin validate .
npm run typecheck            # pure modules
npm run typecheck:plugin     # hooks module against the engine's generated types
```

`hooks/register.tsx` is the only file that touches the engine (`$`); everything under
`hooks/graph`, `hooks/metrics`, `hooks/observers`, `hooks/commands` is pure and Node-tested.

## API limitations (2.1.291)

- Per-file token figures are estimates: Context Lab's own `~chars/4`, or the engine's
  local "summary" breakdown when it gives one. Exact counts need the opt-in `full`
  breakdown, which sends token-count requests (network) — off by default.
- `prompt.context` fires for a conversation's first message (again after compaction or
  `/clear`), not every turn. "Loaded N times" counts contexts, not prompts.
- If another plugin rewrites the `claudeMd` text, the engine stops reporting the files
  behind it; Context Lab then shows one "rewritten, files unknown" node and does not guess.
- Doctor can only prove an event works by having seen it fire this session.
- Nested `CLAUDE.md` delivery is observable through `prompt.attachment` (`nested_memory`)
  but its text format is not a typed API; until Phase 2b lands nested files are not shown.

## Privacy

No network calls and no model calls by default. File contents are hashed and measured in
memory, never persisted: only paths, hashes, sizes and counts reach `$.store`.
