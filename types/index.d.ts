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
  skills: string[]
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
  skillListing?: { totalSkills: number; includedSkills: number; tokens: number }
  measuredAt: number
}

/** Mirrors hooks/analysis/issue-engine.ts: locations and evidence, never file contents. */
export interface ContextIssue {
  id: string
  type: "duplicate" | "lexical-overlap" | "stale-reference" | "discoverable" | "large-always-on"
  severity: "info" | "low" | "medium" | "high"
  evidence: "observed" | "deterministic" | "inferred" | "experimental"
  nodeIds: string[]
  title: string
  explanation: string
  action: string
  locations: string[]
  details: { label: "OBSERVED" | "DETERMINISTIC" | "SIZE" | "EXPERIMENTAL" | "SOURCE"; text: string }[]
  estimatedSavings?: number
  requiresEval: boolean
}

export interface AgentRecord {
  toolUseId: string
  agentId?: string
  parentAgentId?: string
  type: string
  provider: string
  fork: boolean
  background: boolean
  teammate: boolean
  model?: string
  denied: boolean
  at: number
}

declare module "claude-code" {
  interface PluginState {
    "context-lab": {
      graph: ContextGraph
      usage: SessionUsageSnapshot | null
      /** Engine events observed this session, by name: what doctor can prove. */
      seen: Record<string, number>
      /** Subagents spawned this session: topology only, never their prompts. */
      agents: AgentRecord[]
      /** True once the person hid the band above the prompt; /context-lab shows it again. */
      bandHidden: boolean
      /** The pane's view (SPEC §21). */
      view: "overview" | "tree" | "issues" | "experiments"
      /** The eval in progress, or the latest result, as the Experiments view shows it. */
      experiment: {
        status: "running" | "done" | "stopped" | "failed"
        runId: string
        variant: string
        done: number
        total: number
        lines: string[]
      } | null
      /** The analyzers' last findings; null until they ran this session. */
      issues: ContextIssue[] | null
      /** Canonical project root whose stored telemetry is merged into `graph`. */
      loadedFor: string | null
    }
  }
}
