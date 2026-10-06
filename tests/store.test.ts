import assert from "node:assert/strict"
import { mkdtempSync, rmSync, unlinkSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { FileStore, openSession } from "../core/store.ts"
import { progress } from "../core/state.ts"

const dirs: string[] = []
const tempProject = () => {
  const d = mkdtempSync(join(tmpdir(), "claudeos-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

// The milestone demo, minus the agent: work, close, reopen, know everything.
test("state survives closing and reopening the session", () => {
  const root = tempProject()

  const day1 = openSession(new FileStore(root), "proj", 0)
  assert.equal(day1.restored, false)
  day1.dispatch({ type: "USER_GOAL", goal: "Implement Stripe refunds", at: 1 })
  day1.dispatch({
    type: "PLAN_SET",
    tasks: [
      { id: "1", title: "Refund model" },
      { id: "2", title: "Fix webhook handling" },
    ],
    at: 2,
  })
  day1.dispatch({ type: "TASK_COMPLETED", taskId: "1", at: 3 })
  day1.dispatch({ type: "TASK_STARTED", taskId: "2", at: 4 })
  day1.dispatch({ type: "DECISION_MADE", id: "d1", text: "Persist Stripe event IDs", at: 5 })
  day1.dispatch({ type: "FILE_CHANGED", path: "src/payments/refunds.ts", at: 6 })
  day1.dispatch({
    type: "CHECK_RAN",
    kind: "tests",
    result: { status: "failed", passed: 31, failed: 1, at: 7 },
    at: 7,
  })
  day1.dispatch({ type: "BLOCKER_FOUND", id: "b1", text: "refund fixture failing", at: 8 })
  day1.dispatch({ type: "NEXT_ACTION_SET", action: "Inspect refund fixture", at: 9 })

  const day2 = openSession(new FileStore(root), "proj", 1000)
  const s = day2.state
  assert.equal(day2.restored, true)
  assert.equal(s.goal, "Implement Stripe refunds")
  assert.equal(s.currentTask, "Fix webhook handling")
  assert.equal(progress(s), 0.5)
  assert.deepEqual(s.decisions.map((d) => d.text), ["Persist Stripe event IDs"])
  assert.deepEqual(s.blockers.map((b) => b.text), ["refund fixture failing"])
  assert.equal(s.evidence.tests?.failed, 1)
  assert.equal(s.nextAction, "Inspect refund fixture")
})

test("lost snapshot is rebuilt from the journal", () => {
  const root = tempProject()
  const store = new FileStore(root)
  const a = openSession(store, "proj", 0)
  a.dispatch({ type: "USER_GOAL", goal: "g", at: 1 })
  a.dispatch({ type: "FILE_CHANGED", path: "x.ts", at: 2 })

  unlinkSync(store.statePath)
  const b = openSession(new FileStore(root), "proj", 10)
  assert.equal(b.restored, true)
  assert.equal(b.state.goal, "g")
  assert.deepEqual(b.state.changedFiles, ["x.ts"])
})

test("corrupt snapshot is moved aside and state is rebuilt", () => {
  const root = tempProject()
  const store = new FileStore(root)
  openSession(store, "proj", 0).dispatch({ type: "USER_GOAL", goal: "g", at: 1 })

  writeFileSync(store.statePath, "{ not json")
  const s = openSession(new FileStore(root), "proj", 10)
  assert.equal(s.state.goal, "g")
  assert.ok(readdirSync(store.dir).some((f) => f.startsWith("state.json.corrupt-")))
})

test("torn last journal line is skipped", () => {
  const root = tempProject()
  const store = new FileStore(root)
  openSession(store, "proj", 0).dispatch({ type: "USER_GOAL", goal: "g", at: 1 })
  writeFileSync(store.journalPath, '{"type":"FILE_CHANGED","pa', { flag: "a" })
  assert.equal(store.readJournal().length, 1)
})
