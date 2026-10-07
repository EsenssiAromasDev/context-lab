import { canonicalPath } from "../graph/graph-builder.ts"
import type { SourceText } from "./sections.ts"

// Stale references (SPEC §15): repository paths an instruction file names
// that do not exist. Extraction is conservative — ordinary English, branch
// names, package names, URLs, globs and commands are not paths.

export type Confidence = "high" | "medium"

export interface PathRef {
  nodeId: string
  file: string
  /** The path as written, cleaned of punctuation, anchors and quotes. */
  path: string
  confidence: Confidence
  /** 1-based line in the analyzed text. */
  line: number
}

const EXTENSIONS = new Set(
  (
    "ts tsx js jsx mjs cjs json jsonc md mdx py rb go rs java kt kts swift c h cc cpp hpp cs php sh bash zsh ps1 bat cmd " +
    "yml yaml toml ini cfg conf env lock sql html htm css scss sass less vue svelte astro txt xml gradle tf hcl proto " +
    "graphql gql prisma dockerfile r ipynb csv"
  ).split(" "),
)

const FENCE = /^[ \t]{0,3}(```|~~~)/
const INLINE_CODE = /`([^`\n]+)`/g
const LINK = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const BARE = /(?<![\w`/.-])((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\/?)(?![\w`])/g

export function extractPathRefs(src: SourceText): PathRef[] {
  const out: PathRef[] = []
  const seen = new Set<string>()
  const add = (raw: string, line: number, from: "code" | "link" | "bare") => {
    const path = clean(raw)
    const confidence = judge(path, from)
    if (!confidence) return
    const key = `${path}@${line}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ nodeId: src.nodeId, file: src.file, path, confidence, line })
  }

  let fence: string | null = null
  src.text.split(/\r?\n/).forEach((text, i) => {
    const f = FENCE.exec(text)
    if (f) {
      if (fence === null) fence = f[1]!
      else if (f[1] === fence) fence = null
      return
    }
    // Code blocks hold commands, trees and examples: trees are the
    // discoverability analyzer's, the rest is not a reference.
    if (fence !== null) return
    const line = i + 1
    for (const m of text.matchAll(LINK)) add(m[1]!, line, "link")
    const withoutLinks = text.replace(LINK, " ")
    for (const m of withoutLinks.matchAll(INLINE_CODE)) add(m[1]!, line, "code")
    const prose = withoutLinks.replace(INLINE_CODE, " ")
    for (const m of prose.matchAll(BARE)) add(m[1]!, line, "bare")
  })
  return out
}

function clean(raw: string): string {
  return raw
    .trim()
    .replace(/^["'(<]+|["')>,;:!?]+$/g, "")
    .replace(/[#?].*$/, "")
    .replace(/\.$/, "")
}

/** How sure we are that `path` names a repository path, or null when it does not. */
function judge(path: string, from: "code" | "link" | "bare"): Confidence | null {
  if (path.length < 3 || /\s/.test(path)) return null
  if (/:\/\/|^(?:https?|mailto|data):/i.test(path)) return null
  if (/[*?[\]{}<>$%=|\\]/.test(path)) return null
  if (/^[@~\-/]/.test(path)) return null
  if (path.includes(":")) return null
  if (!path.includes("/")) return null

  const relative = /^\.{1,2}\//.test(path)
  const dir = path.endsWith("/")
  const ext = extensionOf(path)
  const segments = path.replace(/^\.{1,2}\//, "").replace(/\/$/, "").split("/").filter(Boolean)
  if (segments.length === 0 || segments.some((s) => s === "." )) return null
  // Lists of alternatives, not paths: `system_a/b/c`, `.ttf/.otf/.woff`, `x/y`.
  if (segments.some((s) => /^[a-z]$/i.test(s))) return null
  // An elided path (`openspec/changes/.../spec.md`) names no single file.
  if (segments.some((s) => /^\.{3,}$/.test(s) || s.includes("…"))) return null
  if (segments.filter((s) => s.startsWith(".")).length >= 2) return null

  if (from === "link") return relative || ext || dir || segments.length >= 2 ? "high" : null
  if (from === "code") {
    if (ext || relative) return "high"
    if (dir || segments.length >= 3) return "medium"
    return null // `owner/repo`, `feat/branch`: not clearly a path
  }
  // Bare prose: only shapes ordinary words never take.
  if (relative && (ext || dir || segments.length >= 2)) return "medium"
  if (ext && segments.length >= 2) return "medium"
  if (dir && segments.length >= 2) return "medium"
  return null
}

function extensionOf(path: string): boolean {
  const last = path.replace(/\/$/, "").split("/").pop() ?? ""
  const dot = last.lastIndexOf(".")
  if (dot <= 0) return last.toLowerCase() === "dockerfile" || last.toLowerCase() === "makefile"
  return EXTENSIONS.has(last.slice(dot + 1).toLowerCase())
}

/** Where a reference may point: the project root first, then the file's own directory. */
export function candidatePaths(ref: PathRef, fileDir: string, root: string): string[] {
  const p = ref.path.replace(/\/$/, "")
  const out = new Set<string>()
  if (!p.startsWith("../")) out.add(join(root, p))
  out.add(join(fileDir, p))
  return [...out]
}

/**
 * Where the reference's first segment would be: a missing path is only called
 * stale when its anchor exists (`src/` is there, `src/legacy/api.ts` is not).
 * An unanchored "path" is as likely prose (`width/height/fps`) or relative to
 * another base as it is stale, and is not reported.
 */
export function anchorPaths(ref: PathRef, fileDir: string, root: string): string[] {
  const rel = ref.path.replace(/\/$/, "")
  const lead = /^(?:\.{1,2}\/)*/.exec(rel)![0]
  const first = rel.slice(lead.length).split("/")[0]!
  const out = new Set<string>()
  if (!lead.startsWith("..")) out.add(join(root, `${lead}${first}`))
  out.add(join(fileDir, `${lead}${first}`))
  return [...out]
}

/** Build output, dependencies and local env files: absent by design, never stale. */
const GENERATED = new Set(["dist", "out", "build", "target", "coverage", "node_modules", ".next", ".nuxt", "__pycache__", ".venv", "venv"])

export function isGenerated(path: string): boolean {
  return path
    .replace(/^(?:\.{1,2}\/)+/, "")
    .split("/")
    .some((s) => GENERATED.has(s) || /[-_]out$/.test(s) || /^\.env(?:\.|$)/.test(s))
}

export interface StaleRef extends PathRef {
  checked: string[]
}

export function staleRefs(
  refs: readonly PathRef[],
  exists: (path: string) => boolean,
  fileDirOf: (nodeId: string) => string,
  root: string,
): StaleRef[] {
  const out: StaleRef[] = []
  for (const r of refs) {
    if (isGenerated(r.path)) continue
    const dir = fileDirOf(r.nodeId)
    const checked = candidatePaths(r, dir, root)
    if (checked.some(exists)) continue
    if (!anchorPaths(r, dir, root).some(exists)) continue
    out.push({ ...r, checked })
  }
  return out
}

/** Joins and normalizes `./` and `../` segments, canonical form. */
export function join(dir: string, rel: string): string {
  const parts = canonicalPath(dir).split("/")
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (parts.length > 1) parts.pop()
    } else parts.push(seg)
  }
  return parts.join("/")
}

/**
 * The 1-based line of `needle` in a file's text on disk, nearest to `hint`
 * (its line in the delivered text, which lost comments and frontmatter).
 */
export function locateLine(diskText: string, needle: string, hint: number): number | undefined {
  let best: number | undefined
  diskText.split(/\r?\n/).forEach((text, i) => {
    if (!text.includes(needle)) return
    if (best === undefined || Math.abs(i + 1 - hint) < Math.abs(best - hint)) best = i + 1
  })
  return best
}
