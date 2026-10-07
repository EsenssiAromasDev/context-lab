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
  on("fs.exists", () => ({ value: true }))
  const disk = opts.disk ?? {}
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
    const out = cmd === "--version" ? "git version 2.47.0\n" : cmd === "rev-parse HEAD" ? "abc123\n" : ""
    return { value: { exitCode: 0, stdout: out, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The engine's own prompt.context: hands back what it was given.
  on("prompt.context", ($, e) => ({ blocks: e.blocks, ...(e.instructionFiles ? { instructionFiles: e.instructionFiles } : {}) }))
  on("session.measure", ($, e) => ({ changed: e.changed }))
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

test("unbuilt views say so and write nothing", async ($, on) => {
  const w = world(on)
  await start($)
  expect(await run($, "issues")).toContain("Phase 4")
  expect(await run($, "report")).toContain("Nothing was written")
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
