import type { EvalConfig } from "./config.ts"
import { joinPath, type EvalHost } from "./host.ts"
import {
  addWorktree,
  linkDependencies,
  removeWorktree,
  unlinkAll,
  worktreeBase,
  writeGraderFiles,
  type GitInfo,
} from "./worktree.ts"

// Eval tasks from the repository's own history — no one has to write them.
//
// A commit that changed source code AND its tests is a real task with a real
// grader: start from its parent, ask for the change its message describes,
// then run the tests that commit wrote. A candidate is kept only if those
// tests FAIL on the parent and PASS on the commit (calibration), so every
// mined task can actually tell a good attempt from a bad one. No model calls.

export interface Commit {
  sha: string
  parents: string[]
  subject: string
  body: string
}

export interface FileChange {
  path: string
  added: number
  deleted: number
  status: "A" | "M" | "D" | "R" | "other"
}

export interface Candidate {
  commit: Commit
  testFiles: string[]
  sourceFiles: string[]
  changedLines: number
}

export interface MineLimits {
  maxFiles: number
  maxLines: number
  minSubject: number
}

export const DEFAULT_LIMITS: MineLimits = { maxFiles: 12, maxLines: 600, minSubject: 10 }

const REC = "\x1e"
const UNIT = "\x1f"

export function parseLog(out: string): Commit[] {
  return out
    .split(REC)
    .map((r) => r.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((r) => {
      const [sha = "", parents = "", subject = "", body = ""] = r.split(UNIT)
      return { sha: sha.trim(), parents: parents.trim().split(/\s+/).filter(Boolean), subject: subject.trim(), body: body.trim() }
    })
    .filter((c) => /^[0-9a-f]{40}$/.test(c.sha))
}

/** A commit's changed files: `git show --numstat` lines, each with its status from `--name-status`. */
export function parseNumstat(numstat: string, nameStatus: string): FileChange[] {
  const status = new Map<string, FileChange["status"]>()
  for (const line of nameStatus.split(/\r?\n/)) {
    const [s, ...paths] = line.split("\t")
    if (!s || paths.length === 0) continue
    const code = s[0] === "A" || s[0] === "M" || s[0] === "D" || s[0] === "R" ? s[0] : "other"
    status.set(paths[paths.length - 1]!, code)
  }
  const out: FileChange[] = []
  for (const line of numstat.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!m) continue
    const path = m[3]!.includes(" => ") ? m[3]!.replace(/\{[^}]* => ([^}]*)\}/, "$1").replace(/^.* => /, "") : m[3]!
    out.push({
      path,
      added: m[1] === "-" ? 0 : Number(m[1]),
      deleted: m[2] === "-" ? 0 : Number(m[2]),
      status: status.get(path) ?? "other",
    })
  }
  return out
}

export function isTestPath(p: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|specs?)\//i.test(p) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p) ||
    /(^|\/)test_[^/]+\.py$/i.test(p) ||
    /_test\.(py|go)$/i.test(p)
  )
}

function isSourcePath(p: string): boolean {
  if (isTestPath(p)) return false
  if (p.startsWith(".context-lab/") || p.startsWith(".github/") || p.startsWith("docs/")) return false
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|c|cc|cpp|h|hpp|vue|svelte)$/i.test(p)
}

/** Whether a commit looks like one coherent, gradable task. */
export function candidateFrom(commit: Commit, changes: readonly FileChange[], limits: MineLimits = DEFAULT_LIMITS): Candidate | { skip: string } {
  if (commit.parents.length !== 1) return { skip: "merge or root commit" }
  if (commit.subject.length < limits.minSubject) return { skip: "message too short to describe a task" }
  if (/^(merge|revert|wip|bump|chore\(deps\)|release)/i.test(commit.subject)) return { skip: "not a code task" }
  if (changes.length === 0 || changes.length > limits.maxFiles) return { skip: "too many or no files" }
  const changedLines = changes.reduce((n, c) => n + c.added + c.deleted, 0)
  if (changedLines > limits.maxLines) return { skip: "too large" }
  const testFiles = changes.filter((c) => isTestPath(c.path) && c.status !== "D").map((c) => c.path)
  const sourceFiles = changes.filter((c) => isSourcePath(c.path)).map((c) => c.path)
  if (testFiles.length === 0) return { skip: "no tests changed" }
  if (sourceFiles.length === 0) return { skip: "only tests changed" }
  return { commit, testFiles, sourceFiles, changedLines }
}

