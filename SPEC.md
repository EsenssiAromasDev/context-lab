# Context Lab V1
## Claude Code Context Architecture Profiler & Evidence-Based Optimizer

**Status:** V1 specification (source of truth for this repository)
**Target:** Claude Code Mods >= 2.1.287 (developed and verified against 2.1.291)
**Language:** TypeScript
**Execution:** Claude Code Mod / function hooks
**Primary principle:** Measure first. Recommend second. Never claim improvement without evidence.

> Sections marked **[API 2.1.291]** were corrected against the type declarations the
> engine generates (`.claude-plugin/types/claude-code/index.d.ts`). Per §4, those
> declarations are authoritative; where this spec and the types disagree, the types win
> and this file gets updated.

---

## 0. Verified API surface [API 2.1.291]

What the engine actually exposes for Context Lab, verified in the generated types:

| Need | API | Notes |
| --- | --- | --- |
| Instruction files loaded | `prompt.context` → `e.instructionFiles?: InstructionFile[]` | `{ path (absolute), kind, content, parent? }`. `kind ∈ managed \| user \| project \| local \| memory`. In render order, `@` imports included. **Undefined when a hook above rewrote the `claudeMd` text** → files unknown, must be shown as such. Fires per conversation's first user message (cached; re-fired on compaction, `/clear`, `$.ui.invalidate`). |
| Load order | array index of `instructionFiles` | no explicit field |
| Context blocks | `prompt.context` → `e.blocks: { name, text }[]` | `claudeMd`, `userEmail`, `attachedProject`, `currentDate`, plugin blocks |
| Nested CLAUDE.md delivery | `prompt.attachment` with `type: "nested_memory"` | Attachments the engine injects mid-conversation. **Makes nested delivery observable** (see §12). Kind names are build-dependent: match by name, fail soft. |
| Engine's nested walk | `$.fs.ancestors({ names, of, below })` | Same walk the engine uses for nested CLAUDE.md; used to produce INFERRED/AVAILABLE nodes |
| Session totals | `session.measure` (push) and `$.session.usage()` (pull) | `context: { tokens?, window, percent? }`, `cost?: { usd }`, `rateLimits[]`. Missing figures are omitted by the engine, never zeroed. |
| Per-category / per-file tokens | `$.session.usage({ breakdown: "summary" })` | `breakdown.memoryFiles[]: { path, type, tokens }`, `categories[]`, `skills`, `mcpTools`, `agents`, `apiUsage`. `summary` = engine-local estimate, **no network**. `full` = one token-count request per file → network, opt-in only (§10). |
| Skills | `skill.prompt` → `{ skill, text }` | text as the skill computed it |
| Subagents | `agent.spawn` → `{ tool_use_id, prompt, description, subagentType, provider, model?, parentModel, agentId? }` | |
| Commands | `$.command.register({ name, description })` in `session.start` + `command.run` hook returning `{ text }` | `e.args` is everything after the name |
| UI | `$.ui.open({ id, title })` + `ui.render` on `{ component: "Pane", requestId }` | |
| Live state | `atom(ref, initial)` / `read` / `update` from `claude-code`, declared in `types/index.d.ts` | survives hot reload |
| Cross-session state | `$.store` | one JSON per plugin (≈4 MiB), not per project |
| Files | `$.fs.read/write/list/exists/stat/ancestors` | no append/rename; native paths on Windows |
| Processes | `$.process.run(argv, { cwd, env, stdin, timeoutMs })` | no shell; ≤10 min per call; `exitCode`, `stdout`, `stderr` |
| Engine version | `$.session.version()` → `{ version, base?, builtAt? }` | |

Host constraints (learned building the previous adapter on this build):

- The hooks module runs with **no Node and no DOM**. All business logic lives in pure
  TypeScript modules that take plain data; only `hooks/register.tsx` and `hooks/runtime/`
  touch `$`.
- `claude plugin validate` requires `$` be spelled `$.noun.method(...)` at call sites and
  only passed to top-level functions; `$.fs` cannot be passed as a value (wrap in closures).
