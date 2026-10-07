import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { DEFAULT_EVAL, defaultConfigText, parseEvalConfig } from "../hooks/eval/config.ts"
import { joinPath, parseCmdShim } from "../hooks/eval/host.ts"
import { initFiles } from "../hooks/eval/init.ts"
import { renderExperiment, summarize, type TrialResult } from "../hooks/eval/report.ts"
import { claudeArgv, parseClaudeOutput, prepare, runExperiment, schedule } from "../hooks/eval/runner.ts"
import { bootstrapDiff, mean, median, percentDiff, rng } from "../hooks/eval/statistics.ts"
import { parseTask, parseYaml, splitCommand, type Task } from "../hooks/eval/tasks.ts"
import { dirtyPaths } from "../hooks/eval/worktree.ts"
import { nodeHost } from "../scripts/eval.ts"

// ── statistics ──────────────────────────────────────────────────────────────

test("mean, median, percent difference", () => {
  assert.equal(mean([]), undefined)
  assert.equal(mean([1, 2, 3]), 2)
  assert.equal(median([3, 1, 2, 10]), 2.5)
  assert.equal(percentDiff(200, 150), -25)
  assert.equal(percentDiff(0, 5), undefined)
  assert.equal(percentDiff(undefined, 5), undefined)
})

test("bootstrap is deterministic with a seed and resamples tasks, not trials", () => {
  const tasks = [
    { baseline: [1, 1, 1], variant: [1, 1, 0] },
    { baseline: [0, 1, 0], variant: [1, 1, 1] },
    { baseline: [1, 0, 1], variant: [1, 0, 1] },
  ]
  const a = bootstrapDiff(tasks, 2000, 7)!
  assert.deepEqual(bootstrapDiff(tasks, 2000, 7), a)
  assert.ok(a[0] <= a[1])
  // One task with a hundred trials weighs as much as one with one trial.
  const heavy = bootstrapDiff([{ baseline: Array(100).fill(1), variant: Array(100).fill(0) }, { baseline: [0], variant: [1] }], 4000, 1)!
  assert.ok(heavy[0] < 0 && heavy[1] > 0, JSON.stringify(heavy))
  assert.equal(bootstrapDiff([{ baseline: [], variant: [1] }], 100, 1), undefined)
  const r = rng(3)
  assert.ok([r(), r(), r()].every((x) => x >= 0 && x < 1))
})

// ── tasks ───────────────────────────────────────────────────────────────────

test("task YAML: the spec's examples parse", () => {
  const parsed = parseTask(
    'id: fix-invalid-user-validation\n\nprompt: |\n  The user creation endpoint accepts invalid email addresses.\n  Fix the issue without changing unrelated behavior.\n\ngrader:\n  command: "pytest tests/test_users.py -q"\n\ntimeout_seconds: 600\n',
    "a.yaml",
  )
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.value, {
    id: "fix-invalid-user-validation",
    prompt: "The user creation endpoint accepts invalid email addresses.\nFix the issue without changing unrelated behavior.",
    graderArgv: ["pytest", "tests/test_users.py", "-q"],
    timeoutSeconds: 600,
    file: "a.yaml",
  })
  const argv = parseTask("id: x\nprompt: do it # comment\ngrader:\n  argv:\n    - node\n    - --test\n    - 'a b.ts'\n", "b.yaml")
  assert.ok(argv.ok)
  assert.deepEqual(argv.value.graderArgv, ["node", "--test", "a b.ts"])
  assert.equal(argv.value.timeoutSeconds, 600)
  assert.deepEqual(parseYaml("a: [x, 'y']\nb: >\n  folded\n  text\n"), { a: ["x", "y"], b: "folded text" })
})

test("task validation and shell-free grader commands", () => {
  assert.equal(parseTask("prompt: x\ngrader:\n  command: t", "a.yaml").ok, false)
  assert.equal(parseTask("id: x\ngrader:\n  command: t", "a.yaml").ok, false)
  assert.equal(parseTask("id: x\nprompt: y", "a.yaml").ok, false)
  assert.deepEqual(splitCommand(`node --test "a b.ts" 'c'`), { ok: true, value: ["node", "--test", "a b.ts", "c"] })
  for (const bad of ["npm test | tail", "a && b", "x > out", "echo $HOME", "a; b"]) assert.equal(splitCommand(bad).ok, false, bad)
  const json = parseTask(JSON.stringify({ id: "j", prompt: "p", grader: { command: "npm test" } }), "j.json")
  assert.ok(json.ok)
})

// ── runner pieces ───────────────────────────────────────────────────────────

const task = (id: string): Task => ({ id, prompt: "p", graderArgv: ["true"], timeoutSeconds: 60, file: `${id}.yaml` })

