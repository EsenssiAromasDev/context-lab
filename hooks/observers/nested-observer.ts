import { canonicalPath, nodeId, upsertNode } from "../graph/graph-builder.ts"
import type { ContextGraph, ContextKind, EvidenceLevel } from "../graph/graph.ts"
import { sha256 } from "../metrics/hash.ts"
import { CHARS_PER_TOKEN, measure } from "../metrics/size.ts"

// Nested instruction files (SPEC §12): three levels of evidence, never mixed.
//
//   observed   a `nested_memory` attachment the engine sent, attributed to a path
//   inferred   the engine's own nested walk ($.fs.ancestors) finds the file
//              after a Read, but no attachment for it has been seen
//   available  the file exists in the repository; nothing says it was loaded
//
// The attachment's text format is not part of the typed API: attribution is a
// heuristic over its "Contents of <path>…:" headers, and whatever cannot be
// attributed is counted, not guessed.

export interface NestedFile {
  path: string
  /** The file's text as delivered or read; measured and hashed here, then dropped. */
  content: string
}

export interface NestedContext {
  at: number
  root: string
  sessionId?: string | undefined
}

/** Instruction file names the engine loads from nested directories. */
export const NESTED_NAMES = ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"] as const

/** Names Context Lab reports as available when found in the repository. */
export const AVAILABLE_NAMES = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"])

const HEADER = /^Contents of (.+?\.md)(?: \([^\n]*\))?:[ \t]*$/gm

/**
 * Splits a nested_memory attachment's text into the files it carries, by its
 * "Contents of <path>:" headers. Text with no recognizable header yields [].
 */
export function parseNestedMemory(text: string): NestedFile[] {
  const heads = [...text.matchAll(HEADER)]
  return heads.map((m, i) => {
    const start = m.index! + m[0].length
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : text.length
    return { path: m[1]!.trim(), content: text.slice(start, end).replace(/^\s*\n/, "").trimEnd() }
  })
}

/** The tier a nested file belongs to, judged from its path. */
export function kindForPath(path: string): ContextKind {
  const p = canonicalPath(path)
  return p.endsWith("/CLAUDE.local.md") || p === "CLAUDE.local.md" ? "local" : "project"
}

export interface AttachmentOutcome {
  graph: ContextGraph
  attributed: number
}

/** A nested_memory attachment as sent (after every hook): its files become observed. */
export function observeNestedAttachment(graph: ContextGraph, text: string, ctx: NestedContext): AttachmentOutcome {
  const files = parseNestedMemory(text)
  let g = graph
  for (const f of files) {
    const canon = canonicalPath(f.path)
    const id = nodeId(kindForPath(canon), canon)
    g = upsertNode(
      g,
      {
        id,
        path: canon,
        name: basename(canon),
        kind: kindForPath(canon),
        evidence: "observed",
        contentHash: sha256(f.content),
        ...measure(f.content),
      },
      ctx.at,
      { counted: true, sessionId: ctx.sessionId },
    )
    g = place(g, id, "observed")
  }
  return { graph: g, attributed: files.length }
}

/**
 * The files the engine's nested walk finds for a file just read. Each one not
 * observed in this context becomes inferred; observed ones stay as they are.
 */
export function inferFromRead(graph: ContextGraph, found: readonly NestedFile[], readPath: string, ctx: NestedContext): ContextGraph {
  const root = canonicalPath(ctx.root)
  let g = graph
  for (const f of found) {
    const canon = canonicalPath(f.path)
    if (!isStrictlyInside(canon, root)) continue
    const id = nodeId(kindForPath(canon), canon)
    if (g.current.includes(id) || g.nested.includes(id)) continue
    g = upsertNode(
      g,
      {
        id,
        path: canon,
        name: basename(canon),
        kind: kindForPath(canon),
        evidence: "inferred",
        contentHash: sha256(f.content),
        ...measure(f.content),
      },
      ctx.at,
      { counted: false },
    )
    const node = g.nodes[id]!
    const trigger = relative(canonicalPath(readPath), root)
    g = { ...g, nodes: { ...g.nodes, [id]: { ...node, metadata: { ...node.metadata, inferredFrom: trigger } } } }
    g = place(g, id, "inferred")
  }
  return g
}

export interface RepoFile {
  path: string
  bytes: number
}

/** Instruction files found in the repository that this context has not otherwise accounted for. */
export function markAvailable(graph: ContextGraph, files: readonly RepoFile[], ctx: NestedContext): ContextGraph {
  let g: ContextGraph = { ...graph, available: [] }
  for (const f of files) {
    const canon = canonicalPath(f.path)
    const kind = kindForPath(canon)
    const id = nodeId(kind, canon)
    if (g.current.includes(id) || g.nested.includes(id) || g.inferred.includes(id)) continue
    const known = g.nodes[id]
    g = upsertNode(
      g,
      {
        id,
        path: canon,
        name: basename(canon),
        kind,
        evidence: "available",
        // Size from the listing only: the file is not read.
        ...(known?.characters === undefined
          ? { bytes: f.bytes, estimatedTokens: Math.ceil(f.bytes / CHARS_PER_TOKEN) }
          : {}),
      },
      known?.lastSeenAt ?? ctx.at,
      { counted: false },
    )
    g = place(g, id, "available")
  }
  return g
}

/** Directories a repository scan for instruction files never descends into. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".context-lab",
])

export function shouldDescend(name: string): boolean {
  return !SKIP_DIRS.has(name) && (!name.startsWith(".") || name === ".claude")
}

/** Puts a node in the list for its evidence in this context, out of the weaker ones. */
function place(g: ContextGraph, id: string, level: EvidenceLevel): ContextGraph {
  const without = (list: string[]) => list.filter((x) => x !== id)
  if (level === "observed") {
    return {
      ...g,
      nested: g.nested.includes(id) ? g.nested : [...g.nested, id],
      inferred: without(g.inferred),
      available: without(g.available),
    }
  }
  if (level === "inferred") {
    return { ...g, inferred: g.inferred.includes(id) ? g.inferred : [...g.inferred, id], available: without(g.available) }
  }
  return { ...g, available: g.available.includes(id) ? g.available : [...g.available, id] }
}

function isStrictlyInside(path: string, root: string): boolean {
  return path.startsWith(`${root}/`)
}

function relative(path: string, root: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path
}