- `claude plugin test .` runs **every** `*.test.ts` in the repo inside the no-Node sandbox.
  Therefore: plugin-harness tests are `*.test.ts`; pure-logic Node tests are `*.spec.ts`
  (`node --test`). This replaces the `tests/*.test.ts` naming in the original §43.
- No `crypto` module in the sandbox: hashing uses a pure-TS SHA-256 (`hooks/metrics/hash.ts`).

---

## 1. Product definition

Context Lab is a Claude Code Mod that answers four questions:

1. What context is Claude actually receiving?
2. Where does that context come from?
3. Which parts appear redundant, stale, unnecessarily always-on, or structurally inefficient?
4. Does changing that context architecture measurably improve agent performance?

Context Lab must behave like a **profiler**. It is not a prompt-writing assistant, not a
generic token counter, and not an LLM that reads `CLAUDE.md` and gives subjective advice.

```text
CPU profiler     → where execution time goes
Memory profiler  → where memory goes
Context Lab      → where agent context goes, and whether it earns its cost
```

The product optimizes for **Agent Quality / Context Cost**, not minimum context size.

---

## 2. V1 success definition

A user enters an arbitrary Claude Code repository, installs Context Lab, runs
`/context-lab` and sees:

```text
CONTEXT LAB

Context                         71,420 / 200,000

Instructions                     ~8,320
├── ~/.claude/CLAUDE.md          ~1,110
├── ./CLAUDE.md                  ~3,640
├── .claude/rules/api.md         ~1,480
├── .claude/rules/tests.md         ~690
└── nested instructions          ~1,400

Runtime
├── conversation
├── tools
└── other

Issues                              4
├── 2 redundant sections
├── 1 stale path
└── 1 large always-on section
```

`/context-lab tree` shows the architecture:

```text
SESSION CONTEXT
│
├── USER INSTRUCTIONS
│   └── ~/.claude/CLAUDE.md
├── PROJECT INSTRUCTIONS
│   ├── ./CLAUDE.md
│   ├── .claude/rules/api.md
│   └── .claude/rules/tests.md
├── DYNAMIC
│   └── skill: testing
└── INFERRED
    └── src/api/CLAUDE.md
```

Every node is explicitly classified: `● OBSERVED`, `◐ INFERRED`, `○ AVAILABLE`.
**Context Lab must never present inferred context as observed context.**

`/context-lab issues` returns evidence-backed findings.

V1 also contains a basic controlled evaluation mechanism comparing `BASELINE` vs
`CONTEXT VARIANT` on user-defined coding tasks with deterministic graders, closing the loop:

```text
OBSERVE → ANALYZE → PROPOSE → EXPERIMENT → MEASURE
```

---

## 3. Non-goals for V1

Do NOT attempt: automatic rewriting of the CLAUDE.md architecture, automatic semantic
architecture generation, automatic production changes, multi-model benchmarking, cloud
dashboard, team collaboration, central telemetry, SaaS backend, cross-machine sync,
AI-generated "intelligence score".

Do not invent `Context quality = 94/100`, `Agent intelligence = 87%`, `Prompt score = A+`.
Those metrics have no defensible meaning. V1 produces measurements, issues, experiments and
evidence.

---

## 4. Technical foundation

Mods are Claude Code plugins whose behaviour lives in a function-hooks module exposing
`register(on, options)`. Hooks intercept engine events and participate in the chain via
`next(...)`. The API is early access and may change between releases.

Minimum supported Claude Code: **2.1.287**.

At development time Context Lab MUST use the type declarations generated by the installed
Claude Code (laid into `.claude-plugin/types/` on every load; not committed):

```text
claude --plugin-dir .          # lays .claude-plugin/types/ for this build
claude plugin validate .
claude plugin test .
npm run typecheck:plugin
```

**The generated declarations are authoritative.**

---

## 5. Existing work we reuse

- **`agents-md` (Anthropic)** — behavioural reference for `prompt.context`. The
  `claude-code` repository is governed by Anthropic's commercial terms: study the public Mod
  API, do **not** copy proprietary source. Our observer is implemented independently.
