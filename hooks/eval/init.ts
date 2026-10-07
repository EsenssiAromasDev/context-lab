import { defaultConfigText } from "./config.ts"

// `/context-lab init` (SPEC §25): the only command that creates
// `.context-lab/`. It never overwrites a file that exists.

export interface InitFile {
  path: string
  text: string
}

export const EXAMPLE_TASK = `# Copy to <id>.yaml to enable it. Files ending .yaml/.yml/.json here are eval tasks.
id: example-task

prompt: |
  Describe the change Claude should make, as you would in a session.
  Be specific about the expected behavior.

grader:
  # Runs in the trial's worktree, without a shell (no pipes, &&, redirections).
  # Exit code 0 = success. Files under .context-lab/evals/graders/ are copied
  # into the worktree just before grading (hidden from Claude while it works).
  command: "npm test"

timeout_seconds: 600
`

export const VARIANTS_README = `# Context variants

One folder per variant:

    <name>/
      manifest.json      { "name", "description", "createdFrom", "changes": [{ "file", "reason" }], "delete": [] }
      files/             copied over the project root in the variant's trials

\`files/CLAUDE.md\` replaces CLAUDE.md; \`"delete": ["CLAUDE.md"]\` removes it instead.
Run with \`/context-lab eval <name>\`: baseline and variant start from the same commit.
`

export const GRADERS_README = `# Graders

Files here are copied into each trial's worktree after Claude finishes and before
the task's grader runs. They are hidden from Claude during the trial.
`

export function initFiles(): InitFile[] {
  return [
    { path: ".context-lab/config.json", text: defaultConfigText() },
    { path: ".context-lab/.gitignore", text: "results/\nreports/\n" },
    { path: ".context-lab/evals/tasks/example.yaml.example", text: EXAMPLE_TASK },
    { path: ".context-lab/evals/graders/README.md", text: GRADERS_README },
    { path: ".context-lab/variants/README.md", text: VARIANTS_README },
  ]
}

export function renderInit(created: readonly string[], kept: readonly string[]): string {
  const lines = ["Context Lab initialized.", ""]
  for (const p of created) lines.push(`  created  ${p}`)
  for (const p of kept) lines.push(`  kept     ${p} (exists, not overwritten)`)
  lines.push(
    "",
    "Next:",
    "  1. Add tasks to .context-lab/evals/tasks/ (see example.yaml.example)",
    "  2. Add a variant under .context-lab/variants/<name>/",
    "  3. Commit, then /context-lab eval <name>",
    "",
    "results/ and reports/ are git-ignored by .context-lab/.gitignore.",
  )
  return lines.join("\n")
}
