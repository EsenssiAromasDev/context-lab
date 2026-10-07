import assert from "node:assert/strict"
import { test } from "node:test"
import { parseArgs, renderHelp } from "../../../hooks/commands/context-lab.ts"

test("ls is an alias of tree; nothing else changes", () => {
  assert.deepEqual(parseArgs("ls"), { view: "tree" })
  assert.deepEqual(parseArgs("  LS "), { view: "tree" })
  assert.deepEqual(parseArgs("tree"), { view: "tree" })
  assert.deepEqual(parseArgs(""), { view: "overview" })
  assert.deepEqual(parseArgs("eval x"), { view: "eval", arg: "x" })
  assert.deepEqual(parseArgs("lsx"), { view: "help", unknown: "lsx" })
  assert.match(renderHelp({ view: "help" }), /\bls\b/)
})