- **Community `context-bar`** (MIT) — reference for context visualization (category bars,
  AbovePrompt UI, live updates). Code may be adapted with attribution in
  `THIRD_PARTY_NOTICES.md`.
- **Community Mod template** — plugin.json / hooks.json / register / state contracts /
  tests; state through the engine's mechanisms, not module globals.
- **Blast Radius** (Apache-2.0, Anthropic DevRel playground) — reference for process
  execution, interactive UI, event interception, pane behaviour, tests.

Anything adapted is recorded in `THIRD_PARTY_NOTICES.md` before it is merged.

---

## 6. Repository structure [API 2.1.291]

```text
.
├── .claude-plugin/plugin.json
├── hooks/
│   ├── hooks.json                 → { "modules": ["./register.tsx"] }
│   ├── register.tsx               the only file that touches `$`: atoms, $.store, doctor probe,
│   │                              events → pure modules (validator rule, DECISIONS D-002)
│   ├── observers/                 pure: event payload → graph changes
│   │   ├── context-observer.ts    prompt.context
│   │   ├── attachment-observer.ts prompt.attachment (nested_memory)       [Phase 2b]
│   │   ├── skill-observer.ts      skill.prompt                            [Phase 3]
│   │   └── agent-observer.ts      agent.spawn                             [Phase 3]
│   ├── analysis/                  pure deterministic analyzers            [Phase 4]
│   │   ├── sections.ts  duplicates.ts  stale-paths.ts
│   │   ├── discoverability.ts  size-analysis.ts  issue-engine.ts
│   ├── graph/
│   │   ├── graph.ts               domain model
│   │   ├── graph-builder.ts       immutable updates
│   │   └── graph-selectors.ts     tree / totals
│   ├── metrics/
│   │   ├── hash.ts                pure SHA-256
│   │   ├── size.ts                chars, bytes, ~tokens, formatting
│   │   └── usage.ts               SessionUsage → SessionUsageSnapshot
│   ├── eval/                      [Phase 7] config runner worktree grader statistics report
│   ├── commands/
│   │   └── context-lab.ts         arg parsing + text views (pure)
│   └── ui/                        [Phase 5] pane views
├── types/index.d.ts               PluginState contract for $.state
├── tests/
│   ├── *.spec.ts                  Node tests of pure modules (node --test)
│   └── context-lab.test.ts        plugin-harness tests (claude plugin test)
├── fixtures/ simple-project/ redundant-project/ nested-project/
├── SPEC.md  README.md  DECISIONS.md  SECURITY.md  THIRD_PARTY_NOTICES.md
└── tsconfig.json  tsconfig.plugin.json
```

Keep `register.tsx` thin. Business logic must not live there.

---

## 7. Core domain model

```typescript
type EvidenceLevel = "observed" | "inferred" | "available";

type ContextKind =
  | "managed" | "user" | "project" | "local" | "memory"
  | "skill" | "runtime" | "unknown";

interface ContextNode {
  id: string;
  path?: string;
  name: string;
  kind: ContextKind;
  evidence: EvidenceLevel;
  parentId?: string;
  loadOrder?: number;
  contentHash?: string;
  characters?: number;
  bytes?: number;
  estimatedTokens?: number;
  /** Engine's own per-file estimate from usage breakdown "summary", when available. */
  engineTokens?: number;
  firstSeenAt?: number;
  lastSeenAt?: number;
  loadCount: number;
  sessionCount: number;
  metadata: Record<string, unknown>;
}

interface ContextEdge {
  from: string;
  to: string;
  type: "contains" | "loads" | "imports" | "triggers" | "inherits" | "possible-nested";
  evidence: "observed" | "inferred";
}

interface ContextGraph {
  nodes: Record<string, ContextNode>;
  edges: ContextEdge[];
  capturedAt: number;
  sessionId?: string;
}
```

IDs are deterministic: `sha256(kind + "\0" + canonicalPath)` (skills: `sha256("skill\0" + name)`).
**Deviation from the draft** (`kind + path + contentHash`): including the content hash would
create a new node every time a file is edited, breaking "same file observed twice does not
duplicate node" and per-file load counts. The content hash is a node attribute; a change of
hash is recorded as `metadata.contentChanges`. See DECISIONS.md D-003.

