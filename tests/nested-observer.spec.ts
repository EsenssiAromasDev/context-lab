import assert from "node:assert/strict"
import { test } from "node:test"
import { renderOverview, renderTree } from "../hooks/commands/context-lab.ts"
import { nodeId } from "../hooks/graph/graph-builder.ts"
import { emptyGraph } from "../hooks/graph/graph.ts"
import { contextTree } from "../hooks/graph/graph-selectors.ts"
import { observeContext } from "../hooks/observers/context-observer.ts"
import {
  inferFromRead,
  kindForPath,
  markAvailable,
  observeNestedAttachment,
  parseNestedMemory,
  shouldDescend,
} from "../hooks/observers/nested-observer.ts"

// The nested-project fixture (SPEC §44), as the engine would present it.
const ROOT = "/work/nested-project"
const NESTED = `${ROOT}/src/api/CLAUDE.md`
const ctx = { at: 10, root: ROOT, sessionId: "s1" }

const started = () =>
  observeContext(
    emptyGraph(),
    { blocks: [], instructionFiles: [{ path: `${ROOT}/CLAUDE.md`, kind: "project", content: "# Nested project" }] },
    { at: 1, sessionId: "s1" },
  )

const labels = (g: ReturnType<typeof started>) => contextTree(g).map((x) => `${x.evidence}:${x.label}`)

test("parseNestedMemory reads the engine's Contents-of headers", () => {
  const text = [
    `Contents of ${NESTED} (project instructions, checked into the codebase):`,
    "",
    "# API rules",
    "Every handler validates its input.",
    "",
    `Contents of C:\\work\\p (x86)\\src\\CLAUDE.local.md:`,
    "local note",
  ].join("\n")
  const files = parseNestedMemory(text)
  assert.deepEqual(
    files.map((f) => f.path),
    [NESTED, "C:\\work\\p (x86)\\src\\CLAUDE.local.md"],
  )
  assert.equal(files[0]!.content, "# API rules\nEvery handler validates its input.")
  assert.equal(files[1]!.content, "local note")
  assert.deepEqual(parseNestedMemory("some reminder with no header"), [])
  assert.deepEqual(parseNestedMemory("Contents of the week: nothing"), [])
})

test("nested fixture: before a Read, root observed and nested available", () => {
  const g = markAvailable(
    started(),
    [
      { path: `${ROOT}/CLAUDE.md`, bytes: 16 },
      { path: NESTED, bytes: 400 },
    ],
    ctx,
  )
  assert.deepEqual(labels(g), ["observed:PROJECT", "available:AVAILABLE"])
  assert.deepEqual(g.available, [nodeId("project", NESTED)])
  assert.equal(g.nodes[nodeId("project", NESTED)]!.estimatedTokens, 100)
})

test("nested fixture: after a Read with no attachment, nested is inferred", () => {
  let g = markAvailable(started(), [{ path: NESTED, bytes: 400 }], ctx)
  g = inferFromRead(g, [{ path: NESTED, content: "# API rules" }], `${ROOT}/src/api/service.ts`, ctx)
  const id = nodeId("project", NESTED)
  assert.deepEqual(g.inferred, [id])
  assert.deepEqual(g.available, [])
  assert.equal(g.nodes[id]!.evidence, "inferred")
  assert.equal(g.nodes[id]!.loadCount, 0)
  assert.equal(g.nodes[id]!.metadata.inferredFrom, "src/api/service.ts")
  assert.deepEqual(labels(g), ["observed:PROJECT", "inferred:POSSIBLE NESTED"])
  assert.match(renderTree({ graph: g, usage: undefined, root: ROOT }), /◐ \.\/src\/api\/CLAUDE\.md {2}~3 {2}← src\/api\/service\.ts/)
  assert.match(renderOverview({ graph: g, usage: undefined, root: ROOT }), /◐ 1 nested file inferred/)
})

