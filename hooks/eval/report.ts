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

/** The verdict in the words the person reads. */
export function verdictWord(v: Verdict): string {
  return { SUPPORTED: "RESPALDADO", PROMISING: "PROMETEDOR", "NOT PROMISING": "NO COMPENSA", INCONCLUSIVE: "SIN DATOS SUFICIENTES" }[v]
}

function verdict(s: ExperimentSummary, tasks: number, c: EvalConfig): void {
  const lines = s.interpretation
  if (tasks === 0 || s.qualityDiffPp === undefined) {
    s.verdict = "INCONCLUSIVE"
    lines.push("Ninguna tarea terminó con las dos versiones: no hay nada que comparar.")
    return
  }
  const reduction = s.contextDiffPercent === undefined ? undefined : -s.contextDiffPercent
  const savings = reduction !== undefined && reduction >= c.minContextReductionPercent
  lines.push(
    reduction === undefined
      ? "? Ahorro de instrucciones: no se pudo medir."
      : savings
        ? `✓ Ahorra: las instrucciones fijas bajan un ${reduction.toFixed(0)}%.`
        : `✗ Apenas ahorra: las instrucciones fijas cambian un ${fmtPct(-reduction)} (hace falta bajar al menos un ${c.minContextReductionPercent}%).`,
  )
  const [lo, hi] = s.qualityCiPp ?? [s.qualityDiffPp, s.qualityDiffPp]
  if (lo > 0) lines.push("✓ Claude acierta MÁS tareas con el cambio, y la diferencia es clara.")
  else lines.push("? No está demostrado que Claude acierte más con el cambio.")
  if (hi < 0) lines.push("✗ Claude acierta MENOS tareas con el cambio, y la diferencia es clara.")
  else if (s.qualityDiffPp < -c.maxAcceptedQualityRegressionPp) {
    lines.push(`✗ Claude acertó menos tareas con el cambio (${fmtPp(s.qualityDiffPp)}), más de lo tolerado (${c.maxAcceptedQualityRegressionPp} puntos).`)
  } else lines.push("✓ Con estos datos no se ve que Claude empeore.")

  const withinTolerance = s.qualityDiffPp >= -c.maxAcceptedQualityRegressionPp
  if (!savings || !withinTolerance) {
    s.verdict = "NOT PROMISING"
    lines.push("")
    lines.push(!withinTolerance ? "Conclusión: no hagas este cambio; Claude trabaja peor." : "Conclusión: el cambio ahorra demasiado poco para que merezca la pena.")
    return
  }
  const enough = tasks >= c.minTasksForSupport
  const ciHolds = lo >= -c.maxAcceptedQualityRegressionPp
  lines.push("")
  if (enough && ciHolds) {
    s.verdict = "SUPPORTED"
    lines.push("Conclusión: puedes hacer el cambio. Ahorra contexto y los datos descartan que Claude empeore.")
  } else {
    s.verdict = "PROMISING"
    lines.push("Conclusión: buena señal, pero aún no es seguro.")
    if (!enough) lines.push(`Con ${tasks} tarea(s) no basta: haz al menos ${c.minTasksForSupport} tareas reales antes de fiarte.`)
    if (!ciHolds) lines.push(`Los datos todavía permiten que Claude empeore hasta ${fmtPp(-lo).replace("+", "")}: haz más tareas o más intentos.`)
  }
}

export function renderExperiment(s: ExperimentSummary): string {
  const col = (label: string, a: string, b: string) => `${label.padEnd(28)}${a.padEnd(18)}${b}`
  const rate = (a: ArmSummary) =>
    a.passRate === undefined ? "?" : `${(a.passRate * 100).toFixed(0)}% (${Math.round(a.passRate * a.trials)} de ${a.trials})`
  const tok = (x: number | undefined) => (x === undefined ? "?" : x >= 10_000 ? `${(x / 1000).toFixed(1)}k` : exact(x))
  const usd = (x: number | undefined) => (x === undefined ? "?" : `$${x.toFixed(3)}`)
  const withDiff = (value: string, diff: number | undefined) => (diff === undefined ? value : `${value}  (${fmtPct(diff)})`)
  const ctx = (x: number | undefined) => (x === undefined ? "?" : approx(x))
  const lines = [
    `EXPERIMENTO: tus instrucciones actuales contra "${s.variant}"`,
    "Pregunta: ¿Claude trabaja igual de bien con el cambio, y gasta menos?",
    `${s.tasks} tarea(s) · ${s.trialsPerTask} intento(s) por tarea · modelo ${s.model} · commit ${s.gitSha.slice(0, 10)}`,
    "",
    col("", "ACTUAL", "CON EL CAMBIO"),
    col("Tareas resueltas", rate(s.baseline), rate(s.candidate)),
    col("Instrucciones fijas", ctx(s.baseline.contextTokens), withDiff(ctx(s.candidate.contextTokens), s.contextDiffPercent)),
    col("Tokens leídos por intento", tok(s.baseline.inputTokensPerTrial), withDiff(tok(s.candidate.inputTokensPerTrial), s.inputDiffPercent)),
    col("Coste por intento", usd(s.baseline.costPerTrial), withDiff(usd(s.candidate.costPerTrial), s.costDiffPercent)),
    col("Tiempo (mediana)", dur(s.baseline.medianDurationMs), dur(s.candidate.medianDurationMs)),
    col("Intentos con errores", String(s.baseline.errors), String(s.candidate.errors)),
    "",
    s.qualityDiffPp === undefined
      ? "Diferencia en tareas resueltas: ?"
      : `Diferencia en tareas resueltas: ${fmtPp(s.qualityDiffPp)}` +
        (s.qualityCiPp ? ` (con un 95% de confianza, entre ${fmtNum(s.qualityCiPp[0])} y ${fmtNum(s.qualityCiPp[1])} puntos)` : ""),
    "",
    `RESULTADO: ${verdictWord(s.verdict)}`,
    ...s.interpretation.map((l) => (l ? `  ${l}` : "")),
    "",
    `Reglas: se tolera perder hasta ${s.config.maxAcceptedQualityRegressionPp} puntos, el cambio debe ahorrar al menos un ${s.config.minContextReductionPercent}% de instrucciones y «respaldado» exige ${s.config.minTasksForSupport}+ tareas (todo configurable en .context-lab/config.json).`,
  ]
  return lines.join("\n")
}

function fmtPp(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)} puntos`
}

function fmtNum(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)}`
}

function fmtPct(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`
}

function dur(ms: number | undefined): string {
  return ms === undefined ? "?" : `${(ms / 1000).toFixed(1)} s`
}