Canonical paths: forward slashes, drive letter lower-cased, no trailing slash.

---

## 8. Observability pipeline — `prompt.context` [API 2.1.291]

Highest-value event. Observe only in V1; never modify.

```typescript
on("prompt.context", async ($, e, next) => {
  const result = await next(e)
  try { await recordContext($, result) } catch (err) { logDebug($, err) }
  return result
})
```

Read `result.instructionFiles` (what is actually sent after every hook below us).
For every instruction file: create/update node, mark OBSERVED, record kind, path, parent
(`imports` edge from parent), order (array index), content hash, size; increment
`loadCount`; increment `sessionCount` the first time it is seen in a session.

If `instructionFiles` is `undefined` while a `claudeMd` block exists, another hook rewrote the
text: record a single node `kind: "unknown"` named `claudeMd (rewritten by a hook)` with the
block's size, OBSERVED, and say so in the UI. Never guess the files behind it.

Never persist raw file contents outside the current process by default (§39).

---

## 9. Runtime context measurements [API 2.1.291]

Sources: `session.measure` (pushed after each main-thread turn) and `$.session.usage()`.

```typescript
interface SessionUsageSnapshot {
  contextUsed?: number;        // usage.context.tokens
  contextCapacity?: number;    // usage.context.window
  contextPercent?: number;     // usage.context.percent
  inputTokens?: number;        // breakdown.apiUsage.input_tokens (when breakdown fetched)
  outputTokens?: number;       // breakdown.apiUsage.output_tokens
  cacheReadTokens?: number;    // breakdown.apiUsage.cache_read_input_tokens
  cacheWriteTokens?: number;   // breakdown.apiUsage.cache_creation_input_tokens
  costUsd?: number;            // usage.cost.usd
  autoCompactThreshold?: number;
  measuredAt: number;
}
```

Missing data = `undefined`. Never fabricate values.

---

## 10. Per-file token measurement [API 2.1.291]

Three tiers, always labelled with their source:

| Tier | Source | Network | Rendering |
| --- | --- | --- | --- |
| Local estimate (DEFAULT) | `ceil(characters / 4)` computed by Context Lab | none | `~3.6k` |
| Engine estimate (DEFAULT when available) | `$.session.usage({ breakdown: "summary" })` → `memoryFiles[].tokens` | none | `~3.6k` (engine) |
| Exact count (OPT-IN) | `$.session.usage({ breakdown: "full" })` (one token-count request per file) | **yes** | `3,612` |

Estimated tokens MUST always render with `~`. The exact tier is OFF by default, explicit
opt-in via config, clearly discloses network transmission, never silently enabled.
V1 is valid without it.

---

## 11. Dynamic context

Observe `skill.prompt`, `agent.spawn`, `tool.call` where the generated declarations support
them.

**Skills:** `skill.prompt` → `ContextNode(kind="skill", evidence="observed")`, recording
skill id, time, activation count, size of `text`. This distinguishes always-on instructions
from progressively disclosed ones.

**Agents:** `agent.spawn` only to understand topology: agent type, parent (`agentId`), fork
status (`subagentType === "fork"`), model. No Mission-Control-level visualization in V1.

---

## 12. Nested context [API 2.1.291]

The draft assumed nested CLAUDE.md delivery could not be observed. On 2.1.291 the engine
emits a `prompt.attachment` of `type: "nested_memory"` when it attaches a nested instruction
file. Therefore:

| Situation | Evidence |
| --- | --- |
| `nested_memory` attachment observed and its path attributable from the attachment | `● OBSERVED` |
| Instruction file found by `$.fs.ancestors({ names: ["CLAUDE.md", "AGENTS.md"], of: readFile, below: root })` after a Read, but no attachment observed | `◐ INFERRED` |
| Instruction file present in the repo, never read-adjacent, never delivered | `○ AVAILABLE` |

An inferred node becomes observed **only** when an event confirms it. Attachment kind names
are build-dependent: match by name, fail soft, and fall back to the inferred path when the
attachment carries no attributable path. The attachment text's format is not part of the
typed API; parsing it is a heuristic and must be covered by `doctor` (§38).

