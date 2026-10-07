import { measure } from "../metrics/size.ts"
import { basename, dirname, joinPath, listFiles, type EvalHost } from "./host.ts"

// Trial isolation (SPEC §29): every trial — baseline included — runs in a
// fresh `git worktree` of one recorded SHA, outside the repository (so the
// main checkout's CLAUDE.md never sits above it), and is removed afterwards.

export interface GitInfo {
  /** The repository's top level, as git prints it. */
  top: string
  /** HEAD at the start of the run: every trial starts from it. */
  sha: string
  /** The project root relative to `top` ("" when they are the same). */
  sub: string
}

const git = (host: EvalHost, cwd: string, args: string[], timeoutMs = 120_000) =>
  host.run(["git", ...args], { cwd, timeoutMs })

export async function gitInfo(host: EvalHost, root: string): Promise<GitInfo | { error: string }> {
  try {
    const top = await git(host, root, ["rev-parse", "--show-toplevel"])
    if (top.exitCode !== 0) return { error: "not a git repository: eval needs Git" }
    const head = await git(host, root, ["rev-parse", "HEAD"])
    if (head.exitCode !== 0) return { error: "the repository has no commit yet" }
    const t = top.stdout.trim().replace(/\\/g, "/")
    const r = root.replace(/\\/g, "/").replace(/\/$/, "")
    const sub = r.toLowerCase().startsWith(`${t.toLowerCase()}/`) ? r.slice(t.length + 1) : ""
    return { top: t, sha: head.stdout.trim(), sub }
  } catch (err) {
    return { error: `git is not available: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Paths that make the tree dirty, `.context-lab/` (eval definitions and
 * results, never part of what is measured) excluded. Parses `-z` porcelain.
 */
export function dirtyPaths(porcelainZ: string, contextLabPrefix: string): string[] {
  const out: string[] = []
  const parts = porcelainZ.split("\0")
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (status.includes("R") || status.includes("C")) i++ // the rename's source follows
    if (!path.startsWith(contextLabPrefix)) out.push(path)
  }
  return out
}

export async function workingTreeChanges(host: EvalHost, info: GitInfo): Promise<string[]> {
  const r = await git(host, info.top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  if (r.exitCode !== 0) throw new Error(`git status failed: ${r.stderr.trim()}`)
  return dirtyPaths(r.stdout, `${info.sub ? `${info.sub}/` : ""}.context-lab/`)
}

export function worktreeBase(info: GitInfo, configured?: string): string {
  return configured ?? joinPath(dirname(info.top), ".context-lab-worktrees", basename(info.top))
}

export async function addWorktree(host: EvalHost, info: GitInfo, dir: string): Promise<void> {
  const r = await git(host, info.top, ["worktree", "add", "--detach", "--quiet", dir, info.sha])
  if (r.exitCode !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`)
}

export async function removeWorktree(host: EvalHost, info: GitInfo, dir: string): Promise<void> {
  try {
    await git(host, info.top, ["worktree", "remove", "--force", dir])
  } finally {
    await git(host, info.top, ["worktree", "prune"]).catch(() => undefined)
  }
}

/** Takes `.context-lab/` out of the trial's tree, so the agent never reads tasks or graders. */
export async function hideContextLab(host: EvalHost, wtRoot: string): Promise<void> {
  await git(host, wtRoot, ["rm", "-r", "-q", "--ignore-unmatch", "--", ".context-lab"])
}

export async function copyTree(host: EvalHost, from: string, to: string): Promise<string[]> {
  const files = await listFiles(host, from)
  for (const rel of files) await host.write(joinPath(to, rel), await host.read(joinPath(from, rel)))
  return files
}

/** Puts the graders in place just before grading: the same files for every trial. */
export async function installGraders(host: EvalHost, mainRoot: string, wtRoot: string): Promise<void> {
  const rel = ".context-lab/evals/graders"
  await copyTree(host, joinPath(mainRoot, rel), joinPath(wtRoot, rel))
}

/**
 * Local estimate (~chars/4) of the project's always-on instruction files in a
 * tree: CLAUDE.md, .claude/CLAUDE.md, .claude/rules/**.md. The same yardstick
 * for both arms; not what a session would load in total.
 */
export async function projectInstructionTokens(host: EvalHost, wtRoot: string): Promise<number> {
  const candidates = ["CLAUDE.md", ".claude/CLAUDE.md"]
  const rules = (await listFiles(host, joinPath(wtRoot, ".claude/rules"))).filter((f) => f.endsWith(".md"))
  candidates.push(...rules.map((f) => `.claude/rules/${f}`))
  let total = 0
  for (const rel of candidates) {
    const p = joinPath(wtRoot, rel)
    if (await host.exists(p)) total += measure(await host.read(p)).estimatedTokens
  }
  return total
}