test("schedule alternates which arm goes first, every task in both arms", () => {
  const s = schedule([task("a"), task("b"), task("c")], 2)
  assert.equal(s.length, 12)
  const firsts = s.filter((_, i) => i % 2 === 0).map((x) => `${x.task.id}${x.trial}:${x.arm}`)
  assert.deepEqual(firsts, ["a1:variant", "a2:baseline", "b1:baseline", "b2:variant", "c1:variant", "c2:baseline"])
  for (const id of ["a", "b", "c"]) assert.equal(s.filter((x) => x.task.id === id && x.arm === "baseline").length, 2)
})

test("claude output: usage summed with cache, missing figures undefined", () => {
  const out = parseClaudeOutput(
    JSON.stringify({ is_error: false, total_cost_usd: 0.0294, usage: { input_tokens: 10, cache_creation_input_tokens: 13803, cache_read_input_tokens: 16553, output_tokens: 39 } }),
  )
  assert.deepEqual(out, { inputTokens: 30366, outputTokens: 39, costUsd: 0.0294, isError: false })
  assert.deepEqual(parseClaudeOutput("not json"), {})
  assert.deepEqual(parseClaudeOutput(JSON.stringify({ result: "ok" })), {})
  assert.deepEqual(claudeArgv(["claude"], { ...DEFAULT_EVAL, model: "haiku" }, "do"), ["claude", "-p", "do", "--output-format", "json", "--model", "haiku", "--permission-mode", "acceptEdits"])
})

test("windows npm shim → the executable it starts", () => {
  const shim = '@ECHO off\nGOTO start\n:start\nSETLOCAL\nCALL :find_dp0\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\n'
  assert.equal(parseCmdShim(shim, "C:\\nvm4w\\nodejs\\claude.cmd"), "C:/nvm4w/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe")
  assert.equal(parseCmdShim("@echo off\nnode x.js", "C:/a/claude.cmd"), undefined)
})

test("dirty check ignores .context-lab/ only", () => {
  const z = " M src/a.ts\0?? .context-lab/variants/x/manifest.json\0R  new.ts\0old.ts\0?? sub/.context-lab/x\0"
  assert.deepEqual(dirtyPaths(z, ".context-lab/"), ["src/a.ts", "new.ts", "sub/.context-lab/x"])
  assert.deepEqual(dirtyPaths(z, "sub/.context-lab/"), ["src/a.ts", ".context-lab/variants/x/manifest.json", "new.ts"])
})

test("config: defaults, bounds, and what init writes", () => {
  assert.deepEqual(parseEvalConfig(undefined), DEFAULT_EVAL)
  const c = parseEvalConfig(JSON.stringify({ trialsPerTask: 5, maxAcceptedQualityRegressionPp: -1, model: "haiku", claude: ["node", "x.js"] }))
  assert.equal(c.trialsPerTask, 5)
  assert.equal(c.maxAcceptedQualityRegressionPp, 3)
  assert.equal(c.model, "haiku")
  assert.deepEqual(c.claude, ["node", "x.js"])
  const written = JSON.parse(defaultConfigText())
  assert.equal(written.trialsPerTask, 3)
  assert.equal(written.largeSectionEstimatedTokens, 1000)
  assert.deepEqual(initFiles().map((f) => f.path), [
    ".context-lab/config.json",
    ".context-lab/.gitignore",
    ".context-lab/evals/tasks/example.yaml.example",
    ".context-lab/evals/graders/README.md",
    ".context-lab/variants/README.md",
  ])
})

// ── verdicts ────────────────────────────────────────────────────────────────

function trials(spec: { task: string; base: number[]; variant: number[] }[], ctx: [number, number], input: [number, number]): TrialResult[] {
  const out: TrialResult[] = []
  for (const t of spec) {
    for (const [arm, outcomes] of [["baseline", t.base], ["variant", t.variant]] as const) {
      outcomes.forEach((o, k) =>
        out.push({
          taskId: t.task,
          variant: arm === "baseline" ? "baseline" : "compact",
          arm,
          trial: k + 1,
          success: o === 1,
          durationMs: 1000,
          inputTokens: arm === "baseline" ? input[0] : input[1],
          outputTokens: 100,
          costUsd: 0.01,
          contextTokens: arm === "baseline" ? ctx[0] : ctx[1],
          graderExitCode: o === 1 ? 0 : 1,
          claudeExitCode: 0,
          claudeVersion: "2.1.291",
          gitSha: "abc",
          startedAt: 0,
        }),
      )
    }
  }
  return out
}

const meta = { runId: "r", variant: "compact", gitSha: "abc", claudeVersion: "2.1.291", model: "haiku", trialsPerTask: 3 }

