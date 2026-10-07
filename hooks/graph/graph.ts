// The Context Graph (SPEC §7). Plain JSON data: it lives in $.state, is
// persisted to $.store, and never carries file contents (SPEC §39).

export type EvidenceLevel = "observed" | "inferred" | "available"

export type ContextKind =
  | "managed"
  | "user"
  | "project"
  | "local"
  | "memory"
  | "skill"
  | "runtime"
  | "unknown"

export interface ContextNode {
  id: string
  path?: string
  name: string
  kind: ContextKind
  evidence: EvidenceLevel
  parentId?: string
  /** Position in the most recent context this node was observed in. */
  loadOrder?: number
  contentHash?: string
  characters?: number
  bytes?: number
  /** Local estimate (~chars/4). Always rendered with "~". */
  estimatedTokens?: number
  /** The engine's own estimate (usage breakdown "summary"), when it gave one. */
  engineTokens?: number
  firstSeenAt?: number
  lastSeenAt?: number
  /** Contexts (prompt.context firings) this node was observed in. */
  loadCount: number
  /** Distinct sessions this node was observed in. */
  sessionCount: number
  metadata: Record<string, unknown>
}

export type EdgeType = "contains" | "loads" | "imports" | "triggers" | "inherits" | "possible-nested"

export interface ContextEdge {
  from: string
  to: string
  type: EdgeType
  evidence: "observed" | "inferred"
}

export interface ContextGraph {
  nodes: Record<string, ContextNode>
  edges: ContextEdge[]
  capturedAt: number
  sessionId?: string
  /** Ids of the instruction nodes in the latest observed context, in load order. */
  current: string[]
  /** Contexts observed in total, and how many had their files hidden by a rewrite. */
  contexts: number
  rewrittenContexts: number
}

export function emptyGraph(at = 0): ContextGraph {
  return { nodes: {}, edges: [], capturedAt: at, current: [], contexts: 0, rewrittenContexts: 0 }
}

/**
 * A graph read back from $.store, for a new session: counts and history kept,
 * `current` cleared (an earlier session's context is not this one's).
 * Anything that does not look like a graph is dropped, not repaired.
 */
export function restoreGraph(value: unknown): ContextGraph | null {
  if (typeof value !== "object" || value === null) return null
  const g = value as Partial<ContextGraph>
  if (typeof g.nodes !== "object" || g.nodes === null || !Array.isArray(g.edges)) return null
  if (typeof g.contexts !== "number" || typeof g.capturedAt !== "number") return null
  return {
    nodes: g.nodes,
    edges: g.edges,
    capturedAt: g.capturedAt,
    current: [],
    contexts: g.contexts,
    rewrittenContexts: typeof g.rewrittenContexts === "number" ? g.rewrittenContexts : 0,
  }
}
