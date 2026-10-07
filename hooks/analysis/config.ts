import { DEFAULT_ANALYSIS, type AnalysisConfig } from "./issue-engine.ts"

// Analyzer thresholds from .context-lab/config.json (SPEC §17, §25). Only
// known numeric keys within sane bounds are taken; anything else keeps the
// default. A threshold means "investigate", never "remove".

const BOUNDS: Record<keyof AnalysisConfig, [number, number]> = {
  largeSectionEstimatedTokens: [50, 1_000_000],
  overlapHigh: [0.01, 1],
  overlapMedium: [0.01, 1],
  discoverableMinRatio: [0.01, 1],
}

export function parseAnalysisConfig(text: string | undefined): AnalysisConfig {
  const config = { ...DEFAULT_ANALYSIS }
  if (text === undefined) return config
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return config
  }
  if (typeof raw !== "object" || raw === null) return config
  const src = raw as Record<string, unknown>
  for (const key of Object.keys(BOUNDS) as (keyof AnalysisConfig)[]) {
    const v = src[key]
    const [lo, hi] = BOUNDS[key]
    if (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi) config[key] = v
  }
  if (config.overlapMedium > config.overlapHigh) config.overlapMedium = config.overlapHigh
  return config
}
