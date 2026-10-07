import assert from "node:assert/strict"
import { test } from "node:test"
import { engineFileTokens, toSnapshot } from "../hooks/metrics/usage.ts"

test("missing usage fields remain undefined", () => {
  const s = toSnapshot({ context: { window: 200_000 } }, 5)
  assert.deepEqual(s, { contextCapacity: 200_000, measuredAt: 5 })
  assert.equal("contextUsed" in s, false)
  assert.equal("costUsd" in s, false)
  assert.equal("inputTokens" in s, false)
})

test("a full reading maps every figure the engine gave", () => {
  const s = toSnapshot(
    {
      context: {
        tokens: 71_420,
        window: 200_000,
        percent: 36,
        breakdown: {
          memoryFiles: [{ path: "/p/CLAUDE.md", type: "Project", tokens: 3640 }],
          categories: [
            { name: "System prompt", tokens: 3000, kind: "used", isDeferred: false },
            { name: "Free space", tokens: 100_000, kind: "free", isDeferred: false },
            { name: "MCP tools", tokens: 900, kind: "deferred", isDeferred: true },
          ],
          apiUsage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
        },
      },
      cost: { usd: 0.42 },
    },
    9,
  )
  assert.equal(s.contextUsed, 71_420)
  assert.equal(s.contextPercent, 36)
  assert.equal(s.costUsd, 0.42)
  assert.equal(s.cacheWriteTokens, 40)
  assert.deepEqual(s.categories, [{ name: "System prompt", tokens: 3000, kind: "used" }])
  assert.equal("autoCompactThreshold" in s, false)
})

test("engine per-file tokens are keyed by path", () => {
  assert.equal(engineFileTokens(undefined).size, 0)
  const m = engineFileTokens({ memoryFiles: [{ path: "/a", type: "User", tokens: 7 }], categories: [], apiUsage: null })
  assert.equal(m.get("/a"), 7)
})
