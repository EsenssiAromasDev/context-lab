import { parseEvalConfig, MAX_PROCESS_SECONDS, type EvalConfig } from "./config.ts"
import { joinPath, listFiles, resolveClaude, type EvalHost } from "./host.ts"
import { renderExperiment, summarize, type Arm, type ExperimentSummary, type TrialResult } from "./report.ts"
import { parseTask, type Task } from "./tasks.ts"
import { applyVariant, BASELINE, loadVariant, type Variant } from "./variant.ts"
import {
  addWorktree,
  gitInfo,
  hideContextLab,
  installGraders,
  instructionsAt,
  linkDependencies,
  projectInstructionTokens,
  syncInstructions,
  unlinkAll,
  writeGraderFiles,
  removeWorktree,
  workingTreeChanges,
  worktreeBase,
  type GitInfo,
} from "./worktree.ts"

// The eval harness (SPEC §26–36): baseline vs one context variant, each
// trial in its own worktree of one SHA, alternating which arm goes first,
// graded by the task's own deterministic command.

export const DIRTY_REFUSAL = [
  "Experimento cancelado: hay cambios sin guardar en git.",
  "",
  "Cada intento tiene que empezar exactamente desde el mismo código,",
  "así que el proyecto debe estar sin cambios pendientes.",
  "",
  "Haz commit (o git stash) y vuelve a intentarlo.",
].join("\n")

export interface Slot {
  task: Task
  arm: Arm
  trial: number
}

/**
 * The run order: per task and trial, both arms back to back, which goes first
 * alternating (task 1: variant → baseline, task 2: baseline → variant, ...),
 * so neither arm systematically runs first (SPEC §30).
 */
export function schedule(tasks: readonly Task[], trialsPerTask: number): Slot[] {
  const out: Slot[] = []
  tasks.forEach((task, t) => {
    for (let trial = 1; trial <= trialsPerTask; trial++) {
      const variantFirst = (t + trial - 1) % 2 === 0
      const arms: Arm[] = variantFirst ? ["variant", "baseline"] : ["baseline", "variant"]
      for (const arm of arms) out.push({ task, arm, trial })
    }
  })
  return out
}

export interface ClaudeOutput {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  isError?: boolean
  /** Why it ended, when it ended in error: the result's subtype and the start of its text. */
  detail?: string
}

/** `claude -p --output-format json`'s figures; a figure it does not give stays undefined. */
export function parseClaudeOutput(stdout: string): ClaudeOutput {
  let j: Record<string, unknown>
  try {
    const text = stdout.trim()
    j = JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>
  } catch {
    return {}
  }
  const out: ClaudeOutput = {}
  const u = j.usage as Record<string, unknown> | undefined
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
  if (u) {
    const parts = [n(u.input_tokens), n(u.cache_read_input_tokens), n(u.cache_creation_input_tokens)]
    if (parts[0] !== undefined) out.inputTokens = parts.reduce<number>((a, b) => a + (b ?? 0), 0)
    const o = n(u.output_tokens)
    if (o !== undefined) out.outputTokens = o
  }
  const cost = n(j.total_cost_usd)
  if (cost !== undefined) out.costUsd = cost
  if (typeof j.is_error === "boolean") out.isError = j.is_error
  if (out.isError) {
    const why = [typeof j.subtype === "string" ? j.subtype : "", typeof j.result === "string" ? j.result.replace(/\s+/g, " ").slice(0, 160) : ""]
    out.detail = why.filter(Boolean).join(": ")
  }
  return out
}

export function claudeArgv(base: readonly string[], config: EvalConfig, prompt: string): string[] {
  return [...base, "-p", prompt, "--output-format", "json", ...(config.model ? ["--model", config.model] : []), ...config.claudeArgs]
}

export async function loadTasks(host: EvalHost, root: string): Promise<{ tasks: Task[]; errors: string[] }> {
  const dir = joinPath(root, ".context-lab/evals/tasks")
  const tasks: Task[] = []
  const errors: string[] = []
  for (const rel of await listFiles(host, dir)) {
    if (!/\.(ya?ml|json)$/i.test(rel)) continue
    const parsed = parseTask(await host.read(joinPath(dir, rel)), rel)
    if (parsed.ok) tasks.push(parsed.value)
    else errors.push(parsed.error)
  }
  const seen = new Set<string>()
  for (const t of tasks) {
    if (seen.has(t.id)) errors.push(`duplicate task id "${t.id}"`)
    seen.add(t.id)
  }
  return { tasks, errors }
}