Implementation notes (verified live on 2.1.291, fixture `nested-project`):

- The attachment text carries one `Contents of <absolute path> (<description>):` header per
  file; `hooks/observers/nested-observer.ts` splits on it. Attachments with no recognizable
  header are counted as unattributed and shown by `doctor`, never guessed.
- Only the main conversation's attachments count (`agentId` absent), and only when the text
  reaching Context Lab is not `null` (dropped by a hook beneath).
- Inference uses `$.fs.ancestors({ names: ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"],
  of, below: root })` after a successful Read inside the project, once per directory per context.
- AVAILABLE comes from a bounded breadth-first listing (≤1500 dirs, depth ≤6, skipping
  dependency/build/dot folders except `.claude`) run only by `/context-lab tree`; names
  `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`.
- Marks are per context: the graph keeps `nested`, `inferred`, `available` id lists reset at
  each `prompt.context`; a node's own `evidence` is the strongest it ever had (history).

---

## 13. Analyzer A — exact duplication

Split Markdown by headings, normalize, hash each section.

```text
DUPLICATE_CONTEXT
Similarity: exact
Potential duplicated characters: 22
Evidence: deterministic
```

## 14. Analyzer B — lexical overlap

normalize → lowercase → strip formatting → tokenize words → 5-word shingles → Jaccard.

```text
>= 0.85     HIGH overlap
0.70–0.85   MEDIUM overlap
< 0.70      not flagged
```

Never call this semantic similarity. Call it **lexical overlap**.

## 15. Analyzer C — stale paths

Extract probable repository paths (backticked paths, `./x`, `dir/` tokens with a slash and a
plausible extension or trailing slash) and check existence. Do not flag ordinary English.

Implementation rules (from dogfooding real CLAUDE.md files, DECISIONS D-014):
- a path is only reported when its first segment exists (anchored): `src/legacy/x.ts` with
  `src/` present, never `width/height/fps` or a path relative to some other base;
- generated or local-only paths (`dist/`, `out/`, `build/`, `*-out/`, `.env*`…) are never stale;
- alternatives (`system_a/b/c`, `.ttf/.otf`) and elisions (`a/.../b.md`) are not paths;
- code fences are skipped (trees belong to §16); one issue per file and path, every line listed;
- line numbers are located in the file on disk (the delivered text lost comments/frontmatter).

```text
STALE_REFERENCE
CLAUDE.md:82  →  src/services/legacy-api.ts
Repository: path does not exist
Evidence: filesystem check
Confidence: HIGH
```

## 16. Analyzer D — repository-discoverable context

Conservative V1 patterns: large directory trees, long explicit file inventories, generated
module listings. If most listed entries exist in the filesystem → `DISCOVERABLE_CONTEXT`,
"candidate for on-demand discovery", **requires eval before removal**. Never auto-delete.

Thresholds are read from `.context-lab/config.json` when present (`largeSectionEstimatedTokens`,
`overlapHigh`, `overlapMedium`, `discoverableMinRatio`); out-of-range values keep the defaults.

## 17. Analyzer E — large always-on sections

Flag large project instruction sections (default `largeSectionEstimatedTokens: 1000`,
configurable). The threshold means **investigate**, not remove. Report observed load frequency
and size as evidence.

---

## 18. Issue model

```typescript
interface ContextIssue {
  id: string;
  type: "duplicate" | "lexical-overlap" | "stale-reference" | "discoverable" | "large-always-on";
  severity: "info" | "low" | "medium" | "high";
  evidence: "observed" | "deterministic" | "inferred" | "experimental";
  nodeIds: string[];
  title: string;
  explanation: string;
  estimatedSavings?: number;
  requiresEval: boolean;
}
```

Never use an LLM-generated confidence score in V1.

## 19. Evidence model

Every recommendation states why it exists:

```text
Finding       Large repository tree in CLAUDE.md
Evidence      OBSERVED       Loaded 19/19 times
              DETERMINISTIC  47/49 listed paths exist in repository
              SIZE           ~1,184 tokens
              EXPERIMENTAL   Not tested
Recommendation  Evaluate moving it out of always-on context.
Confidence      NOT YET EXPERIMENTALLY VERIFIED
```

