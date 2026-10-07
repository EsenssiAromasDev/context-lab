import { approx, exact } from "../metrics/size.ts"
import type { EvalConfig } from "./config.ts"
import { bootstrapDiff, mean, median, percentDiff, taskMean, type PairedTask } from "./statistics.ts"

// Trial results → experiment summary → the text a person reads (SPEC §32–36).
// Primary metric: task success rate. No combined score; the verdict wording
// says what the evidence does and does not establish.

export type Arm = "baseline" | "variant"

export interface TrialResult {
  taskId: string
  variant: string
  arm: Arm
  trial: number
  success: boolean
  durationMs: number
  /** Input tokens processed, cache reads and writes included; undefined when not reported. */
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  /** Local estimate of the project instruction files in the trial's worktree. */
  contextTokens?: number
  graderExitCode: number
  claudeExitCode: number
  claudeVersion: string
  gitSha: string
  startedAt: number
  /** Why the trial could not be judged normally (timeout, Claude error), when it could not. */
  error?: string
}

export type Verdict = "SUPPORTED" | "PROMISING" | "NOT PROMISING" | "INCONCLUSIVE"

export interface ArmSummary {
  trials: number
  passRate?: number
  contextTokens?: number
  inputTokensPerTrial?: number
  medianInputTokens?: number
  outputTokensPerTrial?: number
  costPerTrial?: number
  medianDurationMs?: number
  successesPerMillionInput?: number
  costPerSuccess?: number
  tokensPerSuccess?: number
  errors: number
}

export interface ExperimentSummary {
  runId: string
  variant: string
  gitSha: string
  claudeVersion: string
  model: string
  tasks: number
  trialsPerTask: number
  baseline: ArmSummary
  candidate: ArmSummary
  /** Pass rate difference, variant − baseline, percentage points (task-weighted). */
  qualityDiffPp?: number
  qualityCiPp?: [number, number]
  contextDiffPercent?: number
  inputDiffPercent?: number
  costDiffPercent?: number
  verdict: Verdict
  interpretation: string[]
  config: Pick<EvalConfig, "maxAcceptedQualityRegressionPp" | "minContextReductionPercent" | "minTasksForSupport" | "bootstrapIterations" | "seed">
}

export interface RunMeta {
  runId: string
  variant: string
  gitSha: string
  claudeVersion: string
  model: string
  trialsPerTask: number
}

function arm(results: readonly TrialResult[]): ArmSummary {
  const successes = results.filter((r) => r.success).length
  const inputs = results.map((r) => r.inputTokens).filter((x): x is number => x !== undefined)
  const outputs = results.map((r) => r.outputTokens).filter((x): x is number => x !== undefined)
  const costs = results.map((r) => r.costUsd).filter((x): x is number => x !== undefined)
  const contexts = results.map((r) => r.contextTokens).filter((x): x is number => x !== undefined)
  const s: ArmSummary = { trials: results.length, errors: results.filter((r) => r.error !== undefined).length }
  if (results.length) s.passRate = successes / results.length
  const ctx = median(contexts)
  if (ctx !== undefined) s.contextTokens = ctx
  const inMean = mean(inputs)
  if (inMean !== undefined) s.inputTokensPerTrial = inMean
  const inMed = median(inputs)
  if (inMed !== undefined) s.medianInputTokens = inMed
  const outMean = mean(outputs)
  if (outMean !== undefined) s.outputTokensPerTrial = outMean
  const costMean = mean(costs)
  if (costMean !== undefined) s.costPerTrial = costMean
  const dur = median(results.map((r) => r.durationMs))
  if (dur !== undefined) s.medianDurationMs = dur
  // Derived metrics only where every trial reported the figure: a partial sum would mislead.
  if (inputs.length === results.length && inputs.length > 0) {
    const total = inputs.reduce((a, b) => a + b, 0)
    if (total > 0) s.successesPerMillionInput = (successes / total) * 1_000_000
    if (successes > 0) s.tokensPerSuccess = total / successes
  }
  if (costs.length === results.length && costs.length > 0 && successes > 0) {
    s.costPerSuccess = costs.reduce((a, b) => a + b, 0) / successes
  }
  return s
}