/**
 * How to run a commit's test files, without a shell: the configured command,
 * else detected from the files and the project (pytest, vitest, jest,
 * node --test). Undefined when the project's runner cannot be told.
 */
export function testArgv(files: readonly string[], project: ProjectFacts, configured?: readonly string[]): string[] | undefined {
  if (configured) return configured.flatMap((a) => (a === "{files}" ? [...files] : [a]))
  if (files.every((f) => f.endsWith(".py"))) return [project.python ?? "python", "-m", "pytest", "-q", ...files]
  if (files.every((f) => /\.[cm]?[jt]sx?$/.test(f))) {
    if (project.vitest) return ["node", "node_modules/vitest/vitest.mjs", "run", ...files]
    if (project.jest) return ["node", "node_modules/jest/bin/jest.js", ...files]
    if (files.every((f) => /\.([cm]?js|[cm]?ts)$/.test(f))) return ["node", "--test", ...files]
  }
  return undefined
}

export interface ProjectFacts {
  vitest: boolean
  jest: boolean
  /** The project's own virtualenv python, when it has one. */
  python?: string
}

export async function projectFacts(host: EvalHost, root: string): Promise<ProjectFacts> {
  const facts: ProjectFacts = { vitest: false, jest: false }
  const pkg = joinPath(root, "package.json")
  if (await host.exists(pkg)) {
    try {
      const j = JSON.parse(await host.read(pkg)) as Record<string, Record<string, string> | undefined>
      const deps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) }
      facts.vitest = "vitest" in deps
      facts.jest = "jest" in deps
    } catch {}
  }
  for (const v of [".venv", "venv"]) {
    for (const exe of host.isWindows ? ["Scripts/python.exe"] : ["bin/python"]) {
      const p = joinPath(root, v, exe)
      if (await host.exists(p)) {
        facts.python = p
        return facts
      }
    }
  }
  return facts
}

export const PROMPT_TEMPLATE = (c: Commit) =>
  [
    "Make the following change in this repository. It is a real change from this project's history, described by its commit message:",
    "",
    c.subject,
    ...(c.body ? ["", c.body] : []),
    "",
    "Implement it in the code. Tests for this change will be run afterwards; do not just edit tests.",
  ].join("\n")

/** A mined task as a task file (YAML the task reader parses back). */
export function taskYaml(c: Candidate, argv: readonly string[], timeoutSeconds = 600): string {
  const q = (s: string) => JSON.stringify(s)
  const prompt = PROMPT_TEMPLATE(c.commit)
    .split("\n")
    .map((l) => `  ${l}`.replace(/\s+$/, ""))
    .join("\n")
  return [
    `# Mined by Context Lab from commit ${c.commit.sha} (${c.changedLines} changed lines).`,
    `id: hist-${c.commit.sha.slice(0, 8)}`,
    `base_sha: ${c.commit.parents[0]}`,
    "prompt: |",
    prompt,
    "grader:",
    "  argv:",
    ...argv.map((a) => `    - ${q(a)}`),
    `  from_sha: ${c.commit.sha}`,
    "  files:",
    ...c.testFiles.map((f) => `    - ${q(f)}`),
    `timeout_seconds: ${timeoutSeconds}`,
    "",
  ].join("\n")
}

export interface MineProgress {
  scanned: number
  candidates: number
  kept: number
  current?: string
}

export interface MineOutcome {
  kept: { id: string; file: string; subject: string }[]
  scanned: number
  candidates: number
  /** Why candidates were dropped, counted. */
  skipped: Record<string, number>
}

const git = (host: EvalHost, cwd: string, args: string[], timeoutMs = 120_000) => host.run(["git", ...args], { cwd, timeoutMs })

/**
 * Reads up to `scan` commits, keeps up to `max` calibrated tasks and writes
 * them to .context-lab/evals/tasks/hist-<sha>.yaml (existing ones are kept).
 */