## 20. Scientific foundation

Context is a finite resource; optimize for a small, high-signal set of tokens; just-in-time
retrieval and progressive disclosure are useful strategies; long-context models do not use
all positions equally ("Lost in the Middle"). Hypothesis, tested per repository:

```text
MORE CONTEXT ≠ AUTOMATICALLY BETTER
LESS CONTEXT ≠ AUTOMATICALLY BETTER
HIGHER SIGNAL / CONTEXT may improve agent performance.
```

---

## 21–23. UI

`/context-lab` opens a pane (Phase 5; until then the command prints the same views as text).
Plain terminal UI only. No browser, no images. Must work on macOS, Linux and Windows
terminals. Views: Overview `[o]`, Tree `[t]`, Issues `[i]`, Experiments `[e]`. Legend always
visible: `● observed  ◐ inferred  ○ available`.

## 24. Report — `/context-lab report`

Writes `.context-lab/reports/<timestamp>.md` only after the explicit command: environment,
architecture, instruction files, sizes, load counts, issues, evidence, experiment results,
limitations. No raw transcript.

## 25. Persistent project data — `/context-lab init`

Context Lab creates nothing inside a repository until `/context-lab init`:

```text
.context-lab/
├── config.json
├── evals/tasks/
├── variants/
├── results/
└── reports/
```

Recommended `.gitignore`: `.context-lab/results/`, `.context-lab/reports/`.

---

## 26–36. Evaluation system

- `/context-lab eval <variant>` compares baseline vs variant under controlled conditions.
- **Task schema** (`.context-lab/evals/tasks/*.yaml`): `id`, `prompt`, `grader.command`,
  `timeout_seconds`. Prefer deterministic graders (tests, typecheck, lint, static analysis,
  DB assertions) over LLM-as-judge.
- **Variant format**: `.context-lab/variants/<name>/manifest.json` + `files/` overlay.
  Variants are written by users in V1.
- **Isolation**: require Git and a clean working tree, else refuse with:
  "Context Lab eval refused. Evaluation requires a clean Git state so every trial can start
  from the same repository snapshot. Commit or stash changes first."
  Per trial: SHA → temporary `git worktree` → apply variant → run Claude task
  (`claude -p` via `$.process.run`, ≤10 min per call) → run grader → record → remove worktree.
  Baseline gets its own fresh worktree too.
- **Controls**: same SHA, task, Claude Code version, model config, permission config,
  timeout, machine, grader. Alternate order per task (candidate→baseline, baseline→candidate…).
- **Trials**: `trialsPerTask` (default 3). Smoke test: 5 tasks × 2 variants × 1 trial.
  Evidence: ≥20 real tasks, multiple trials.
- **TrialResult**: `taskId, variant, trial, success, durationMs, inputTokens?, outputTokens?,
  costUsd?, graderExitCode, claudeVersion, gitSha, startedAt`. Unknown usage = `undefined`.
- **Metrics**: primary Task Success Rate; secondary context size, input/output tokens,
  duration, cost; derived successes/1M input tokens, cost/success, tokens/success.
  No combined magic score.
- **Statistics**: mean, median, absolute and percentage difference, 95% bootstrap CI
  resampled **at task level**, seeded RNG for tests.
- **Guardrail**: `maxAcceptedQualityRegressionPp: 3`, `minContextReductionPercent: 10`.
  `PROMISING` = reduction ≥ threshold AND observed regression ≤ tolerance. `SUPPORTED` only
  when the CI meets the configured criterion. Wording: "Context savings: CLEAR / Quality
  improvement: NOT ESTABLISHED / Quality regression: NOT OBSERVED WITH CURRENT POWER" —
  never "Variant is 4% smarter".

---

## 37. Command surface

One root command: `/context-lab [overview|tree|issues|init|report|eval <variant>|doctor]`.
No command proliferation.

## 38. Doctor — `/context-lab doctor`

