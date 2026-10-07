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
})

test("overview before anything is observed says so instead of inventing figures", () => {
  const text = renderOverview({ graph: emptyGraph(), usage: undefined, root: "/p" })
  assert.match(text, /not measured yet/)
  assert.match(text, /not observed yet/)
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
  assert.match(overview, /71,420 \/ 200,000/)
  assert.match(overview, /● ~\/\.claude\/CLAUDE\.md\s+~1\.1k/)
  assert.match(overview, /● \.\/CLAUDE\.md\s+~100/)
  assert.match(overview, /● observed {2}◐ inferred {2}○ available/)

  const tree = renderTree({ graph, usage, root: "/p" })
  assert.match(tree, /● USER/)
  assert.match(tree, /● PROJECT/)
  assert.match(tree, /└─ ● \.\/CLAUDE\.md/)
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
  assert.match(text, /prompt\.context\s+✓ observed ×2/)
  assert.match(text, /session\.measure\s+hooked, not yet observed/)
  assert.match(text, /✗ 3 changed path/)
  assert.match(text, /READY \(eval needs a clean git repository\)/)
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
  assert.match(paneLines("issues", input).join("\n"), /Nothing observed yet/)
  const observed = observeContext(emptyGraph(), { blocks: [], instructionFiles: [] }, { at: 1 })
  assert.deepEqual(paneLines("issues", { ...input, graph: observed }), ["Not analyzed yet: press r to run the analyzers."])
  assert.match(paneLines("experiments", input).join("\n"), /Phase 7/)
  assert.deepEqual(TABS.map((t) => t.hotkey), ["o", "t", "i", "e"])
  assert.equal(openedLine("tree").split("\n").length, 1)
})
