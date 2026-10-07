import assert from "node:assert/strict"
import { test } from "node:test"
import { analyze, DEFAULT_ANALYSIS } from "../hooks/analysis/issue-engine.ts"
import { renderOverview, renderTree } from "../hooks/commands/context-lab.ts"
import { emptyGraph } from "../hooks/graph/graph.ts"
import { contextTree } from "../hooks/graph/graph-selectors.ts"
import { agentTree, recordSpawn, summarizeAgents, type SpawnInput } from "../hooks/observers/agent-observer.ts"
import { observeContext } from "../hooks/observers/context-observer.ts"
import { observeSkill, skillNodeId } from "../hooks/observers/skill-observer.ts"

const SKILL_TEXT = "# Commit\nWrite a conventional commit message. SKILL-SECRET-MARKER"

// ── skills ──────────────────────────────────────────────────────────────────

test("an activated skill is an observed node of this context, counted per activation", () => {
  let g = observeSkill(emptyGraph(), { skill: "commit", text: SKILL_TEXT }, { at: 1, sessionId: "s1" })
  g = observeSkill(g, { skill: "commit", text: SKILL_TEXT }, { at: 2, sessionId: "s1" })
  const id = skillNodeId("commit")
  assert.deepEqual(g.skills, [id])
  const n = g.nodes[id]!
  assert.equal(n.kind, "skill")
  assert.equal(n.evidence, "observed")
  assert.equal(n.name, "skill: commit")
  assert.equal(n.loadCount, 2)
  assert.equal(n.sessionCount, 1)
  assert.equal(n.characters, SKILL_TEXT.length)
  assert.equal(JSON.stringify(g).includes("SKILL-SECRET-MARKER"), false)
})

test("an empty skill text delivers nothing", () => {
  const g = emptyGraph()
  assert.equal(observeSkill(g, { skill: "x", text: "  \n" }, { at: 1 }), g)
})

test("skills are per context: a new context lists none, history stays on the node", () => {
  let g = observeSkill(emptyGraph(), { skill: "commit", text: SKILL_TEXT }, { at: 1 })
  assert.deepEqual(contextTree(g).map((x) => x.label), ["SKILLS ACTIVADAS EN ESTA CONVERSACIÓN"])
  g = observeContext(g, { blocks: [], instructionFiles: [] }, { at: 2 })
  assert.deepEqual(g.skills, [])
  assert.deepEqual(contextTree(g), [])
  assert.equal(g.nodes[skillNodeId("commit")]!.loadCount, 1)
})

test("a skill that repeats an always-on section is found by the analyzers", () => {
  const body = "Always run the full test suite with npm test before you open a pull request and fix every failure"
  let g = observeContext(
    emptyGraph(),
    { blocks: [], instructionFiles: [{ path: "/r/CLAUDE.md", kind: "project", content: `## Testing\n${body}` }] },
    { at: 1 },
  )
  g = observeSkill(g, { skill: "testing", text: `## Testing\n${body}` }, { at: 2 })
  const sources = [
    { nodeId: g.current[0]!, file: "./CLAUDE.md", text: `## Testing\n${body}`, fromDisk: false },
    { nodeId: skillNodeId("testing"), file: "skill: testing", text: `## Testing\n${body}`, fromDisk: false },
  ]
  const issues = analyze({ graph: g, sources, root: "/r", config: DEFAULT_ANALYSIS }, new Set())
  assert.deepEqual(issues.map((i) => i.type), ["duplicate"])
  assert.deepEqual(issues[0]!.locations, ["./CLAUDE.md > Testing", "skill: testing > Testing"])
})

// ── agents ──────────────────────────────────────────────────────────────────

const spawn = (id: string, over: Partial<SpawnInput> = {}): SpawnInput => ({
  tool_use_id: id,
  subagentType: "Explore",
  provider: { plugin: "engine" },
  fork: false,
  background: false,
  ...over,
})

