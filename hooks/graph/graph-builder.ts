import { sha256 } from "../metrics/hash.ts"
import type { ContextEdge, ContextGraph, ContextKind, ContextNode, EvidenceLevel } from "./graph.ts"

// Immutable graph updates. Every function returns a new graph; inputs are
// never mutated (graphs come out of $.state frozen).

/** Forward slashes, lower-case drive letter, no trailing slash. */
export function canonicalPath(path: string): string {
  let p = path.replace(/\\/g, "/")
  p = p.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`)
  if (p.length > 1 && p.endsWith("/") && !/^[a-z]:\/$/.test(p)) p = p.slice(0, -1)
  return p
}

/**
 * Deterministic node id: sha256(kind \0 key), key the canonical path (or a
 * skill's name). Content is deliberately not part of the id (DECISIONS D-003).
 */
export function nodeId(kind: ContextKind, key: string): string {
  return sha256(`${kind}\0${key}`)
}

const RANK: Record<EvidenceLevel, number> = { available: 0, inferred: 1, observed: 2 }

/** Evidence only ever rises; an inferred node becomes observed only by an observation. */
export function strongest(a: EvidenceLevel, b: EvidenceLevel): EvidenceLevel {
  return RANK[a] >= RANK[b] ? a : b
}

export interface NodePatch {
  id: string
  name: string
  kind: ContextKind
  evidence: EvidenceLevel
  path?: string
  parentId?: string
  loadOrder?: number
  contentHash?: string
  characters?: number
  bytes?: number
  estimatedTokens?: number
  engineTokens?: number
}

/**
 * Inserts or updates a node. `load` counts it as delivered once more (only
 * meaningful for observed evidence); `sessionId` drives sessionCount.
 */
export function upsertNode(
  graph: ContextGraph,
  patch: NodePatch,
  at: number,
  load: { counted: boolean; sessionId?: string | undefined },
): ContextGraph {
  const prev = graph.nodes[patch.id]
  const metadata: Record<string, unknown> = { ...(prev?.metadata ?? {}) }

  if (prev?.contentHash !== undefined && patch.contentHash !== undefined && prev.contentHash !== patch.contentHash) {
    metadata.contentChanges = Number(metadata.contentChanges ?? 0) + 1
  }

  let loadCount = prev?.loadCount ?? 0
  let sessionCount = prev?.sessionCount ?? 0
  if (load.counted) {
    loadCount += 1
    if (load.sessionId === undefined || metadata.lastSessionId !== load.sessionId) {
      sessionCount += 1
      if (load.sessionId !== undefined) metadata.lastSessionId = load.sessionId
    }
  }

  const next: ContextNode = {
    ...(prev ?? {}),
    ...stripUndefined(patch),
    id: patch.id,
    name: patch.name,
    kind: patch.kind,
    evidence: prev ? strongest(prev.evidence, patch.evidence) : patch.evidence,
    firstSeenAt: prev?.firstSeenAt ?? at,
    lastSeenAt: at,
    loadCount,
    sessionCount,
    metadata,
  }
  return { ...graph, nodes: { ...graph.nodes, [patch.id]: next }, capturedAt: at }
}

export function addEdge(graph: ContextGraph, edge: ContextEdge): ContextGraph {
  const i = graph.edges.findIndex((e) => e.from === edge.from && e.to === edge.to && e.type === edge.type)
  if (i === -1) return { ...graph, edges: [...graph.edges, edge] }
  const old = graph.edges[i]!
  if (old.evidence === "observed" || edge.evidence === "inferred") return graph
  const edges = graph.edges.slice()
  edges[i] = { ...old, evidence: "observed" }
  return { ...graph, edges }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
