import { expect, mock, test, type Engine } from "claude-code/testing"
import type { On } from "claude-code"

// Integration through the engine: prompt.context / session.measure / the
// /context-lab command, with the world beneath the plugin stubbed. Runs in
// the plugin sandbox via `claude plugin test .` (pure logic: tests/*.spec.ts).

const ROOT = "/work/proj"
const SECRET = "SECRET-CONTENT-MARKER"

interface World {
  store: Map<string, unknown>
  logs: string[]
  setUsage: (u: unknown) => void
  /** How many times the plugin asked for the engine's nested walk. */
  walks: () => number
}

interface WorldOptions {
  failUsage?: boolean
  /** The project's files, relative to ROOT. */
  disk?: Record<string, string>
  /** Paths `git status` reports as changed (relative to ROOT). */
  dirty?: string[]
  /** Where the session draws; none (a -p run) by default. */
  surfaces?: ("terminal" | "desktop")[]
}

/** The engine hands $.fs native paths (C:\work\proj\... on Windows). */
const key = (path: string) => path.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "")

/** The engine's nested walk over `disk`: directories strictly inside ROOT down to `of`'s. */
function ancestorsOf(disk: Record<string, string>, of: string, names: readonly string[]) {
  const rel = of.slice(ROOT.length + 1).split("/").slice(0, -1)
  const out = []
  for (let i = 1; i <= rel.length; i++) {
    const dir = rel.slice(0, i).join("/")
    for (const name of names) {
      const content = disk[`${dir}/${name}`]
      if (content !== undefined) {
        out.push({ dir: `${ROOT}/${dir}`, name, content, parts: [{ path: `${ROOT}/${dir}/${name}`, content }] })
      }
    }
  }
  return out
}

/** One directory of `disk`, as $.fs.list answers. */
function listOf(disk: Record<string, string>, path: string) {
  const prefix = path === ROOT ? "" : `${path.slice(ROOT.length + 1)}/`
  const entries = new Map<string, { name: string; kind: "file" | "dir"; size: number; mtimeMs: number; isLink: boolean }>()
  for (const [file, content] of Object.entries(disk)) {
    if (!file.startsWith(prefix)) continue
    const [head, ...rest] = file.slice(prefix.length).split("/")
    entries.set(head!, { name: head!, kind: rest.length ? "dir" : "file", size: content.length, mtimeMs: 0, isLink: false })
  }
  return [...entries.values()]
}