export function summarize(results: readonly TrialResult[], meta: RunMeta, config: EvalConfig): ExperimentSummary {
  const base = results.filter((r) => r.arm === "baseline")
  const cand = results.filter((r) => r.arm === "variant")
  const taskIds = [...new Set(results.map((r) => r.taskId))]
  const paired: PairedTask[] = taskIds.map((id) => ({
    baseline: base.filter((r) => r.taskId === id).map((r) => (r.success ? 1 : 0)),
    variant: cand.filter((r) => r.taskId === id).map((r) => (r.success ? 1 : 0)),
  }))
  const complete = paired.filter((t) => t.baseline.length > 0 && t.variant.length > 0)

  const s: ExperimentSummary = {
    ...meta,
    tasks: taskIds.length,
    baseline: arm(base),
    candidate: arm(cand),
    verdict: "INCONCLUSIVE",
    interpretation: [],
    config: {
      maxAcceptedQualityRegressionPp: config.maxAcceptedQualityRegressionPp,
      minContextReductionPercent: config.minContextReductionPercent,
      minTasksForSupport: config.minTasksForSupport,
      bootstrapIterations: config.bootstrapIterations,
      seed: config.seed,
    },
  }

  const bMean = taskMean(complete, "baseline")
  const vMean = taskMean(complete, "variant")
  if (bMean !== undefined && vMean !== undefined) s.qualityDiffPp = (vMean - bMean) * 100
  const ci = bootstrapDiff(complete, config.bootstrapIterations, config.seed)
  if (ci) s.qualityCiPp = [ci[0] * 100, ci[1] * 100]
  const ctx = percentDiff(s.baseline.contextTokens, s.candidate.contextTokens)
  if (ctx !== undefined) s.contextDiffPercent = ctx
  const inp = percentDiff(s.baseline.inputTokensPerTrial, s.candidate.inputTokensPerTrial)
  if (inp !== undefined) s.inputDiffPercent = inp
  const cost = percentDiff(s.baseline.costPerTrial, s.candidate.costPerTrial)
  if (cost !== undefined) s.costDiffPercent = cost

  verdict(s, complete.length, config)
  return s
}

function verdict(s: ExperimentSummary, tasks: number, c: EvalConfig): void {
  const lines = s.interpretation
  if (tasks === 0 || s.qualityDiffPp === undefined) {
    s.verdict = "INCONCLUSIVE"
    lines.push("No task finished in both arms: nothing can be compared.")
    return
  }
  const reduction = s.contextDiffPercent === undefined ? undefined : -s.contextDiffPercent
  const savings = reduction !== undefined && reduction >= c.minContextReductionPercent
  lines.push(
    reduction === undefined
      ? "Context savings: UNKNOWN (instruction size not measured)"
      : savings
        ? `Context savings: CLEAR (${fmtPct(-reduction)} project instructions)`
        : `Context savings: BELOW THRESHOLD (${fmtPct(-reduction)}; threshold −${c.minContextReductionPercent}%)`,
  )
  const [lo, hi] = s.qualityCiPp ?? [s.qualityDiffPp, s.qualityDiffPp]
  lines.push(lo > 0 ? "Quality improvement: ESTABLISHED (95% CI above 0)" : "Quality improvement: NOT ESTABLISHED")
  lines.push(
    hi < 0
      ? "Quality regression: OBSERVED (95% CI below 0)"
      : s.qualityDiffPp < -c.maxAcceptedQualityRegressionPp
        ? `Quality regression: OBSERVED (${fmtPp(s.qualityDiffPp)}, beyond the −${c.maxAcceptedQualityRegressionPp} pp tolerance)`
        : "Quality regression: NOT OBSERVED WITH CURRENT POWER",
  )

  const withinTolerance = s.qualityDiffPp >= -c.maxAcceptedQualityRegressionPp
  if (!savings || !withinTolerance) {
    s.verdict = "NOT PROMISING"
    if (!savings) lines.push("The variant does not reduce context enough to be worth adopting on cost grounds.")
    if (!withinTolerance) lines.push("The observed pass rate fell more than the accepted tolerance.")
    return
  }
  const enough = tasks >= c.minTasksForSupport
  const ciHolds = lo >= -c.maxAcceptedQualityRegressionPp
  if (enough && ciHolds) {
    s.verdict = "SUPPORTED"
    lines.push("Context is reduced, and the 95% CI rules out a regression beyond the tolerance.")
  } else {
    s.verdict = "PROMISING"
    lines.push("The variant reduces context and no meaningful regression was observed.")
    if (!enough) lines.push(`Only ${tasks} task(s): ${c.minTasksForSupport}+ real tasks are needed before calling it SUPPORTED.`)
    if (!ciHolds) lines.push(`The 95% CI still allows a regression of ${fmtPp(lo)}: more tasks or trials are needed.`)
  }
}

