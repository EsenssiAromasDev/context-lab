import assert from "node:assert/strict"
import { test } from "node:test"
import { compareVersions, parseArgs, renderDoctor, renderOverview, renderTree } from "../hooks/commands/context-lab.ts"
import { emptyGraph } from "../hooks/graph/graph.ts"
import { observeContext } from "../hooks/observers/context-observer.ts"

test("parseArgs", () => {
  assert.deepEqual(parseArgs(""), { view: "overview" })
  assert.deepEqual(parseArgs("  Tree "), { view: "tree" })
  assert.deepEqual(parseArgs("eval minimal-context"), { view: "eval", arg: "minimal-context" })
  assert.deepEqual(parseArgs("bogus"), { view: "help", unknown: "bogus" })
  assert.deepEqual(parseArgs("problemas"), { view: "issues" })
  assert.deepEqual(parseArgs("probar sin-claude"), { view: "eval", arg: "sin-claude" })
})

test("overview before anything is observed says so instead of inventing figures", () => {
  const text = renderOverview({ graph: emptyGraph(), usage: undefined, root: "/p" })
  assert.match(text, /Aún sin medir/)
  assert.match(text, /Aún no se ha visto/)
})

test("overview and tree show observed files with ~ estimates and the legend", () => {
  const graph = observeContext(
    emptyGraph(),
    {
      blocks: [],
      instructionFiles: [
        { path: "/home/dev/.claude/CLAUDE.md", kind: "user", content: "x".repeat(4400) },
        { path: "/p/CLAUDE.md", kind: "project", content: "y".repeat(400) },
      ],
    },
    { at: 1 },
  )
  const usage = { contextUsed: 71_420, contextCapacity: 200_000, contextPercent: 36, measuredAt: 1 }
  const overview = renderOverview({ graph, usage, root: "/p" })
  assert.match(overview, /71\.4k de 200k tokens \(36%\)/)
  assert.match(overview, /~\/\.claude\/CLAUDE\.md\s+~1\.1k/)
  assert.match(overview, /\.\/CLAUDE\.md\s+~100/)
  assert.match(overview, /LO QUE CLAUDE LEE SIEMPRE, antes de que escribas\s+~1\.2k tokens/)
  assert.match(overview, /✓ Tus instrucciones son pequeñas \(0\.6% del contexto\)/)
  assert.match(overview, /Teclas: 1 Resumen · 2 Archivos · 3 Problemas · 4 Experimentos/)

  const tree = renderTree({ graph, usage, root: "/p" })
  assert.match(tree, /TUS INSTRUCCIONES PERSONALES/)
  assert.match(tree, /INSTRUCCIONES DE ESTE PROYECTO/)
  assert.match(tree, /● Claude lo recibe \(confirmado\)/)
  assert.match(tree, /● \.\/CLAUDE\.md\s+~100 tokens · visto en 1 conversación/)
})

test("doctor reports unobserved events honestly and needs a clean repo for eval", () => {
  const text = renderDoctor({
    version: "2.1.291",
    observed: { "prompt.context": 2 },
    git: { available: true, version: "2.47.0" },
    repo: { isRepo: true, clean: false, dirty: 3 },
    root: "/p",
    usageApi: true,
    breakdown: true,
    fs: true,
  })
  assert.match(text, /instrucciones al empezar\s+✓ 2 veces/)
  assert.match(text, /uso del contexto\s+todavía no ha ocurrido/)
  assert.match(text, /✗ 3 archivo\(s\): haz commit antes de probar/)
  assert.match(text, /LISTO \(para experimentos hace falta un repositorio git sin cambios pendientes\)/)
})

test("compareVersions", () => {
  assert.ok(compareVersions("2.1.291", "2.1.287") > 0)
  assert.ok(compareVersions("2.1.280-dev.20260920", "2.1.287") < 0)
  assert.equal(compareVersions("2.1.287", "2.1.287"), 0)
})

test("pane views: same text as headless, honest placeholders, one transcript line", async () => {
  const { paneLines, openedLine, TABS } = await import("../hooks/commands/context-lab.ts")
  const input = { graph: emptyGraph(), usage: undefined, root: "/p" }
  assert.deepEqual(paneLines("overview", input), renderOverview(input).split("\n"))
  assert.match(paneLines("issues", input).join("\n"), /Aún no se ha visto nada/)
  const observed = observeContext(emptyGraph(), { blocks: [], instructionFiles: [] }, { at: 1 })
  assert.deepEqual(paneLines("issues", { ...input, graph: observed }), ["Aún sin revisar: pulsa a para buscar problemas."])
  assert.match(paneLines("experiments", input).join("\n"), /Aún no hay experimentos/)
  assert.deepEqual(TABS.map((t) => t.hotkey), ["1", "2", "3", "4"])
  assert.equal(openedLine("tree").split("\n").length, 1)
})

test("band line: nothing before observation; usage, instructions, skills, issues after", async () => {
  const { bandLine } = await import("../hooks/commands/context-lab.ts")
  assert.equal(bandLine({ graph: emptyGraph(), usage: undefined, root: "/p" }), undefined)
  const graph = observeContext(
    emptyGraph(),
    { blocks: [], instructionFiles: [{ path: "/p/CLAUDE.md", kind: "project", content: "y".repeat(400) }, { path: "/p/a.md", kind: "project", content: "z" }] },
    { at: 1 },
  )
  const usage = { contextUsed: 950, contextCapacity: 200_000, measuredAt: 1 }
  assert.equal(bandLine({ graph, usage, root: "/p" }), "Context Lab · contexto 950 de 200k · Claude lee siempre ~101 tokens (2 archivos)")
  assert.equal(bandLine({ graph, usage, root: "/p", issues: [] }), "Context Lab · contexto 950 de 200k · Claude lee siempre ~101 tokens (2 archivos) · sin problemas")
})
