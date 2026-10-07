import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { applyToProject, planApply, renderApplyPlan } from "../hooks/eval/apply.ts"
import { defaultConfigText, parseEvalConfig } from "../hooks/eval/config.ts"
import { initFiles } from "../hooks/eval/init.ts"
import { candidateFrom, isTestPath, mineTasks, parseLog, parseNumstat, taskYaml, testArgv } from "../hooks/eval/mine.ts"
import { optimize, renderOptimize } from "../hooks/eval/optimize.ts"
import { propose, renderProposal, scopeOf, slug } from "../hooks/eval/propose.ts"
import { renderExperiment } from "../hooks/eval/report.ts"
import { loadTasks, prepare, runExperiment } from "../hooks/eval/runner.ts"
import { parseTask } from "../hooks/eval/tasks.ts"
import { loadVariant } from "../hooks/eval/variant.ts"
import { gitInfo, isInstructionPath, isPathScoped, projectInstructionTokens } from "../hooks/eval/worktree.ts"
import { splitSections } from "../hooks/analysis/sections.ts"
import { nodeHost } from "../scripts/eval.ts"

// ── pure pieces ─────────────────────────────────────────────────────────────

test("git log and numstat parsing", () => {
  const sha = "a".repeat(40)
  const log = `${sha}\x1f${"b".repeat(40)}\x1fAdd multiply\x1fBody line\x1e\n${"c".repeat(40)}\x1f\x1fRoot\x1f\x1e`
  const commits = parseLog(log)
  assert.equal(commits.length, 2)
  assert.deepEqual(commits[0], { sha, parents: ["b".repeat(40)], subject: "Add multiply", body: "Body line" })
  assert.deepEqual(commits[1]!.parents, [])
  const changes = parseNumstat("3\t1\tsrc/math.cjs\n10\t0\ttests/m.test.cjs\n-\t-\tlogo.png", "M\tsrc/math.cjs\nA\ttests/m.test.cjs\nA\tlogo.png")
  assert.deepEqual(changes.map((c) => `${c.status}:${c.path}:${c.added + c.deleted}`), ["M:src/math.cjs:4", "A:tests/m.test.cjs:10", "A:logo.png:0"])
})

test("which commits are tasks", () => {
  const c = { sha: "a".repeat(40), parents: ["b".repeat(40)], subject: "Add multiply to the math module", body: "" }
  const ch = (path: string, n = 5) => ({ path, added: n, deleted: 0, status: "M" as const })
  assert.ok(!("skip" in candidateFrom(c, [ch("src/math.ts"), ch("tests/math.test.ts")])))
  assert.deepEqual(candidateFrom(c, [ch("tests/math.test.ts")]), { skip: "only tests changed" })
  assert.deepEqual(candidateFrom(c, [ch("src/math.ts")]), { skip: "no tests changed" })
  assert.deepEqual(candidateFrom({ ...c, subject: "wip" }, [ch("src/a.ts"), ch("tests/a.test.ts")]), { skip: "message too short to describe a task" })
  assert.deepEqual(candidateFrom({ ...c, parents: [] }, [ch("src/a.ts"), ch("tests/a.test.ts")]), { skip: "merge or root commit" })
  assert.deepEqual(candidateFrom(c, [ch("src/a.ts", 500), ch("tests/a.test.ts", 200)]), { skip: "too large" })
  for (const t of ["tests/a.py", "src/a.test.ts", "pkg/test_x.py", "x/__tests__/y.js", "a_test.go"]) assert.ok(isTestPath(t), t)
  for (const t of ["src/testing.ts", "src/contest.py"]) assert.ok(!isTestPath(t), t)
})

test("test runners: configured, pytest, vitest, jest, node --test", () => {
  const none = { vitest: false, jest: false }
  assert.deepEqual(testArgv(["tests/a.py"], { ...none, python: "/p/.venv/bin/python" }), ["/p/.venv/bin/python", "-m", "pytest", "-q", "tests/a.py"])
  assert.deepEqual(testArgv(["a.test.ts"], { ...none, vitest: true }), ["node", "node_modules/vitest/vitest.mjs", "run", "a.test.ts"])
  assert.deepEqual(testArgv(["a.test.js"], { ...none, jest: true }), ["node", "node_modules/jest/bin/jest.js", "a.test.js"])
  assert.deepEqual(testArgv(["t/a.test.cjs"], none), ["node", "--test", "t/a.test.cjs"])
  assert.equal(testArgv(["a_test.go"], none), undefined)
  assert.deepEqual(testArgv(["x.py"], none, ["tox", "-e", "py", "--", "{files}"]), ["tox", "-e", "py", "--", "x.py"])
})

