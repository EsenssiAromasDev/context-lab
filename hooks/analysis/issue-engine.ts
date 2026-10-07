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
import { historyBlock } from "./history.ts"
import { splitSections, type Section, type SourceText } from "./sections.ts"
import { anchorPaths, candidatePaths, extractPathRefs, staleRefs } from "./stale-paths.ts"

// Issue engine (SPEC §13–19): deterministic analyzers over the text Claude was
// actually sent, each finding carrying the evidence it rests on. No model
// calls, no scores, no recommendation to delete anything without an eval.

export type IssueType = "duplicate" | "lexical-overlap" | "stale-reference" | "discoverable" | "large-always-on" | "history-log"
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
  /** What it is, in a few plain words. */
  title: string
  /** What happens, in one plain sentence. */
  explanation: string
  /** What the person can do about it. */
  action: string
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
    return `Claude lo ha recibido en ${Math.min(n?.loadCount ?? 0, contexts)} de ${contexts} conversaciones vistas`
  }
  const sourceNote = (ids: readonly string[]): EvidenceLine[] =>
    input.sources.some((s) => ids.includes(s.nodeId) && s.fromDisk)
      ? [{ label: "SOURCE", text: "Leído del archivo en disco (el texto exacto que recibió Claude ya no estaba en memoria)" }]
      : []

  for (const g of exactDuplicates(sections)) {
    const ids = unique(g.sections.map((s) => s.nodeId))
    issues.push({
      id: issueId("duplicate", g.sections.map(where)),
      type: "duplicate",
      severity: g.estimatedSavings >= 50 ? "medium" : "low",
      evidence: "deterministic",
      nodeIds: ids,
      title: "Texto repetido",
      explanation: `El mismo texto está en ${g.sections.length} sitios, así que Claude lo lee ${g.sections.length} veces en cada conversación.`,
      action: "Deja una sola copia y borra las demás.",
      locations: g.sections.map(where),
      details: [
        { label: "DETERMINISTIC", text: `Son idénticos si se ignoran mayúsculas y formato (${g.duplicatedCharacters} caracteres repetidos).` },
        ...ids.map((id) => ({ label: "OBSERVED" as const, text: `${short(graph.nodes[id])}: ${loaded(id)}.` })),
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
      title: "Texto casi repetido",
      explanation: `Estas dos secciones dicen casi lo mismo: el ${Math.round(o.jaccard * 100)}% de sus frases coincide.`,
      action: "Únelas, o deja cada idea en un solo sitio.",
      locations: [where(o.a), where(o.b)],
      details: [
        { label: "DETERMINISTIC", text: "Se comparan las palabras, no el significado: confirma que de verdad dicen lo mismo." },
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
      title: "Ruta que ya no existe",
      explanation: `Las instrucciones mencionan ${r.path}, pero no existe en el proyecto.`,
      action: "Corrige la ruta o quita la referencia: Claude puede perder tiempo buscándola.",
      locations: unique(locations),
      details: [
        { label: "DETERMINISTIC", text: `Buscado en ${r.checked.map((c) => rel(c, root)).join(" y en ")}: no está.` },
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

  // A dated log is one finding, not one "large section" per entry.
  const inHistory = new Set<string>()
  for (const src of input.sources) {
    const own = sections.filter((s) => s.nodeId === src.nodeId)
    const h = historyBlock(own)
    if (!h) continue
    for (const s of own) if (h.ranges.some((r) => s.line >= r.from && s.line <= r.to)) inHistory.add(`${s.nodeId}#${s.line}`)
    const fileTokens = own.reduce((n, s) => n + s.estimatedTokens, 0)
    const share = fileTokens === 0 ? 0 : Math.round((h.estimatedTokens / fileTokens) * 100)
    issues.push({
      id: issueId("history-log", [src.nodeId]),
      type: "history-log",
      severity: h.estimatedTokens >= 5000 ? "high" : h.estimatedTokens >= 1000 ? "medium" : "low",
      evidence: "deterministic",
      nodeIds: [src.nodeId],
      title: "Bitácora con fechas que Claude lee siempre",
      explanation: `${h.entries} entradas con fecha (${approx(h.estimatedTokens)} tokens, el ${share}% del archivo) son historia del proyecto, no instrucciones, y Claude las lee en cada conversación.`,
      action: "Muévelas a un archivo aparte (p. ej. docs/claude-historial.md) y deja una línea que diga dónde están: Claude lo leerá solo cuando haga falta. /context-lab optimizar lo hace y comprueba que Claude no empeora.",
      locations: [`${src.file} (${h.entries} secciones que empiezan por una fecha)`],
      details: [
        { label: "DETERMINISTIC", text: `${h.entries} encabezados empiezan por una fecha (AAAA-MM-DD).` },
        { label: "OBSERVED", text: `${loaded(src.nodeId)}.` },
        { label: "EXPERIMENTAL", text: "Nadie ha probado todavía si quitarla empeora a Claude." },
      ],
      estimatedSavings: h.estimatedTokens,
      requiresEval: true,
    })
  }

  for (const s of sections) {
    if (s.estimatedTokens < config.largeSectionEstimatedTokens) continue
    if (inHistory.has(`${s.nodeId}#${s.line}`)) continue
    if (!graph.current.includes(s.nodeId)) continue // always-on only
    issues.push({
      id: issueId("large-always-on", [where(s)]),
      type: "large-always-on",
      severity: s.estimatedTokens >= config.largeSectionEstimatedTokens * 2 ? "low" : "info",
      evidence: "observed",
      nodeIds: [s.nodeId],
      title: "Sección grande que se carga siempre",
      explanation: `Ocupa ${approx(s.estimatedTokens)} tokens en cada conversación, la necesites o no.`,
      action: "No es un error. Si solo hace falta a veces, muévela a una skill o a un archivo aparte; antes, comprueba con /context-lab probar que Claude no empeora.",
      locations: [where(s)],
      details: [
        { label: "OBSERVED", text: `${loaded(s.nodeId)}.` },
        { label: "SIZE", text: `Se avisa a partir de ${config.largeSectionEstimatedTokens} tokens (configurable en .context-lab/config.json).` },
        { label: "EXPERIMENTAL", text: "Nadie ha probado todavía si quitarla empeora a Claude." },
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
  const what = b.kind === "tree" ? "un árbol de carpetas" : "una lista de archivos"
  return {
    id: issueId("discoverable", [`${b.nodeId}#${b.line}`]),
    type: "discoverable",
    severity: b.estimatedTokens >= 500 ? "medium" : "low",
    evidence: "deterministic",
    nodeIds: [b.nodeId],
    title: "Listado que Claude puede consultar solo",
    explanation: `Es ${what} (${approx(b.estimatedTokens)} tokens) y ${b.existing} de sus ${b.total} rutas existen: Claude puede mirar las carpetas cuando lo necesite en vez de leerlo siempre.`,
    action: "Puedes quitarlo de las instrucciones fijas. Antes, comprueba con /context-lab probar que Claude no empeora.",
    locations: [`${b.file} > ${sectionAt(sections, b.nodeId, b.line)}`],
    details: [
      { label: "OBSERVED", text: `${loaded(b.nodeId)}.` },
      { label: "DETERMINISTIC", text: `${b.existing} de ${b.total} rutas del listado existen en el proyecto (${Math.round(b.ratio * 100)}%).` },
      { label: "EXPERIMENTAL", text: "Nadie ha probado todavía si quitarlo empeora a Claude." },
    ],
    estimatedSavings: b.estimatedTokens,
    requiresEval: true,
  }
}

function where(s: Section): string {
  return `${s.file} > ${s.heading}`
}

function sectionAt(sections: readonly Section[], nodeId: string, line: number): string {
  let heading = "(inicio del archivo)"
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
