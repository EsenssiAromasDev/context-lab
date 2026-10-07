# Context Lab

A Claude Code Mod that profiles the context Claude receives: what is loaded, where it comes
from, what looks redundant or stale, and — with controlled evals — whether changing it
actually helps. Measure first, recommend second, never claim improvement without evidence.

The full V1 specification is [SPEC.md](SPEC.md). Design decisions: [DECISIONS.md](DECISIONS.md).

## Status

| Phase | | |
| --- | --- | --- |
| 1 Skeleton (`/context-lab`, doctor, tests) | done | |
| 2 Context observer (`prompt.context` → graph, tree) | done | |
| 2b Nested files (attached ● / inferred ◐ / available ○) | done | verified live on 2.1.291 |
| 3 Usage (`session.measure`, engine per-file estimates) | done | skills/agents pending |
| 4 Analyzers (duplicates, lexical overlap, stale paths, discoverable, large always-on) | done | deterministic, zero model calls |
| 5 Pane UI · 6 Reports · 7 Eval · 8 Dogfood | todo | |

## Use

```text
/context-lab            overview: context used, always-on instructions with ~sizes
/context-lab tree       architecture by tier, imports nested, ● observed ◐ inferred ○ available
/context-lab issues     evidence-backed findings: duplicates, overlap, stale paths, listings, size
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
- Nested `CLAUDE.md` delivery is observed through `prompt.attachment` (`nested_memory`),
  attributed by parsing its `Contents of <path>:` headers — not a typed API. If a build
  changes that text, `doctor` shows the attachments as unattributed instead of guessing.
- Analyzers read the text Claude was sent, kept in memory only. After a plugin reload that
  memory is gone and they read the files from disk; such findings say "Read from disk".
- Stale paths are only reported when the path's first directory exists: a reference to a
  whole removed top-level folder is not caught (by design, to avoid flagging prose).
- Subagents' nested attachments are not counted yet (main conversation only).
- In `claude -p`, a command registered by a Mod is not resolved for the initial prompt:
  try `/context-lab` in an interactive session.

Analyzer thresholds can be set in `.context-lab/config.json`:

```json
{ "largeSectionEstimatedTokens": 1000, "overlapHigh": 0.85, "overlapMedium": 0.7, "discoverableMinRatio": 0.8 }
```

## Privacy

No network calls and no model calls by default. File contents are hashed and measured in
memory, never persisted: only paths, hashes, sizes and counts reach `$.store`.
