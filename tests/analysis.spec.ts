import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join as pathJoin, resolve } from "node:path"
import { test } from "node:test"
import { parseAnalysisConfig } from "../hooks/analysis/config.ts"
import { findListings, parseTree, scoreListing } from "../hooks/analysis/discoverability.ts"
import { exactDuplicates, jaccard, lexicalOverlaps, shingles } from "../hooks/analysis/duplicates.ts"
import { DEFAULT_ANALYSIS, analyze, pathsToCheck, type AnalyzedSource } from "../hooks/analysis/issue-engine.ts"
import { splitSections } from "../hooks/analysis/sections.ts"
import { extractPathRefs, join, locateLine } from "../hooks/analysis/stale-paths.ts"
import { renderIssues, renderOverview } from "../hooks/commands/context-lab.ts"
import { canonicalPath, nodeId } from "../hooks/graph/graph-builder.ts"
import { emptyGraph, type ContextGraph } from "../hooks/graph/graph.ts"
import { observeContext } from "../hooks/observers/context-observer.ts"

const src = (text: string, file = "./CLAUDE.md", id = "n1") => ({ nodeId: id, file, text })

// ── sections ────────────────────────────────────────────────────────────────

test("sections split on headings, not on # inside code fences", () => {
  const s = splitSections(src("intro\n# A\none\n```sh\n# not a heading\n```\n## B\ntwo\n"))
  assert.deepEqual(
    s.map((x) => [x.heading, x.level, x.line]),
    [
      ["(preamble)", 0, 1],
      ["A", 1, 2],
      ["B", 2, 7],
    ],
  )
  assert.match(s[1]!.body, /# not a heading/)
})

// ── duplicates & lexical overlap ────────────────────────────────────────────

test("exact duplicates ignore formatting and case, and skip tiny bodies", () => {
  const a = splitSections(src("## Testing\nAlways run **npm test** before you open a PR.\n## Tiny\nok", "./CLAUDE.md", "a"))
  const b = splitSections(src("## Tests\nalways run `npm test` before you open a pr\n## Tiny\nok", "./rules.md", "b"))
  const groups = exactDuplicates([...a, ...b])
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0]!.sections.map((s) => s.heading), ["Testing", "Tests"])
  assert.ok(groups[0]!.duplicatedCharacters > 20)
})

test("lexical overlap: thresholds, and exact duplicates are not double-reported", () => {
  const base = "always run the full test suite with npm test before you open a pull request and fix every failure"
  const sections = [
    ...splitSections(src(`## A\n${base}`, "./a.md", "a")),
    ...splitSections(src(`## B\n${base} promptly`, "./b.md", "b")),
    ...splitSections(src(`## C\n${base}`, "./c.md", "c")),
    ...splitSections(src("## D\ncompletely different words about deployment pipelines and release trains", "./d.md", "d")),
  ]
  const overlaps = lexicalOverlaps(sections)
  assert.ok(overlaps.every((o) => o.a.nodeId !== "d" && o.b.nodeId !== "d"))
  assert.ok(!overlaps.some((o) => [o.a.nodeId, o.b.nodeId].sort().join() === "a,c"), "a/c are an exact duplicate")
  const ab = overlaps.find((o) => [o.a.nodeId, o.b.nodeId].sort().join() === "a,b")!
  assert.equal(ab.level, "high")
  assert.ok(ab.jaccard >= 0.85)
})

test("jaccard and shingles", () => {
  assert.equal(jaccard(new Set(), new Set()), 0)
  assert.equal(jaccard(new Set(["a"]), new Set(["a"])), 1)
  assert.equal(shingles("one two three four five six").size, 2)
  assert.equal(shingles("one two").size, 1)
})

// ── stale paths ─────────────────────────────────────────────────────────────

test("path extraction: paths yes; English, branches, packages, URLs, globs, commands no", () => {
  const text = [
    "See `src/auth.ts` and `./scripts/build.sh` and src/api/ for details.",
    "Read [the guide](docs/guide.md#setup) or https://example.com/a/b.ts.",
    "Use and/or, I/O, `feat/my-branch`, `owner/repo`, `@scope/pkg`, `src/**/*.ts`, `~/notes/x.md`.",
    "Run `/context-lab tree` or `npm run build`. Version 1.2/3.4 is fine.",
    "```",
    "src/inside-a-fence.ts",
    "```",
  ].join("\n")
  const refs = extractPathRefs(src(text))
  assert.deepEqual(
    refs.map((r) => `${r.path}:${r.confidence}:${r.line}`),
    ["src/auth.ts:high:1", "./scripts/build.sh:high:1", "src/api/:medium:1", "docs/guide.md:high:2"],
  )
})