Checks: Claude Code version (≥ 2.1.287), function hooks, whether `prompt.context`,
`session.measure`, `skill.prompt`, `prompt.attachment` have been observed this session,
Git available, repo status, project root, session usage API, usage breakdown, filesystem
access, eval prerequisites. Events can be hooked but only *proven* by having fired: doctor
reports `observed` / `not yet observed`, never claims an event works without evidence.

## 39. State management

Live state through `$.state` atoms (survive hot reloads). Lightweight cross-session
telemetry in `$.store`, keyed by canonical project root.

```typescript
interface ContextLabState {
  graph: ContextGraph;
  issues: ContextIssue[];
  usage?: SessionUsageSnapshot;
  ui: { currentView: "overview" | "tree" | "issues" | "experiments"; selectedIssue?: string };
}
```

Never persist conversation content, tool outputs, source code, or full instruction contents.
Allowed: content hashes, sizes, paths, load counts, issue metadata, experiment summaries.

## 40. Privacy and network

Default `NETWORK = OFF`, `MODEL CALLS = 0`. Analysis works locally. Remote capabilities
(exact token counts) are separately enabled.

## 41. Threat model

Scan: read-only. Normal session: no shell commands needed for analysis (doctor and eval may
run `git`). Report: writes only `.context-lab/`. Eval: may invoke git, Claude Code and
configured graders. Network: none directly by default. Automatic code or CLAUDE.md
modification: forbidden. External commands use argv arrays (`$.process.run` has no shell);
never concatenate repository text into a command line.

## 42. Failure behaviour

Fail open. Observer hooks wrap their work in try/catch, log to the debug log, and always
return `next(e)`'s result. Only explicit `/context-lab …` commands surface errors.

## 43. Test requirements

Unit tests (Node `*.spec.ts` for pure modules, `*.test.ts` for the plugin harness) MUST cover:

- prompt.context creates observed nodes
- same file observed twice does not duplicate node; loadCount increments correctly
- parent relationship preserved
- rewritten `claudeMd` (no `instructionFiles`) is shown as unknown, never guessed
- exact duplicate detection; lexical overlap; stale path detector; directory-tree detection
- inferred nodes never become observed unless an event confirms them
- missing usage fields remain undefined
- no raw content persisted
- bootstrap calculation deterministic with seeded RNG
- dirty repository blocks eval; baseline and variant start from same SHA

## 44. Fixture projects

- `simple-project/` — `CLAUDE.md`, `src/`, `tests/` → 1 observed project instruction, 0 issues.
- `redundant-project/` — `CLAUDE.md` + `.claude/rules/testing.md` repeating the testing
  section → lexical overlap detected.
- `nested-project/` — `CLAUDE.md`, `src/api/CLAUDE.md`, `src/api/service.ts` → before Read:
  root observed, nested available; after Read without attachment: nested inferred; after a
  `nested_memory` attachment: nested observed.

## 45. Performance budgets

Observers return the engine's result immediately and record in the background
(`/context-lab` awaits in-flight work before drawing). The usage breakdown costs ~1 s on
2.1.291, so after a turn it is fetched only when the context has files not yet asked about.
prompt.context observer < 10 ms typical; issue analysis < 50 ms on a small repo; UI refresh
< 16 ms; filesystem scans cached/debounced by path + mtime + content hash; never recursively
scan huge repos on every event.

## 46. Research principles encoded in V1

P1 Context is finite. P2 Maximize useful signal, not minimum tokens. P3 Cheaply retrievable
information may not need to be always-on. P4 Progressive disclosure can reduce unnecessary
context. P5 Longer context can create retrieval/attention problems. P6 No change is better
merely because it is shorter. P7 Repository-specific eval results override generic heuristics.

---

## 47. Development sequence

Build in this order. Each phase's acceptance gate must pass before the next.

