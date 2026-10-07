import { addEdge, canonicalPath, nodeId, upsertNode } from "../graph/graph-builder.ts"
import type { ContextGraph, ContextKind } from "../graph/graph.ts"
import { sha256 } from "../metrics/hash.ts"
import { measure } from "../metrics/size.ts"

// prompt.context → graph (SPEC §8). Observe only: the caller passes what
// next(e) resolved to, i.e. what is actually sent after every hook below.
// File contents are measured and hashed here, then dropped.

/** Structural slice of the engine's PromptContextResult. */
export interface ContextPayload {
  blocks: readonly { name: string; text: string }[]
  instructionFiles?: readonly { path: string; kind: string; content: string; parent?: string }[]
}

export interface ObserveContext {
  at: number
  sessionId?: string | undefined
  /** Engine per-file estimates (usage breakdown "summary"), by the path it reports. */
  engineTokens?: ReadonlyMap<string, number>
}

const INSTRUCTION_KINDS = new Set<ContextKind>(["managed", "user", "project", "local", "memory"])

export function observeContext(graph: ContextGraph, payload: ContextPayload, ctx: ObserveContext): ContextGraph {
  // A new context starts without nested files: they are attached again on demand.
  let g: ContextGraph = { ...graph, contexts: graph.contexts + 1, nested: [], inferred: [], available: [], skills: [] }
  if (ctx.sessionId !== undefined) g = { ...g, sessionId: ctx.sessionId }
  const load = { counted: true, sessionId: ctx.sessionId }

  if (payload.instructionFiles === undefined) {
    const block = payload.blocks.find((b) => b.name === "claudeMd")
    if (!block) return { ...g, current: [] }
    // A hook above rewrote the claudeMd text: the files behind it are unknown.
    // Record what is observably sent, and nothing we cannot see.
    const id = nodeId("unknown", "claudeMd")
    const size = measure(block.text)
    g = upsertNode(
      g,
      {
        id,
        name: "claudeMd (rewritten by a hook; files unknown)",
        kind: "unknown",
        evidence: "observed",
        loadOrder: 0,
        contentHash: sha256(block.text),
        ...size,
      },
      ctx.at,
      load,
    )
    return { ...g, current: [id], rewrittenContexts: g.rewrittenContexts + 1 }
  }

  const files = payload.instructionFiles
  const kindOf = new Map<string, ContextKind>()
  for (const f of files) kindOf.set(canonicalPath(f.path), toKind(f.kind))
  const idOf = (path: string): string | undefined => {
    const canon = canonicalPath(path)
    const kind = kindOf.get(canon)
    if (kind) return nodeId(kind, canon)
    return Object.values(g.nodes).find((n) => n.path === canon)?.id
  }

  const current: string[] = []
  files.forEach((f, order) => {
    const canon = canonicalPath(f.path)
    const kind = toKind(f.kind)
    const id = nodeId(kind, canon)
    const parentId = f.parent === undefined ? undefined : idOf(f.parent)
    const engine = ctx.engineTokens?.get(f.path) ?? lookupCanonical(ctx.engineTokens, canon)
    g = upsertNode(
      g,
      {
        id,
        path: canon,
        name: basename(canon),
        kind,
        evidence: "observed",
        loadOrder: order,
        contentHash: sha256(f.content),
        ...measure(f.content),
        ...(parentId === undefined ? {} : { parentId }),
        ...(engine === undefined ? {} : { engineTokens: engine }),
      },
      ctx.at,
      load,
    )
    if (parentId !== undefined) g = addEdge(g, { from: parentId, to: id, type: "imports", evidence: "observed" })
    if (!current.includes(id)) current.push(id)
  })
  return { ...g, current }
}

/** Attaches engine per-file estimates to this context's files (always-on and nested). */
export function applyEngineTokens(graph: ContextGraph, engineTokens: ReadonlyMap<string, number>): ContextGraph {
  let changed = false
  const nodes = { ...graph.nodes }
  for (const id of [...graph.current, ...graph.nested]) {
    const n = nodes[id]
    if (!n?.path) continue
    const t = lookupCanonical(engineTokens, n.path)
    if (t !== undefined && t !== n.engineTokens) {
      nodes[id] = { ...n, engineTokens: t }
      changed = true
    }
  }
  return changed ? { ...graph, nodes } : graph
}

function lookupCanonical(map: ReadonlyMap<string, number> | undefined, canon: string): number | undefined {
  if (!map) return undefined
  for (const [path, tokens] of map) if (canonicalPath(path) === canon) return tokens
  return undefined
}

function toKind(kind: string): ContextKind {
  return INSTRUCTION_KINDS.has(kind as ContextKind) ? (kind as ContextKind) : "unknown"
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path
}

/**
 * The text each instruction node was actually sent with, keyed by node id:
 * for the analyzers, held in memory only, never persisted (SPEC §39).
 */
export function deliveredTexts(payload: ContextPayload): Map<string, string> {
  const out = new Map<string, string>()
  if (payload.instructionFiles === undefined) {
    const block = payload.blocks.find((b) => b.name === "claudeMd")
    if (block) out.set(nodeId("unknown", "claudeMd"), block.text)
    return out
  }
  for (const f of payload.instructionFiles) {
    const canon = canonicalPath(f.path)
    out.set(nodeId(toKind(f.kind), canon), f.content)
  }
  return out
}
