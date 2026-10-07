import { findListings, isDiscoverable, listingCandidates, scoreListing } from "../analysis/discoverability.ts"
import { exactDuplicates } from "../analysis/duplicates.ts"
import { DEFAULT_ANALYSIS, type AnalysisConfig } from "../analysis/issue-engine.ts"
import { historyBlock } from "../analysis/history.ts"
import { splitSections, type Section } from "../analysis/sections.ts"
import { extractPathRefs } from "../analysis/stale-paths.ts"
import { measure } from "../metrics/size.ts"
import type { EvalConfig } from "./config.ts"
import { joinPath, type EvalHost } from "./host.ts"
import { instructionsAt, isPathScoped, worktreeBase, type GitInfo } from "./worktree.ts"

// A proposed, slimmer instruction set — written as a context variant, never
// applied by itself. Deterministic transforms first (nothing is rephrased):
//
//   1. exact duplicate sections   → keep the first copy
//   2. discoverable listings      → one line saying Claude can list the files
//   3. a dated log ("2026-08-12 — …") → moved to docs/, one pointer line left
//   4. sections about one folder  → moved to .claude/rules/<name>.md with
//                                   `paths:` so they load only for that folder
//
// Optionally (explicit opt-in, it calls a model): large always-on sections are
// rewritten shorter by Claude, keeping every rule, command and path.

export interface ProposedChange {
  file: string
  kind: "duplicate" | "listing" | "history" | "path-scoped" | "summarized"
  /** Plain description of what changed. */
  what: string
  tokensBefore: number
  tokensAfter: number
}

export interface Proposal {
  name: string
  dir: string
  changes: ProposedChange[]
  /** Always-on project instruction tokens (local estimate), before and after. */
  before: number
  after: number
  files: string[]
  /** Files the proposal removes (all of their content was a duplicate). */
  deleted: string[]
}

interface Edit {
  /** 1-based inclusive line range in the original file. */
  from: number
  to: number
  replacement: string[]
}

/** Files whose content is always loaded and that the proposal may change. */
function transformable(path: string, text: string): boolean {
  if (path.endsWith("AGENTS.md") || path.endsWith("CLAUDE.local.md")) return false
  if (path.startsWith(".claude/rules/")) return !isPathScoped(text)
  return path.endsWith("CLAUDE.md")
}

function looksSpanish(text: string): boolean {
  const words = text.toLowerCase().match(/\b(el|la|los|las|de|que|para|con|una|por|del)\b/g)?.length ?? 0
  const en = text.toLowerCase().match(/\b(the|and|for|with|that|this|from|you)\b/g)?.length ?? 0
  return words > en
}

const GENERIC_ROOTS = new Set(["src", "lib", "app", "packages", "apps", "source", "code"])

/**
 * The folder a section is only about, when every path it names lies under
 * one specific folder (a bare `src/` is too broad to be worth scoping).
 */
export function scopeOf(section: Section): string | undefined {
  const refs = extractPathRefs({ nodeId: section.nodeId, file: section.file, text: section.body })
    .map((r) => r.path.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((p) => !p.startsWith("../"))
  if (refs.length < 2) return undefined
  const dirs = refs.map((p) => {
    const segs = p.split("/")
    return /\.[a-z0-9]+$/i.test(segs[segs.length - 1]!) ? segs.slice(0, -1) : segs
  })
  const common: string[] = []
  for (let i = 0; ; i++) {
    const seg = dirs[0]![i]
    if (seg === undefined || !dirs.every((d) => d[i] === seg)) break
    common.push(seg)
  }
  if (common.length === 0) return undefined
  if (common.length === 1 && GENERIC_ROOTS.has(common[0]!.toLowerCase())) return undefined
  return common.join("/")
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "seccion"
  )
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  const lines = text.split(/\r?\n/)
  for (const e of [...edits].sort((a, b) => b.from - a.from)) lines.splice(e.from - 1, e.to - e.from + 1, ...e.replacement)
  return lines.join("\n").replace(/\n{3,}/g, "\n\n")
}

function overlaps(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from <= b.to && b.from <= a.to
}

export interface ProposeOptions {
  /** Rewrite large always-on sections shorter with Claude (calls a model). */
  summarize?: boolean
  /** How to start Claude Code (from resolveClaude), needed with `summarize`. */
  claude?: readonly string[]
  analysis?: AnalysisConfig
}

/**
 * Builds the proposal from the instruction files at HEAD and writes it as
 * `.context-lab/variants/<name>/`. Returns undefined when nothing would change.
 */