export async function mineTasks(
  host: EvalHost,
  root: string,
  info: GitInfo,
  config: EvalConfig,
  onProgress?: (p: MineProgress) => void | Promise<void>,
): Promise<MineOutcome> {
  const outcome: MineOutcome = { kept: [], scanned: 0, candidates: 0, skipped: {} }
  const skip = (why: string) => (outcome.skipped[why] = (outcome.skipped[why] ?? 0) + 1)
  if (info.sub) throw new Error("Las tareas del historial necesitan abrir Claude en la raíz del repositorio.")

  const log = await git(host, info.top, ["log", "--no-merges", `-n${config.mineScan}`, `--format=%H${UNIT}%P${UNIT}%s${UNIT}%b${REC}`, info.sha])
  if (log.exitCode !== 0) throw new Error(`git log failed: ${log.stderr.trim()}`)
  const commits = parseLog(log.stdout)
  const facts = await projectFacts(host, root)
  const tasksDir = joinPath(root, ".context-lab/evals/tasks")
  const base = joinPath(worktreeBase(info, config.worktreeDir), `mine-${await host.now()}`)

  for (const commit of commits) {
    if (outcome.kept.length >= config.mineMax) break
    outcome.scanned++
    const file = joinPath(tasksDir, `hist-${commit.sha.slice(0, 8)}.yaml`)
    if (await host.exists(file)) {
      outcome.kept.push({ id: `hist-${commit.sha.slice(0, 8)}`, file, subject: commit.subject })
      continue
    }
    const numstat = await git(host, info.top, ["show", "--numstat", "--format=", commit.sha])
    const names = await git(host, info.top, ["show", "--name-status", "--format=", commit.sha])
    const cand = candidateFrom(commit, parseNumstat(numstat.stdout, names.stdout))
    if ("skip" in cand) {
      skip(cand.skip)
      continue
    }
    const argv = testArgv(cand.testFiles, facts, config.testCommand)
    if (!argv) {
      skip("test runner not detected (set testCommand)")
      continue
    }
    outcome.candidates++
    await onProgress?.({ scanned: outcome.scanned, candidates: outcome.candidates, kept: outcome.kept.length, current: commit.subject })
    const verdict = await calibrate(host, root, info, config, cand, argv, joinPath(base, commit.sha.slice(0, 8)))
    if (verdict !== "ok") {
      skip(verdict)
      continue
    }
    await host.write(file, taskYaml(cand, argv))
    outcome.kept.push({ id: `hist-${commit.sha.slice(0, 8)}`, file, subject: commit.subject })
  }
  await onProgress?.({ scanned: outcome.scanned, candidates: outcome.candidates, kept: outcome.kept.length })
  return outcome
}

/**
 * The commit's tests must fail on its parent and pass on the commit itself:
 * otherwise the task cannot tell a good attempt from a bad one.
 */
async function calibrate(
  host: EvalHost,
  root: string,
  info: GitInfo,
  config: EvalConfig,
  cand: Candidate,
  argv: readonly string[],
  dir: string,
): Promise<"ok" | string> {
  let created = false
  let links: string[] = []
  const run = async () => {
    try {
      return (await host.run(argv, { cwd: dir, timeoutMs: config.graderTimeoutSeconds * 1000 })).exitCode
    } catch {
      return -1
    }
  }
  try {
    await addWorktree(host, info, dir, cand.commit.parents[0])
    created = true
    links = await linkDependencies(host, root, dir, config.links)
    await writeGraderFiles(host, info, dir, cand.testFiles, cand.commit.sha)
    const before = await run()
    if (before === 0) return "tests already pass before the change"
    if (before === -1) return "tests time out"
    const co = await git(host, dir, ["checkout", "-f", "-q", "--detach", cand.commit.sha])
    if (co.exitCode !== 0) return "checkout failed"
    const after = await run()
    if (after !== 0) return "tests do not pass on the commit itself"
    return "ok"
  } catch (err) {
    return `setup failed: ${err instanceof Error ? err.message.slice(0, 60) : "error"}`
  } finally {
    const unlinked = await unlinkAll(host, links)
    if (unlinked && created) await removeWorktree(host, info, dir).catch(() => undefined)
  }
}