test("verdict: PROMISING with few tasks, SUPPORTED with enough, never 'smarter'", () => {
  const few = summarize(trials([{ task: "a", base: [1, 1, 1], variant: [1, 1, 1] }, { task: "b", base: [1, 0, 1], variant: [1, 0, 1] }], [8300, 4900], [43100, 37200]), meta, DEFAULT_EVAL)
  assert.equal(few.verdict, "PROMISING")
  assert.ok(Math.abs(few.contextDiffPercent! + 40.96) < 0.1)
  assert.match(few.interpretation.join("\n"), /✓ Ahorra: las instrucciones fijas bajan un 41%/)
  assert.match(few.interpretation.join("\n"), /✓ Con estos datos no se ve que Claude empeore/)
  assert.match(few.interpretation.join("\n"), /haz al menos 20 tareas reales/)
  const text = renderExperiment(few)
  assert.match(text, /RESULTADO: PROMETEDOR/)
  assert.match(text, /Tareas resueltas\s+83% \(5 de 6\)\s+83% \(5 de 6\)/)
  assert.doesNotMatch(text, /smarter|score/i)

  const many = Array.from({ length: 24 }, (_, i) => ({ task: `t${i}`, base: [1, 1, 1], variant: [1, 1, 1] }))
  assert.equal(summarize(trials(many, [8300, 4900], [43100, 37200]), meta, DEFAULT_EVAL).verdict, "SUPPORTED")
})

test("verdict: NOT PROMISING on regression or no savings; INCONCLUSIVE without pairs", () => {
  const worse = summarize(trials([{ task: "a", base: [1, 1, 1], variant: [0, 0, 0] }], [8000, 4000], [1, 1]), meta, DEFAULT_EVAL)
  assert.equal(worse.verdict, "NOT PROMISING")
  assert.match(worse.interpretation.join("\n"), /✗ Claude acierta MENOS tareas con el cambio/)
  assert.match(worse.interpretation.join("\n"), /no hagas este cambio/)
  const same = summarize(trials([{ task: "a", base: [1], variant: [1] }], [8000, 7900], [1, 1]), meta, DEFAULT_EVAL)
  assert.equal(same.verdict, "NOT PROMISING")
  assert.match(same.interpretation.join("\n"), /✗ Apenas ahorra/)
  const none = summarize(trials([{ task: "a", base: [1], variant: [] }], [8000, 4000], [1, 1]), meta, DEFAULT_EVAL)
  assert.equal(none.verdict, "INCONCLUSIVE")
})

test("missing usage stays undefined: no derived figure from partial data", () => {
  const ts = trials([{ task: "a", base: [1, 1], variant: [1, 1] }], [100, 50], [10, 10])
  delete ts[0]!.inputTokens
  const s = summarize(ts, meta, DEFAULT_EVAL)
  assert.equal(s.baseline.successesPerMillionInput, undefined)
  assert.equal(s.candidate.successesPerMillionInput, 100_000)
})

// ── end to end: real git, real worktrees, a fake Claude Code ───────────────

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const FAKE_CLAUDE = `
const fs = require("node:fs")
if (process.argv.includes("--version")) { console.log("9.9.9 (Fake Code)"); process.exit(0) }
// Evidence the trial saw what it should: no eval definitions, and which instructions.
if (fs.existsSync(".context-lab")) fs.writeFileSync("LEAK", "saw .context-lab")
const guided = fs.existsSync("CLAUDE.md")
fs.writeFileSync("answer.txt", guided ? "42" : "41")
console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.01, usage: { input_tokens: guided ? 150 : 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } }))
`

const GRADER = `
const fs = require("node:fs")
const ok = !fs.existsSync("LEAK") && fs.existsSync("answer.txt") && fs.readFileSync("answer.txt", "utf8") === "42"
process.exit(ok ? 0 : 1)
`

