import type { ContextGraph, ContextNode } from "../graph/graph.ts"
import { sha256 } from "../metrics/hash.ts"
import { approx } from "../metrics/size.ts"
import {
  findListings,
  isDiscoverable,
  listingCandidates,
  scoreListing,
  type DiscoverableBlock,
} from "./discoverability.ts"
import { exactDuplicates, lexicalOverlaps } from "./duplicates.ts"
import { splitSections, type Section, type SourceText } from "./sections.ts"
import { anchorPaths, candidatePaths, extractPathRefs, staleRefs } from "./stale-paths.ts"

// Issue engine (SPEC §13–19): deterministic analyzers over the text Claude was
// actually sent, each finding carrying the evidence it rests on. No model
// calls, no scores, no recommendation to delete anything without an eval.

export type IssueType = "duplicate" | "lexical-overlap" | "stale-reference" | "discoverable" | "large-always-on"
export type Severity = "info" | "low" | "medium" | "high"
export type IssueEvidence = "observed" | "deterministic" | "inferred" | "experimental"

export interface EvidenceLine {
  label: "OBSERVED" | "DETERMINISTIC" | "SIZE" | "EXPERIMENTAL" | "SOURCE"
  text: string
}

export interface ContextIssue {
  id: string
  type: IssueType
  severity: Severity
  evidence: IssueEvidence
  nodeIds: string[]
  title: string
  explanation: string
  /** Where: `./CLAUDE.md > Testing`, `./CLAUDE.md:82`. */
  locations: string[]
  details: EvidenceLine[]
  estimatedSavings?: number
  requiresEval: boolean
}

export interface AnalysisConfig {
  largeSectionEstimatedTokens: number
  overlapHigh: number
  overlapMedium: number
  discoverableMinRatio: number
}

export const DEFAULT_ANALYSIS: AnalysisConfig = {
  largeSectionEstimatedTokens: 1000,
  overlapHigh: 0.85,
  overlapMedium: 0.7,
  discoverableMinRatio: 0.8,
}

export interface AnalyzedSource extends SourceText {
  /** True when the delivered text was unavailable and the file was read from disk. */
  fromDisk: boolean
  /** Locates a 1-based line of the analyzed text in the file on disk, when it can. */
  diskLine?: (line: number, needle: string) => number | undefined
}

export interface AnalysisInput {
  graph: ContextGraph
  sources: readonly AnalyzedSource[]
  root: string
  config?: AnalysisConfig
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 }

/** Every path the analyzers will ask about, for the caller to check on disk once. */
export function pathsToCheck(input: AnalysisInput): string[] {
  const out = new Set<string>()
  for (const src of input.sources) {
    const dir = dirOf(input.graph.nodes[src.nodeId], input.root)
    for (const ref of extractPathRefs(src)) {
      for (const p of [...candidatePaths(ref, dir, input.root), ...anchorPaths(ref, dir, input.root)]) out.add(p)
    }
    for (const listing of findListings(src)) for (const p of listingCandidates(listing, input.root)) out.add(p)
  }
  return [...out]
}

