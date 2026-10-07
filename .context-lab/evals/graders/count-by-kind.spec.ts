import assert from "node:assert/strict"
import { test } from "node:test"
import { emptyGraph } from "../../../hooks/graph/graph.ts"
import * as selectors from "../../../hooks/graph/graph-selectors.ts"
import { observeContext } from "../../../hooks/observers/context-observer.ts"

test("countByKind", () => {
  const f = (selectors as Record<string, unknown>).countByKind as (g: unknown) => Record<string, number>
  assert.equal(typeof f, "function")
  assert.deepEqual(f(emptyGraph()), {})
  const g = observeContext(
    emptyGraph(),
    {
      blocks: [],
      instructionFiles: [
        { path: "/h/.claude/CLAUDE.md", kind: "user", content: "a" },
        { path: "/p/CLAUDE.md", kind: "project", content: "b" },
        { path: "/p/docs/x.md", kind: "project", content: "c", parent: "/p/CLAUDE.md" },
        { path: "/p/CLAUDE.local.md", kind: "local", content: "d" },
      ],
    },
    { at: 1 },
  )
  assert.deepEqual(f(g), { user: 1, project: 2, local: 1 })
})