function world(on: On, opts: WorldOptions = {}): World {
  const store = new Map<string, unknown>()
  const logs: string[] = []
  let usage: unknown = { startedAt: 100, context: { window: 200_000 }, rateLimits: [] }
  on("session.start", ($, e) => ({ cwd: e.cwd }))
  on("session.root", () => ({ value: ROOT }))
  on("session.surfaces", () => ({ value: opts.surfaces ?? [] }))
  on("ui.open", () => ({ value: { isPlaced: true as const } }))
  on("session.usage", () => {
    if (opts.failUsage) throw new Error("usage unavailable")
    return { value: usage as never }
  })
  on("session.version", () => ({ value: { version: "2.1.291" } as never }))
  on("command.register", ($, e) => ({ value: { command: e.name } }))
  on("store.get", ($, e) => ({ value: store.get(e.key) as never }))
  on("store.set", ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on("ui.log", ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  const disk = opts.disk ?? {}
  // Without a disk every path exists (root, git); with one, its files and their directories do.
  on("fs.exists", ($, e) => {
    if (opts.disk === undefined) return { value: true }
    const p = key(e.path).replace(/\/$/, "")
    if (p === ROOT) return { value: true }
    const rel = p.slice(ROOT.length + 1)
    return { value: p.startsWith(`${ROOT}/`) && Object.keys(disk).some((f) => f === rel || f.startsWith(`${rel}/`)) }
  })
  on("fs.write", ($, e) => {
    disk[key(e.path).slice(ROOT.length + 1)] = e.text
    return { value: undefined }
  })
  on("fs.read", ($, e) => {
    const text = disk[key(e.path).slice(ROOT.length + 1)]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  let walks = 0
  on("fs.ancestors", ($, e) => {
    walks += 1
    return { value: ancestorsOf(disk, key(e.of ?? ROOT), e.names) as never }
  })
  on("fs.list", ($, e) => ({ value: listOf(disk, key(e.path)) }))
  // The engine's own: sends the text, unless a hook beneath dropped it (DROP).
  on("prompt.attachment", ($, e) => ({ text: e.text.includes("DROP") ? null : e.text }))
  on("tool.call", { tool: "Read" }, ($, e) => ({
    result: { type: "text", file: { filePath: e.file_path, content: disk[e.file_path.slice(ROOT.length + 1)] ?? "" } } as never,
  }))
  on("process.run", ($, e) => {
    const cmd = e.argv.slice(1).join(" ")
    const status = (opts.dirty ?? []).map((p) => ` M ${p}`).join("\n")
    const zStatus = (opts.dirty ?? []).map((p) => ` M ${p}\u0000`).join("")
    const out =
      cmd === "--version" ? "git version 2.47.0\n"
      : cmd === "rev-parse HEAD" ? "abc123\n"
      : cmd === "rev-parse --show-toplevel" ? `${ROOT}\n`
      : cmd === "status --porcelain" ? status
      : cmd.startsWith("status --porcelain=v1 -z") ? zStatus
      : ""
    return { value: { exitCode: 0, stdout: out, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The engine's own prompt.context: hands back what it was given.
  on("prompt.context", ($, e) => ({ blocks: e.blocks, ...(e.instructionFiles ? { instructionFiles: e.instructionFiles } : {}) }))
  on("session.measure", ($, e) => ({ changed: e.changed }))
  // The engine's own: a skill's text as computed; a spawn starts (DENY refuses it).
  on("skill.prompt", ($, e) => ({ text: e.text }))
  on("agent.spawn", ($, e) =>
    e.description.includes("DENY") ? { deny: "not allowed" } : { model: "claude-haiku-4-5", agentId: `agent-${e.tool_use_id}` },
  )
  mock.clock(on, { now: 1_000 })
  return { store, logs, setUsage: (u) => (usage = u), walks: () => walks }
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: null, isInteractive: false })

const files = [
  { path: "/home/dev/.claude/CLAUDE.md", kind: "user" as const, content: "x".repeat(4400) },
  { path: `${ROOT}/CLAUDE.md`, kind: "project" as const, content: `# Project\n${SECRET}\n` + "y".repeat(400) },
  { path: `${ROOT}/docs/api.md`, kind: "project" as const, content: "API", parent: `${ROOT}/CLAUDE.md` },
]

const run = async ($: Engine, args = "") => (
  await $.command.run({
    command: "context-lab",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 100 },
  })
).text ?? ""

test("prompt.context is observed, passed through untouched, and shown in tree", async ($, on) => {
  const w = world(on)
  await start($)
  const input = { blocks: [{ name: "claudeMd", text: "framed" }], instructionFiles: files }
  const out = await $.prompt.context(input)
  expect(out.blocks).toEqual(input.blocks)
  expect(out.instructionFiles).toEqual(files)

  const tree = await run($, "tree")
  expect(tree).toContain("● USER")
  expect(tree).toContain("● PROJECT")
  expect(tree).toContain("● ./CLAUDE.md")
  expect(tree).toContain("● ./docs/api.md")
  expect(tree).toContain("● observed  ◐ inferred  ○ available")
  expect(w.logs).toEqual([])
})

test("overview shows real context use and never persists raw content", async ($, on) => {
  const w = world(on)
  await start($)
  await $.prompt.context({ blocks: [], instructionFiles: files })
  w.setUsage({
    startedAt: 100,
    context: { tokens: 71_420, window: 200_000, percent: 36 },
    rateLimits: [],
    cost: { usd: 1.5 },
  })
  await $.session.measure({ context: { tokens: 71_420, window: 200_000, percent: 36 }, rateLimits: [], changed: ["context"] })

  const overview = await run($)
  expect(overview).toContain("71,420 / 200,000")
  expect(overview).toContain("● ~/.claude/CLAUDE.md")
  expect(overview).toContain("~1.1k")
  expect(overview).toContain("$1.50")

  const stored = JSON.stringify([...w.store.values()])
  expect(stored.includes(SECRET)).toBe(false)
  expect(stored.includes("CLAUDE.md")).toBe(true)
})

test("each observed context counts one more load per file", async ($, on) => {
  const w = world(on)
  await start($)
  await $.prompt.context({ blocks: [], instructionFiles: files })
  w.setUsage({ startedAt: 200, context: { window: 200_000 }, rateLimits: [] })
  await $.prompt.context({ blocks: [], instructionFiles: files })
  const tree = await run($, "tree")
  expect(tree).toContain("×2")
})

test("doctor reports what was observed and the repository state", async ($, on) => {
  world(on)
  await start($)
  await $.prompt.context({ blocks: [], instructionFiles: files })
  const text = await run($, "doctor")
  expect(text).toContain("Claude Code 2.1.291")
  expect(text).toMatch(/prompt\.context\s+✓ observed ×1/)
  expect(text).toMatch(/session\.measure\s+hooked, not yet observed/)
  expect(text).toMatch(/Repository clean\s+✓/)
  expect(text).toContain("Status: READY")
})

test("an observer failure never breaks the engine's answer", async ($, on) => {
  const w = world(on, { failUsage: true })
  await start($)
  const input = { blocks: [{ name: "claudeMd", text: "t" }], instructionFiles: files }
  const out = await $.prompt.context(input)
  expect(out.instructionFiles).toEqual(files)
  await run($, "doctor") // waits for the background observation
  expect(w.logs.some((l) => l.includes("context-lab prompt.context"))).toBe(true)
})

test("issues before anything is observed says so", async ($, on) => {
  const w = world(on)
  await start($)
  expect(await run($, "issues")).toContain("Nothing observed yet")
  expect(await run($, "nope")).toContain('Unknown view "nope"')
  expect(w.store.size).toBe(0)
})

// Phase 2b — nested instruction files (SPEC §12, the nested-project fixture).

const NESTED_DISK = {
  "CLAUDE.md": "# Nested project",
  "src/api/CLAUDE.md": "# API rules\nEvery handler validates its input.",
  "src/api/service.ts": "export function handler() {}",
  "node_modules/pkg/CLAUDE.md": "never listed",
}

const rootContext = {
  blocks: [],
  instructionFiles: [{ path: `${ROOT}/CLAUDE.md`, kind: "project" as const, content: "# Nested project" }],
}

const attachment = (text: string, agentId?: string) => ({
  type: "nested_memory",
  text,
  origin: { kind: "engine" as const },
  ...(agentId === undefined ? {} : { agentId }),
})

test("nested: available before a Read, inferred after it, observed once attached", async ($, on) => {
  const w = world(on, { disk: NESTED_DISK })
  await start($)
  await $.prompt.context(rootContext)

  let tree = await run($, "tree")
  expect(tree).toContain("○ AVAILABLE")
  expect(tree).toContain("○ ./src/api/CLAUDE.md")
  expect(tree.includes("node_modules")).toBe(false)

  await $.tool.call({ tool: "Read", file_path: `${ROOT}/src/api/service.ts` })
  tree = await run($, "tree")
  expect(tree).toContain("◐ POSSIBLE NESTED")
  expect(tree).toContain("◐ ./src/api/CLAUDE.md")
  expect(tree).toContain("← src/api/service.ts")
  expect(tree.includes("○ ./src/api/CLAUDE.md")).toBe(false)

  const text = `Contents of ${ROOT}/src/api/CLAUDE.md (project instructions):

${NESTED_DISK["src/api/CLAUDE.md"]}`
  const sent = await $.prompt.attachment(attachment(text))
  expect(sent.text).toBe(text)
  tree = await run($, "tree")
  expect(tree).toContain("● NESTED (attached on read)")
  expect(tree).toContain("● ./src/api/CLAUDE.md")
  expect(tree.includes("◐ ./src/api/CLAUDE.md")).toBe(false)

  const doctor = await run($, "doctor")
  expect(doctor).toMatch(/nested_memory attribution\s+✓ 1 file\(s\) from 1/)
  expect(w.logs).toEqual([])
})

test("nested: a subagent's attachment and one a hook dropped are not observed", async ($, on) => {
  world(on, { disk: NESTED_DISK })
  await start($)
  await $.prompt.context(rootContext)
  await $.prompt.attachment(attachment(`Contents of ${ROOT}/src/api/CLAUDE.md:
x`, "agent-1"))
  await $.prompt.attachment(attachment(`Contents of ${ROOT}/src/api/CLAUDE.md:
DROP`))
  const tree = await run($, "tree")
  expect(tree.includes("NESTED (attached on read)")).toBe(false)
  expect(tree).toContain("○ ./src/api/CLAUDE.md")
})

test("nested: an unattributable attachment is reported by doctor, not guessed", async ($, on) => {
  world(on, { disk: NESTED_DISK })
  await start($)
  await $.prompt.context(rootContext)
  await $.prompt.attachment(attachment("API rules, in a format this build invented"))
  expect(await run($, "doctor")).toMatch(/nested_memory attribution\s+✗ 1\/1 unattributed/)
  expect((await run($, "tree")).includes("NESTED (attached on read)")).toBe(false)
})

test("nested: the walk runs once per directory per context, and never outside the project", async ($, on) => {
  const w = world(on, { disk: NESTED_DISK })
  await start($)
  await $.prompt.context(rootContext)
  await $.tool.call({ tool: "Read", file_path: `${ROOT}/src/api/service.ts` })
  await $.tool.call({ tool: "Read", file_path: `${ROOT}/src/api/CLAUDE.md` })
  await $.tool.call({ tool: "Read", file_path: "/etc/hosts" })
  expect(w.walks()).toBe(1)
})

// Phase 4 — issues from what Claude was sent (SPEC §13–19).

test("issues: lexical overlap between delivered files, counted in the overview", async ($, on) => {
  world(on, { disk: { "CLAUDE.md": "x", ".claude/rules/testing.md": "x" } })
  await start($)
  const body = "Always run the full test suite with npm test before you open a pull request and fix every failure you find"
  await $.prompt.context({
    blocks: [],
    instructionFiles: [
      { path: `${ROOT}/CLAUDE.md`, kind: "project", content: `# P\n## Testing\n${body}.` },
      { path: `${ROOT}/.claude/rules/testing.md`, kind: "project", content: `## Testing\n${body} promptly.` },
    ],
  })
  const issues = await run($, "issues")
  expect(issues).toContain("MEDIUM  Lexical overlap (HIGH)")
  expect(issues).toContain("./CLAUDE.md > Testing")
  expect(issues).toContain("./.claude/rules/testing.md > Testing")
  expect(await run($)).toMatch(/Issues\s+1/)
})

test("issues: stale paths are checked on disk and located on the file's real line", async ($, on) => {
  // On disk the file has frontmatter and a comment the engine strips before sending.
  const onDisk = "---\nx: 1\n---\n<!-- note -->\n# P\nSee `src/api/service.ts` and `src/missing.ts`.\n"
  world(on, { disk: { "CLAUDE.md": onDisk, "src/api/service.ts": "code" } })
  await start($)
  await $.prompt.context({
    blocks: [],
    instructionFiles: [{ path: `${ROOT}/CLAUDE.md`, kind: "project", content: "# P\nSee `src/api/service.ts` and `src/missing.ts`.\n" }],
  })
  const issues = await run($, "issues")
  expect(issues).toContain("LOW  Stale path")
  expect(issues).toContain("./CLAUDE.md:6")
  expect(issues).toContain("References src/missing.ts, which does not exist.")
  expect(issues.includes("src/api/service.ts, which")).toBe(false)
})

test("issues: thresholds come from .context-lab/config.json", async ($, on) => {
  const big = `# Architecture\n${"word ".repeat(700)}`
  world(on, { disk: { "CLAUDE.md": big, ".context-lab/config.json": JSON.stringify({ largeSectionEstimatedTokens: 500 }) } })
  await start($)
  await $.prompt.context({ blocks: [], instructionFiles: [{ path: `${ROOT}/CLAUDE.md`, kind: "project", content: big }] })
  const issues = await run($, "issues")
  expect(issues).toContain("Large always-on section")
  expect(issues).toContain("threshold 500, configurable")
  expect(issues).toContain("NOT EXPERIMENTALLY TESTED")
})

// Phase 3 — dynamic context: skills and subagents (SPEC §11).

const spawnInput = (id: string, over: Record<string, unknown> = {}) => ({
  tool_use_id: id,
  prompt: "PROMPT-SECRET task text",
  description: "explore the repo",
  subagentType: "Explore",
  provider: { plugin: "engine", tier: "core" as const },
  parentModel: "claude-opus-5-5",
  background: false,
  fork: false,
  ...over,
})

test("skills: an activation is observed in tree and overview, with the listing's cost", async ($, on) => {
  const w = world(on)
  await start($)
  await $.prompt.context({ blocks: [], instructionFiles: files })
  const sent = await $.skill.prompt({ skill: "commit", text: "# Commit\n" + "Write a good message. ".repeat(40) })
  expect(sent.text.startsWith("# Commit")).toBe(true)
  w.setUsage({
    startedAt: 100,
    context: {
      window: 200_000,
      breakdown: {
        memoryFiles: [],
        categories: [],
        apiUsage: null,
        skills: { totalSkills: 80, includedSkills: 54, tokens: 2100, skillFrontmatter: [] },
      },
    },
    rateLimits: [],
  })
  const tree = await run($, "tree")
  expect(tree).toContain("● SKILLS (activated)")
  expect(tree).toContain("● skill: commit")
  const overview = await run($)
  expect(overview).toMatch(/Skill listing \(always-on\)\s+~2\.1k {2}54\/80 skills listed/)
  expect(overview).toMatch(/● skill: commit\s+~\d+ {2}×1/)
  expect(await run($, "doctor")).toMatch(/skill\.prompt\s+✓ observed ×1/)
  expect(w.logs).toEqual([])
})

test("subagents: topology in the tree, prompts never kept, denials counted", async ($, on) => {
  const w = world(on)
  await start($)
  await $.prompt.context({ blocks: [], instructionFiles: files })
  const started = await $.agent.spawn(spawnInput("t1"))
  expect(started.agentId).toBe("agent-t1")
  await $.agent.spawn(spawnInput("t2", { subagentType: "general-purpose", parentAgentId: "agent-t1" }))
  await $.agent.spawn(spawnInput("t3", { description: "DENY this" }))

  const tree = await run($, "tree")
  expect(tree).toContain("SUBAGENTS (this session) — Subagents 2 spawned (Explore ×1, general-purpose ×1) · 1 spawned by a subagent · 1 denied")
  expect(tree).toContain("├─ Explore  claude-haiku-4-5")
  expect(tree).toContain("│  └─ general-purpose  claude-haiku-4-5")
  expect(tree).toContain("(DENIED)")
  expect(await run($, "doctor")).toMatch(/agent\.spawn\s+✓ observed ×3/)
  expect(JSON.stringify([...w.store.values()]).includes("PROMPT-SECRET")).toBe(false)
})

// Phase 5 — the pane (SPEC §21–23).

const paneProps = {
  title: "Context Lab",
  isFocused: true,
  bodyColumns: 100,
  placement: "dock" as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const mountPane = ($: Engine, surface: "terminal" | "desktop") =>
  $.ui.mount({ plugin: "context-lab", surface, component: "Pane", props: paneProps, requestId: "context-lab" })

for (const surface of ["terminal", "desktop"] as const) {
  test(`pane (${surface}): /context-lab opens it, one line in the transcript, keys switch views`, async ($, on) => {
    world(on, { surfaces: [surface], disk: { "CLAUDE.md": "x", "src/a.ts": "x" } })
    await start($)
    await $.prompt.context({
      blocks: [],
      instructionFiles: [{ path: `${ROOT}/CLAUDE.md`, kind: "project", content: "# P\nSee `src/missing.ts`.\n" }],
    })
    const line = await run($)
    expect(line).toBe("Context Lab opened on overview. Keys in the pane: o overview, t tree, i issues, e experiments, r refresh, Esc close.")

    const ui = await mountPane($, surface)
    expect((await ui.find({ key: "tab-overview" }))?.text).toContain("Overview")
    expect(JSON.stringify(await ui.drawn())).toContain("CONTEXT LAB")
    expect(JSON.stringify(await ui.drawn())).toMatch(/LOW\s+1/)

    await ui.press({ key: "tab-tree" })
    expect(JSON.stringify(await ui.drawn())).toContain("SESSION CONTEXT")

    await ui.press({ key: "tab-issues" })
    const issues = JSON.stringify(await ui.drawn())
    expect(issues).toContain("CONTEXT ISSUES")
    expect(issues).toContain("References src/missing.ts, which does not exist.")

    await ui.press({ key: "tab-experiments" })
    expect(JSON.stringify(await ui.drawn())).toContain("No experiment results yet")
  })
}

test("pane: refresh re-runs the analyzers on what was observed since", async ($, on) => {
  world(on, { surfaces: ["terminal"], disk: { "CLAUDE.md": "x", "src/a.ts": "x" } })
  await start($)
  await $.prompt.context({ blocks: [], instructionFiles: [{ path: `${ROOT}/CLAUDE.md`, kind: "project", content: "# P\nclean\n" }] })
  await run($, "issues")
  const ui = await mountPane($, "terminal")
  expect(JSON.stringify(await ui.drawn())).toContain("No issues found")

  await $.prompt.context({
    blocks: [],
    instructionFiles: [{ path: `${ROOT}/CLAUDE.md`, kind: "project", content: "# P\nSee `src/gone.ts`.\n" }],
  })
  await ui.press({ key: "refresh" })
  expect(JSON.stringify(await ui.drawn())).toContain("References src/gone.ts")
})

test("headless (no surface): /context-lab answers with the full text, no pane", async ($, on) => {
  world(on)
  await start($)
  await $.prompt.context({ blocks: [], instructionFiles: files })
  expect(await run($)).toContain("CONTEXT LAB")
  expect(await run($, "experiments")).toContain("No experiment results yet")
})

// Phases 6–7 through the engine: init, report, eval's guards.

test("init creates .context-lab/ once and never overwrites", async ($, on) => {
  const disk: Record<string, string> = { "CLAUDE.md": "x" }
  world(on, { disk })
  await start($)
  const first = await run($, "init")
  expect(first).toContain("created  .context-lab/config.json")
  expect(first).toContain("created  .context-lab/.gitignore")
  expect(JSON.parse(disk[".context-lab/config.json"]!).trialsPerTask).toBe(3)
  disk[".context-lab/config.json"] = '{"trialsPerTask": 9}'
  const second = await run($, "init")
  expect(second).toContain("kept     .context-lab/config.json (exists, not overwritten)")
  expect(disk[".context-lab/config.json"]).toBe('{"trialsPerTask": 9}')
})

test("report writes one Markdown file under .context-lab/reports/, without contents", async ($, on) => {
  const disk: Record<string, string> = { "CLAUDE.md": "x", "src/a.ts": "x" }
  world(on, { disk })
  await start($)
  await $.prompt.context({
    blocks: [],
    instructionFiles: [{ path: `${ROOT}/CLAUDE.md`, kind: "project", content: "# P\nSECRET-REPORT-MARKER see `src/gone.ts`\n" }],
  })
  const answer = await run($, "report")
  expect(answer).toMatch(/^Report written: \.\/\.context-lab\/reports\/.+\.md$/)
  const name = Object.keys(disk).find((k) => k.startsWith(".context-lab/reports/"))!
  const report = disk[name]!
  expect(report).toContain("# Context Lab report")
  expect(report).toContain("| Claude Code | 2.1.291 |")
  expect(report).toContain("| Git commit | abc123 |")
  expect(report).toContain("| ./CLAUDE.md | always-on | project |")
  expect(report).toContain("References src/gone.ts, which does not exist.")
  expect(report).toContain("## Limitations")
  expect(report.includes("SECRET-REPORT-MARKER")).toBe(false)
  expect(Object.keys(disk).filter((k) => !k.startsWith(".context-lab/reports/") && !["CLAUDE.md", "src/a.ts"].includes(k))).toEqual([])
})

test("eval: refused on a dirty tree, usage without a variant, stop when idle", async ($, on) => {
  world(on, { disk: { "CLAUDE.md": "x" }, dirty: ["src/app.ts"] })
  await start($)
  expect(await run($, "eval")).toContain("Usage: /context-lab eval <variant>")
  expect(await run($, "eval stop")).toBe("No eval is running.")
  const dirty = await run($, "eval compact")
  expect(dirty).toContain("Context Lab eval refused.")
  expect(dirty).toContain("Commit or stash changes first.")
  expect(dirty).toContain("src/app.ts")
})

test("eval: a clean tree with no .context-lab asks for init", async ($, on) => {
  world(on, { disk: { "CLAUDE.md": "x" } })
  await start($)
  expect(await run($, "eval compact")).toBe("No .context-lab/ here: run /context-lab init first.")
})