export async function propose(host: EvalHost, root: string, info: GitInfo, config: EvalConfig, opts: ProposeOptions = {}): Promise<Proposal | undefined> {
  const analysis = opts.analysis ?? DEFAULT_ANALYSIS
  const all = await instructionsAt(host, info, info.sha)
  const files = [...all].filter(([p, t]) => transformable(p, t)).sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
  const edits = new Map<string, Edit[]>()
  const changes: ProposedChange[] = []
  const newFiles = new Map<string, string>()
  const add = (path: string, e: Edit) => {
    const list = edits.get(path) ?? []
    if (list.some((x) => overlaps(x, e))) return false
    list.push(e)
    edits.set(path, list)
    return true
  }
  const sectionsByFile = new Map(files.map(([p, t]) => [p, splitSections({ nodeId: p, file: p, text: t })]))
  const allSections = [...sectionsByFile.values()].flat()
  const range = (s: Section) => ({ from: s.line, to: s.endLine })

  // 1. Exact duplicates: the first copy stays.
  for (const g of exactDuplicates(allSections)) {
    for (const s of g.sections.slice(1)) {
      if (add(s.nodeId, { ...range(s), replacement: [] })) {
        changes.push({ file: s.nodeId, kind: "duplicate", what: `Quitada "${s.heading}": repetía ${g.sections[0]!.nodeId} > ${g.sections[0]!.heading}`, tokensBefore: s.estimatedTokens, tokensAfter: 0 })
      }
    }
  }

  // 2. Listings Claude can rebuild by looking at the folders.
  for (const [path, text] of files) {
    for (const listing of findListings({ nodeId: path, file: path, text })) {
      const candidates = listingCandidates(listing, root)
      const existing = new Set<string>()
      for (const c of candidates) if (await host.exists(c)) existing.add(c)
      const scored = scoreListing(listing, (p) => existing.has(p), root)
      if (!isDiscoverable(scored, analysis.discoverableMinRatio)) continue
      const note = looksSpanish(text)
        ? "_(Listado quitado: Claude puede ver la estructura de carpetas cuando la necesite.)_"
        : "_(Listing removed: Claude can look at the folder structure when it needs it.)_"
      if (add(path, { from: listing.line, to: listing.endLine, replacement: [note] })) {
        changes.push({ file: path, kind: "listing", what: `Quitado un listado de ${scored.total} rutas (línea ${listing.line})`, tokensBefore: listing.estimatedTokens, tokensAfter: measure(note).estimatedTokens })
      }
    }
  }

  // 3. A dated log moves to a file of its own, with one line saying where.
  for (const [path, text] of files) {
    const h = historyBlock(sectionsByFile.get(path) ?? [])
    if (!h) continue
    const spanish = looksSpanish(text)
    let target = spanish ? "docs/claude-historial.md" : "docs/claude-history.md"
    if (all.has(target) || (await host.exists(joinPath(root, target)))) target = target.replace(/\.md$/, "-context-lab.md")
    const lines = text.split(/\r?\n/)
    const pointer = spanish
      ? `_(Historial del proyecto movido a ${target}: léelo cuando necesites el contexto de decisiones pasadas.)_`
      : `_(Project history moved to ${target}: read it when you need the context of past decisions.)_`
    const ranges = h.ranges.filter((r, i) => add(path, { ...r, replacement: i === 0 ? [pointer, ""] : [] }))
    if (ranges.length === 0) continue
    const moved = ranges.map((r) => lines.slice(r.from - 1, r.to).join("\n").trimEnd()).join("\n\n")
    const title = spanish ? `# Historial del proyecto\n\n_(Movido desde ${path} por Context Lab.)_` : `# Project history\n\n_(Moved from ${path} by Context Lab.)_`
    newFiles.set(target, `${title}\n\n${moved}\n`)
    changes.push({ file: path, kind: "history", what: `${ranges.length} entradas con fecha movidas a ${target} (queda una línea que dice dónde)`, tokensBefore: h.estimatedTokens, tokensAfter: measure(pointer).estimatedTokens })
  }

  // 4. Sections about one folder become path-scoped rules.
  for (const [path] of files) {
    if (path.startsWith(".claude/rules/")) continue
    for (const s of sectionsByFile.get(path) ?? []) {
      if (s.level === 0 || s.estimatedTokens < 120) continue
      const scope = scopeOf(s)
      if (!scope) continue
      const rule = `.claude/rules/${slug(scope)}-${slug(s.heading)}.md`
      if (newFiles.has(rule) || all.has(rule)) continue
      if (!add(path, { ...range(s), replacement: [] })) continue
      const body = `---\npaths:\n  - "${scope}/**"\n---\n\n${"#".repeat(s.level)} ${s.heading}\n\n${s.body}\n`
      newFiles.set(rule, body)
      changes.push({ file: path, kind: "path-scoped", what: `"${s.heading}" movida a ${rule}: solo se carga al trabajar en ${scope}/`, tokensBefore: s.estimatedTokens, tokensAfter: 0 })
    }
  }

  // 5. Optional: large always-on sections rewritten shorter by Claude.
  if (opts.summarize && opts.claude) {
    for (const [path] of files) {
      for (const s of sectionsByFile.get(path) ?? []) {
        if (s.estimatedTokens < analysis.largeSectionEstimatedTokens) continue
        const edited = edits.get(path)?.some((e) => overlaps(e, range(s)))
        if (edited) continue
        const shorter = await summarize(host, info, config, opts.claude, s)
        if (!shorter) continue
        const replacement = s.level > 0 ? [`${"#".repeat(s.level)} ${s.heading}`, "", ...shorter.split("\n"), ""] : [...shorter.split("\n"), ""]
        if (add(path, { ...range(s), replacement })) {
          changes.push({ file: path, kind: "summarized", what: `"${s.heading}" resumida por Claude`, tokensBefore: s.estimatedTokens, tokensAfter: measure(shorter).estimatedTokens })
        }
      }
    }
  }

  if (changes.length === 0) return undefined

  const now = new Date(await host.now())
  const name = `auto-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  const dir = joinPath(root, ".context-lab/variants", name)
  const written: string[] = []
  const deleted: string[] = []
  for (const [path, text] of files) {
    const e = edits.get(path)
    if (!e?.length) continue
    const next = applyEdits(text, e)
    // A file left with nothing but its frontmatter or blank lines is removed, not kept empty.
    if (next.replace(/^---[\s\S]*?---/, "").trim() === "" && path !== "CLAUDE.md") {
      deleted.push(path)
      continue
    }
    await host.write(joinPath(dir, "files", path), next)
    written.push(path)
  }
  for (const [path, text] of newFiles) {
    await host.write(joinPath(dir, "files", path), text)
    written.push(path)
  }
  const before = files.reduce((n, [, t]) => n + measure(t).estimatedTokens, 0)
  const removed = changes.reduce((n, c) => n + c.tokensBefore - c.tokensAfter, 0)
  const proposal: Proposal = { name, dir, changes, before, after: Math.max(0, before - removed), files: written, deleted }
  await host.write(
    joinPath(dir, "manifest.json"),
    `${JSON.stringify(
      {
        name,
        description: "Propuesta de Context Lab: misma información, menos texto siempre cargado.",
        createdFrom: info.sha,
        changes: changes.map((c) => ({ file: c.file, reason: c.what })),
        delete: deleted,
        tokensBefore: proposal.before,
        tokensAfter: proposal.after,
      },
      null,
      2,
    )}\n`,
  )
  return proposal
}

/** CLAUDE.md at the root first, then deeper files, rules last. */
function order(path: string): number {
  if (path === "CLAUDE.md") return 0
  if (path === ".claude/CLAUDE.md") return 1
  if (path.startsWith(".claude/rules/")) return 3
  return 2
}

const SUMMARY_PROMPT = (s: Section) =>
  [
    "Rewrite the following section of a CLAUDE.md file (instructions for an AI coding agent) to be as short as possible.",
    "Keep EVERY rule, constraint, command, file path, name and number exactly. Remove explanations, examples, history and repetition.",
    "Keep the same language as the original. Output ONLY the rewritten section body as Markdown, without the heading and without any comment.",
    "",
    `Section heading: ${s.heading}`,
    "-----",
    s.body,
  ].join("\n")

/** Claude's shorter version of a section, or undefined when it is not shorter or the call failed. */
async function summarize(host: EvalHost, info: GitInfo, config: EvalConfig, claude: readonly string[], s: Section): Promise<string | undefined> {
  // Run outside the repository so its own CLAUDE.md is not loaded (and paid for) again.
  const cwd = worktreeBase(info, config.worktreeDir)
  await host.write(joinPath(cwd, ".context-lab-summarize"), "")
  try {
    const r = await host.run([...claude, "-p", SUMMARY_PROMPT(s), "--output-format", "json", "--model", config.model ?? "haiku", "--strict-mcp-config"], {
      cwd,
      timeoutMs: 180_000,
    })
    if (r.exitCode !== 0) return undefined
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as { result?: unknown; is_error?: boolean }
    const text = typeof j.result === "string" && !j.is_error ? j.result.trim() : ""
    if (!text || measure(text).estimatedTokens >= s.estimatedTokens * 0.9) return undefined
    return text
  } catch {
    return undefined
  }
}

export function renderProposal(p: Proposal): string {
  const pct = p.before === 0 ? 0 : Math.round(((p.before - p.after) / p.before) * 100)
  const lines = [
    `PROPUESTA: ${p.name}`,
    "",
    `Instrucciones que Claude lee siempre: ~${p.before} → ~${p.after} tokens (−${pct}%)`,
    "",
    "Cambios (no se ha tocado ningún archivo tuyo; la propuesta está en",
    `${p.dir.replace(/\\/g, "/").replace(/^.*\/(\.context-lab\/)/, "$1")}/):`,
  ]
  for (const c of p.changes) lines.push(`  · ${c.file}: ${c.what}  (~${c.tokensBefore} → ~${c.tokensAfter} tokens)`)
  for (const d of p.deleted) lines.push(`  · ${d}: se borra (todo su contenido estaba repetido)`)
  return lines.join("\n")
}

