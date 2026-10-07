import assert from "node:assert/strict"
import { test } from "node:test"
import * as dup from "../../../hooks/analysis/duplicates.ts"

test("overlapLabel", () => {
  const f = (dup as Record<string, unknown>).overlapLabel as (j: number, t?: { high: number; medium: number }) => string | null
  assert.equal(typeof f, "function")
  assert.equal(f(0.9), "high")
  assert.equal(f(0.85), "high")
  assert.equal(f(0.7), "medium")
  assert.equal(f(0.69), null)
  assert.equal(f(0.6, { high: 0.8, medium: 0.5 }), "medium")
  assert.equal(f(0.8, { high: 0.8, medium: 0.5 }), "high")
})
