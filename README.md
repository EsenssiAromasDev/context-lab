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
| 3 Usage, skills (`skill.prompt`), subagents (`agent.spawn`) | done | verified live on 2.1.291 |
| 4 Analyzers (duplicates, lexical overlap, stale paths, discoverable, large always-on) | done | deterministic, zero model calls |
| 5 Pane UI (o/t/i/e tabs, r refresh, Esc close) | done | |
| 6 Reports (`/context-lab report`) | done | |
| 7 Eval harness (init, worktrees, graders, bootstrap CI, verdicts) | done | end-to-end tested with real git |
| 8 Dogfood | done | [docs/DOGFOOD.md](docs/DOGFOOD.md): self-profile + baseline vs no-CLAUDE.md |

## Install

```text
/plugin install context-lab --marketplace EsenssiAromasDev/context-lab
```

Answer `y` to add the marketplace and pick a scope. Requires Claude Code >= 2.1.287.

## Use

The interface speaks Spanish, in plain words: what Claude reads before you type, how much of
the context it takes, what is wrong with it and what to do. Commands accept Spanish names
(`resumen`, `archivos`, `problemas`, `experimentos`, `iniciar`, `probar`, `informe`) or the
English ones below. In the pane: `1` Resumen · `2` Archivos · `3` Problemas · `4` Experimentos ·
`a` Actualizar · `Esc`.


```text
A one-line band above the prompt shows context use, always-on instructions and issues once
something has been observed (Ver shows the pane, Ocultar hides it until the next /context-lab).

/context-lab            opens the pane — keys: 1 resumen · 2 archivos · 3 problemas · 4 experimentos · a actualizar · Esc
/context-lab <view>     opens the pane on that view (headless -p: prints it instead)

Views:
overview                context used, always-on instructions with ~sizes
tree                    architecture by tier, imports nested, ● observed ◐ inferred ○ available
issues                  evidence-backed findings: duplicates, overlap, stale paths, listings, size
/context-lab init       create .context-lab/ (config, task example, variants and graders folders)
/context-lab report     write .context-lab/reports/<timestamp>.md
/context-lab eval <v>   baseline vs variant <v> in isolated git worktrees (eval stop: stop)
/context-lab doctor     (text) what this Claude Code build exposes, git state, readiness
```

Requires Claude Code >= 2.1.287 (developed on 2.1.291).

## Dogfood result

Context Lab on its own repository: 2 always-on files (~280 tokens) and 0 issues. In a real
experiment, `baseline` vs `no-claude-md` (5 tasks × 1 trial, Haiku), both arms passed 5/5. The
verdict is **PROMISING**: context dropped by 100%, and no regression was observed with that little
data. It is not SUPPORTED, because the tasks were too easy to tell the arms apart and 20+ are
needed. Full write-up, including why the −32% in input tokens is noise: [docs/DOGFOOD.md](docs/DOGFOOD.md).

## Experiments without a session

A headless `claude -p` cannot run a Mod's command, so the same harness has a CLI:

```text
node scripts/eval.ts init
node scripts/eval.ts <variant>
```

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
- Whether a subagent receives the instruction files is not exposed by `agent.spawn`; the
  tree says so. Subagent prompts are never stored.
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