export interface Prepared {
  info: GitInfo
  config: EvalConfig
  tasks: Task[]
  variant: Variant
  claude: { argv: string[]; version: string }
  /** Today's instruction files, for tasks that start at an older commit. */
  headInstructions: Map<string, string>
}

/** Everything checked before the first trial; any failure refuses the run. */
export async function prepare(host: EvalHost, root: string, variantName: string): Promise<Prepared | { error: string }> {
  const info = await gitInfo(host, root)
  if ("error" in info) return info
  const dirty = await workingTreeChanges(host, info)
  if (dirty.length) return { error: `${DIRTY_REFUSAL}\n\nCambiados: ${dirty.slice(0, 10).join(", ")}${dirty.length > 10 ? ", ..." : ""}` }
  const configPath = joinPath(root, ".context-lab/config.json")
  if (!(await host.exists(configPath))) return { error: "Aquí no hay carpeta .context-lab/: ejecuta primero /context-lab iniciar." }
  const config = parseEvalConfig(await host.read(configPath))
  const { tasks, errors } = await loadTasks(host, root)
  if (errors.length) return { error: `Hay errores en los archivos de tareas:\n${errors.map((e) => `- ${e}`).join("\n")}` }
  if (tasks.length === 0) return { error: "No hay tareas en .context-lab/evals/tasks/ (mira el ejemplo que creó /context-lab iniciar)." }
  const variant = await loadVariant(host, root, variantName)
  if ("error" in variant) return variant
  const claude = await resolveClaude(host, config.claude)
  if ("error" in claude) return claude
  const headInstructions = tasks.some((t) => t.baseSha !== undefined) ? await instructionsAt(host, info, info.sha) : new Map<string, string>()
  return { info, config, tasks, variant, claude, headInstructions }
}

export interface Progress {
  runId: string
  done: number
  total: number
  /** What is running now, e.g. `task-id · variant · trial 2`. */
  current?: string
}

export interface RunHooks {
  onProgress?(p: Progress): Promise<void> | void
  shouldStop?(): boolean
}

export interface RunOutcome {
  runId: string
  results: TrialResult[]
  summary: ExperimentSummary
  resultsDir: string
  stopped: boolean
}

export function runIdFor(at: number, variant: string): string {
  return `${new Date(at).toISOString().replace(/[:.]/g, "-")}-${variant}`
}