function project(): { root: string; worktrees: string; git: (...a: string[]) => string } {
  const base = mkdtempSync(join(tmpdir(), "cl-eval-"))
  dirs.push(base)
  const root = join(base, "proj")
  const worktrees = join(base, "wt")
  mkdirSync(root)
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: root, encoding: "utf8" })
  git("init", "-q", "-b", "main")
  const write = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  write("CLAUDE.md", "# Project\nThe answer is 42. " + "Context. ".repeat(100))
  write("src/app.cjs", "module.exports = 1\n")
  write("fake-claude.cjs", FAKE_CLAUDE)
  for (const f of initFiles()) write(f.path, f.text)
  const config = { ...JSON.parse(defaultConfigText()), trialsPerTask: 1, claude: ["node", join(root, "fake-claude.cjs").replace(/\\/g, "/")], claudeArgs: [], worktreeDir: worktrees.replace(/\\/g, "/") }
  write(".context-lab/config.json", JSON.stringify(config))
  write(".context-lab/evals/graders/check.cjs", GRADER)
  for (const id of ["one", "two"]) {
    write(`.context-lab/evals/tasks/${id}.yaml`, `id: ${id}\nprompt: Write the answer.\ngrader:\n  command: "node .context-lab/evals/graders/check.cjs"\ntimeout_seconds: 60\n`)
  }
  write(".context-lab/variants/no-claude-md/manifest.json", JSON.stringify({ name: "no-claude-md", description: "Without CLAUDE.md", delete: ["CLAUDE.md"] }))
  git("add", "-A")
  git("commit", "-q", "-m", "init")
  return { root: root.replace(/\\/g, "/"), worktrees, git }
}

test("e2e: a dirty working tree refuses the eval", async () => {
  const p = project()
  writeFileSync(join(p.root, "src/app.cjs"), "module.exports = 2\n")
  const r = await prepare(nodeHost, p.root, "no-claude-md")
  assert.ok("error" in r)
  assert.match(r.error, /Experimento cancelado: hay cambios sin guardar en git\.[\s\S]*Haz commit \(o git stash\)[\s\S]*src\/app\.cjs/)
})

test("e2e: untracked eval definitions under .context-lab/ do not count as dirty", async () => {
  const p = project()
  writeFileSync(join(p.root, ".context-lab/variants/README.md"), "edited")
  const r = await prepare(nodeHost, p.root, "no-claude-md")
  assert.ok(!("error" in r), "error" in r ? r.error : "")
})

test("e2e: baseline vs variant from one SHA, isolated worktrees, hidden graders, results on disk", async () => {
  const p = project()
  const head = p.git("rev-parse", "HEAD").trim()
  const prepared = await prepare(nodeHost, p.root, "no-claude-md")
  assert.ok(!("error" in prepared), "error" in prepared ? prepared.error : "")
  const progress: string[] = []
  const out = await runExperiment(nodeHost, p.root, prepared, { onProgress: (x) => void (x.current && progress.push(x.current)) })

  assert.equal(out.results.length, 4)
  assert.ok(out.results.every((r) => r.gitSha === head), "every trial starts from the same SHA")
  assert.ok(out.results.every((r) => r.claudeVersion === "9.9.9"))
  const by = (arm: string) => out.results.filter((r) => r.arm === arm)
  assert.deepEqual(by("baseline").map((r) => r.success), [true, true], JSON.stringify(out.results))
  assert.deepEqual(by("variant").map((r) => r.success), [false, false])
  assert.ok(by("baseline").every((r) => r.inputTokens === 150 && (r.contextTokens ?? 0) > 200))
  assert.ok(by("variant").every((r) => r.inputTokens === 100 && r.contextTokens === 0))
  assert.deepEqual(progress, ["one · no-claude-md · trial 1", "one · baseline · trial 1", "two · baseline · trial 1", "two · no-claude-md · trial 1"])

  assert.equal(out.summary.verdict, "NOT PROMISING")
  assert.equal(out.summary.qualityDiffPp, -100)
  assert.equal(out.summary.contextDiffPercent, -100)

  // The main checkout is untouched, the worktrees are gone, the results are written.
  assert.equal(p.git("status", "--porcelain").trim(), "")
  assert.ok(existsSync(join(p.root, "CLAUDE.md")))
  assert.ok(!existsSync(join(p.root, "answer.txt")))
  assert.deepEqual(p.git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1)
  const leftovers = existsSync(p.worktrees) ? readdirSync(join(p.worktrees, out.runId)).length : 0
  assert.equal(leftovers, 0)
  const saved = JSON.parse(readFileSync(join(out.resultsDir, "trials.json"), "utf8"))
  assert.equal(saved.length, 4)
  assert.ok(existsSync(joinPath(out.resultsDir, "summary.json")))
  assert.match(readFileSync(join(out.resultsDir, "report.md"), "utf8"), /EXPERIMENTO: tus instrucciones actuales contra "no-claude-md"/)
})

test("e2e: stop between trials keeps what ran", async () => {
  const p = project()
  const prepared = await prepare(nodeHost, p.root, "no-claude-md")
  assert.ok(!("error" in prepared))
  let n = 0
  const out = await runExperiment(nodeHost, p.root, prepared, { shouldStop: () => n++ >= 2 })
  assert.equal(out.stopped, true)
  assert.equal(out.results.length, 2)
  assert.match(readFileSync(join(out.resultsDir, "report.md"), "utf8"), /Detenido antes de terminar todas las ejecuciones/)
})