export function analyze(input: AnalysisInput, existing: ReadonlySet<string>): ContextIssue[] {
  const config = input.config ?? DEFAULT_ANALYSIS
  const { graph, root } = input
  const exists = (p: string) => existing.has(p)
  const sections = input.sources.flatMap((s) => splitSections(s))
  const issues: ContextIssue[] = []
  const contexts = Math.max(graph.contexts, 1)
  const loaded = (id: string) => {
    const n = graph.nodes[id]
    return `Loaded in ${Math.min(n?.loadCount ?? 0, contexts)}/${contexts} observed contexts`
  }
  const sourceNote = (ids: readonly string[]): EvidenceLine[] =>
    input.sources.some((s) => ids.includes(s.nodeId) && s.fromDisk)
      ? [{ label: "SOURCE", text: "Read from disk: the delivered text was not in memory (plugin reloaded)" }]
      : []

  for (const g of exactDuplicates(sections)) {
    const ids = unique(g.sections.map((s) => s.nodeId))
    issues.push({
      id: issueId("duplicate", g.sections.map(where)),
      type: "duplicate",
      severity: g.estimatedSavings >= 50 ? "medium" : "low",
      evidence: "deterministic",
      nodeIds: ids,
      title: "Exact duplicate section",
      explanation: `The same text is sent ${g.sections.length} times.`,
      locations: g.sections.map(where),
      details: [
        { label: "DETERMINISTIC", text: `Identical after normalization; ${g.duplicatedCharacters} duplicated characters` },
        ...ids.map((id) => ({ label: "OBSERVED" as const, text: `${short(graph.nodes[id])}: ${loaded(id)}` })),
        { label: "SIZE", text: `${approx(g.estimatedSavings)} tokens beyond the first copy` },
        ...sourceNote(ids),
      ],
      estimatedSavings: g.estimatedSavings,
      requiresEval: false,
    })
  }

  for (const o of lexicalOverlaps(sections, { high: config.overlapHigh, medium: config.overlapMedium })) {
    const ids = unique([o.a.nodeId, o.b.nodeId])
    issues.push({
      id: issueId("lexical-overlap", [where(o.a), where(o.b)]),
      type: "lexical-overlap",
      severity: o.level === "high" ? "medium" : "low",
      evidence: "deterministic",
      nodeIds: ids,
      title: `Lexical overlap (${o.level.toUpperCase()})`,
      explanation: "Two sections share most of their wording. Lexical overlap, not a judgement of meaning.",
      locations: [where(o.a), where(o.b)],
      details: [
        { label: "DETERMINISTIC", text: `Overlap ${Math.round(o.jaccard * 100)}% (Jaccard of 5-word shingles)` },
        { label: "SIZE", text: `Potential duplicate ${approx(o.estimatedSavings)} tokens` },
        ...sourceNote(ids),
      ],
      estimatedSavings: o.estimatedSavings,
      requiresEval: false,
    })
  }

  const stale = staleRefs(
    input.sources.flatMap((s) => extractPathRefs(s)),
    exists,
    (id) => dirOf(graph.nodes[id], root),
    root,
  )
  // One issue per file and path, listing every place it is mentioned.
  const byPath = new Map<string, typeof stale>()
  for (const r of stale) byPath.set(`${r.nodeId}:${r.path}`, [...(byPath.get(`${r.nodeId}:${r.path}`) ?? []), r])
  for (const [key, refs] of byPath) {
    const r = refs[0]!
    const src = input.sources.find((s) => s.nodeId === r.nodeId)
    const locations = refs.map((ref) => {
      const line = src?.diskLine?.(ref.line, ref.path) ?? (src?.fromDisk ? ref.line : undefined)
      return line === undefined ? `${ref.file} (${sectionAt(sections, ref.nodeId, ref.line)})` : `${ref.file}:${line}`
    })
    issues.push({
      id: issueId("stale-reference", [key]),
      type: "stale-reference",
      severity: "low",
      evidence: "deterministic",
      nodeIds: [r.nodeId],
      title: "Stale path",
      explanation: `References ${r.path}, which does not exist.`,
      locations: unique(locations),
      details: [
        { label: "DETERMINISTIC", text: `Filesystem check: not found at ${r.checked.map((c) => rel(c, root)).join(" or ")}` },
        { label: "DETERMINISTIC", text: `Confidence it names a path: ${r.confidence.toUpperCase()}` },
      ],
      requiresEval: false,
    })
  }

  for (const src of input.sources) {
    for (const listing of findListings(src)) {
      const scored = scoreListing(listing, exists, root)
      if (!isDiscoverable(scored, config.discoverableMinRatio)) continue
      issues.push(discoverableIssue(scored, sections, graph, loaded))
    }
  }

  for (const s of sections) {
    if (s.estimatedTokens < config.largeSectionEstimatedTokens) continue
    if (!graph.current.includes(s.nodeId)) continue // always-on only
    issues.push({
      id: issueId("large-always-on", [where(s)]),
      type: "large-always-on",
      severity: s.estimatedTokens >= config.largeSectionEstimatedTokens * 2 ? "low" : "info",
      evidence: "observed",
      nodeIds: [s.nodeId],
      title: "Large always-on section",
      explanation: "Sent with every conversation. Size alone is not a defect: a candidate for evaluation.",
      locations: [where(s)],
      details: [
        { label: "OBSERVED", text: loaded(s.nodeId) },
        { label: "SIZE", text: `${approx(s.estimatedTokens)} tokens (threshold ${config.largeSectionEstimatedTokens}, configurable)` },
        { label: "EXPERIMENTAL", text: "Not tested" },
      ],
      requiresEval: true,
    })
  }

  return issues.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.estimatedSavings ?? 0) - (a.estimatedSavings ?? 0),
  )
}

function discoverableIssue(
  b: DiscoverableBlock,
  sections: readonly Section[],
  graph: ContextGraph,
  loaded: (id: string) => string,
): ContextIssue {
  const what = b.kind === "tree" ? "Repository tree" : "File inventory"
  const always = graph.current.includes(b.nodeId)
  return {
    id: issueId("discoverable", [`${b.nodeId}#${b.line}`]),
    type: "discoverable",
    severity: b.estimatedTokens >= 500 ? "medium" : "low",
    evidence: "deterministic",
    nodeIds: [b.nodeId],
    title: `${what} ${always ? "permanently loaded" : "in context"}`,
    explanation: "Most entries can be listed from the filesystem on demand. Candidate for on-demand discovery; requires eval before removal.",
    locations: [`${b.file} > ${sectionAt(sections, b.nodeId, b.line)}`],
    details: [
      { label: "OBSERVED", text: loaded(b.nodeId) },
      { label: "DETERMINISTIC", text: `${b.existing}/${b.total} listed paths exist in the repository (${Math.round(b.ratio * 100)}%)` },
      { label: "SIZE", text: `${approx(b.estimatedTokens)} tokens` },
      { label: "EXPERIMENTAL", text: "Not tested" },
    ],
    estimatedSavings: b.estimatedTokens,
    requiresEval: true,
  }
}

function where(s: Section): string {
  return `${s.file} > ${s.heading}`
}

function sectionAt(sections: readonly Section[], nodeId: string, line: number): string {
  let heading = "(preamble)"
  for (const s of sections) if (s.nodeId === nodeId && s.line <= line) heading = s.heading
  return heading
}

function dirOf(node: ContextNode | undefined, root: string): string {
  const p = node?.path
  return p === undefined ? root : p.slice(0, p.lastIndexOf("/")) || root
}

function rel(path: string, root: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

function short(n: ContextNode | undefined): string {
  return n?.name ?? "?"
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

function issueId(type: IssueType, keys: readonly string[]): string {
  return sha256(`${type}\0${[...keys].sort().join("\0")}`).slice(0, 12)
}

/** Issue counts by severity, for the overview. */
export function countBySeverity(issues: readonly ContextIssue[]): Record<Severity, number> {
  const out: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 }
  for (const i of issues) out[i.severity]++
  return out
}