| Phase | Deliver | Gate | Status |
| --- | --- | --- | --- |
| 1 Skeleton | plugin loads, `/context-lab` works, test harness, doctor | `claude plugin validate .` + `claude plugin test .` + `npm test` pass | done (gates pass; live load pending) |
| 2 Context observer | `prompt.context` → ContextNode/Graph, observed hierarchy, `/context-lab tree` | tree shows real loaded instruction architecture | done in harness; verify live |
| 2b Nested | `prompt.attachment` nested_memory + `$.fs.ancestors` inference + bounded available scan | nested fixture behaves per §44 | done; verified live on 2.1.291 |
| 3 Usage | `session.measure`, usage snapshot, engine per-file estimates; skills/agents observers | overview shows real context use | usage done; skill/agent observers todo |
| 4 Analyzers | duplicates, lexical overlap, stale paths, discoverable, large always-on | fixture tests pass, zero LLM calls | done; dogfooded on 8 local repos |
| 5 UI | Overview / Tree / Issues pane | — | todo |
| 6 Reports | `/context-lab report` | — | todo |
| 7 Eval harness | init, schemas, clean-git guard, worktrees, grader, trials, statistics, experiment UI | — | todo |
| 8 Dogfood | profile this repo, one variant, baseline vs variant, results in README | — | todo |

## 48. Definition of Done

- [ ] installs on a fresh supported Claude Code
- [ ] validates with `claude plugin validate`
- [ ] all tests pass with `claude plugin test` and `npm test`
- [ ] `/context-lab` opens correctly
- [ ] actual `prompt.context` instructions appear; hierarchy is correct
- [ ] observed and inferred context cannot be confused
- [ ] total context usage appears where supported
- [ ] file/section sizes appear
- [ ] duplicate, lexical overlap, stale path, discoverable detection work
- [ ] reports work
- [ ] eval init, baseline and variant experiments work in isolated Git worktrees
- [ ] grader results captured; statistics produced
- [ ] raw conversations not persisted; no network calls by default
- [ ] no instruction file is automatically modified
- [ ] README documents API limitations; THIRD_PARTY_NOTICES is correct
- [ ] Context Lab successfully profiles itself

## 49. README demo V1 must be capable of showing

```text
> /context-lab
Context               64.2k / 200k
Instructions                ~7.8k
4 instruction files observed
1 nested file inferred
3 potential issues

> /context-lab issues
1. CLAUDE.md > Repository structure   ~1.1k tokens   96% filesystem-discoverable
2. CLAUDE.md > Tests                  overlaps rules/tests.md by 89%
3. CLAUDE.md:124                      references src/old/auth.ts which no longer exists

> /context-lab eval compact
24 tasks × 3 trials        BASE     COMPACT
Success                    84.7%    85.4%
Context                    ~7.8k    ~4.9k
Input/task                 42.8k    37.1k
Δ success +0.7 pp   95% CI [-2.0,+3.4]   Δ context -37.2%   Δ input -13.3%
Verdict: PROMISING — large context reduction, no measurable regression detected.
```

## 50. Architecture summary

```text
                   CLAUDE CODE
                        │
              FUNCTION HOOK EVENTS
      ┌─────────────────┼──────────────────────┐
prompt.context   session.measure   prompt.attachment / skill.prompt / agent.spawn
      └─────────────────┼──────────────────────┘
                        ▼
                 OBSERVERS (pure)
                        ▼
                  CONTEXT GRAPH
             ┌──────────┴──────────┐
      STATIC ANALYSIS         LIVE PROFILER
             └──────────┬──────────┘
                        ▼
                 EVIDENCE ENGINE
          ┌─────────────┴─────────────┐
      UI / REPORT                EVAL HARNESS → BASELINE vs VARIANT → EVIDENCE
```

## 51. Product rule

> Context Lab must never recommend deleting context merely because it uses tokens. It should
> identify candidates for improvement and use reproducible evidence to determine whether a
> context architecture is actually better.

## 52. V1 → V2 boundary

Only after V1 works: automatic architecture proposals, LLM-assisted contradiction detection,
semantic redundancy, automatic CLAUDE.md → Skill migrations, attribution by task type,
Bayesian analysis, multi-model comparison, historical dashboard, optimal-context search,
architecture versioning, team policies, CI regression testing.

```text
OBSERVE → DIAGNOSE → GENERATE VARIANT → EVALUATE → SELECT → DEPLOY → OBSERVE
```

V1 stops just before automatic generation/deployment. That is intentional.