test("nested fixture: an attachment confirms it as observed, and a later Read cannot demote it", () => {
  let g = inferFromRead(started(), [{ path: NESTED, content: "# API rules" }], `${ROOT}/src/api/service.ts`, ctx)
  const out = observeNestedAttachment(g, `Contents of ${NESTED} (project instructions):\n\n# API rules\n`, ctx)
  assert.equal(out.attributed, 1)
  g = out.graph
  const id = nodeId("project", NESTED)
  assert.deepEqual(g.nested, [id])
  assert.deepEqual(g.inferred, [])
  assert.equal(g.nodes[id]!.evidence, "observed")
  assert.equal(g.nodes[id]!.loadCount, 1)

  g = inferFromRead(g, [{ path: NESTED, content: "# API rules" }], `${ROOT}/src/api/other.ts`, ctx)
  g = markAvailable(g, [{ path: NESTED, bytes: 11 }], ctx)
  assert.deepEqual(g.nested, [id])
  assert.deepEqual(g.inferred, [])
  assert.deepEqual(g.available, [])
  assert.deepEqual(labels(g), ["observed:PROJECT", "observed:NESTED (attached on read)"])
  assert.match(renderOverview({ graph: g, usage: undefined, root: ROOT }), /Nested \(attached on read\)/)
})

test("an attachment that cannot be attributed changes nothing and reports 0", () => {
  const g = started()
  const out = observeNestedAttachment(g, "a reformatted reminder the parser does not know", ctx)
  assert.equal(out.attributed, 0)
  assert.equal(out.graph, g)
})

test("a new context starts without the previous context's nested files", () => {
  let g = observeNestedAttachment(started(), `Contents of ${NESTED}:\nx`, ctx).graph
  g = inferFromRead(g, [{ path: `${ROOT}/lib/CLAUDE.md`, content: "y" }], `${ROOT}/lib/a.ts`, ctx)
  g = observeContext(g, { blocks: [], instructionFiles: [] }, { at: 20, sessionId: "s1" })
  assert.deepEqual([g.nested, g.inferred, g.available], [[], [], []])
  // History stays on the node.
  assert.equal(g.nodes[nodeId("project", NESTED)]!.evidence, "observed")
  assert.deepEqual(contextTree(g), [])
})

test("the root's own files and files outside the project are never inferred", () => {
  const g = inferFromRead(
    started(),
    [
      { path: `${ROOT}/CLAUDE.md`, content: "# Nested project" },
      { path: "/elsewhere/CLAUDE.md", content: "z" },
      { path: ROOT, content: "z" },
    ],
    `${ROOT}/src/a.ts`,
    ctx,
  )
  assert.deepEqual(g.inferred, [])
})

test("no nested content is kept in the graph", () => {
  const marker = "NESTED-SECRET-MARKER"
  let g = inferFromRead(started(), [{ path: NESTED, content: marker }], `${ROOT}/src/api/x.ts`, ctx)
  g = observeNestedAttachment(g, `Contents of ${NESTED}:\n${marker}`, ctx).graph
  assert.equal(JSON.stringify(g).includes(marker), false)
})

test("kinds and scan rules", () => {
  assert.equal(kindForPath(`${ROOT}/src/CLAUDE.local.md`), "local")
  assert.equal(kindForPath(NESTED), "project")
  assert.equal(shouldDescend("src"), true)
  assert.equal(shouldDescend(".claude"), true)
  assert.equal(shouldDescend("node_modules"), false)
  assert.equal(shouldDescend(".git"), false)
  assert.equal(shouldDescend(".cache"), false)
})

test("a later Read or listing never overwrites what a delivery measured (no false content change)", () => {
  const framed = `Contents of ${NESTED} (project instructions):\n\n# API rules`
  let g = observeNestedAttachment(started(), framed, ctx).graph
  const id = nodeId("project", NESTED)
  const measured = { ...g.nodes[id]! }

  // Next context: the same file is read from disk (different bytes), then attached again.
  g = observeContext(g, { blocks: [], instructionFiles: [] }, { at: 20, sessionId: "s2" })
  g = inferFromRead(g, [{ path: NESTED, content: "# API rules\n<!-- comment the engine strips -->" }], `${ROOT}/src/api/a.ts`, ctx)
  g = markAvailable(g, [{ path: NESTED, bytes: 999 }], ctx)
  assert.equal(g.nodes[id]!.contentHash, measured.contentHash)
  assert.equal(g.nodes[id]!.characters, measured.characters)

  g = observeNestedAttachment(g, framed, { ...ctx, sessionId: "s2" }).graph
  assert.equal(g.nodes[id]!.metadata.contentChanges, undefined)
  assert.equal(g.nodes[id]!.loadCount, 2)
  assert.equal(g.nodes[id]!.sessionCount, 2)
})
