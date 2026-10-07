import { canonicalPath } from "./graph-builder.ts"
import type { ContextGraph, ContextKind, ContextNode, EvidenceLevel } from "./graph.ts"

// Read-only views over the graph for the UI and reports.

export const MARK: Record<EvidenceLevel, string> = { observed: "●", inferred: "◐", available: "○" }
export const LEGEND = "● observed  ◐ inferred  ○ available"

export interface TreeGroup {
  label: string
  /** The group's own evidence: observed if any member was observed. */
  evidence: EvidenceLevel
  items: TreeItem[]
}

export interface TreeItem {
  node: ContextNode
  children: TreeItem[]
}

const GROUPS: { label: string; kinds: ContextKind[] }[] = [
  { label: "MANAGED", kinds: ["managed"] },
  { label: "USER", kinds: ["user"] },
  { label: "PROJECT", kinds: ["project", "local"] },
  { label: "MEMORY", kinds: ["memory"] },
  { label: "UNATTRIBUTED", kinds: ["unknown"] },
  { label: "SKILLS", kinds: ["skill"] },
]

/** Instruction nodes of the latest observed context, in load order. */
export function currentInstructions(graph: ContextGraph): ContextNode[] {
  return graph.current.map((id) => graph.nodes[id]).filter((n): n is ContextNode => n !== undefined)
}

/** Tokens of the current always-on instructions: engine estimate when present, else local. */
export function instructionTokens(graph: ContextGraph): number {
  return currentInstructions(graph).reduce((sum, n) => sum + tokensOf(n), 0)
}

export function tokensOf(n: ContextNode): number {
  return n.engineTokens ?? n.estimatedTokens ?? 0
}

/**
 * The architecture as /context-lab tree draws it: observed instructions of the
 * latest context grouped by tier with imports nested under their parent, then
 * dynamic and non-observed nodes in their own groups. Evidence is per node.
 */
export function contextTree(graph: ContextGraph): TreeGroup[] {
  const live = currentInstructions(graph)
  const liveIds = new Set(live.map((n) => n.id))
  const skills = Object.values(graph.nodes).filter((n) => n.kind === "skill")
  const others = Object.values(graph.nodes).filter(
    (n) => n.kind !== "skill" && !liveIds.has(n.id) && n.evidence !== "observed",
  )

  const groups: TreeGroup[] = []
  for (const { label, kinds } of GROUPS) {
    const members = (kinds.includes("skill") ? skills : live).filter((n) => kinds.includes(n.kind))
    if (members.length === 0) continue
    groups.push({ label, evidence: groupEvidence(members), items: nest(members) })
  }
  const inferred = others.filter((n) => n.evidence === "inferred")
  if (inferred.length) groups.push({ label: "POSSIBLE NESTED", evidence: "inferred", items: nest(inferred) })
  const available = others.filter((n) => n.evidence === "available")
  if (available.length) groups.push({ label: "AVAILABLE", evidence: "available", items: nest(available) })
  return groups
}

function nest(nodes: ContextNode[]): TreeItem[] {
  const ids = new Set(nodes.map((n) => n.id))
  const items = new Map(nodes.map((n) => [n.id, { node: n, children: [] as TreeItem[] }]))
  const roots: TreeItem[] = []
  for (const n of nodes) {
    const item = items.get(n.id)!
    const parent = n.parentId !== undefined && ids.has(n.parentId) ? items.get(n.parentId) : undefined
    if (parent && parent !== item) parent.children.push(item)
    else roots.push(item)
  }
  return roots
}

function groupEvidence(nodes: ContextNode[]): EvidenceLevel {
  if (nodes.some((n) => n.evidence === "observed")) return "observed"
  if (nodes.some((n) => n.evidence === "inferred")) return "inferred"
  return "available"
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
