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
}

function world(on: On, opts: { failUsage?: boolean } = {}): World {
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
  on("process.run", ($, e) => {
    const cmd = e.argv.slice(1).join(" ")
    const out = cmd === "--version" ? "git version 2.47.0\n" : cmd === "rev-parse HEAD" ? "abc123\n" : ""
    return { value: { exitCode: 0, stdout: out, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The engine's own prompt.context: hands back what it was given.
  on("prompt.context", ($, e) => ({ blocks: e.blocks, ...(e.instructionFiles ? { instructionFiles: e.instructionFiles } : {}) }))
  on("session.measure", ($, e) => ({ changed: e.changed }))
  mock.clock(on, { now: 1_000 })
  return { store, logs, setUsage: (u) => (usage = u) }
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
