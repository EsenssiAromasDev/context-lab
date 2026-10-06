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

/** The world beneath the plugin: project root, an in-memory disk, a clock. */
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
  const clock = mock.clock(on, { now: 1_000 })
  const state = (): ProjectState => {
    // The plugin reports its own failures through $.ui.log; none are expected.
    expect(logs).toEqual([])
    return JSON.parse(files.get(STATE) ?? "null")
  }
  return { files, clock, state }
}

/** The tools beneath the plugin: Edit and Write succeed, Bash per `exit`. */
function tools(on: On, exit: { code: number } = { code: 0 }) {
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
  on("tool.call", { tool: "Bash" }, ($, e) =>
    exit.code === 0
      ? { result: { stdout: "ok", stderr: "", interrupted: false } }
      : { isError: true as const, result: undefined, text: `Exit code ${exit.code}\n1 failing` },
  )
}

const start = ($: Engine) =>
  $.session.start({ cwd: ROOT, surface: null, isInteractive: false })

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
  tools(on)
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

  const types = w.files.get(JOURNAL)!.trim().split("\n").map((l) => JSON.parse(l).type)
  expect(types).toEqual(["SESSION_STARTED", "FILE_CHANGED", "CHECKPOINT", "SESSION_STARTED"])
})

test("a session starting on an existing .claudeos restores it", async ($, on) => {
  const files = new Map<string, string>()
  const w = world(on, files)
  tools(on)
  files.set(
    JOURNAL,
    JSON.stringify({ type: "USER_GOAL", goal: "Implement Stripe refunds", at: 1 }) + "\n",
  )
  await start($)
  expect(w.state().goal).toBe("Implement Stripe refunds")
})
