import assert from "node:assert/strict"
import { test } from "node:test"
import { canonicalPath, nodeId, upsertNode } from "../hooks/graph/graph-builder.ts"
import { emptyGraph, restoreGraph } from "../hooks/graph/graph.ts"
import { contextTree, currentInstructions, displayPath, instructionTokens } from "../hooks/graph/graph-selectors.ts"
import { applyEngineTokens, observeContext, type ContextPayload } from "../hooks/observers/context-observer.ts"

const ROOT = "/work/proj"
const SECRET = "Always run npm test. SECRET-CONTENT-MARKER"

const payload = (): ContextPayload => ({
  blocks: [{ name: "claudeMd", text: "framed..." }],
  instructionFiles: [
    { path: "/home/dev/.claude/CLAUDE.md", kind: "user", content: "Be terse." },
    { path: `${ROOT}/CLAUDE.md`, kind: "project", content: `# Project\n${SECRET}` },
    { path: `${ROOT}/docs/api.md`, kind: "project", content: "API rules", parent: `${ROOT}/CLAUDE.md` },
    { path: `${ROOT}/CLAUDE.local.md`, kind: "local", content: "local" },
  ],
})

test("prompt.context creates observed nodes in load order", () => {
  const g = observeContext(emptyGraph(), payload(), { at: 1, sessionId: "s1" })
  const files = currentInstructions(g)
  assert.deepEqual(files.map((n) => n.kind), ["user", "project", "project", "local"])
  assert.ok(files.every((n) => n.evidence === "observed"))
  assert.deepEqual(files.map((n) => n.loadOrder), [0, 1, 2, 3])
  assert.equal(files[1]!.characters, `# Project\n${SECRET}`.length)
  assert.equal(g.contexts, 1)
})

test("same file observed twice does not duplicate node; loadCount and sessionCount", () => {
  let g = observeContext(emptyGraph(), payload(), { at: 1, sessionId: "s1" })
  g = observeContext(g, payload(), { at: 2, sessionId: "s1" })
  g = observeContext(g, payload(), { at: 3, sessionId: "s2" })
  assert.equal(Object.keys(g.nodes).length, 4)
  const root = g.nodes[nodeId("project", `${ROOT}/CLAUDE.md`)]!
  assert.equal(root.loadCount, 3)
  assert.equal(root.sessionCount, 2)
  assert.equal(root.firstSeenAt, 1)
  assert.equal(root.lastSeenAt, 3)
  assert.equal(g.contexts, 3)
})

test("an edited file keeps its node and records the content change", () => {
  let g = observeContext(emptyGraph(), payload(), { at: 1 })
  const edited = payload()
  edited.instructionFiles = edited.instructionFiles!.map((f) => (f.kind === "local" ? { ...f, content: "changed" } : f))
  g = observeContext(g, edited, { at: 2 })
  const local = g.nodes[nodeId("local", `${ROOT}/CLAUDE.local.md`)]!
  assert.equal(local.metadata.contentChanges, 1)
  assert.equal(Object.keys(g.nodes).length, 4)
})

test("parent relationship preserved as an observed imports edge", () => {
  const g = observeContext(emptyGraph(), payload(), { at: 1 })
  const parent = nodeId("project", `${ROOT}/CLAUDE.md`)
  const child = nodeId("project", `${ROOT}/docs/api.md`)
  assert.equal(g.nodes[child]!.parentId, parent)
  assert.deepEqual(g.edges, [{ from: parent, to: child, type: "imports", evidence: "observed" }])
  const project = contextTree(g).find((x) => x.label === "PROJECT")!
  assert.equal(project.items[0]!.node.id, parent)
  assert.equal(project.items[0]!.children[0]!.node.id, child)
})

test("a rewritten claudeMd (no instructionFiles) is unknown, never guessed", () => {
  const g = observeContext(emptyGraph(), { blocks: [{ name: "claudeMd", text: "custom text" }] }, { at: 1 })
  const files = currentInstructions(g)
  assert.equal(files.length, 1)
  assert.equal(files[0]!.kind, "unknown")
  assert.equal(files[0]!.path, undefined)
  assert.equal(g.rewrittenContexts, 1)
})

test("no claudeMd at all leaves no current instructions", () => {
  const g = observeContext(emptyGraph(), { blocks: [], instructionFiles: [] }, { at: 1 })
  assert.deepEqual(g.current, [])
  assert.equal(g.contexts, 1)
})

test("no raw content is kept in the graph", () => {
  let g = observeContext(emptyGraph(), payload(), { at: 1, sessionId: "s1" })
  g = observeContext(g, { blocks: [{ name: "claudeMd", text: SECRET }] }, { at: 2 })
  assert.equal(JSON.stringify(g).includes("SECRET-CONTENT-MARKER"), false)
})

test("inferred nodes never become observed unless an observation confirms them", () => {
  const canon = `${ROOT}/src/api/CLAUDE.md`
  const id = nodeId("project", canon)
  let g = upsertNode(
    emptyGraph(),
    { id, name: "CLAUDE.md", kind: "project", evidence: "inferred", path: canon },
    1,
    { counted: false },
  )
  g = upsertNode(g, { id, name: "CLAUDE.md", kind: "project", evidence: "available", path: canon }, 2, { counted: false })
  assert.equal(g.nodes[id]!.evidence, "inferred")
  assert.equal(g.nodes[id]!.loadCount, 0)
  assert.equal(contextTree(g).find((x) => x.label === "POSSIBLE NESTED")!.evidence, "inferred")

  g = observeContext(g, { blocks: [], instructionFiles: [{ path: canon, kind: "project", content: "x" }] }, { at: 3 })
  assert.equal(g.nodes[id]!.evidence, "observed")
})

test("engine per-file estimates are preferred over local ones", () => {
  let g = observeContext(emptyGraph(), payload(), { at: 1 })
  const local = instructionTokens(g)
  g = applyEngineTokens(g, new Map([[`${ROOT}/CLAUDE.md`.replace(/\//g, "\\"), 999]]))
  assert.equal(g.nodes[nodeId("project", `${ROOT}/CLAUDE.md`)]!.engineTokens, 999)
  assert.notEqual(instructionTokens(g), local)
  assert.equal(applyEngineTokens(g, new Map()), g)
})

test("restored graphs keep history but not the earlier session's current context", () => {
  const g = observeContext(emptyGraph(), payload(), { at: 1 })
  const back = restoreGraph(JSON.parse(JSON.stringify(g)))!
  assert.equal(back.contexts, 1)
  assert.deepEqual(back.current, [])
  assert.equal(restoreGraph({ nope: true }), null)
  assert.equal(restoreGraph(null), null)
})

test("paths: canonical form and display", () => {
  assert.equal(canonicalPath("C:\\Users\\Dev\\proj\\"), "c:/Users/Dev/proj")
  assert.equal(displayPath("C:\\work\\proj\\CLAUDE.md", "c:/work/proj"), "./CLAUDE.md")
  assert.equal(displayPath("C:\\Users\\dev\\.claude\\CLAUDE.md", "c:/work/proj"), "~/.claude/CLAUDE.md")
  assert.equal(displayPath("/etc/claude/CLAUDE.md", "/work/proj"), "/etc/claude/CLAUDE.md")
})