test("a mined task file round-trips through the task reader", () => {
  const c = { sha: "a".repeat(40), parents: ["b".repeat(40)], subject: 'Add "multiply"', body: "Multiplies two numbers.\n\nNo overflow checks." }
  const yaml = taskYaml({ commit: c, testFiles: ["tests/m u.test.cjs"], sourceFiles: ["src/m.cjs"], changedLines: 12 }, ["node", "--test", "tests/m u.test.cjs"])
  const parsed = parseTask(yaml, "hist-aaaaaaaa.yaml")
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error)
  assert.equal(parsed.value.id, "hist-aaaaaaaa")
  assert.equal(parsed.value.baseSha, "b".repeat(40))
  assert.equal(parsed.value.graderFrom, "a".repeat(40))
  assert.deepEqual(parsed.value.graderFiles, ["tests/m u.test.cjs"])
  assert.deepEqual(parsed.value.graderArgv, ["node", "--test", "tests/m u.test.cjs"])
  assert.match(parsed.value.prompt, /Add "multiply"\n\nMultiplies two numbers\.\n\nNo overflow checks\./)
})

test("instruction paths, path-scoped rules, scopes, slugs", () => {
  assert.ok(isInstructionPath("CLAUDE.md") && isInstructionPath("src/api/CLAUDE.md") && isInstructionPath(".claude/rules/a.md"))
  assert.ok(!isInstructionPath(".context-lab/variants/x/files/CLAUDE.md") && !isInstructionPath("docs/a.md"))
  assert.ok(isPathScoped('---\npaths:\n  - "src/api/**"\n---\n# x'))
  assert.ok(!isPathScoped("# x\npaths: no frontmatter"))
  const [api] = splitSections({ nodeId: "n", file: "f", text: "## API\nHandlers in `src/api/handlers.ts` use `src/api/schema.ts`." })
  assert.equal(scopeOf(api!), "src/api")
  const [broad] = splitSections({ nodeId: "n", file: "f", text: "## Code\nSee `src/a.ts` and `src/b.ts`." })
  assert.equal(scopeOf(broad!), undefined)
  assert.equal(slug("Reglas de la API ñ/Á"), "reglas-de-la-api-n-a")
})

// ── end to end with real git ────────────────────────────────────────────────

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** Implements whatever the prompt asks only when CLAUDE.md says "multiply is a*b" (guidance helps). */
const FAKE_CLAUDE = `
const fs = require("node:fs")
if (process.argv.includes("--version")) { console.log("9.9.9 (Fake Code)"); process.exit(0) }
const prompt = process.argv[process.argv.indexOf("-p") + 1] || ""
const guided = fs.existsSync("CLAUDE.md") && fs.readFileSync("CLAUDE.md", "utf8").includes("multiply is a*b")
if (/multiply/i.test(prompt)) {
  const src = fs.readFileSync("src/math.cjs", "utf8")
  fs.writeFileSync("src/math.cjs", src + (guided ? "\\nmodule.exports.multiply = (a, b) => a * b\\n" : "\\nmodule.exports.multiply = (a, b) => a + b\\n"))
}
console.log(JSON.stringify({ is_error: false, total_cost_usd: guided ? 0.02 : 0.01, usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } }))
`

function history() {
  const base = mkdtempSync(join(tmpdir(), "cl-mine-"))
  dirs.push(base)
  const root = join(base, "proj")
  mkdirSync(root)
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: root, encoding: "utf8" })
  const write = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  const commit = (msg: string) => {
    git("add", "-A")
    git("commit", "-q", "-m", msg)
    return git("rev-parse", "HEAD").trim()
  }
  git("init", "-q", "-b", "main")
  write(".gitignore", "node_modules/\n")
  // A dependency only reachable through the linked node_modules.
  write("node_modules/dep/index.js", "module.exports = 'dep-ok'\n")
  write("src/math.cjs", "module.exports.add = (a, b) => a + b\n")
  write("tests/add.test.cjs", "const t=require('node:test');const a=require('node:assert');const m=require('../src/math.cjs');t.test('add',()=>a.equal(m.add(2,3),5))\n")
  commit("Initial math module with add")
  write("src/math.cjs", "module.exports.add = (a, b) => a + b\nmodule.exports.multiply = (a, b) => a * b\n")
  write(
    "tests/multiply.test.cjs",
    "const t=require('node:test');const a=require('node:assert');const m=require('../src/math.cjs');t.test('mul',()=>{a.equal(require('dep'),'dep-ok');a.equal(m.multiply(3,4),12)})\n",
  )
  const multiply = commit("Add multiply to the math module")
  write("tests/add.test.cjs", "const t=require('node:test');const a=require('node:assert');const m=require('../src/math.cjs');t.test('add',()=>a.equal(m.add(1,1),2))\n")
  commit("Change the add test values only")
  write("README.md", "# docs\n")
  commit("Write the README documentation")
  write("src/math.cjs", "module.exports.add = (a, b) => a + b\nmodule.exports.multiply = (a, b) => a * b\n// tidy\n")
  write("tests/add2.test.cjs", "const t=require('node:test');const a=require('node:assert');const m=require('../src/math.cjs');t.test('add2',()=>a.equal(m.add(2,2),4))\n")
  commit("Tidy math and cover add twice")
  // Today's instructions arrive only at HEAD: trials must still get them.
  write("CLAUDE.md", "# Project\nRemember: multiply is a*b.\n")
  write("fake-claude.cjs", FAKE_CLAUDE)
  for (const f of initFiles()) write(f.path, f.text)
  const config = { ...JSON.parse(defaultConfigText()), trialsPerTask: 1, claude: ["node", join(root, "fake-claude.cjs").replace(/\\/g, "/")], claudeArgs: [], worktreeDir: join(base, "wt").replace(/\\/g, "/") }
  write(".context-lab/config.json", JSON.stringify(config))
  write(".context-lab/variants/no-claude-md/manifest.json", JSON.stringify({ name: "no-claude-md", delete: ["CLAUDE.md"] }))
  commit("Add project instructions")
  return { root: root.replace(/\\/g, "/"), base, git, multiply }
}