export function renderExperiment(s: ExperimentSummary): string {
  const col = (label: string, a: string, b: string) => `${label.padEnd(26)}${a.padEnd(16)}${b}`
  const pct = (x: number | undefined) => (x === undefined ? "?" : `${(x * 100).toFixed(1)}%`)
  const tok = (x: number | undefined) => (x === undefined ? "?" : approxOrExact(x))
  const usd = (x: number | undefined) => (x === undefined ? "?" : `$${x.toFixed(3)}`)
  const lines = [
    "CONTEXT EXPERIMENT",
    "",
    `baseline vs ${s.variant}`,
    `Run ${s.runId} · git ${s.gitSha.slice(0, 10)} · Claude Code ${s.claudeVersion} · model ${s.model}`,
    `Tasks ${s.tasks} · trials/task ${s.trialsPerTask}`,
    "",
    "QUALITY",
    "────────────────────────────────",
    col("", "BASELINE", s.variant.toUpperCase()),
    col("Pass rate", pct(s.baseline.passRate), pct(s.candidate.passRate)),
    col("Δ (task-weighted)", s.qualityDiffPp === undefined ? "?" : fmtPp(s.qualityDiffPp), ""),
    col("95% bootstrap CI", s.qualityCiPp ? `[${fmtNum(s.qualityCiPp[0])}, ${fmtNum(s.qualityCiPp[1])}] pp` : "?", ""),
    col("Trials with errors", String(s.baseline.errors), String(s.candidate.errors)),
    "",
    "CONTEXT",
    "────────────────────────────────",
    col("Project instructions", s.baseline.contextTokens === undefined ? "?" : approx(s.baseline.contextTokens), s.candidate.contextTokens === undefined ? "?" : approx(s.candidate.contextTokens)),
    col("Δ", s.contextDiffPercent === undefined ? "?" : fmtPct(s.contextDiffPercent), ""),
    "",
    "COST",
    "────────────────────────────────",
    col("Input tokens / trial", tok(s.baseline.inputTokensPerTrial), tok(s.candidate.inputTokensPerTrial)),
    col("Δ input", s.inputDiffPercent === undefined ? "?" : fmtPct(s.inputDiffPercent), ""),
    col("Output tokens / trial", tok(s.baseline.outputTokensPerTrial), tok(s.candidate.outputTokensPerTrial)),
    col("Cost / trial", usd(s.baseline.costPerTrial), usd(s.candidate.costPerTrial)),
    col("Cost / success", usd(s.baseline.costPerSuccess), usd(s.candidate.costPerSuccess)),
    col("Successes / 1M input", fmtOpt(s.baseline.successesPerMillionInput), fmtOpt(s.candidate.successesPerMillionInput)),
    col("Median duration", dur(s.baseline.medianDurationMs), dur(s.candidate.medianDurationMs)),
    "",
    "VERDICT",
    "────────────────────────────────",
    s.verdict,
    "",
    ...s.interpretation,
    "",
    `Guardrails: regression ≤ ${s.config.maxAcceptedQualityRegressionPp} pp, context reduction ≥ ${s.config.minContextReductionPercent}%, SUPPORTED needs ≥ ${s.config.minTasksForSupport} tasks (configurable, not scientific constants).`,
  ]
  return lines.join("\n")
}

function approxOrExact(x: number): string {
  return x >= 10_000 ? `${(x / 1000).toFixed(1)}k` : exact(x)
}

function fmtPp(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)} pp`
}

function fmtNum(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)}`
}

function fmtPct(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`
}

function fmtOpt(x: number | undefined): string {
  return x === undefined ? "?" : x.toFixed(1)
}

function dur(ms: number | undefined): string {
  return ms === undefined ? "?" : `${(ms / 1000).toFixed(1)} s`
}
