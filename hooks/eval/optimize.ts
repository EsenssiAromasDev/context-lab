import { parseAnalysisConfig } from "../analysis/config.ts"
import { parseEvalConfig } from "./config.ts"
import { joinPath, resolveClaude, type EvalHost } from "./host.ts"
import { initFiles } from "./init.ts"
import { mineTasks, type MineOutcome, type MineProgress } from "./mine.ts"
import { propose, renderProposal, type Proposal } from "./propose.ts"
import { renderExperiment } from "./report.ts"
import { loadTasks, prepare, runExperiment, type Progress, type RunOutcome } from "./runner.ts"
import { gitInfo } from "./worktree.ts"

// `/context-lab optimizar`: the whole loop in one command.
//
//   tasks    from the repository's own history (if there are not enough)
//   proposal a slimmer instruction set, as a variant
//   test     baseline vs proposal, in isolated worktrees
//   verdict  plain words, and how to apply it if it holds up

export type OptimizeStep =
  | { step: "init" }
  | { step: "mine"; progress: MineProgress }
  | { step: "propose" }
  | { step: "eval"; progress: Progress }

export interface OptimizeOptions {
  summarize?: boolean
  /** Below this many tasks, more are mined from history first. */
  minTasks?: number
  onStep?(s: OptimizeStep): void | Promise<void>
  shouldStop?(): boolean
}

export interface OptimizeOutcome {
  mined?: MineOutcome
  proposal?: Proposal
  run?: RunOutcome
  /** Why the loop stopped early, in plain words. */
  stopped?: string
}

export async function optimize(host: EvalHost, root: string, opts: OptimizeOptions = {}): Promise<OptimizeOutcome> {
  const out: OptimizeOutcome = {}
  const info = await gitInfo(host, root)
  if ("error" in info) return { stopped: info.error }

  // 1. .context-lab/ exists (nothing existing is overwritten).
  await opts.onStep?.({ step: "init" })
  for (const f of initFiles()) {
    const p = joinPath(root, f.path)
    if (!(await host.exists(p))) await host.write(p, f.text)
  }
  const configText = await host.read(joinPath(root, ".context-lab/config.json"))
  const config = parseEvalConfig(configText)
  const analysis = parseAnalysisConfig(configText)

  // 2. Enough tasks: mine the history when there are too few.
  const { tasks } = await loadTasks(host, root)
  if (tasks.length < (opts.minTasks ?? 5)) {
    out.mined = await mineTasks(host, root, info, config, (progress) => opts.onStep?.({ step: "mine", progress }))
    if ((await loadTasks(host, root)).tasks.length === 0) {
      return { ...out, stopped: "No se pudieron sacar tareas del historial (hacen falta commits que cambien código y sus tests). Escribe alguna en .context-lab/evals/tasks/." }
    }
  }

  // 3. The proposal.
  await opts.onStep?.({ step: "propose" })
  let claude: string[] | undefined
  if (opts.summarize) {
    const c = await resolveClaude(host, config.claude)
    if ("error" in c) return { ...out, stopped: c.error }
    claude = c.argv
  }
  const proposal = await propose(host, root, info, config, { analysis, ...(opts.summarize ? { summarize: true } : {}), ...(claude ? { claude } : {}) })
  if (!proposal) return { ...out, stopped: "No hay nada que recortar con seguridad: tus instrucciones no tienen texto repetido, listados innecesarios ni secciones de una sola carpeta." }
  out.proposal = proposal

  // 4. The experiment.
  const prepared = await prepare(host, root, proposal.name)
  if ("error" in prepared) return { ...out, stopped: prepared.error }
  out.run = await runExperiment(host, root, prepared, {
    onProgress: (progress) => opts.onStep?.({ step: "eval", progress }),
    ...(opts.shouldStop ? { shouldStop: opts.shouldStop } : {}),
  })
  return out
}

export function renderOptimize(o: OptimizeOutcome): string {
  const lines = ["OPTIMIZAR TUS INSTRUCCIONES", ""]
  if (o.mined) {
    lines.push(`1. Tareas de tu historial: ${o.mined.kept.length} (de ${o.mined.scanned} commits revisados, ${o.mined.candidates} candidatos comprobados)`)
    const why = Object.entries(o.mined.skipped).sort((a, b) => b[1] - a[1]).slice(0, 3)
    if (why.length) lines.push(`   Descartados sobre todo por: ${why.map(([k, n]) => `${k} (${n})`).join(", ")}`)
  } else lines.push("1. Tareas: se usaron las que ya había en .context-lab/evals/tasks/")
  if (o.proposal) lines.push("", `2. ${renderProposal(o.proposal).split("\n").join("\n   ")}`)
  if (o.run) lines.push("", `3. ${renderExperiment(o.run.summary).split("\n").join("\n   ")}`)
  if (o.stopped) lines.push("", `Se detuvo: ${o.stopped}`)
  if (o.run && o.proposal && (o.run.summary.verdict === "SUPPORTED" || o.run.summary.verdict === "PROMISING")) {
    lines.push("", `Siguiente: /context-lab aplicar ${o.proposal.name}   (te enseña qué cambia; nada se toca sin "confirmar")`)
  }
  return lines.join("\n")
}
