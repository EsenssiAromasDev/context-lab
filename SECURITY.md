# Security

Context Lab runs inside Claude Code as trusted code. Its rules (SPEC §40–42):

| Activity | Allowed |
| --- | --- |
| Observing context | read-only; no shell commands, no network, no model calls |
| Persisting | paths, hashes, sizes, counts in `$.store`; never file contents, transcripts or tool output |
| `/context-lab doctor` | `git --version`, `git rev-parse HEAD`, `git status --porcelain` (argv, no shell) |
| `/context-lab report` / `init` | writes only under `.context-lab/`; init never overwrites a file |
| `/context-lab eval` | `git worktree add/remove` under `<repo parent>/.context-lab-worktrees/` (or `worktreeDir`), `claude -p` in each worktree with `--permission-mode acceptEdits` by default, the task's grader; never the working tree; results under `.context-lab/results/` |
| Modifying code or instruction files | forbidden |
| Exact token counts | opt-in only; sends instruction text to Anthropic's token-count endpoint |

Grader commands are split into argv without a shell; pipes, `&&`, redirections and `$` are
refused. Claude Code in a trial runs with the permissions `claudeArgs` gives it (default
`acceptEdits`): tasks come from the repository's own `.context-lab/evals/tasks/`, so review them
as you would any script you run.

Every external command is an argv array through `$.process.run` (no shell). Repository text
is never concatenated into a command line.

Observer hooks fail open: an error is logged to the debug log and the engine's result is
returned unchanged.

Report vulnerabilities privately to the maintainer rather than in a public issue.