export async function runExperiment(host: EvalHost, root: string, p: Prepared, hooks: RunHooks = {}): Promise<RunOutcome> {
  const started = await host.now()
  const runId = runIdFor(started, p.variant.name)
  const resultsDir = joinPath(root, ".context-lab/results", runId)
  const base = joinPath(worktreeBase(p.info, p.config.worktreeDir), runId)
  const slots = schedule(p.tasks, p.config.trialsPerTask)
  const results: TrialResult[] = []
  let stopped = false

  for (const [i, slot] of slots.entries()) {
    if (hooks.shouldStop?.()) {
      stopped = true
      break
    }
    const label = `${slot.task.id} · ${slot.arm === "variant" ? p.variant.name : BASELINE} · trial ${slot.trial}`
    await hooks.onProgress?.({ runId, done: i, total: slots.length, current: label })
    results.push(await runTrial(host, root, p, slot, joinPath(base, `${String(i + 1).padStart(3, "0")}-${slot.arm}`)))
    await host.write(joinPath(resultsDir, "trials.json"), `${JSON.stringify(results, null, 2)}\n`)
  }

  const summary = summarize(
    results,
    { runId, variant: p.variant.name, gitSha: p.info.sha, claudeVersion: p.claude.version, model: p.config.model ?? "default", trialsPerTask: p.config.trialsPerTask },
    p.config,
  )
  await host.write(joinPath(resultsDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
  await host.write(joinPath(resultsDir, "report.md"), `# ${runId}\n\n\`\`\`text\n${renderExperiment(summary)}\n\`\`\`\n${stopped ? "\nDetenido antes de terminar todas las ejecuciones.\n" : ""}`)
  await hooks.onProgress?.({ runId, done: results.length, total: slots.length })
  return { runId, results, summary, resultsDir, stopped }
}

async function runTrial(host: EvalHost, root: string, p: Prepared, slot: Slot, dir: string): Promise<TrialResult> {
  const startedAt = await host.now()
  const r: TrialResult = {
    taskId: slot.task.id,
    variant: slot.arm === "variant" ? p.variant.name : BASELINE,
    arm: slot.arm,
    trial: slot.trial,
    success: false,
    durationMs: 0,
    graderExitCode: -1,
    claudeExitCode: -1,
    claudeVersion: p.claude.version,
    gitSha: p.info.sha,
    startedAt,
  }
  const wtRoot = p.info.sub ? joinPath(dir, p.info.sub) : dir
  const base = slot.task.baseSha ?? p.info.sha
  r.gitSha = base
  let created = false
  let links: string[] = []
  try {
    await addWorktree(host, p.info, dir, base)
    created = true
    await hideContextLab(host, wtRoot)
    // A task from history starts at its old commit, with today's instructions.
    if (base !== p.info.sha) await syncInstructions(host, p.info, wtRoot, p.headInstructions)
    if (slot.arm === "variant") await applyVariant(host, p.variant, wtRoot)
    links = await linkDependencies(host, root, wtRoot, p.config.links)
    r.contextTokens = await projectInstructionTokens(host, wtRoot)

    const claudeTimeout = Math.min(slot.task.timeoutSeconds, MAX_PROCESS_SECONDS) * 1000
    const t0 = await host.now()
    try {
      const run = await host.run(claudeArgv(p.claude.argv, p.config, slot.task.prompt), { cwd: wtRoot, timeoutMs: claudeTimeout })
      r.claudeExitCode = run.exitCode
      const out = parseClaudeOutput(run.stdout)
      if (out.inputTokens !== undefined) r.inputTokens = out.inputTokens
      if (out.outputTokens !== undefined) r.outputTokens = out.outputTokens
      if (out.costUsd !== undefined) r.costUsd = out.costUsd
      if (run.exitCode !== 0 || out.isError) {
        const detail = out.detail ?? run.stderr.replace(/\s+/g, " ").trim().slice(0, 160)
        r.error = `Claude Code exited ${run.exitCode}${detail ? ` — ${detail}` : ""}`
      }
    } catch (err) {
      r.error = `Claude Code did not finish: ${err instanceof Error ? err.message : String(err)}`
    }
    r.durationMs = (await host.now()) - t0

    // The repository decides, whatever Claude reported: grade what is on disk.
    await installGraders(host, root, wtRoot)
    if (slot.task.graderFiles && slot.task.graderFrom) await writeGraderFiles(host, p.info, wtRoot, slot.task.graderFiles, slot.task.graderFrom)
    try {
      const g = await host.run(slot.task.graderArgv, { cwd: wtRoot, timeoutMs: p.config.graderTimeoutSeconds * 1000 })
      r.graderExitCode = g.exitCode
      // The end of the grader's output says why a failing attempt failed.
      if (g.exitCode !== 0) r.graderOutput = `${g.stdout}\n${g.stderr}`.trim().slice(-1500)
      r.success = g.exitCode === 0
    } catch (err) {
      r.error = [r.error, `grader did not finish: ${err instanceof Error ? err.message : String(err)}`].filter(Boolean).join("; ")
    }
  } catch (err) {
    r.error = `trial setup failed: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    // Links go first: deleting a tree could otherwise follow them into the real folders.
    const unlinked = await unlinkAll(host, links)
    if (!unlinked) r.error = [r.error, `could not remove dependency links; worktree kept at ${dir}`].filter(Boolean).join("; ")
    else if (created) await removeWorktree(host, p.info, dir).catch(() => undefined)
  }
  return r
}

/** The most recent run's summary under .context-lab/results, if any. */
export async function latestSummary(host: EvalHost, root: string): Promise<ExperimentSummary | undefined> {
  const dir = joinPath(root, ".context-lab/results")
  if (!(await host.exists(dir))) return undefined
  const runs = (await host.list(dir)).filter((e) => e.kind === "dir").map((e) => e.name).sort().reverse()
  for (const run of runs) {
    const p = joinPath(dir, run, "summary.json")
    if (!(await host.exists(p))) continue
    try {
      return JSON.parse(await host.read(p)) as ExperimentSummary
    } catch {
      continue
    }
  }
  return undefined
}
