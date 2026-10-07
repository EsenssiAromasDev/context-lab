import { countBySeverity, type ContextIssue, type Severity } from "../analysis/issue-engine.ts"
import type { ContextGraph } from "../graph/graph.ts"
import { agentTree, summarizeAgents, type AgentRecord, type AgentTreeItem } from "../observers/agent-observer.ts"
import {
  LEGEND,
  MARK,
  contextTree,
  currentInstructions,
  displayPath,
  instructionTokens,
  nestedInstructions,
  nestedTokens,
  tokensOf,
  type TreeItem,
} from "../graph/graph-selectors.ts"
import { approx } from "../metrics/size.ts"
import type { SessionUsageSnapshot } from "../metrics/usage.ts"

// /context-lab: argument parsing and the text views (SPEC §21–23, §37–38).
// Pure: register.tsx gathers the facts, these functions only format them.
// Plain Spanish, every number said with what it means, and a verdict that
// tells the person whether anything is worth doing.

export const MIN_VERSION = "2.1.287"

export type View = "overview" | "tree" | "issues" | "experiments" | "init" | "report" | "eval" | "doctor" | "help"

export interface Parsed {
  view: View
  /** `eval <variant>`'s variant. */
  arg?: string
  /** A word that names no view. */
  unknown?: string
}

/** Every word a view answers to: its English name and the Spanish one shown in the help. */
const WORDS: Record<string, View> = {
  overview: "overview",
  resumen: "overview",
  tree: "tree",
  archivos: "tree",
  issues: "issues",
  problemas: "issues",
  experiments: "experiments",
  experimentos: "experiments",
  init: "init",
  iniciar: "init",
  report: "report",
  informe: "report",
  eval: "eval",
  probar: "eval",
  doctor: "doctor",
  help: "help",
  ayuda: "help",
}

/** The views the pane shows, in tab order, with the key that switches to each (SPEC §21). */
export type PaneView = "overview" | "tree" | "issues" | "experiments"

export const TABS: readonly { view: PaneView; label: string; hotkey: string }[] = [
  { view: "overview", label: "Resumen", hotkey: "1" },
  { view: "tree", label: "Archivos", hotkey: "2" },
  { view: "issues", label: "Problemas", hotkey: "3" },
  { view: "experiments", label: "Experimentos", hotkey: "4" },
]

/** The key that re-measures and re-analyzes. */
export const REFRESH_KEY = "a"

export function isPaneView(view: View): view is PaneView {
  return TABS.some((t) => t.view === view)
}

