// Context Lab's $.state contract (SPEC §39). Self-contained by rule of the
// validator, so the shapes below mirror hooks/graph/graph.ts and
// hooks/metrics/usage.ts; `npm run typecheck:plugin` fails if they drift.
// Only lightweight telemetry: paths, hashes, sizes, counts. Never contents.

export type EvidenceLevel = "observed" | "inferred" | "available"
export type ContextKind = "managed" | "user" | "project" | "local" | "memory" | "skill" | "runtime" | "unknown"

export interface ContextNode {
  id: string
  path?: string
  name: string
  kind: ContextKind
  evidence: EvidenceLevel
  parentId?: string
  loadOrder?: number
  contentHash?: string
  characters?: number
  bytes?: number
  estimatedTokens?: number
  engineTokens?: number
  firstSeenAt?: number
  lastSeenAt?: number
  loadCount: number
  sessionCount: number
  metadata: Record<string, unknown>
}

export interface ContextEdge {
  from: string
  to: string
  type: "contains" | "loads" | "imports" | "triggers" | "inherits" | "possible-nested"
  evidence: "observed" | "inferred"
}

export interface ContextGraph {
  nodes: Record<string, ContextNode>
  edges: ContextEdge[]
  capturedAt: number
  sessionId?: string
  current: string[]
  nested: string[]
  inferred: string[]
  available: string[]
  contexts: number
  rewrittenContexts: number
}

export interface SessionUsageSnapshot {
  contextUsed?: number
  contextCapacity?: number
  contextPercent?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number
  autoCompactThreshold?: number
  categories?: { name: string; tokens: number; kind: string }[]
  measuredAt: number
}

declare module "claude-code" {
  interface PluginState {
    "context-lab": {
      graph: ContextGraph
      usage: SessionUsageSnapshot | null
      /** Engine events observed this session, by name: what doctor can prove. */
      seen: Record<string, number>
      /** Canonical project root whose stored telemetry is merged into `graph`. */
      loadedFor: string | null
    }
  }
}
