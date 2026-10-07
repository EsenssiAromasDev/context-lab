import { countBySeverity, type ContextIssue } from "../analysis/issue-engine.ts"
import type { ContextGraph } from "../graph/graph.ts"
import {
  LEGEND,
  MARK,
  contextTree,
  currentInstructions,
  displayPath,
  instructionTokens,
  nestedInstructions,
  nestedTokens,
  tokensOf,
  type TreeItem,
} from "../graph/graph-selectors.ts"
import { approx, exact } from "../metrics/size.ts"
import type { SessionUsageSnapshot } from "../metrics/usage.ts"

// /context-lab: argument parsing and the text views (SPEC §21–23, §37–38).
// Pure: register.tsx gathers the facts, these functions only format them.

export const MIN_VERSION = "2.1.287"

export type View = "overview" | "tree" | "issues" | "init" | "report" | "eval" | "doctor" | "help"

export interface Parsed {
  view: View
  /** `eval <variant>`'s variant. */
  arg?: string
  /** A word that names no view. */
  unknown?: string
}

const VIEWS = new Set<View>(["overview", "tree", "issues", "init", "report", "eval", "doctor", "help"])

export function parseArgs(args: string): Parsed {
  const [word, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  if (word === undefined) return { view: "overview" }
  const w = word.toLowerCase()
  if (!VIEWS.has(w as View)) return { view: "help", unknown: word }
  const view = w as View
  return rest.length ? { view, arg: rest.join(" ") } : { view }
}

export interface ViewInput {
  graph: ContextGraph
  usage: SessionUsageSnapshot | undefined
  root: string | undefined
  /** Findings of the analyzers; undefined when they were not run. */
  issues?: readonly ContextIssue[]
}

export function renderOverview(input: ViewInput): string {
  const { graph, usage, root } = input
  const lines = ["CONTEXT LAB", ""]
  lines.push(row("Context", contextFigure(usage)))
  if (usage?.contextPercent !== undefined) lines.push(bar(usage.contextPercent))
  lines.push("")

  const files = currentInstructions(graph)
  if (graph.contexts === 0) {
    lines.push("Instructions          not observed yet")
    lines.push("  (prompt.context fires with the conversation's first message)")
  } else {
    lines.push(row("Always-on instructions", approx(instructionTokens(graph))))
    for (const n of files) {
      lines.push(row(`${MARK[n.evidence]} ${displayPath(n.path, root) || n.name}`, approx(tokensOf(n)), 2))
    }
    if (files.length === 0) lines.push("  (no instruction files in the latest context)")
  }

  const nested = nestedInstructions(graph)
  if (nested.length) {
    lines.push("", row("Nested (attached on read)", approx(nestedTokens(graph))))
    for (const n of nested) lines.push(row(`${MARK.observed} ${displayPath(n.path, root)}`, approx(tokensOf(n)), 2))
  }
  if (graph.inferred.length) {
    const s = graph.inferred.length === 1 ? "" : "s"
    lines.push(`${MARK.inferred} ${graph.inferred.length} nested file${s} inferred (found after a Read, delivery not seen)`)
  }

  if (usage?.categories?.length) {
    lines.push("", "Runtime (engine estimate)")
    for (const c of usage.categories) lines.push(row(c.name, approx(c.tokens), 2))
  }
  if (usage?.costUsd !== undefined) lines.push("", row("Session cost", `$${usage.costUsd.toFixed(2)}`))

  lines.push("")
  if (input.issues === undefined) lines.push("Issues                not analyzed")
  else if (input.issues.length === 0) lines.push(row("Issues", "0"))
  else {
    const c = countBySeverity(input.issues)
    lines.push(row("Issues", String(input.issues.length)))
    for (const sev of ["high", "medium", "low", "info"] as const) if (c[sev]) lines.push(row(sev.toUpperCase(), String(c[sev]), 2))
  }
  lines.push("", LEGEND)
  lines.push("/context-lab tree · issues · doctor")
  return lines.join("\n")
}

export function renderTree({ graph, root }: ViewInput): string {
  const lines = ["SESSION CONTEXT", "│"]
  const groups = contextTree(graph)
  if (groups.length === 0) {
    lines.push("└── (nothing observed yet)")
  }
  groups.forEach((group, gi) => {
    const lastGroup = gi === groups.length - 1
    lines.push(`${lastGroup ? "└─" : "├─"} ${MARK[group.evidence]} ${group.label}`)
    const pad = lastGroup ? "   " : "│  "
    drawItems(group.items, pad, root, lines)
    if (!lastGroup) lines.push("│")
  })
  if (graph.rewrittenContexts > 0) {
    lines.push("", `Note: ${graph.rewrittenContexts} context(s) had claudeMd rewritten by a hook; files behind it unknown.`)
  }
  lines.push("", LEGEND)
  return lines.join("\n")
}

function drawItems(items: TreeItem[], pad: string, root: string | undefined, out: string[]): void {
  items.forEach((item, i) => {
    const last = i === items.length - 1
    const n = item.node
    const label = n.kind === "skill" || n.kind === "unknown" ? n.name : displayPath(n.path, root)
    const size = approx(tokensOf(n))
    const loads = item.evidence === "observed" ? `  ×${n.loadCount}` : ""
    const from = typeof n.metadata.inferredFrom === "string" && item.evidence === "inferred" ? `  ← ${n.metadata.inferredFrom}` : ""
    out.push(`${pad}${last ? "└─" : "├─"} ${MARK[item.evidence]} ${label}  ${size}${loads}${from}`)
    drawItems(item.children, pad + (last ? "   " : "│  "), root, out)
  })
}

export interface DoctorFacts {
  version?: string
  observed: Readonly<Record<string, number>>
  git: { available: boolean; version?: string }
  repo: { isRepo: boolean; clean?: boolean; dirty?: number; sha?: string }
  root?: string
  usageApi: boolean
  breakdown: boolean
  fs: boolean
}

export const WATCHED_EVENTS = ["prompt.context", "session.measure", "prompt.attachment", "tool.call", "skill.prompt", "agent.spawn"]

/** Counters register.tsx keeps in `observed` for nested_memory attribution. */
export const NESTED_SEEN = "nested_memory"
export const NESTED_FILES = "nested_memory:files"
export const NESTED_UNATTRIBUTED = "nested_memory:unattributed"

export function renderDoctor(f: DoctorFacts): string {
  const ok = "✓"
  const no = "✗"
  const lines = ["Context Lab Doctor", ""]
  const versionOk = f.version !== undefined && compareVersions(f.version, MIN_VERSION) >= 0
  lines.push(row(`Claude Code ${f.version ?? "(unknown)"}`, versionOk ? ok : `${no} needs >= ${MIN_VERSION}`))
  lines.push(row("Function hooks", ok))
  for (const ev of WATCHED_EVENTS) {
    const n = f.observed[ev] ?? 0
    lines.push(row(ev, n > 0 ? `${ok} observed ×${n}` : "hooked, not yet observed"))
  }
  const attachments = f.observed[NESTED_SEEN] ?? 0
  const unattributed = f.observed[NESTED_UNATTRIBUTED] ?? 0
  if (attachments === 0) lines.push(row("nested_memory attribution", "no nested attachment seen yet"))
  else if (unattributed === 0) lines.push(row("nested_memory attribution", `${ok} ${f.observed[NESTED_FILES] ?? 0} file(s) from ${attachments}`))
  else lines.push(row("nested_memory attribution", `${no} ${unattributed}/${attachments} unattributed (text format changed?)`))
  lines.push("")
  lines.push(row("Git", f.git.available ? `${ok} ${f.git.version ?? ""}`.trim() : `${no} not found`))
  if (!f.repo.isRepo) lines.push(row("Repository", "not a git repository"))
  else lines.push(row("Repository clean", f.repo.clean ? ok : `${no} ${f.repo.dirty ?? "?"} changed path(s)`))
  lines.push(row("Project root", f.root ?? "(unknown)"))
  lines.push(row("Filesystem access", f.fs ? ok : no))
  lines.push("")
  lines.push(row("Session usage API", f.usageApi ? ok : no))
  lines.push(row("Per-file engine estimates", f.breakdown ? `${ok} (summary, local)` : "unavailable"))
  lines.push(row("Exact token attribution", "off (opt-in, network)"))
  lines.push(row("Local estimates", ok))
  lines.push("")
  const evalReady = f.git.available && f.repo.isRepo && f.repo.clean === true
  const ready = versionOk && f.fs && f.usageApi
  lines.push(`Status: ${ready ? "READY" : "DEGRADED"}${ready && !evalReady ? " (eval needs a clean git repository)" : ""}`)
  return lines.join("\n")
}

export function renderHelp(p: Parsed): string {
  const lines: string[] = []
  if (p.unknown) lines.push(`Unknown view "${p.unknown}".`, "")
  lines.push(
    "/context-lab              overview of the context Claude receives",
    "/context-lab tree         the context architecture (observed / inferred / available)",
    "/context-lab issues       evidence-backed findings",
    "/context-lab doctor       what this Claude Code exposes to Context Lab",
    "/context-lab init         create .context-lab/ for evals",
    "/context-lab report       write a report to .context-lab/reports/",
    "/context-lab eval <name>  baseline vs context variant",
  )
  return lines.join("\n")
}

export const PENDING: Partial<Record<View, string>> = {
  init: "init arrives with the eval harness (Phase 7, SPEC §25). Nothing was written.",
  report: "report arrives in Phase 6 (SPEC §24). Nothing was written.",
  eval: "eval arrives in Phase 7 (SPEC §26–36). Nothing was run.",
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10))
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10))
  for (let i = 0; i < 3; i++) {
    const d = (Number.isNaN(pa[i]) ? 0 : (pa[i] ?? 0)) - (Number.isNaN(pb[i]) ? 0 : (pb[i] ?? 0))
    if (d !== 0) return d
  }
  return 0
}

