import { canonicalPath } from "./graph-builder.ts"
import type { ContextGraph, ContextKind, ContextNode, EvidenceLevel } from "./graph.ts"

// Read-only views over the graph for the UI and reports.

export const MARK: Record<EvidenceLevel, string> = { observed: "●", inferred: "◐", available: "○" }
export const LEGEND = "● observed  ◐ inferred  ○ available"

export interface TreeGroup {
  label: string
  /** The group's evidence: its strongest member's. */
  evidence: EvidenceLevel
  items: TreeItem[]
}

export interface TreeItem {
  node: ContextNode
  /** Evidence in this context (the node's `evidence` is the strongest it ever had). */
  evidence: EvidenceLevel
  children: TreeItem[]
}

const GROUPS: { label: string; kinds: ContextKind[] }[] = [
  { label: "MANAGED", kinds: ["managed"] },
  { label: "USER", kinds: ["user"] },
  { label: "PROJECT", kinds: ["project", "local"] },
  { label: "MEMORY", kinds: ["memory"] },
  { label: "UNATTRIBUTED", kinds: ["unknown"] },
]

/** Instruction nodes of the latest observed context, in load order. */
export function currentInstructions(graph: ContextGraph): ContextNode[] {
  return pick(graph, graph.current)
}

/** Nested instruction files the engine attached in this context. */
export function nestedInstructions(graph: ContextGraph): ContextNode[] {
  return pick(graph, graph.nested)
}

/** Tokens of the current always-on instructions: engine estimate when present, else local. */
export function instructionTokens(graph: ContextGraph): number {
  return currentInstructions(graph).reduce((sum, n) => sum + tokensOf(n), 0)
}

export function nestedTokens(graph: ContextGraph): number {
  return nestedInstructions(graph).reduce((sum, n) => sum + tokensOf(n), 0)
}

export function tokensOf(n: ContextNode): number {
  return n.engineTokens ?? n.estimatedTokens ?? 0
}

/**
 * The architecture as /context-lab tree draws it: the latest context's
 * always-on files grouped by tier, imports nested under their parent; then
 * nested files attached on read, skills, and the inferred and available ones,
 * each marked with its evidence in this context.
 */
export function contextTree(graph: ContextGraph): TreeGroup[] {
  const live = currentInstructions(graph)
  const groups: TreeGroup[] = []
  for (const { label, kinds } of GROUPS) {
    const members = live.filter((n) => kinds.includes(n.kind))
    if (members.length) groups.push(group(label, members, "observed"))
  }
  const nested = nestedInstructions(graph)
  if (nested.length) groups.push(group("NESTED (attached on read)", nested, "observed"))
  const skills = Object.values(graph.nodes).filter((n) => n.kind === "skill")
  if (skills.length) groups.push(group("SKILLS", skills, "observed"))
  const inferred = pick(graph, graph.inferred)
  if (inferred.length) groups.push(group("POSSIBLE NESTED", inferred, "inferred"))
  const available = pick(graph, graph.available)
  if (available.length) groups.push(group("AVAILABLE", available, "available"))
  return groups
}

function group(label: string, nodes: ContextNode[], evidence: EvidenceLevel): TreeGroup {
  return { label, evidence, items: nest(nodes, evidence) }
}

function pick(graph: ContextGraph, ids: readonly string[]): ContextNode[] {
  return ids.map((id) => graph.nodes[id]).filter((n): n is ContextNode => n !== undefined)
}

function nest(nodes: ContextNode[], evidence: EvidenceLevel): TreeItem[] {
  const ids = new Set(nodes.map((n) => n.id))
  const items = new Map(nodes.map((n) => [n.id, { node: n, evidence, children: [] as TreeItem[] }]))
  const roots: TreeItem[] = []
  for (const n of nodes) {
    const item = items.get(n.id)!
    const parent = n.parentId !== undefined && ids.has(n.parentId) ? items.get(n.parentId) : undefined
    if (parent && parent !== item) parent.children.push(item)
    else roots.push(item)
  }
  return roots
}

/**
 * How a path reads to the person: `./x` under the project root, `~/x` under a
 * home directory, else as is.
 */
export function displayPath(path: string | undefined, root: string | undefined): string {
  if (path === undefined) return "(no path)"
  const p = canonicalPath(path)
  if (root !== undefined) {
    const r = canonicalPath(root)
    if (p === r) return "."
    if (p.startsWith(`${r}/`)) return `./${p.slice(r.length + 1)}`
  }
  const home = /^(?:[a-z]:)?\/(?:users|home)\/[^/]+\/(.*)$/i.exec(p)
  if (home) return `~/${home[1]}`
  if (p.startsWith("/root/")) return `~/${p.slice(6)}`
  return p
}
