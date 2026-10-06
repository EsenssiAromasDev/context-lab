import assert from "node:assert/strict"
import { test } from "node:test"
import { detectChecks, mapToolCall, projectRelative } from "../adapters/claude-code/mapper.ts"

const ctx = { root: "/work/proj", at: 42 }

test("Edit inside the project becomes FILE_CHANGED with a relative path", () => {
  assert.deepEqual(mapToolCall("Edit", { file_path: "/work/proj/src/foo.ts" }, { kind: "ok" }, ctx), [
    { type: "FILE_CHANGED", path: "src/foo.ts", at: 42 },
  ])
})

test("denied, failed, outside-project and own-state edits change nothing", () => {
  const input = { file_path: "/work/proj/src/foo.ts" }
  assert.deepEqual(mapToolCall("Write", input, { kind: "denied" }, ctx), [])
  assert.deepEqual(mapToolCall("Write", input, { kind: "error" }, ctx), [])
  assert.deepEqual(mapToolCall("Write", { file_path: "/home/me/.bashrc" }, { kind: "ok" }, ctx), [])
  assert.deepEqual(mapToolCall("Write", { file_path: "/work/proj/.claudeos/state.json" }, { kind: "ok" }, ctx), [])
})

test("NotebookEdit uses notebook_path", () => {
  const [e] = mapToolCall("NotebookEdit", { notebook_path: "/work/proj/nb.ipynb" }, { kind: "ok" }, ctx)
  assert.equal(e?.type === "FILE_CHANGED" && e.path, "nb.ipynb")
})

test("Windows paths compare case-insensitively", () => {
  assert.equal(projectRelative("c:\\Users\\Me\\Proj\\src\\a.ts", "C:\\Users\\me\\proj"), "src/a.ts")
  assert.equal(projectRelative("C:\\Users\\me\\proj2\\a.ts", "C:\\Users\\me\\proj"), null)
  assert.equal(projectRelative("/work/proj/../other/a.ts", "/work/proj"), null)
})

test("Bash test run becomes CHECK_RAN with status from the tool outcome", () => {
  const input = { command: "npm test" }
  const [passed] = mapToolCall("Bash", input, { kind: "ok" }, ctx)
  assert.deepEqual(passed, {
    type: "CHECK_RAN",
    kind: "tests",
    result: { status: "passed", command: "npm test", at: 42 },
    at: 42,
  })
  const [failed] = mapToolCall("Bash", input, { kind: "error" }, ctx)
  assert.equal(failed?.type === "CHECK_RAN" && failed.result.status, "failed")
  const [cut] = mapToolCall("Bash", input, { kind: "error", interrupted: true }, ctx)
  assert.equal(cut?.type === "CHECK_RAN" && cut.result.status, "error")
})

test("background and unrelated shell commands record nothing", () => {
  assert.deepEqual(mapToolCall("Bash", { command: "npm test", run_in_background: true }, { kind: "ok" }, ctx), [])
  assert.deepEqual(
    mapToolCall("Bash", { command: "npm test" }, { kind: "ok", result: { backgroundTaskId: "t1" } }, ctx),
    [],
  )
  assert.deepEqual(mapToolCall("Bash", { command: "ls -la" }, { kind: "ok" }, ctx), [])
  assert.deepEqual(mapToolCall("Read", { file_path: "/work/proj/a.ts" }, { kind: "ok" }, ctx), [])
})

test("detects common check commands", () => {
  const cases: Array<[string, string[]]> = [
    ["npm test", ["tests"]],
    ["npm run test -- --watch=false", ["tests"]],
    ["pnpm vitest run", ["tests"]],
    ["npx jest src", ["tests"]],
    ["node --test tests/a.spec.ts", ["tests"]],
    ["pytest -q", ["tests"]],
    ["python -m pytest tests/", ["tests"]],
    ["CI=1 go test ./...", ["tests"]],
    ["cargo test", ["tests"]],
    ["npm run lint", ["lint"]],
    ["npx eslint .", ["lint"]],
    ["ruff check .", ["lint"]],
    ["npm run typecheck", ["types"]],
    ["npx tsc --noEmit", ["types"]],
    ["tsc -p tsconfig.json", ["types"]],
    ["mypy src", ["types"]],
    ["npm run build", ["build"]],
    ["tsc -b", ["build"]],
    ["cargo build --release", ["build"]],
    ["npm install", []],
    ["git status", []],
    ["echo 'npm test'", []],
  ]
  for (const [command, kinds] of cases) assert.deepEqual(detectChecks(command), kinds, command)
})

test("only credits checks whose success the exit status proves", () => {
  // && : all parts must pass for success.
  assert.deepEqual(detectChecks("npm run lint && npm test"), ["lint", "tests"])
  assert.deepEqual(detectChecks("cd app && npm test"), ["tests"])
  // ; and || : status is the last part's.
  assert.deepEqual(detectChecks("npm test; npm run lint"), ["lint"])
  assert.deepEqual(detectChecks("npm test || true"), [])
  // pipe: status is the last stage's, so nothing is proven.
  assert.deepEqual(detectChecks("npm test | tail -20"), [])
  assert.deepEqual(detectChecks("npm test 2>&1 | tail -20"), [])
  // redirections are not separators.
  assert.deepEqual(detectChecks("npm test 2>&1"), ["tests"])
  assert.deepEqual(detectChecks("npm test > out.txt 2>&1"), ["tests"])
  // quoted operators are not operators.
  assert.deepEqual(detectChecks(`pytest -k "a or b" && echo "x | y"`), ["tests"])
})
