import { measure } from "../metrics/size.ts"
import { joinPath, type EvalHost } from "./host.ts"
import type { ExperimentSummary } from "./report.ts"
import { verdictWord } from "./report.ts"
import type { Variant } from "./variant.ts"
import { showAt, type GitInfo } from "./worktree.ts"

// Applying a variant to the project: only on the person's explicit
// confirmation, never over uncommitted edits, always reversible with git.

export interface ApplyPlan {
  variant: string
  files: { path: string; before?: number; after: number }[]
  deletes: string[]
  /** Files the person changed since the last commit: applying would overwrite their edits. */
  blocked: string[]
  /** The latest experiment on this variant, when there is one. */
  tested?: ExperimentSummary
}

export async function planApply(host: EvalHost, root: string, info: GitInfo, v: Variant, tested?: ExperimentSummary): Promise<ApplyPlan> {
  const plan: ApplyPlan = { variant: v.name, files: [], deletes: [...v.delete], blocked: [] }
  if (tested) plan.tested = tested
  for (const rel of [...v.files, ...v.delete]) {
    const path = joinPath(root, rel)
    if (!(await host.exists(path))) continue
    const now = await host.read(path)
    const committed = await showAt(host, info, "HEAD", rel).catch(() => undefined)
    if (committed === undefined || committed.replace(/\r\n/g, "\n") !== now.replace(/\r\n/g, "\n")) plan.blocked.push(rel)
  }
  for (const rel of v.files) {
    const path = joinPath(root, rel)
    const before = (await host.exists(path)) ? measure(await host.read(path)).estimatedTokens : undefined
    const after = measure(await host.read(joinPath(v.dir, "files", rel))).estimatedTokens
    plan.files.push({ path: rel, after, ...(before === undefined ? {} : { before }) })
  }
  return plan
}

export function renderApplyPlan(plan: ApplyPlan): string {
  const lines = [`APLICAR "${plan.variant}"`, ""]
  for (const f of plan.files) lines.push(`  ${f.before === undefined ? "nuevo     " : "cambia    "}${f.path}  ${f.before === undefined ? "" : `~${f.before} → `}~${f.after} tokens`)
  for (const d of plan.deletes) lines.push(`  se borra  ${d}`)
  lines.push("")
  if (!plan.tested) lines.push("⚠ Esta versión NO se ha probado. Antes: /context-lab probar " + plan.variant)
  else lines.push(`Probada: ${verdictWord(plan.tested.verdict)} (${plan.tested.tasks} tareas, run ${plan.tested.runId}).`)
  if (plan.blocked.length) {
    lines.push("", `✗ No se puede aplicar: tienes cambios sin commit en ${plan.blocked.join(", ")}.`, "  Haz commit o descártalos; así nada tuyo se pierde.")
  } else {
    lines.push("", `Para aplicarlo: /context-lab aplicar ${plan.variant} confirmar`, "Se puede deshacer con git (los archivos quedan como cambios sin commit).")
  }
  return lines.join("\n")
}

/** Writes the variant's files into the project and removes its deletions (git rm). */
export async function applyToProject(host: EvalHost, root: string, v: Variant): Promise<string[]> {
  const touched: string[] = []
  for (const rel of v.files) {
    await host.write(joinPath(root, rel), await host.read(joinPath(v.dir, "files", rel)))
    touched.push(rel)
  }
  if (v.delete.length) {
    const r = await host.run(["git", "rm", "-q", "--ignore-unmatch", "--", ...v.delete], { cwd: root, timeoutMs: 60_000 })
    if (r.exitCode !== 0) throw new Error(`git rm failed: ${r.stderr.trim()}`)
    touched.push(...v.delete)
  }
  return touched
}