export function parseArgs(args: string): Parsed {
  const [word, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  if (word === undefined) return { view: "overview" }
  const view = WORDS[word.toLowerCase()]
  if (view === undefined) return { view: "help", unknown: word }
  return rest.length ? { view, arg: rest.join(" ") } : { view }
}

export interface ViewInput {
  graph: ContextGraph
  usage: SessionUsageSnapshot | undefined
  root: string | undefined
  /** Findings of the analyzers; undefined when they were not run. */
  issues?: readonly ContextIssue[]
  /** Subagents spawned this session. */
  agents?: readonly AgentRecord[]
  /** The experiment view's text: a run in progress or the latest result. */
  experiment?: readonly string[]
}

/** The window the share is measured against when the engine has not said: Claude's usual 200k. */
const DEFAULT_WINDOW = 200_000

// ── Resumen ─────────────────────────────────────────────────────────────────

export function renderOverview(input: ViewInput): string {
  const { graph, usage, root } = input
  const lines = ["CONTEXT LAB · qué lee Claude en esta conversación", ""]

  lines.push("CONTEXTO USADO")
  if (usage?.contextCapacity === undefined) lines.push("  Aún sin medir (se mide después de la primera respuesta).")
  else {
    const used = usage.contextUsed === undefined ? "?" : compactCount(usage.contextUsed)
    lines.push(`  ${used} de ${compactCount(usage.contextCapacity)} tokens${usage.contextPercent === undefined ? "" : ` (${usage.contextPercent}%)`}`)
    if (usage.contextPercent !== undefined) lines.push(`  ${bar(usage.contextPercent)}`)
  }
  lines.push("")

  if (graph.contexts === 0) {
    lines.push("LO QUE CLAUDE LEE SIEMPRE")
    lines.push("  Aún no se ha visto: aparece al empezar la conversación.")
  } else {
    const files = currentInstructions(graph)
    lines.push(row("LO QUE CLAUDE LEE SIEMPRE, antes de que escribas", `${approx(instructionTokens(graph))} tokens`))
    for (const n of files) lines.push(row(`  ${shortPath(n.path === undefined ? n.name : displayPath(n.path, root))}`, approx(tokensOf(n))))
    if (files.length === 0) lines.push("  Nada: no hay CLAUDE.md ni memoria en esta conversación.")
  }

  const nested = nestedInstructions(graph)
  if (nested.length || graph.inferred.length) {
    lines.push("", row("CARGADO AL TRABAJAR EN UNA CARPETA", `${approx(nestedTokens(graph))} tokens`))
    for (const n of nested) lines.push(row(`  ${shortPath(displayPath(n.path, root))}`, approx(tokensOf(n))))
    if (graph.inferred.length) {
      lines.push(`  + ${graph.inferred.length} que probablemente también se cargó (sin confirmar): ver tecla 2`)
    }
  }

  const skills = graph.skills.map((id) => graph.nodes[id]).filter((n) => n !== undefined)
  const listing = usage?.skillListing
  if (skills.length || listing) {
    lines.push("", "SKILLS")
    if (listing) {
      lines.push(row("  Lista de skills (Claude la lee siempre)", `${approx(listing.tokens)} tokens`))
      lines.push(`  ${listing.includedSkills === listing.totalSkills ? `Caben las ${listing.totalSkills}.` : `Caben ${listing.includedSkills} de ${listing.totalSkills}.`}`)
    }
    for (const n of skills) lines.push(row(`  Activada ahora: ${n.name.replace(/^skill: /, "")}`, approx(tokensOf(n))))
  }

  const agents = input.agents ?? []
  if (agents.length) lines.push("", `SUBAGENTES: ${agentLine(agents)}`)

  if (usage?.categories?.length) {
    lines.push("", "EN QUÉ SE VA EL CONTEXTO (estimación de Claude Code)")
    for (const c of [...usage.categories].sort((a, b) => b.tokens - a.tokens)) lines.push(row(`  ${c.name}`, approx(c.tokens)))
  }
  if (usage?.costUsd !== undefined) lines.push("", row("COSTE DE ESTA SESIÓN", `$${usage.costUsd.toFixed(2)}`))

  lines.push("", "QUÉ SIGNIFICA")
  for (const v of verdict(input)) lines.push(`  ${v}`)
  lines.push("", `Teclas: ${keysLine()}`)
  return lines.join("\n")
}

/**
 * The plain conclusion of the overview: how big the always-on instructions
 * are against the window, the skill listing's fit, and the findings.
 */
export function verdict(input: ViewInput): string[] {
  const { graph, usage, issues } = input
  const out: string[] = []
  if (graph.contexts > 0) {
    const tokens = instructionTokens(graph) + nestedTokens(graph)
    const window = usage?.contextCapacity ?? DEFAULT_WINDOW
    const share = (tokens / window) * 100
    const pct = share < 1 ? share.toFixed(1) : Math.round(share).toString()
    if (share < 2) out.push(`✓ Tus instrucciones son pequeñas (${pct}% del contexto). No hace falta recortar nada.`)
    else if (share < 10) out.push(`• Tus instrucciones ocupan el ${pct}% del contexto. Recortarlas ahorraría poco; mira si hay texto repetido.`)
    else {
      out.push(`⚠ Tus instrucciones ocupan el ${pct}% del contexto antes de que escribas nada.`)
      out.push("  Vale la pena resumirlas; luego comprueba con /context-lab probar que Claude sigue trabajando igual de bien.")
    }
  }
  const listing = usage?.skillListing
  if (listing && listing.includedSkills < listing.totalSkills) {
    out.push(`⚠ Tienes ${listing.totalSkills} skills y en la lista solo caben ${listing.includedSkills}: Claude no ve completas las demás.`)
    out.push("  Desactiva las que no uses con /skills.")
  }
  if (issues === undefined) {
    if (graph.contexts > 0) out.push(`Problemas: sin revisar todavía (tecla ${REFRESH_KEY}).`)
  } else if (issues.length === 0) out.push("✓ No se encontraron problemas (texto repetido, rutas rotas, listados innecesarios).")
  else {
    const c = countBySeverity(issues)
    const parts = (["high", "medium", "low", "info"] as const).filter((s) => c[s]).map((s) => severityCount(s, c[s]))
    out.push(`⚠ ${issues.length} problema${issues.length === 1 ? "" : "s"} (${parts.join(", ")}): tecla 3 para ver cuáles y qué hacer.`)
  }
  if (out.length === 0) out.push("Aún no hay nada que valorar: escribe algo y vuelve.")
  return out
}

// ── Archivos ────────────────────────────────────────────────────────────────

export function renderTree({ graph, root, agents }: ViewInput): string {
  const lines = ["ARCHIVOS QUE CLAUDE RECIBE", "", LEGEND, ""]
  const groups = contextTree(graph)
  if (groups.length === 0) lines.push("Aún no se ha visto nada: aparece al empezar la conversación.")
  for (const group of groups) {
    lines.push(group.label)
    drawItems(group.items, "  ", root, lines)
    lines.push("")
  }
  if (graph.rewrittenContexts > 0) {
    lines.push(`Nota: en ${graph.rewrittenContexts} conversación(es) otro plugin cambió las instrucciones; no se sabe de qué archivos venían.`, "")
  }
  if (agents?.length) {
    lines.push(`SUBAGENTES EN ESTA SESIÓN: ${agentLine(agents)}`)
    drawAgents(agentTree(agents), "  ", lines)
    lines.push("  (Claude Code no dice si un subagente recibe tus instrucciones.)", "")
  }
  lines.push(`"visto en N conversaciones" cuenta las conversaciones en las que Claude recibió ese archivo.`)
  return lines.join("\n")
}

function agentLine(agents: readonly AgentRecord[]): string {
  const s = summarizeAgents(agents)
  const types = s.byType.map((t) => `${t.type} ×${t.count}`).join(", ")
  const extra = [
    s.forks ? `${s.forks} copia${s.forks === 1 ? "" : "s"} de la conversación (fork)` : "",
    s.nested ? `${s.nested} lanzado${s.nested === 1 ? "" : "s"} por otro subagente` : "",
    s.denied ? `${s.denied} bloqueado${s.denied === 1 ? "" : "s"}` : "",
  ].filter(Boolean)
  return `${s.spawned} lanzado${s.spawned === 1 ? "" : "s"}${types ? ` (${types})` : ""}${extra.length ? ` · ${extra.join(" · ")}` : ""}`
}

function drawAgents(items: readonly AgentTreeItem[], pad: string, out: string[]): void {
  for (const item of items) {
    const a = item.agent
    const flags = [a.fork ? "fork" : "", a.background ? "en segundo plano" : "", a.teammate ? "compañero de equipo" : "", a.denied ? "BLOQUEADO" : ""]
      .filter(Boolean)
      .join(", ")
    const by = a.provider === "engine" ? "" : `  [de ${a.provider}]`
    out.push(`${pad}${a.type}${a.model ? `  ${a.model}` : ""}${flags ? `  (${flags})` : ""}${by}`)
    drawAgents(item.children, `${pad}    `, out)
  }
}

function drawItems(items: TreeItem[], pad: string, root: string | undefined, out: string[]): void {
  for (const item of items) {
    const n = item.node
    const label = n.kind === "skill" || n.kind === "unknown" ? n.name.replace(/^skill: /, "") : shortPath(displayPath(n.path, root))
    const facts = [`${approx(tokensOf(n))} tokens`]
    if (item.evidence === "observed") facts.push(`visto en ${n.loadCount} ${n.loadCount === 1 ? "conversación" : "conversaciones"}`)
    if (typeof n.metadata.inferredFrom === "string" && item.evidence === "inferred") facts.push(`al leer ${n.metadata.inferredFrom}`)
    out.push(row(`${pad}${MARK[item.evidence]} ${label}`, facts.join(" · "), 52))
    drawItems(item.children, `${pad}    `, root, out)
  }
}

// ── Problemas ───────────────────────────────────────────────────────────────

/** How a finding's weight reads: "Importancia alta" ... "Aviso". */
function severityLabel(s: Severity): string {
  return s === "info" ? "Aviso" : `Importancia ${{ high: "alta", medium: "media", low: "baja" }[s]}`
}

function severityCount(s: Severity, n: number): string {
  return s === "info" ? `${n} aviso${n === 1 ? "" : "s"}` : `${n} de importancia ${{ high: "alta", medium: "media", low: "baja" }[s]}`
}

/** /context-lab issues: every finding, where it is, what to do, and why we say so (SPEC §19, §23). */
export function renderIssues(issues: readonly ContextIssue[], graph: ContextGraph): string {
  const lines = [`PROBLEMAS EN LAS INSTRUCCIONES${issues.length ? ` (${issues.length})` : ""}`, ""]
  if (graph.contexts === 0) {
    lines.push("Aún no se ha visto nada: se revisa lo que Claude recibe de verdad, y la conversación no ha empezado.")
    return lines.join("\n")
  }
  if (issues.length === 0) {
    lines.push("✓ No se encontraron problemas.")
    lines.push("")
    lines.push("Se buscó: texto repetido, rutas que ya no existen, listados de carpetas")
    lines.push("innecesarios y secciones muy grandes que se cargan siempre.")
    return lines.join("\n")
  }
  issues.forEach((issue, i) => {
    lines.push(`[${i + 1}] ${severityLabel(issue.severity)} · ${issue.title}`)
    issue.locations.forEach((loc, k) => lines.push(`    ${k === 0 ? "Dónde:    " : "          "}${loc}`))
    lines.push(`    Qué pasa: ${issue.explanation}`)
    lines.push(`    Qué hacer: ${issue.action}`)
    if (issue.estimatedSavings !== undefined) lines.push(`    Ahorro:   ${approx(issue.estimatedSavings)} tokens por conversación`)
    if (issue.details.length) {
      lines.push("    Por qué lo digo:")
      for (const d of issue.details) lines.push(`      · ${d.text}`)
    }
    lines.push("")
  })
  lines.push("Son sugerencias: Context Lab nunca cambia tus archivos.")
  return lines.join("\n")
}

// ── Experimentos ────────────────────────────────────────────────────────────

export const EXPERIMENTS_EMPTY = [
  "Aún no hay experimentos.",
  "",
  "Un experimento responde: «si cambio mis instrucciones, ¿Claude trabaja igual de bien?».",
  "Da las mismas tareas a Claude con tus instrucciones actuales y con las cambiadas, y compara.",
  "",
  "Cómo hacer uno:",
  "  1. /context-lab init                     crea la carpeta .context-lab/",
  "  2. Escribe tareas en .context-lab/evals/tasks/ (hay un ejemplo)",
  "  3. Pon la versión cambiada en .context-lab/variants/<nombre>/",
  "  4. Haz commit y ejecuta /context-lab eval <nombre>",
]

// ── Pane, band, help ────────────────────────────────────────────────────────

/** The body of one pane view, as lines; the same text the command prints headless. */
export function paneLines(view: PaneView, input: ViewInput): string[] {
  if (view === "tree") return renderTree(input).split("\n")
  if (view === "issues") {
    if (input.issues === undefined && input.graph.contexts > 0) return [`Aún sin revisar: pulsa ${REFRESH_KEY} para buscar problemas.`]
    return renderIssues(input.issues ?? [], input.graph).split("\n")
  }
  if (view === "experiments") return ["EXPERIMENTOS", "", ...(input.experiment ?? EXPERIMENTS_EMPTY)]
  return renderOverview(input).split("\n")
}

/**
 * The band above the prompt: one line, or undefined while nothing has been
 * observed (the band then stays out of the way).
 */
export function bandLine(input: ViewInput): string | undefined {
  const { graph, usage, issues } = input
  if (graph.contexts === 0 && usage?.contextCapacity === undefined) return undefined
  const parts = ["Context Lab"]
  if (usage?.contextCapacity !== undefined) {
    const used = usage.contextUsed === undefined ? "?" : compactCount(usage.contextUsed)
    parts.push(`contexto ${used} de ${compactCount(usage.contextCapacity)}${usage.contextPercent === undefined ? "" : ` (${usage.contextPercent}%)`}`)
  }
  if (graph.contexts > 0) {
    const files = currentInstructions(graph).length + nestedInstructions(graph).length
    parts.push(`Claude lee siempre ${approx(instructionTokens(graph) + nestedTokens(graph))} tokens (${files} archivo${files === 1 ? "" : "s"})`)
    if (graph.skills.length) parts.push(`${graph.skills.length} skill${graph.skills.length === 1 ? "" : "s"} activa${graph.skills.length === 1 ? "" : "s"}`)
  }
  if (issues !== undefined) parts.push(issues.length === 0 ? "sin problemas" : `${issues.length} problema${issues.length === 1 ? "" : "s"}`)
  return parts.join(" · ")
}

function keysLine(): string {
  return `${TABS.map((t) => `${t.hotkey} ${t.label}`).join(" · ")} · ${REFRESH_KEY} Actualizar · Esc Cerrar`
}

/** The one line a command leaves in the transcript when the pane shows the view. */
export function openedLine(view: PaneView): string {
  const tab = TABS.find((t) => t.view === view)!
  return `Context Lab abierto en ${tab.label}. Teclas: ${keysLine()}.`
}

export function renderHelp(p: Parsed): string {
  const lines: string[] = []
  if (p.unknown) lines.push(`No conozco "${p.unknown}".`, "")
  lines.push(
    "/context-lab                   abre el panel: qué lee Claude y si sobra algo",
    "/context-lab archivos          qué archivos recibe Claude, uno a uno",
    "/context-lab problemas         texto repetido, rutas rotas, secciones grandes… y qué hacer",
    "/context-lab experimentos      resultados de las pruebas con instrucciones cambiadas",
    "/context-lab iniciar           crea .context-lab/ para hacer experimentos",
    "/context-lab probar <nombre>   compara tus instrucciones con la versión <nombre> (probar stop: detener)",
    "/context-lab informe           guarda un informe en .context-lab/reports/",
    "/context-lab doctor            comprueba qué puede ver Context Lab en esta instalación",
    "",
    "También valen los nombres en inglés: overview, tree, issues, experiments, init, eval, report.",
  )
  return lines.join("\n")
}

// ── Doctor ──────────────────────────────────────────────────────────────────

export interface DoctorFacts {
  version?: string
  observed: Readonly<Record<string, number>>
  git: { available: boolean; version?: string }
  repo: { isRepo: boolean; clean?: boolean; dirty?: number; sha?: string }
  root?: string
  usageApi: boolean
  breakdown: boolean
  fs: boolean
}

export const WATCHED_EVENTS = ["prompt.context", "session.measure", "prompt.attachment", "tool.call", "skill.prompt", "agent.spawn"]

/** What each watched event lets Context Lab see, for the doctor. */
const EVENT_MEANING: Record<string, string> = {
  "prompt.context": "instrucciones al empezar",
  "session.measure": "uso del contexto",
  "prompt.attachment": "CLAUDE.md de carpetas",
  "tool.call": "lecturas de archivos",
  "skill.prompt": "skills activadas",
  "agent.spawn": "subagentes",
}

/** Counters register.tsx keeps in `observed` for nested_memory attribution. */
export const NESTED_SEEN = "nested_memory"
export const NESTED_FILES = "nested_memory:files"
export const NESTED_UNATTRIBUTED = "nested_memory:unattributed"

export function renderDoctor(f: DoctorFacts): string {
  const ok = "✓"
  const no = "✗"
  const lines = ["CONTEXT LAB · comprobación", ""]
  const versionOk = f.version !== undefined && compareVersions(f.version, MIN_VERSION) >= 0
  lines.push(row(`Claude Code ${f.version ?? "(versión desconocida)"}`, versionOk ? ok : `${no} necesita ${MIN_VERSION} o superior`))
  lines.push("", "Qué ha podido ver en esta sesión:")
  for (const ev of WATCHED_EVENTS) {
    const n = f.observed[ev] ?? 0
    lines.push(row(`  ${EVENT_MEANING[ev] ?? ev}`, n > 0 ? `${ok} ${n} ${n === 1 ? "vez" : "veces"}` : "todavía no ha ocurrido"))
  }
  const attachments = f.observed[NESTED_SEEN] ?? 0
  const unattributed = f.observed[NESTED_UNATTRIBUTED] ?? 0
  if (attachments > 0) {
    lines.push(
      row(
        "  qué archivo era cada CLAUDE.md de carpeta",
        unattributed === 0 ? `${ok} identificados ${f.observed[NESTED_FILES] ?? 0}` : `${no} ${unattributed} de ${attachments} sin identificar (¿cambió el formato?)`,
      ),
    )
  }
  lines.push("", "Para hacer experimentos:")
  lines.push(row("  Git", f.git.available ? `${ok} ${f.git.version ?? ""}`.trim() : `${no} no encontrado`))
  if (!f.repo.isRepo) lines.push(row("  Repositorio", "esta carpeta no es un repositorio git"))
  else lines.push(row("  Cambios sin commit", f.repo.clean ? `${ok} ninguno` : `${no} ${f.repo.dirty ?? "?"} archivo(s): haz commit antes de probar`))
  lines.push(row("  Carpeta del proyecto", f.root ?? "(desconocida)"))
  lines.push(row("  Acceso a archivos", f.fs ? ok : no))
  lines.push("", "Medición:")
  lines.push(row("  Uso del contexto", f.usageApi ? ok : no))
  lines.push(row("  Tamaño por archivo según Claude Code", f.breakdown ? `${ok} (estimación local)` : "no disponible"))
  lines.push(row("  Recuento exacto de tokens", "apagado (usaría la red)"))
  lines.push("")
  const evalReady = f.git.available && f.repo.isRepo && f.repo.clean === true
  const ready = versionOk && f.fs && f.usageApi
  lines.push(`Estado: ${ready ? "LISTO" : "INCOMPLETO"}${ready && !evalReady ? " (para experimentos hace falta un repositorio git sin cambios pendientes)" : ""}`)
  return lines.join("\n")
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10))
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10))
  for (let i = 0; i < 3; i++) {
    const d = (Number.isNaN(pa[i]) ? 0 : (pa[i] ?? 0)) - (Number.isNaN(pb[i]) ? 0 : (pb[i] ?? 0))
    if (d !== 0) return d
  }
  return 0
}

// ── helpers ─────────────────────────────────────────────────────────────────

function bar(percent: number, width = 30): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`
}

function row(label: string, value: string, width = 48): string {
  return label.length >= width ? `${label}  ${value}` : label.padEnd(width) + value
}

/** Long paths keep their start and their file name: `~/.claude/projects/…/memory/MEMORY.md`. */
export function shortPath(path: string, max = 44): string {
  if (path.length <= max) return path
  const parts = path.split("/")
  const tail = parts.slice(-2).join("/")
  const head = parts.slice(0, 2).join("/")
  const short = `${head}/…/${tail}`
  return short.length < path.length ? short : path
}

function compactCount(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
}
