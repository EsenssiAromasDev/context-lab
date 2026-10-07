import { expect, mock, test, type Engine } from "claude-code/testing"
import type { On } from "claude-code"
import { shipReadiness } from "../../core/evidence.ts"
import type { ProjectState } from "../../core/state.ts"

// Integration: real engine events → plugin hooks → mapper → core reducer →
// .claudeos/ on a file system the test holds in memory.

const ROOT = "/work/proj"
const STATE = `${ROOT}/.claudeos/state.json`
const JOURNAL = `${ROOT}/.claudeos/events.jsonl`

/** The engine hands $.fs native paths (C:\work\proj\... on Windows). */
const key = (path: string) => path.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "")

interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
  isStdoutTruncated: boolean
  isStderrTruncated: boolean
}
type GitHandler = (argv: readonly string[], stdin?: string) => RunResult

const exited = (exitCode: number, stdout = ""): RunResult => ({
  exitCode,
  stdout,
  stderr: "",
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

/** The world beneath the plugin: project root, an in-memory disk, a clock, no git. */
function world(on: On, files = new Map<string, string>()) {
  on("session.start", ($, e) => ({ cwd: e.cwd }))
  on("session.end", ($, e) => ({ sessionId: e.sessionId }))
  on("session.root", () => ({ value: ROOT }))
  const logs: string[] = []
  on("ui.log", ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on("fs.exists", ($, e) => ({ value: files.has(key(e.path)) }))
  on("fs.read", ($, e) => {
    const text = files.get(key(e.path))
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on("fs.write", ($, e) => {
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  // "Not a git repository" unless a test installs one (fakeGit).
  let git: GitHandler = () => exited(128)
  on("process.run", ($, e) => ({ value: git(e.argv, e.init?.stdin) }))
  const clock = mock.clock(on, { now: 1_000 })

  const state = (): ProjectState => {
    // The plugin reports its own failures through $.ui.log; none are expected.
    expect(logs).toEqual([])
    return JSON.parse(files.get(STATE) ?? "null")
  }
  const journal = (): string[] =>
    (files.get(JOURNAL) ?? "").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).type)
  const useGit = (handler: GitHandler) => {
    git = handler
  }
  return { files, clock, state, journal, useGit }
}

interface Shell {
  code?: number
  /** Side effects of a command on the (fake) worktree. */
  effect?: (command: string) => void
  /** Commands the engine judges read-only. */
  readOnly?: RegExp
}

/** The tools beneath the plugin: Edit succeeds, Bash per `shell`. */
function tools(on: On, shell: Shell = {}) {
  on("tool.call", { tool: "Edit" }, ($, e) => ({
    result: {
      filePath: e.file_path,
      oldString: e.old_string,
      newString: e.new_string,
      originalFile: e.old_string,
      structuredPatch: [],
      userModified: false,
      replaceAll: false,
    },
  }))
  on("tool.call", { tool: "Bash" }, ($, e) => {
    shell.effect?.(e.command)
    const code = shell.code ?? 0
    if (code !== 0) return { isError: true as const, result: undefined, text: `Exit code ${code}\n1 failing` }
    const result = { stdout: "ok", stderr: "", interrupted: false }
    return shell.readOnly?.test(e.command) ? { result, isReadOnly: true as const } : { result }
  })
}

/**
 * Just enough git for worktree.ts: a repo at ROOT whose HEAD tree holds
 * `committed` (path → blob), and whose worktree is the returned map.
 */
function fakeGit(committed: Record<string, string>) {
  const worktree = new Map<string, string>(Object.entries(committed))
  const git: GitHandler = (argv, stdin) => {
    const [, cmd, ...args] = argv
    if (cmd === "rev-parse") return exited(0, args.includes("--show-toplevel") ? `${ROOT}\n` : "h1\n")
    if (cmd === "status") {
      const dirty = [...worktree.keys()].filter((p) => worktree.get(p) !== committed[p])
      return exited(0, dirty.map((p) => ` M ${p}\u0000`).join(""))
    }
    if (cmd === "hash-object") {
      const paths = (stdin ?? "").trim().split("\n")
      return exited(0, paths.map((p) => worktree.get(p)).join("\n") + "\n")
    }
    if (cmd === "ls-tree") {
      const paths = args.slice(args.indexOf("--") + 1)
      return exited(0, paths.map((p) => `100644 blob ${committed[p]}\t${p}\u0000`).join(""))
    }
    throw new Error(`fake git: ${argv.join(" ")}`)
  }
  return { git, worktree }
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: null, isInteractive: false })

test("editing src/foo.ts records FILE_CHANGED, stales evidence, reopens implementing", async ($, on) => {
  const w = world(on)
  tools(on)
  await start($)
  expect(w.state().phase).toBe("planning")

  await w.clock.advance(1_000)
  await $.tool.call({ tool: "Bash", command: "npm test" })
  expect(w.state().evidence.tests?.status).toBe("passed")
  expect(shipReadiness(w.state(), ["tests"]).stale).toEqual([])

  await w.clock.advance(1_000)
  await $.tool.call({ tool: "Edit", file_path: `${ROOT}/src/foo.ts`, old_string: "a", new_string: "b" })

  const s = w.state()
  expect(s.changedFiles).toEqual(["src/foo.ts"])
  expect(s.lastChangeAt).toBe(3_000)
  expect(shipReadiness(s, ["tests"]).stale).toEqual(["tests"])
  expect(s.phase).toBe("implementing")

  const journal = w.files.get(JOURNAL)!.trim().split("\n").map((l) => JSON.parse(l))
  expect(journal.at(-1)).toEqual({ type: "FILE_CHANGED", path: "src/foo.ts", at: 3_000 })
})

test("a failing test run is recorded as failed evidence", async ($, on) => {
  const w = world(on)
  tools(on, { code: 1 })
  await start($)
  await $.tool.call({ tool: "Bash", command: "npm test" })
  expect(w.state().evidence.tests).toEqual({ status: "failed", command: "npm test", at: 1_000 })
})

test("piped and unrelated commands record no evidence", async ($, on) => {
  const w = world(on)
  tools(on, { readOnly: /^git status/ })
  await start($)
  await $.tool.call({ tool: "Bash", command: "npm test 2>&1 | tail -5" })
  await $.tool.call({ tool: "Bash", command: "git status" })
  expect(w.state().evidence).toEqual({})
})

test("state survives session end and a new session start", async ($, on) => {
  const w = world(on)
  tools(on)
  await start($)
  await $.tool.call({ tool: "Edit", file_path: `${ROOT}/src/foo.ts`, old_string: "a", new_string: "b" })
  await $.session.end({ reason: "prompt_input_exit", sessionId: "s1", resume: { id: "s1" } })

  // The disk is all that carries over; the plugin must restore from it.
  await w.clock.advance(60_000)
  await start($)
  const s = w.state()
  expect(s.changedFiles).toEqual(["src/foo.ts"])
  expect(s.phase).toBe("implementing")
  expect(w.journal()).toEqual(["SESSION_STARTED", "FILE_CHANGED", "CHECKPOINT", "SESSION_STARTED"])
})

test("a session starting on an existing .claudeos restores it", async ($, on) => {
  const files = new Map<string, string>()
  const w = world(on, files)
  tools(on)
  files.set(JOURNAL, JSON.stringify({ type: "USER_GOAL", goal: "Implement Stripe refunds", at: 1 }) + "\n")
  await start($)
  expect(w.state().goal).toBe("Implement Stripe refunds")
})

test("a shell command that edits a file is a change, found through git", async ($, on) => {
  const w = world(on)
  const { git, worktree } = fakeGit({ "src/foo.ts": "blob-a", "src/bar.ts": "blob-b" })
  w.useGit(git)
  tools(on, {
    effect: (cmd) => {
      if (cmd.startsWith("sed")) worktree.set("src/foo.ts", "blob-a2")
    },
    readOnly: /^(ls|cat)\b/,
  })
  await start($)
  await $.tool.call({ tool: "Bash", command: "npm test" })
  await w.clock.advance(1_000)
  await $.tool.call({ tool: "Bash", command: "ls src" })
  expect(shipReadiness(w.state(), ["tests"]).stale).toEqual([])

  await $.tool.call({ tool: "Bash", command: "sed -i s/a/b/ src/foo.ts" })
  const s = w.state()
  expect(s.changedFiles).toEqual(["src/foo.ts"])
  expect(shipReadiness(s, ["tests"]).stale).toEqual(["tests"])
})

test("without git, a mutating shell command stales evidence; a test run does not", async ($, on) => {
  const w = world(on)
  tools(on, { readOnly: /^ls\b/ })
  await start($)
  await $.tool.call({ tool: "Bash", command: "npm test" })
  await $.tool.call({ tool: "Bash", command: "ls" })
  expect(w.journal()).toEqual(["SESSION_STARTED", "CHECK_RAN"])

  await $.tool.call({ tool: "Bash", command: "npm run format" })
  const s = w.state()
  expect(s.changedFiles).toEqual([])
  expect(s.phase).toBe("implementing")
  expect(shipReadiness(s, ["tests"]).stale).toEqual(["tests"])
})
