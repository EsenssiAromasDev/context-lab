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
    if (top.exitCode !== 0) return { error: "Esta carpeta no es un repositorio git: los experimentos necesitan git." }
    const head = await git(host, root, ["rev-parse", "HEAD"])
    if (head.exitCode !== 0) return { error: "El repositorio todavía no tiene ningún commit." }
    const t = top.stdout.trim().replace(/\\/g, "/")
    const r = root.replace(/\\/g, "/").replace(/\/$/, "")
    const sub = r.toLowerCase().startsWith(`${t.toLowerCase()}/`) ? r.slice(t.length + 1) : ""
    return { top: t, sha: head.stdout.trim(), sub }
  } catch (err) {
    return { error: `No se encuentra git: ${err instanceof Error ? err.message : String(err)}` }
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

export async function addWorktree(host: EvalHost, info: GitInfo, dir: string, sha = info.sha): Promise<void> {
  const r = await git(host, info.top, ["worktree", "add", "--detach", "--quiet", dir, sha])
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
 * Local estimate (~chars/4) of the project's ALWAYS-ON instruction files in a
 * tree: CLAUDE.md, .claude/CLAUDE.md, and .claude/rules/**.md without a
 * `paths:` frontmatter (a path-scoped rule loads only when Claude touches a
 * matching file). The same yardstick for both arms.
 */
export async function projectInstructionTokens(host: EvalHost, wtRoot: string): Promise<number> {
  const candidates = ["CLAUDE.md", ".claude/CLAUDE.md"]
  const rules = (await listFiles(host, joinPath(wtRoot, ".claude/rules"))).filter((f) => f.endsWith(".md"))
  candidates.push(...rules.map((f) => `.claude/rules/${f}`))
  let total = 0
  for (const rel of candidates) {
    const p = joinPath(wtRoot, rel)
    if (!(await host.exists(p))) continue
    const text = await host.read(p)
    if (rel.startsWith(".claude/rules/") && isPathScoped(text)) continue
    total += measure(text).estimatedTokens
  }
  return total
}

/** True when a rule file's frontmatter has a `paths` field: it loads only for matching files. */
export function isPathScoped(text: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  return m !== null && /^paths\s*:/m.test(m[1]!)
}

/** Instruction files Claude Code loads from a repository (relative paths). */
export function isInstructionPath(p: string): boolean {
  const name = p.slice(p.lastIndexOf("/") + 1)
  if (name === "CLAUDE.md" || name === "CLAUDE.local.md" || name === "AGENTS.md") return !p.startsWith(".context-lab/")
  return /^\.claude\/rules\/.+\.md$/.test(p)
}

async function trackedFiles(host: EvalHost, cwd: string, rev: string): Promise<string[]> {
  const r = await git(host, cwd, ["ls-tree", "-r", "--name-only", "-z", rev])
  if (r.exitCode !== 0) throw new Error(`git ls-tree ${rev} failed: ${r.stderr.trim()}`)
  return r.stdout.split("\0").filter(Boolean)
}

/** A file's content at a commit, read from the main repository. */
export async function showAt(host: EvalHost, info: GitInfo, rev: string, path: string): Promise<string> {
  const r = await git(host, info.top, ["show", `${rev}:${path}`])
  if (r.exitCode !== 0) throw new Error(`git show ${rev}:${path} failed: ${r.stderr.trim()}`)
  return r.stdout
}

/** The project's instruction files at a commit: path → text. */
export async function instructionsAt(host: EvalHost, info: GitInfo, rev: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const p of (await trackedFiles(host, info.top, rev)).filter(isInstructionPath)) out.set(p, await showAt(host, info, rev, p))
  return out
}

/**
 * A trial that starts at an older commit still runs with TODAY's instructions:
 * the experiment compares instruction sets, not history. Writes HEAD's
 * instruction files into the tree and removes ones HEAD no longer has.
 */
export async function syncInstructions(host: EvalHost, info: GitInfo, wtRoot: string, headFiles: ReadonlyMap<string, string>): Promise<void> {
  const present = (await trackedFiles(host, wtRoot, "HEAD")).filter(isInstructionPath)
  const stale = present.filter((p) => !headFiles.has(p))
  if (stale.length) await git(host, wtRoot, ["rm", "-q", "--ignore-unmatch", "--", ...stale])
  for (const [p, text] of headFiles) await host.write(joinPath(wtRoot, p), text)
  // Staged, so a variant's `delete` (git rm) can remove them like any tracked file.
  if (headFiles.size) {
    const r = await git(host, wtRoot, ["add", "-f", "--", ...headFiles.keys()])
    if (r.exitCode !== 0) throw new Error(`git add of today's instructions failed: ${r.stderr.trim()}`)
  }
}

/** Restores a mined task's reference tests into the tree, just before grading. */
export async function writeGraderFiles(host: EvalHost, info: GitInfo, wtRoot: string, files: readonly string[], from: string): Promise<void> {
  for (const f of files) await host.write(joinPath(wtRoot, f), await showAt(host, info, from, f))
}

/**
 * Links the main checkout's dependency folders (node_modules, .venv) into a
 * trial's tree so its tests can run. Returns the links made; `unlinkAll` must
 * remove them before the worktree is deleted, or deleting could follow them.
 */
export async function linkDependencies(host: EvalHost, mainRoot: string, wtRoot: string, names: readonly string[]): Promise<string[]> {
  const made: string[] = []
  for (const name of names) {
    const target = joinPath(mainRoot, name)
    const link = joinPath(wtRoot, name)
    if (!(await host.exists(target)) || (await host.exists(link))) continue
    await host.link(target, link)
    made.push(link)
  }
  return made
}

export async function unlinkAll(host: EvalHost, links: readonly string[]): Promise<boolean> {
  let ok = true
  for (const l of links) {
    try {
      await host.unlink(l)
      if (await host.exists(l)) ok = false
    } catch {
      ok = false
    }
  }
  return ok
}