test("join and locateLine", () => {
  assert.equal(join("c:/work/p", "./a/../b.ts"), "c:/work/p/b.ts")
  assert.equal(join("/work/p/docs", "../src/x.ts"), "/work/p/src/x.ts")
  assert.equal(locateLine("a\nsrc/x.ts\nb\nsrc/x.ts", "src/x.ts", 4), 4)
  assert.equal(locateLine("a\nb", "src/x.ts", 1), undefined)
})

// ── discoverability ─────────────────────────────────────────────────────────

test("tree parsing: glyph trees and indented trees, with comments", () => {
  const glyph = parseTree([
    "src/",
    "├── api/          # handlers",
    "│   ├── routes.ts",
    "│   └── models/",
    "│       └── user.ts",
    "└── utils/  <- helpers",
  ])
  assert.deepEqual(glyph, ["src", "src/api", "src/api/routes.ts", "src/api/models", "src/api/models/user.ts", "src/utils"])
  const indented = parseTree(["src/", "  api/", "    routes.ts", "  utils/", "tests/"])
  assert.deepEqual(indented, ["src", "src/api", "src/api/routes.ts", "src/utils", "tests"])
  assert.equal(parseTree(["npm install", "npm run build", "npm test", "npm run lint", "npm start"]), null)
})

test("inventories: bullet lists that mostly name paths", () => {
  const text = ["- `src/a.ts` — a", "- `src/b.ts`: b", "- src/c/", "- `src/d.ts`", "- `src/e.ts`"].join("\n")
  const [inv] = findListings(src(text))
  assert.equal(inv!.kind, "inventory")
  assert.deepEqual(inv!.entries, ["src/a.ts", "src/b.ts", "src/c", "src/d.ts", "src/e.ts"])
  assert.deepEqual(findListings(src("- Be terse\n- Use tabs\n- `src/a.ts`\n- Prefer x\n- No y")), [])
})

test("scoring tries the tree as written and without the project's own folder name", () => {
  const listing = { nodeId: "n", file: "f", kind: "tree" as const, line: 1, estimatedTokens: 10, entries: ["proj", "proj/src", "proj/src/a.ts", "proj/docs", "proj/docs/b.md", "proj/x"] }
  const on = new Set(["/r/src", "/r/src/a.ts", "/r/docs", "/r/docs/b.md"])
  const scored = scoreListing(listing, (p) => on.has(p), "/r")
  assert.equal(scored.existing, 4)
  assert.equal(scored.total, 5)
  assert.equal(scored.ratio, 4 / 5)
})

// ── config ──────────────────────────────────────────────────────────────────

test("config: known keys within bounds, anything else defaults", () => {
  assert.deepEqual(parseAnalysisConfig(undefined), DEFAULT_ANALYSIS)
  assert.deepEqual(parseAnalysisConfig("not json"), DEFAULT_ANALYSIS)
  const c = parseAnalysisConfig(JSON.stringify({ largeSectionEstimatedTokens: 300, overlapHigh: 7, overlapMedium: 0.9, x: 1 }))
  assert.equal(c.largeSectionEstimatedTokens, 300)
  assert.equal(c.overlapHigh, 0.85)
  assert.equal(c.overlapMedium, 0.85, "medium never exceeds high")
})

// ── fixtures (SPEC §44): real files, real filesystem, zero model calls ─────

const FIXTURES = resolve(import.meta.dirname, "..", "fixtures")

/** A fixture as the engine would deliver it: files observed in one context. */
function fixture(name: string, files: { rel: string; kind?: string }[], config = DEFAULT_ANALYSIS) {
  const root = canonicalPath(pathJoin(FIXTURES, name))
  const instructionFiles = files.map((f) => ({
    path: `${root}/${f.rel}`,
    kind: f.kind ?? "project",
    content: readFileSync(pathJoin(FIXTURES, name, f.rel), "utf8"),
  }))
  const graph: ContextGraph = observeContext(emptyGraph(), { blocks: [], instructionFiles }, { at: 1, sessionId: "s" })
  const sources: AnalyzedSource[] = instructionFiles.map((f, i) => ({
    nodeId: nodeId("project", canonicalPath(f.path)),
    file: `./${files[i]!.rel}`,
    text: f.content,
    fromDisk: false,
    diskLine: (line, needle) => locateLine(f.content, needle, line),
  }))
  const input = { graph, sources, root, config }
  const existing = new Set(pathsToCheck(input).filter((p) => existsSync(p)))
  return { graph, issues: analyze(input, existing) }
}

test("fixture simple-project: one observed instruction, zero issues", () => {
  const { graph, issues } = fixture("simple-project", [{ rel: "CLAUDE.md" }])
  assert.equal(graph.current.length, 1)
  assert.deepEqual(issues, [])
  assert.match(renderIssues(issues, graph), /No issues found/)
})