test("e2e: mining keeps only calibrated tasks, for the right reasons", async () => {
  const h = history()
  const info = await gitInfo(nodeHost, h.root)
  assert.ok(!("error" in info))
  const config = parseEvalConfig(readFileSync(join(h.root, ".context-lab/config.json"), "utf8"))
  const o = await mineTasks(nodeHost, h.root, info, config)
  assert.deepEqual(o.kept.map((k) => k.subject), ["Add multiply to the math module"], JSON.stringify(o.skipped))
  assert.equal(o.skipped["only tests changed"], 1)
  assert.equal(o.skipped["no tests changed"], 2, JSON.stringify(o.skipped)) // README + instructions commits
  assert.equal(o.skipped["tests already pass before the change"], 1)
  assert.equal(o.skipped["merge or root commit"], 1)
  const { tasks } = await loadTasks(nodeHost, h.root)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.graderFrom, h.multiply)
  // Calibration left nothing behind: one worktree (the main one), node_modules intact.
  assert.equal(h.git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1)
  assert.ok(existsSync(join(h.root, "node_modules/dep/index.js")))
  // Mining again finds the same task without re-checking it.
  const again = await mineTasks(nodeHost, h.root, info, config)
  assert.equal(again.kept.length, 1)
  assert.equal(again.candidates, 1) // only "tidy" is re-checked; multiply's file exists
})

test("e2e: a mined task starts at its parent commit with TODAY's instructions, and links node_modules", async () => {
  const h = history()
  const info = await gitInfo(nodeHost, h.root)
  assert.ok(!("error" in info))
  await mineTasks(nodeHost, h.root, info, parseEvalConfig(readFileSync(join(h.root, ".context-lab/config.json"), "utf8")))
  const p = await prepare(nodeHost, h.root, "no-claude-md")
  assert.ok(!("error" in p), "error" in p ? p.error : "")
  const out = await runExperiment(nodeHost, h.root, p)
  const parent = h.git("rev-parse", `${h.multiply}^`).trim()
  assert.ok(out.results.every((r) => r.gitSha === parent), "starts at the commit before the change")
  const base = out.results.find((r) => r.arm === "baseline")!
  const variant = out.results.find((r) => r.arm === "variant")!
  assert.equal(base.success, true, JSON.stringify(base)) // got CLAUDE.md from HEAD, and dep through the link
  assert.equal(variant.success, false) // without the instructions, the fake agent gets multiply wrong
  assert.ok((base.contextTokens ?? 0) > 0 && variant.contextTokens === 0, `${base.contextTokens} / ${variant.contextTokens}`)
  assert.ok(existsSync(join(h.root, "node_modules/dep/index.js")), "the linked folder survives worktree removal")
  assert.equal(h.git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1)
  assert.match(renderExperiment(out.summary), /Sobrecoste medido: \$1\.00 por cada 100 tareas|Ahorro medido: \$1\.00 por cada 100 tareas/)
})

