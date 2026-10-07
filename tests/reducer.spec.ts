import assert from "node:assert/strict"
import { test } from "node:test"
import type { ClaudeOSEvent } from "../core/events.ts"
import { shipReadiness } from "../core/evidence.ts"
import { reduce, reduceAll } from "../core/reducer.ts"
import { createInitialState, progress } from "../core/state.ts"

const fresh = () => createInitialState("proj", 0)
const pass = (at: number) => ({ status: "passed" as const, at })

test("goal + plan moves planning -> implementing and tracks progress", () => {
  const s = reduceAll(fresh(), [
    { type: "USER_GOAL", goal: "Implement Stripe refunds", at: 1 },
    { type: "PLAN_SET", tasks: [{ id: "a", title: "Model" }, { id: "b", title: "Webhook" }], at: 2 },
    { type: "TASK_STARTED", taskId: "a", at: 3 },
    { type: "TASK_COMPLETED", taskId: "a", at: 4 },
  ])
  assert.equal(s.goal, "Implement Stripe refunds")
  assert.equal(s.phase, "implementing")
  assert.equal(progress(s), 0.5)
  assert.equal(s.currentTask, "")
  assert.equal(s.updatedAt, 4)
})

test("reducer never mutates input state", () => {
  const s0 = fresh()
  const frozen = structuredClone(s0)
  reduce(s0, { type: "FILE_CHANGED", path: "a.ts", at: 1 })
  assert.deepEqual(s0, frozen)
})

test("FILE_CHANGED normalizes and dedupes paths", () => {
  const s = reduceAll(fresh(), [
    { type: "FILE_CHANGED", path: "src\\payments\\refunds.ts", at: 1 },
    { type: "FILE_CHANGED", path: "./src/payments/refunds.ts", at: 2 },
  ])
  assert.deepEqual(s.changedFiles, ["src/payments/refunds.ts"])
  assert.equal(s.lastChangeAt, 2)
})

test("unknown events are ignored", () => {
  const s0 = fresh()
  const s1 = reduce(s0, { type: "FROM_THE_FUTURE", at: 9 } as unknown as ClaudeOSEvent)
  assert.equal(s1, s0)
})

test("evidence recorded before a file change is stale", () => {
  const s = reduceAll(fresh(), [
    { type: "CHECK_RAN", kind: "tests", result: pass(5), at: 5 },
    { type: "FILE_CHANGED", path: "a.ts", at: 6 },
  ])
  assert.deepEqual(shipReadiness(s, ["tests"]).stale, ["tests"])
})

test("SHIP_APPROVED is refused when evidence is missing, failing or stale", () => {
  const s = reduceAll(fresh(), [
    { type: "USER_GOAL", goal: "g", at: 1 },
    { type: "CHECK_RAN", kind: "tests", result: { status: "failed", passed: 31, failed: 1, at: 2 }, at: 2 },
    { type: "SHIP_REQUESTED", at: 3 },
    { type: "SHIP_APPROVED", required: ["tests", "build"], at: 4 },
  ])
  assert.equal(s.phase, "implementing")
  assert.match(s.nextAction, /missing evidence: build/)
})

test("SHIP_APPROVED reaches done only with fresh passing evidence and no blockers", () => {
  const base: ClaudeOSEvent[] = [
    { type: "USER_GOAL", goal: "g", at: 1 },
    { type: "FILE_CHANGED", path: "a.ts", at: 2 },
    { type: "BLOCKER_FOUND", id: "b1", text: "fixture failing", at: 3 },
    { type: "CHECK_RAN", kind: "tests", result: pass(4), at: 4 },
    { type: "CHECK_RAN", kind: "build", result: pass(4), at: 4 },
    { type: "SHIP_REQUESTED", at: 5 },
  ]
  const blocked = reduceAll(fresh(), [...base, { type: "SHIP_APPROVED", required: ["tests", "build"], at: 6 }])
  assert.equal(blocked.phase, "implementing")

  const ok = reduceAll(fresh(), [
    ...base,
    { type: "BLOCKER_RESOLVED", id: "b1", at: 6 },
    { type: "SHIP_APPROVED", required: ["tests", "build"], at: 7 },
  ])
  assert.equal(ok.phase, "done")
})

test("an unattributed worktree change stales evidence without inventing a path", () => {
  const s = reduceAll(fresh(), [
    { type: "CHECK_RAN", kind: "tests", result: pass(5), at: 5 },
    { type: "SHIP_APPROVED", required: [], at: 6 },
    { type: "WORKTREE_CHANGED", reason: "make fmt", at: 7 },
  ])
  assert.equal(s.phase, "implementing")
  assert.deepEqual(s.changedFiles, [])
  assert.deepEqual(shipReadiness(s, ["tests"]).stale, ["tests"])
})

test("editing after done reopens implementation", () => {
  const s = reduceAll(fresh(), [
    { type: "SHIP_APPROVED", required: [], at: 1 },
    { type: "FILE_CHANGED", path: "a.ts", at: 2 },
  ])
  assert.equal(s.phase, "implementing")
})

test("new goal resets work state", () => {
  const s = reduceAll(fresh(), [
    { type: "USER_GOAL", goal: "old", at: 1 },
    { type: "FILE_CHANGED", path: "a.ts", at: 2 },
    { type: "USER_GOAL", goal: "new", at: 3 },
  ])
  assert.equal(s.goal, "new")
  assert.deepEqual(s.changedFiles, [])
  assert.equal(s.projectId, "proj")
})
