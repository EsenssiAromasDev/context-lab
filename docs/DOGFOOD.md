# Dogfood: Context Lab on its own repository

SPEC §47 Phase 8, run on 2026-10-07 with Claude Code 2.1.291 on Windows, commit `927e337`.

## 1. Profile

A real session at the repository root, with the Mod loaded (`claude --plugin-dir .`). This is
what `prompt.context` reported and the analyzers found:

```text
SESSION CONTEXT
│
├─ ● PROJECT
│  └─ ● ./CLAUDE.md  ~203  ×1
│
└─ ● MEMORY
   └─ ● ~/.claude/projects/C--Users-jairo-Desktop-CLAUDE-CORE/memory/MEMORY.md  ~77  ×1

● observed  ◐ inferred  ○ available
```

- Always-on instructions: 2 files, about 280 tokens (engine estimates).
- Issues: **0**. No duplicates, no overlap, no stale paths, no listings, nothing large.

There was nothing to trim here: the repository keeps its instructions small on purpose. So the
useful question is not "what can be removed" but **whether the ~200 tokens of CLAUDE.md earn
their cost at all**.

## 2. Experiment: `baseline` vs `no-claude-md`

- **Variant:** `.context-lab/variants/no-claude-md`, which deletes `CLAUDE.md`. Project
  instructions drop from ~206 to 0.
- **Tasks:** five real changes to this code base, in `.context-lab/evals/tasks/`. Each is graded
  by a new test plus the whole existing suite (`node --test`), so a regression fails the task.
- **Checked beforehand:** every grader fails on the commit, and passes once the task is done by
  hand.
- **Settings:** model `haiku`, 1 trial per task (the smoke-test size allowed by §31),
  `--permission-mode acceptEdits --strict-mcp-config` in both arms.
- **How it ran:** `node scripts/eval.ts no-claude-md`. Each trial got its own git worktree of
  `927e337` outside the repository, with `.context-lab/` hidden from Claude. Arms alternated
  first, and every worktree was removed afterwards.

```text
CONTEXT EXPERIMENT

baseline vs no-claude-md
Run 2026-10-07T17-22-49-057Z-no-claude-md · git 927e337dc2 · Claude Code 2.1.291 · model haiku
Tasks 5 · trials/task 1

QUALITY
────────────────────────────────
                          BASELINE        NO-CLAUDE-MD
Pass rate                 100.0%          100.0%
Δ (task-weighted)         +0.0 pp
95% bootstrap CI          [+0.0, +0.0] pp
Trials with errors        0               0

CONTEXT
────────────────────────────────
Project instructions      ~206            ~0
Δ                         -100.0%

COST
────────────────────────────────
Input tokens / trial      224.8k          153.3k
Δ input                   -31.8%
Output tokens / trial     2,187           1,648
Cost / trial              $0.058          $0.046
Cost / success            $0.058          $0.046
Successes / 1M input      4.4             6.5
Median duration           25.9 s          20.9 s

VERDICT
────────────────────────────────
PROMISING

Context savings: CLEAR (-100.0% project instructions)
Quality improvement: NOT ESTABLISHED
Quality regression: NOT OBSERVED WITH CURRENT POWER
The variant reduces context and no meaningful regression was observed.
Only 5 task(s): 20+ real tasks are needed before calling it SUPPORTED.
```

Per trial:

| Task | Baseline | No CLAUDE.md |
| --- | --- | --- |
| count-by-kind | PASS 24 s | PASS 21 s |
| format-percent | PASS 26 s | PASS 15 s |
| ls-alias | PASS 40 s | PASS 29 s |
| overlap-label | PASS 26 s | PASS 32 s |
| short-hash | PASS 25 s | PASS 15 s |

## 3. What this does and does not show

- **The harness works end to end on a real repository.** Worktrees came from one SHA, the
  variant was applied, the graders stayed hidden until grading, cost and token figures were
  captured, and the statistics and the verdict were produced.
- **Quality: no difference, but the experiment could not have found one.** Every trial in both
  arms passed, so the tasks are too easy to discriminate (a ceiling effect). The [0, 0] interval
  is a symptom of that, not evidence of "no effect". A real answer needs harder tasks, the
  repository's own conventions put to the test (for example "add a test" where the naming rule
  in CLAUDE.md matters), 20 or more tasks, and several trials each.
- **The −31.8% in input tokens is NOT caused by the 206 tokens removed.** 206 tokens cannot
  account for ~71k fewer input tokens per trial. The difference comes from how much the agent
  explored in each trial (turns, files read, cache), which varies a lot between single trials.
  With 5 tasks × 1 trial it is noise until shown otherwise. This is why the verdict rests on
  pass rate and on the size of the instructions, not on input tokens.
- **Verdict: PROMISING, not SUPPORTED, and that is correct.** Removing CLAUDE.md looks harmless
  on these tasks, but nothing here justifies deleting it. Per the product rule (SPEC §51), the
  file stays.

## Reproduce

```text
node scripts/eval.ts no-claude-md        # from the repository root, clean tree
```

Results land in `.context-lab/results/<run>/` as `trials.json`, `summary.json` and `report.md`.
That folder is git-ignored.