test("fixture redundant-project: lexical overlap HIGH between the two Testing sections", () => {
  const { issues } = fixture("redundant-project", [{ rel: "CLAUDE.md" }, { rel: ".claude/rules/testing.md" }])
  assert.deepEqual(issues.map((i) => i.type), ["lexical-overlap"])
  const [o] = issues
  assert.equal(o!.title, "Lexical overlap (HIGH)")
  assert.deepEqual(o!.locations, ["./CLAUDE.md > Testing", "./.claude/rules/testing.md > Testing"])
  assert.match(o!.details[0]!.text, /Overlap 9\d% \(Jaccard of 5-word shingles\)/)
})

test("fixture discoverable-project: tree discoverable, one stale path, nothing else", () => {
  const { graph, issues } = fixture("discoverable-project", [{ rel: "CLAUDE.md" }])
  assert.deepEqual(issues.map((i) => i.type).sort(), ["discoverable", "stale-reference"])

  const tree = issues.find((i) => i.type === "discoverable")!
  assert.equal(tree.requiresEval, true)
  assert.deepEqual(tree.locations, ["./CLAUDE.md > Repository structure"])
  assert.ok(tree.details.some((d) => d.text === "12/12 listed paths exist in the repository (100%)"), JSON.stringify(tree.details))
  assert.ok(tree.details.some((d) => d.label === "EXPERIMENTAL" && d.text === "Not tested"))

  const stale = issues.find((i) => i.type === "stale-reference")!
  assert.equal(stale.explanation, "References src/legacy/api.ts, which does not exist.")
  assert.deepEqual(stale.locations, ["./CLAUDE.md:23"])

  const text = renderIssues(issues, graph)
  assert.match(text, /NOT EXPERIMENTALLY TESTED/)
  assert.match(text, /Findings are candidates, not verdicts/)
  const overview = renderOverview({ graph, usage: undefined, root: "/x", issues })
  assert.match(overview, /Issues\s+2/)
})

test("large always-on sections are flagged against the configurable threshold only", () => {
  const big = `# Architecture\n${"word ".repeat(700)}`
  const graph = observeContext(
    emptyGraph(),
    { blocks: [], instructionFiles: [{ path: "/r/CLAUDE.md", kind: "project", content: big }] },
    { at: 1 },
  )
  const sources = [{ nodeId: nodeId("project", "/r/CLAUDE.md"), file: "./CLAUDE.md", text: big, fromDisk: true }]
  const at = (threshold: number) =>
    analyze({ graph, sources, root: "/r", config: { ...DEFAULT_ANALYSIS, largeSectionEstimatedTokens: threshold } }, new Set())
  assert.deepEqual(at(1000), [])
  const [issue] = at(500)
  assert.equal(issue!.type, "large-always-on")
  assert.equal(issue!.evidence, "observed")
  assert.ok(issue!.details.some((d) => d.text === "Loaded in 1/1 observed contexts"))
  assert.match(renderIssues(at(500), graph), /Read from disk|NOT EXPERIMENTALLY TESTED/)
})

test("issues carry deterministic ids and never an invented score", () => {
  const a = fixture("discoverable-project", [{ rel: "CLAUDE.md" }]).issues
  const b = fixture("discoverable-project", [{ rel: "CLAUDE.md" }]).issues
  assert.deepEqual(a.map((i) => i.id), b.map((i) => i.id))
  for (const i of a) assert.equal(/score|confidence\s*=|\/100/i.test(JSON.stringify(i)), false)
})

test("stale paths: only anchored, never generated output, alternatives or elisions; one issue per path", () => {
  const root = "/r"
  const text = [
    "Code in `src/legacy/api.ts` and `src/legacy/api.ts` again.", // anchored (src exists): stale, once
    "Then `width/height/fps`, `system_a/b/c`, `.ttf/.otf/.woff`.", // alternatives
    "Built into `apps/cli/dist/` and `graphify-out/wiki/index.md`; copy `src/.env`.", // generated / env
    "See `openspec/changes/.../spec.md` and `specs/other/spec.md`.", // elided / unanchored
  ].join("\n")
  const id = nodeId("project", "/r/CLAUDE.md")
  const graph = observeContext(emptyGraph(), { blocks: [], instructionFiles: [{ path: "/r/CLAUDE.md", kind: "project", content: text }] }, { at: 1 })
  const issues = analyze(
    { graph, sources: [{ nodeId: id, file: "./CLAUDE.md", text, fromDisk: true }], root, config: DEFAULT_ANALYSIS },
    new Set(["/r/src", "/r/apps", "/r/openspec"]),
  )
  assert.deepEqual(issues.map((i) => i.explanation), ["References src/legacy/api.ts, which does not exist."])
  assert.deepEqual(issues[0]!.locations, ["./CLAUDE.md:1"])
})
