# Security

Context Lab runs inside Claude Code as trusted code. Its rules (SPEC §40–42):

| Activity | Allowed |
| --- | --- |
| Observing context | read-only; no shell commands, no network, no model calls |
| Persisting | paths, hashes, sizes, counts in `$.store`; never file contents, transcripts or tool output |
| `/context-lab doctor` | `git --version`, `git rev-parse HEAD`, `git status --porcelain` (argv, no shell) |
| `/context-lab report` / `init` (future) | writes only under `.context-lab/` |
| `/context-lab eval` (future) | git worktrees, `claude -p`, the user's configured grader; never the working tree |
| Modifying code or instruction files | forbidden |
| Exact token counts | opt-in only; sends instruction text to Anthropic's token-count endpoint |

Every external command is an argv array through `$.process.run` (no shell). Repository text
is never concatenated into a command line.

Observer hooks fail open: an error is logged to the debug log and the engine's result is
returned unchanged.

Report vulnerabilities privately to the maintainer rather than in a public issue.
