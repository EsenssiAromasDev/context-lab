// Engine usage → SessionUsageSnapshot (SPEC §9). Structural input types so
// this module stays pure; the engine's SessionUsage satisfies them.
// A figure the engine does not give stays undefined. Never fabricated.

export interface UsageLike {
  context: {
    tokens?: number
    window: number
    percent?: number
    breakdown?: BreakdownLike
  }
  cost?: { usd: number }
}

export interface BreakdownLike {
  memoryFiles: readonly { path: string; type: string; tokens: number }[]
  categories: readonly { name: string; tokens: number; kind: string; isDeferred: boolean }[]
  autoCompactThreshold?: number
  apiUsage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  } | null
}

export interface UsageCategory {
  name: string
  tokens: number
  kind: string
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
  /** Engine-estimated breakdown rows (/context's), when a breakdown was fetched. */
  categories?: UsageCategory[]
  measuredAt: number
}

export function toSnapshot(usage: UsageLike, at: number): SessionUsageSnapshot {
  const s: SessionUsageSnapshot = { measuredAt: at }
  const { context } = usage
  if (isCount(context.tokens)) s.contextUsed = context.tokens
  if (isCount(context.window) && context.window > 0) s.contextCapacity = context.window
  if (isCount(context.percent)) s.contextPercent = context.percent
  if (usage.cost && isCount(usage.cost.usd)) s.costUsd = usage.cost.usd

  const b = context.breakdown
  if (b) {
    if (b.apiUsage) {
      s.inputTokens = b.apiUsage.input_tokens
      s.outputTokens = b.apiUsage.output_tokens
      s.cacheReadTokens = b.apiUsage.cache_read_input_tokens
      s.cacheWriteTokens = b.apiUsage.cache_creation_input_tokens
    }
    if (isCount(b.autoCompactThreshold)) s.autoCompactThreshold = b.autoCompactThreshold
    s.categories = b.categories
      .filter((c) => c.kind === "used" && !c.isDeferred)
      .map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind }))
  }
  return s
}

/** The engine's per-file token estimates, keyed by the path it reports. */
export function engineFileTokens(breakdown: BreakdownLike | undefined): Map<string, number> {
  const out = new Map<string, number>()
  for (const f of breakdown?.memoryFiles ?? []) out.set(f.path, f.tokens)
  return out
}

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0
}
