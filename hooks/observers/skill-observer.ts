import { nodeId, upsertNode } from "../graph/graph-builder.ts"
import type { ContextGraph } from "../graph/graph.ts"
import { sha256 } from "../metrics/hash.ts"
import { measure } from "../metrics/size.ts"

// skill.prompt → graph (SPEC §11). A skill's instructions reach the context
// only when it is activated: that delivery is observed, and it is what tells
// progressively disclosed instructions apart from always-on ones.
// The text is measured and hashed here, then dropped.

export interface SkillDelivery {
  /** The skill's name as the engine keys it (`commit`, `plugin:skill`). */
  skill: string
  /** The instructions as sent (after every hook beneath). */
  text: string
}

export interface SkillContext {
  at: number
  sessionId?: string | undefined
}

export function skillNodeId(skill: string): string {
  return nodeId("skill", skill)
}

export function observeSkill(graph: ContextGraph, d: SkillDelivery, ctx: SkillContext): ContextGraph {
  // An empty text delivers nothing: a hook beneath answered with none.
  if (d.text.trim().length === 0) return graph
  const id = skillNodeId(d.skill)
  const g = upsertNode(
    graph,
    {
      id,
      name: `skill: ${d.skill}`,
      kind: "skill",
      evidence: "observed",
      contentHash: sha256(d.text),
      ...measure(d.text),
    },
    ctx.at,
    { counted: true, sessionId: ctx.sessionId },
  )
  return g.skills.includes(id) ? g : { ...g, skills: [...g.skills, id] }
}
