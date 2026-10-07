import assert from "node:assert/strict"
import { test } from "node:test"
import * as size from "../../../hooks/metrics/size.ts"

test("formatPercent", () => {
  const f = (size as Record<string, unknown>).formatPercent as (r: number) => string
  assert.equal(typeof f, "function")
  assert.equal(f(0.357), "35.7%")
  assert.equal(f(0), "0.0%")
  assert.equal(f(1), "100.0%")
  assert.equal(f(0.0004), "0.0%")
})
