import assert from "node:assert/strict"
import { test } from "node:test"
import { approx, compact, exact, measure } from "../hooks/metrics/size.ts"

test("measure counts characters, bytes and a ~chars/4 estimate", () => {
  assert.deepEqual(measure("abcde"), { characters: 5, bytes: 5, estimatedTokens: 2 })
  assert.deepEqual(measure("ñ"), { characters: 1, bytes: 2, estimatedTokens: 1 })
})

test("estimates always render with ~, exact counts never do", () => {
  assert.equal(approx(3640), "~3.6k")
  assert.equal(approx(812), "~812")
  assert.equal(approx(undefined), "?")
  assert.equal(exact(71420), "71,420")
  assert.equal(compact(2000), "2k")
  assert.equal(compact(1_250_000), "1.3M")
})
