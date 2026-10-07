import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { sha256, utf8Length } from "../hooks/metrics/hash.ts"

const node = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")

test("sha256 matches node:crypto across lengths and scripts", () => {
  const samples = ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "ñandú 测试 🚀\n## Testing"]
  for (const s of samples) assert.equal(sha256(s), node(s), JSON.stringify(s.slice(0, 20)))
})

test("utf8Length matches Buffer.byteLength", () => {
  for (const s of ["", "abc", "ñ", "测试", "🚀🚀", "mixed ñ 测 🚀"]) assert.equal(utf8Length(s), Buffer.byteLength(s))
})