test("spawns record topology only, never the prompt", () => {
  const withPrompt = { ...spawn("t1"), prompt: "PROMPT-SECRET", description: "DESC-SECRET" }
  const list = recordSpawn([], withPrompt, { model: "claude-haiku-4-5", agentId: "a1" }, 5)
  assert.deepEqual(list, [
    { toolUseId: "t1", type: "Explore", provider: "engine", fork: false, background: false, teammate: false, denied: false, at: 5, agentId: "a1", model: "claude-haiku-4-5" },
  ])
  assert.equal(/SECRET/.test(JSON.stringify(list)), false)
})

test("summary and tree: types, forks, denials, spawns by subagents", () => {
  let list = recordSpawn([], spawn("t1"), { model: "m", agentId: "a1" }, 1)
  list = recordSpawn(list, spawn("t2", { subagentType: "general-purpose", parentAgentId: "a1" }), { model: "m", agentId: "a2" }, 2)
  list = recordSpawn(list, spawn("t3", { subagentType: "fork", fork: true, background: true }), { model: "m", agentId: "a3" }, 3)
  list = recordSpawn(list, spawn("t4", { subagentType: "Explore" }), { deny: "no" }, 4)
  const s = summarizeAgents(list)
  assert.deepEqual(s, {
    spawned: 3,
    denied: 1,
    forks: 1,
    background: 1,
    nested: 1,
    byType: [
      { type: "Explore", count: 1 },
      { type: "fork", count: 1 },
      { type: "general-purpose", count: 1 },
    ],
  })
  const tree = agentTree(list)
  assert.deepEqual(tree.map((t) => t.agent.toolUseId), ["t1", "t3", "t4"])
  assert.deepEqual(tree[0]!.children.map((c) => c.agent.toolUseId), ["t2"])

  const text = renderTree({ graph: emptyGraph(), usage: undefined, root: "/r", agents: list })
  assert.match(text, /SUBAGENTES EN ESTA SESIÓN: 3 lanzados \(Explore ×1, fork ×1, general-purpose ×1\) · 1 copia de la conversación \(fork\) · 1 lanzado por otro subagente · 1 bloqueado/)
  assert.match(text, /\n {2}Explore {2}m\n {6}general-purpose {2}m/)
  assert.match(text, /fork {2}m {2}\(fork, en segundo plano\)/)
  assert.match(text, /Claude Code no dice si un subagente recibe tus instrucciones/)
})

test("a retried spawn (same tool use) replaces its record; the list is bounded", () => {
  let list = recordSpawn([], spawn("t1"), { deny: "x" }, 1)
  list = recordSpawn(list, spawn("t1"), { model: "m", agentId: "a1" }, 2)
  assert.equal(list.length, 1)
  assert.equal(list[0]!.denied, false)
  for (let i = 0; i < 250; i++) list = recordSpawn(list, spawn(`x${i}`), { model: "m" }, i)
  assert.equal(list.length, 200)
})

// ── overview ────────────────────────────────────────────────────────────────

test("overview: skill listing cost, activated skills and subagents under Dynamic", () => {
  const g = observeSkill(emptyGraph(), { skill: "commit", text: "x".repeat(1200) }, { at: 1 })
  const usage = { measuredAt: 1, skillListing: { totalSkills: 80, includedSkills: 54, tokens: 2100 } }
  const agents = recordSpawn([], spawn("t1"), { model: "m", agentId: "a1" }, 1)
  const text = renderOverview({ graph: g, usage, root: "/r", agents })
  assert.match(text, /SKILLS/)
  assert.match(text, /Lista de skills \(Claude la lee siempre\)\s+~2\.1k tokens/)
  assert.match(text, /Caben 54 de 80\./)
  assert.match(text, /⚠ Tienes 80 skills y en la lista solo caben 54/)
  assert.match(text, /Activada ahora: commit\s+~300/)
  assert.match(text, /SUBAGENTES: 1 lanzado \(Explore ×1\)/)
})
