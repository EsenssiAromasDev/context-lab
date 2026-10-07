import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import * as hash from "../../../hooks/metrics/hash.ts"

test("shortHash", () => {
  const f = (hash as Record<string, unknown>).shortHash as (t: string) => string
  assert.equal(typeof f, "function")
  for (const t of ["", "abc", "ñandú 🚀"]) {
    assert.equal(f(t), createHash("sha256").update(t, "utf8").digest("hex").slice(0, 12))
  }
})