function contextFigure(u: SessionUsageSnapshot | undefined): string {
  if (u?.contextCapacity === undefined) return "not measured yet"
  const used = u.contextUsed === undefined ? "?" : exact(u.contextUsed)
  return `${used} / ${exact(u.contextCapacity)}`
}

function bar(percent: number, width = 30): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${percent}%`
}

function row(label: string, value: string, indent = 0): string {
  const left = " ".repeat(indent) + label
  const width = 34
  return left.length >= width ? `${left}  ${value}` : left.padEnd(width) + value
}


/** /context-lab issues: every finding with the evidence it rests on (SPEC §19, §23). */
export function renderIssues(issues: readonly ContextIssue[], graph: ContextGraph): string {
  const lines = ["CONTEXT ISSUES", ""]
  if (graph.contexts === 0) {
    lines.push("Nothing observed yet: issues are found in the context Claude was actually sent.")
    return lines.join("\n")
  }
  if (issues.length === 0) {
    lines.push("No issues found by the deterministic analyzers.")
    lines.push("(duplicates, lexical overlap, stale paths, discoverable listings, large always-on sections)")
    return lines.join("\n")
  }
  issues.forEach((issue, i) => {
    lines.push(`[${i + 1}] ${issue.severity.toUpperCase()}  ${issue.title}`)
    for (const loc of issue.locations) lines.push(`    ${loc}`)
    lines.push(`    ${issue.explanation}`)
    for (const d of issue.details) lines.push(`    ${d.label.padEnd(13)} ${d.text}`)
    if (issue.requiresEval) lines.push("    Status:       NOT EXPERIMENTALLY TESTED")
    lines.push("")
  })
  lines.push("Findings are candidates, not verdicts. Nothing is changed automatically.")
  return lines.join("\n")
}
