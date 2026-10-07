import { DEFAULT_ANALYSIS } from "../analysis/issue-engine.ts"

// Eval settings from .context-lab/config.json (SPEC §31, §35). The guardrail
// defaults are practical tolerances, not scientific constants: configurable.

export interface EvalConfig {
  trialsPerTask: number
  /** PROMISING/SUPPORTED tolerate at most this drop in pass rate (percentage points). */
  maxAcceptedQualityRegressionPp: number
  /** A variant must cut project instruction tokens by at least this much to be PROMISING. */
  minContextReductionPercent: number
  /** SUPPORTED needs at least this many tasks (SPEC §31: 20–50 real tasks). */
  minTasksForSupport: number
  bootstrapIterations: number
  seed: number
  /** `--model` for every trial; absent, Claude Code's default — the same for both arms. */
  model?: string
  /** How to start Claude Code, as argv; absent, resolved (`claude`, or its Windows shim). */
  claude?: string[]
  /** Extra arguments for every trial, after `-p <prompt> --output-format json`. */
  claudeArgs: string[]
  /** Where trial worktrees go; absent, `<repo parent>/.context-lab-worktrees/<repo name>`. */
  worktreeDir?: string
  graderTimeoutSeconds: number
}

export const DEFAULT_EVAL: EvalConfig = {
  trialsPerTask: 3,
  maxAcceptedQualityRegressionPp: 3,
  minContextReductionPercent: 10,
  minTasksForSupport: 20,
  bootstrapIterations: 2000,
  seed: 1,
  claudeArgs: ["--permission-mode", "acceptEdits"],
  graderTimeoutSeconds: 600,
}

/** `$.process.run` allows ten minutes per call; longer timeouts are clamped to it. */
export const MAX_PROCESS_SECONDS = 600

const NUMBERS: Record<string, [number, number]> = {
  trialsPerTask: [1, 100],
  maxAcceptedQualityRegressionPp: [0, 100],
  minContextReductionPercent: [0, 100],
  minTasksForSupport: [1, 10_000],
  bootstrapIterations: [100, 100_000],
  seed: [0, 2 ** 31],
  graderTimeoutSeconds: [1, MAX_PROCESS_SECONDS],
}

export function parseEvalConfig(text: string | undefined): EvalConfig {
  const config: EvalConfig = { ...DEFAULT_EVAL, claudeArgs: [...DEFAULT_EVAL.claudeArgs] }
  if (text === undefined) return config
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return config
  }
  if (typeof raw !== "object" || raw === null) return config
  const src = raw as Record<string, unknown>
  for (const [key, [lo, hi]] of Object.entries(NUMBERS)) {
    const v = src[key]
    if (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi) (config as unknown as Record<string, number>)[key] = v
  }
  if (typeof src.model === "string" && src.model.trim()) config.model = src.model.trim()
  if (isArgv(src.claude)) config.claude = src.claude
  if (isArgv(src.claudeArgs) || (Array.isArray(src.claudeArgs) && src.claudeArgs.length === 0)) config.claudeArgs = src.claudeArgs as string[]
  if (typeof src.worktreeDir === "string" && src.worktreeDir.trim()) config.worktreeDir = src.worktreeDir.trim()
  return config
}

function isArgv(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === "string" && a.length > 0)
}

/** The config.json `/context-lab init` writes: every default, spelled out. */
export function defaultConfigText(): string {
  const { model: _m, claude: _c, worktreeDir: _w, ...evalDefaults } = DEFAULT_EVAL
  return `${JSON.stringify({ ...DEFAULT_ANALYSIS, ...evalDefaults }, null, 2)}\n`
}
