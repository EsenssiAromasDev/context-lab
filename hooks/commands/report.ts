import type { ContextIssue } from "../analysis/issue-engine.ts"
import type { ContextGraph, ContextNode } from "../graph/graph.ts"
import { displayPath, tokensOf } from "../graph/graph-selectors.ts"
import { approx, exact } from "../metrics/size.ts"
import type { SessionUsageSnapshot } from "../metrics/usage.ts"
import type { AgentRecord } from "../observers/agent-observer.ts"
import { renderExperiment, type ExperimentSummary } from "../eval/report.ts"
import { renderTree } from "./context-lab.ts"

// `/context-lab report` (SPEC §24): one Markdown file under
// .context-lab/reports/. Paths, sizes, counts, findings and experiment
// summaries — never instruction text, transcripts or tool output.

export interface ReportInput {
  at: number
  root: string
  graph: ContextGraph
  usage?: SessionUsageSnapshot
  issues: readonly ContextIssue[]
  agents: readonly AgentRecord[]
  environment: { claudeVersion?: string; gitSha?: string; gitClean?: boolean; platform: string }
  experiment?: ExperimentSummary
}

export const LIMITATIONS = [
  "Token figures marked ~ are estimates: the engine's local breakdown, or ~4 characters per token.",
  "`prompt.context` fires per conversation (and after compaction or /clear): load counts count contexts, not prompts.",
  "Nested CLAUDE.md delivery is attributed by parsing the engine's attachment text, which is not a typed API.",
  "Whether a subagent receives instruction files is not exposed by agent.spawn.",
  "Stale paths are reported only when the path's first directory exists.",
  "Findings are candidates for evaluation, not verdicts: nothing is changed automatically.",
]

export function reportFileName(at: number): string {
  return `${new Date(at).toISOString().replace(/[:.]/g, "-")}.md`
}

export function renderReport(r: ReportInput): string {
  const out: string[] = []
  const date = new Date(r.at).toISOString()
  out.push("# Context Lab report", "", `Generated ${date}.`, "")

  out.push("## Environment", "")
  out.push(`| | |`, `| --- | --- |`)
  out.push(`| Claude Code | ${r.environment.claudeVersion ?? "unknown"} |`)
  out.push(`| Git commit | ${r.environment.gitSha ?? "not a git repository"} |`)
  if (r.environment.gitClean !== undefined) out.push(`| Working tree | ${r.environment.gitClean ? "clean" : "has uncommitted changes"} |`)
  out.push(`| Platform | ${r.environment.platform} |`)
  out.push(`| Contexts observed | ${r.graph.contexts} |`, "")

  out.push("## Context use", "")
  const u = r.usage
  if (u?.contextCapacity === undefined) out.push("Not measured in this session.", "")
  else {
    out.push(`Context ${u.contextUsed === undefined ? "?" : exact(u.contextUsed)} / ${exact(u.contextCapacity)} tokens${u.contextPercent === undefined ? "" : ` (${u.contextPercent}%)`}.`, "")
    if (u.categories?.length) {
      out.push("| Category (engine estimate) | Tokens |", "| --- | ---: |")
      for (const c of u.categories) out.push(`| ${c.name} | ${approx(c.tokens)} |`)
      out.push("")
    }
    if (u.skillListing) out.push(`Skill listing (always-on): ${approx(u.skillListing.tokens)} tokens, ${u.skillListing.includedSkills}/${u.skillListing.totalSkills} skills listed.`, "")
  }

  out.push("## Context architecture", "", "```text", renderTree({ graph: r.graph, usage: r.usage, root: r.root, agents: r.agents }), "```", "")

  out.push("## Instruction files", "")
  const rows = [
    ...r.graph.current.map((id) => [id, "always-on"] as const),
    ...r.graph.nested.map((id) => [id, "nested (observed)"] as const),
    ...r.graph.inferred.map((id) => [id, "nested (inferred)"] as const),
    ...r.graph.available.map((id) => [id, "available"] as const),
    ...r.graph.skills.map((id) => [id, "skill (activated)"] as const),
  ]
  if (rows.length === 0) out.push("None observed.", "")
  else {
    out.push("| File | Role | Kind | ~Tokens | Loads | Sessions | Content hash |", "| --- | --- | --- | ---: | ---: | ---: | --- |")
    for (const [id, role] of rows) {
      const n = r.graph.nodes[id]
      if (n) out.push(`| ${label(n, r.root)} | ${role} | ${n.kind} | ${approx(tokensOf(n))} | ${n.loadCount} | ${n.sessionCount} | ${n.contentHash?.slice(0, 12) ?? ""} |`)
    }
    out.push("")
  }

  out.push("## Issues", "")
  if (r.issues.length === 0) out.push("No issues found by the deterministic analyzers.", "")
  r.issues.forEach((i, k) => {
    out.push(`### ${k + 1}. ${i.severity.toUpperCase()} — ${i.title}`, "")
    for (const loc of i.locations) out.push(`- ${loc}`)
    out.push("", i.explanation, "")
    for (const d of i.details) out.push(`- **${d.label}** ${d.text}`)
    if (i.requiresEval) out.push("- **Status** NOT EXPERIMENTALLY TESTED")
    out.push("")
  })

  out.push("## Experiments", "")
  if (r.experiment) out.push("```text", renderExperiment(r.experiment), "```", "")
  else out.push("No experiment results in .context-lab/results/.", "")

  out.push("## Limitations", "", ...LIMITATIONS.map((l) => `- ${l}`), "")
  out.push("_No instruction text, conversation or tool output is included in this report._", "")
  return out.join("\n")
}

function label(n: ContextNode, root: string): string {
  return (n.path === undefined ? n.name : displayPath(n.path, root)).replace(/\|/g, "\\|")
}
