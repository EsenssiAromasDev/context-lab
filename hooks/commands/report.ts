import type { ContextIssue } from "../analysis/issue-engine.ts"
import type { ContextGraph, ContextNode } from "../graph/graph.ts"
import { displayPath, tokensOf } from "../graph/graph-selectors.ts"
import { approx, exact } from "../metrics/size.ts"
import type { SessionUsageSnapshot } from "../metrics/usage.ts"
import type { AgentRecord } from "../observers/agent-observer.ts"
import { renderExperiment, type ExperimentSummary } from "../eval/report.ts"
import { renderTree, verdict } from "./context-lab.ts"

const SEVERITY_ES = { high: "alta", medium: "media", low: "baja", info: "aviso" } as const

// `/context-lab report` (SPEC §24): one Markdown file under
// .context-lab/reports/. Paths, sizes, counts, findings and experiment
// summaries — never instruction text, transcripts or tool output.

export interface ReportInput {
  at: number
  root: string
  graph: ContextGraph
  usage?: SessionUsageSnapshot
  issues: readonly ContextIssue[]
  agents: readonly AgentRecord[]
  environment: { claudeVersion?: string; gitSha?: string; gitClean?: boolean; platform: string }
  experiment?: ExperimentSummary
}

export const LIMITATIONS = [
  "Los tokens con ~ son estimaciones (de Claude Code, o unos 4 caracteres por token).",
  "\"Visto en N conversaciones\" cuenta conversaciones (y compactaciones o /clear), no mensajes.",
  "Qué CLAUDE.md de carpeta llegó a Claude se deduce del texto que adjunta Claude Code, que no es una API formal.",
  "Claude Code no dice si un subagente recibe tus instrucciones.",
  "Una ruta solo se marca como rota si su primera carpeta existe.",
  "Los problemas son sugerencias, no veredictos: Context Lab nunca cambia tus archivos.",
]

export function reportFileName(at: number): string {
  return `${new Date(at).toISOString().replace(/[:.]/g, "-")}.md`
}

export function renderReport(r: ReportInput): string {
  const out: string[] = []
  const date = new Date(r.at).toISOString()
  out.push("# Informe de Context Lab", "", `Generado el ${date}.`, "")

  out.push("## Resumen", "", ...verdict({ graph: r.graph, usage: r.usage, root: r.root, issues: r.issues }).map((v) => `- ${v.trim()}`), "")

  out.push("## Entorno", "")
  out.push(`| | |`, `| --- | --- |`)
  out.push(`| Claude Code | ${r.environment.claudeVersion ?? "desconocido"} |`)
  out.push(`| Commit de git | ${r.environment.gitSha ?? "no es un repositorio git"} |`)
  if (r.environment.gitClean !== undefined) out.push(`| Cambios sin commit | ${r.environment.gitClean ? "ninguno" : "sí"} |`)
  out.push(`| Sistema | ${r.environment.platform} |`)
  out.push(`| Conversaciones vistas | ${r.graph.contexts} |`, "")

  out.push("## Contexto usado", "")
  const u = r.usage
  if (u?.contextCapacity === undefined) out.push("No se midió en esta sesión.", "")
  else {
    out.push(`${u.contextUsed === undefined ? "?" : exact(u.contextUsed)} de ${exact(u.contextCapacity)} tokens${u.contextPercent === undefined ? "" : ` (${u.contextPercent}%)`}.`, "")
    if (u.categories?.length) {
      out.push("| En qué se va (estimación de Claude Code) | Tokens |", "| --- | ---: |")
      for (const c of u.categories) out.push(`| ${c.name} | ${approx(c.tokens)} |`)
      out.push("")
    }
    if (u.skillListing) out.push(`Lista de skills (Claude la lee siempre): ${approx(u.skillListing.tokens)} tokens; caben ${u.skillListing.includedSkills} de ${u.skillListing.totalSkills}.`, "")
  }

  out.push("## Archivos que Claude recibe", "", "```text", renderTree({ graph: r.graph, usage: r.usage, root: r.root, agents: r.agents }), "```", "")

  out.push("## Detalle por archivo", "")
  const rows = [
    ...r.graph.current.map((id) => [id, "siempre"] as const),
    ...r.graph.nested.map((id) => [id, "al trabajar en su carpeta"] as const),
    ...r.graph.inferred.map((id) => [id, "probablemente (sin confirmar)"] as const),
    ...r.graph.available.map((id) => [id, "existe, no cargado"] as const),
    ...r.graph.skills.map((id) => [id, "skill activada"] as const),
  ]
  if (rows.length === 0) out.push("No se ha visto ninguno.", "")
  else {
    out.push("| Archivo | Cuándo lo lee Claude | Tipo | ~Tokens | Conversaciones | Sesiones | Huella del contenido |", "| --- | --- | --- | ---: | ---: | ---: | --- |")
    for (const [id, role] of rows) {
      const n = r.graph.nodes[id]
      if (n) out.push(`| ${label(n, r.root)} | ${role} | ${n.kind} | ${approx(tokensOf(n))} | ${n.loadCount} | ${n.sessionCount} | ${n.contentHash?.slice(0, 12) ?? ""} |`)
    }
    out.push("")
  }

  out.push("## Problemas", "")
  if (r.issues.length === 0) out.push("No se encontraron problemas.", "")
  r.issues.forEach((i, k) => {
    out.push(`### ${k + 1}. ${i.title} (importancia ${SEVERITY_ES[i.severity]})`, "")
    for (const loc of i.locations) out.push(`- Dónde: ${loc}`)
    out.push("", `**Qué pasa:** ${i.explanation}`, "", `**Qué hacer:** ${i.action}`, "")
    if (i.estimatedSavings !== undefined) out.push(`**Ahorro:** ${approx(i.estimatedSavings)} tokens por conversación`, "")
    out.push("**Por qué lo digo:**", ...i.details.map((d) => `- ${d.text}`), "")
  })

  out.push("## Experimentos", "")
  if (r.experiment) out.push("```text", renderExperiment(r.experiment), "```", "")
  else out.push("Aún no hay experimentos en .context-lab/results/.", "")

  out.push("## Límites de estas medidas", "", ...LIMITATIONS.map((l) => `- ${l}`), "")
  out.push("_Este informe no incluye el texto de tus instrucciones, ni conversaciones, ni resultados de herramientas._", "")
  return out.join("\n")
}

function label(n: ContextNode, root: string): string {
  return (n.path === undefined ? n.name : displayPath(n.path, root)).replace(/\|/g, "\\|")
}
