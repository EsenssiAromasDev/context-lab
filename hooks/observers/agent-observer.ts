// agent.spawn → topology (SPEC §11): which subagents ran, from where, how.
// Only structure is kept — never the task prompt or the description, which
// carry conversation content (SPEC §39).
//
// Whether a subagent receives the project's instruction files is not exposed
// by agent.spawn on 2.1.291 (omitClaudeMd exists only on agents a plugin
// registers), so it is reported as unknown rather than guessed.

export interface AgentRecord {
  toolUseId: string
  agentId?: string
  parentAgentId?: string
  type: string
  /** Who provides the agent type: `engine` for built-ins, else the plugin. */
  provider: string
  fork: boolean
  background: boolean
  teammate: boolean
  model?: string
  denied: boolean
  at: number
}

/** Structural slice of the engine's AgentSpawnInput. */
export interface SpawnInput {
  tool_use_id: string
  subagentType: string
  provider: { plugin: string }
  parentAgentId?: string
  fork: boolean
  background: boolean
  isTeammate?: true
}

/** Structural slice of the engine's AgentSpawnResult. */
export interface SpawnResult {
  model?: string
  agentId?: string
  deny?: string
}

/** Keeps the session's last MAX_AGENTS spawns. */
export const MAX_AGENTS = 200

export function recordSpawn(list: readonly AgentRecord[], e: SpawnInput, r: SpawnResult, at: number): AgentRecord[] {
  const rec: AgentRecord = {
    toolUseId: e.tool_use_id,
    type: e.subagentType,
    provider: e.provider.plugin,
    fork: e.fork,
    background: e.background,
    teammate: e.isTeammate === true,
    denied: r.deny !== undefined,
    at,
  }
  if (r.agentId !== undefined) rec.agentId = r.agentId
  if (e.parentAgentId !== undefined) rec.parentAgentId = e.parentAgentId
  if (r.model !== undefined) rec.model = r.model
  return [...list.filter((a) => a.toolUseId !== e.tool_use_id), rec].slice(-MAX_AGENTS)
}

export interface AgentSummary {
  spawned: number
  denied: number
  forks: number
  background: number
  /** Spawned by another subagent rather than the main conversation. */
  nested: number
  byType: { type: string; count: number }[]
}

export function summarizeAgents(list: readonly AgentRecord[]): AgentSummary {
  const started = list.filter((a) => !a.denied)
  const counts = new Map<string, number>()
  for (const a of started) counts.set(a.type, (counts.get(a.type) ?? 0) + 1)
  return {
    spawned: started.length,
    denied: list.length - started.length,
    forks: started.filter((a) => a.fork).length,
    background: started.filter((a) => a.background).length,
    nested: started.filter((a) => a.parentAgentId !== undefined).length,
    byType: [...counts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
  }
}

export interface AgentTreeItem {
  agent: AgentRecord
  children: AgentTreeItem[]
}

/** Spawns arranged by who spawned them: main conversation's first, a subagent's under it. */
export function agentTree(list: readonly AgentRecord[]): AgentTreeItem[] {
  const items = new Map<string, AgentTreeItem>()
  for (const a of list) if (a.agentId !== undefined) items.set(a.agentId, { agent: a, children: [] })
  const roots: AgentTreeItem[] = []
  for (const a of list) {
    const item = a.agentId !== undefined ? items.get(a.agentId)! : { agent: a, children: [] }
    const parent = a.parentAgentId !== undefined ? items.get(a.parentAgentId) : undefined
    if (parent && parent !== item) parent.children.push(item)
    else roots.push(item)
  }
  return roots
}