test("e2e: proposal removes duplicates and listings, moves a one-folder section to a scoped rule", async () => {
  const base = mkdtempSync(join(tmpdir(), "cl-prop-"))
  dirs.push(base)
  const root = join(base, "p").replace(/\\/g, "/")
  mkdirSync(root)
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: root, encoding: "utf8" })
  const write = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  for (const d of ["src/api", "src/ui", "scripts", "docs"]) write(`${d}/x.ts`, "x\n")
  const testing = "## Testing\n\nAlways run the whole test suite with npm test before you open any pull request.\n"
  const api =
    "## API rules\n\n" +
    "Every handler in `src/api/handlers.ts` validates its input against `src/api/schema.ts` before it touches the database. " +
    "Errors use the shared error envelope and never leak stack traces to the client. ".repeat(8) +
    "\n"
  write(
    "CLAUDE.md",
    "# Proyecto\n\nInstrucciones para el agente de la empresa.\n\n## Estructura\n\n```\n.\n├── src/\n│   ├── api/\n│   └── ui/\n├── scripts/\n└── docs/\n```\n\n" + testing + "\n" + api,
  )
  write(".claude/rules/testing.md", testing)
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "-m", "init")
  const info = await gitInfo(nodeHost, root)
  assert.ok(!("error" in info))
  const p = await propose(nodeHost, root, info, parseEvalConfig(defaultConfigText()))
  assert.ok(p)
  assert.deepEqual(p.changes.map((c) => c.kind).sort(), ["duplicate", "listing", "path-scoped"])
  assert.ok(p.after < p.before)
  const claudeMd = readFileSync(join(p.dir, "files/CLAUDE.md"), "utf8")
  assert.doesNotMatch(claudeMd, /├── api/)
  assert.match(claudeMd, /Listing removed: Claude can look at the folder structure/) // mostly English text: the note follows it
  assert.doesNotMatch(claudeMd, /API rules/)
  assert.match(claudeMd, /## Testing/) // the first copy stays
  const rules = readdirSync(join(p.dir, "files/.claude/rules"))
  const scoped = rules.find((r) => r.startsWith("src-api"))!
  const rule = readFileSync(join(p.dir, "files/.claude/rules", scoped), "utf8")
  assert.ok(isPathScoped(rule))
  assert.match(rule, /paths:\n {2}- "src\/api\/\*\*"/)
  assert.match(rule, /## API rules/)
  // CLAUDE.md's copy was the first: the rule held nothing else, so the proposal deletes it.
  assert.ok(!existsSync(join(p.dir, "files/.claude/rules/testing.md")))
  assert.deepEqual(p.deleted, [".claude/rules/testing.md"])
  assert.deepEqual(JSON.parse(readFileSync(join(p.dir, "manifest.json"), "utf8")).delete, [".claude/rules/testing.md"])
  assert.match(renderProposal(p), /PROPUESTA: auto-/)
  // The yardstick: path-scoped rules do not count as always-on.
  assert.ok((await projectInstructionTokens(nodeHost, join(p.dir, "files"))) < (await projectInstructionTokens(nodeHost, root)))

  // Applying: refused over uncommitted edits, done on confirmation otherwise.
  const v = await loadVariant(nodeHost, root, p.name)
  assert.ok(!("error" in v))
  writeFileSync(join(root, "CLAUDE.md"), "edited by hand\n")
  const blocked = await planApply(nodeHost, root, info, v)
  assert.deepEqual(blocked.blocked, ["CLAUDE.md"])
  assert.match(renderApplyPlan(blocked), /No se puede aplicar: tienes cambios sin commit en CLAUDE\.md/)
  git("checkout", "--", "CLAUDE.md")
  const plan = await planApply(nodeHost, root, info, v)
  assert.deepEqual(plan.blocked, [])
  assert.match(renderApplyPlan(plan), /NO se ha probado/)
  const touched = await applyToProject(nodeHost, root, v)
  assert.ok(touched.includes("CLAUDE.md"))
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), claudeMd)
})

test("e2e: optimize runs the whole loop and says what to do next", async () => {
  const h = history()
  // Give the proposal something to remove: a duplicated section in CLAUDE.md and a rule.
  const dup = "## Testing\n\nAlways run the whole test suite with node --test before you open any pull request.\n"
  writeFileSync(join(h.root, "CLAUDE.md"), `# Project\nRemember: multiply is a*b.\n\n${dup}`)
  mkdirSync(join(h.root, ".claude/rules"), { recursive: true })
  writeFileSync(join(h.root, ".claude/rules/testing.md"), dup)
  h.git("add", "-A")
  h.git("commit", "-q", "-m", "Document testing twice")
  const steps: string[] = []
  const o = await optimize(nodeHost, h.root, { onStep: (s) => void steps.push(s.step) })
  assert.equal(o.stopped, undefined, o.stopped)
  assert.equal(o.mined?.kept.length, 1)
  assert.ok(o.proposal && o.run)
  assert.ok(steps.includes("mine") && steps.includes("propose") && steps.includes("eval"))
  // The proposal kept "multiply is a*b", so the fake agent still succeeds with it.
  assert.ok(o.run.results.every((r) => r.success), JSON.stringify(o.run.results))
  const text = renderOptimize(o)
  assert.match(text, /1\. Tareas de tu historial: 1/)
  assert.match(text, /2\. PROPUESTA: auto-/)
  assert.match(text, /3\. EXPERIMENTO/)
})
