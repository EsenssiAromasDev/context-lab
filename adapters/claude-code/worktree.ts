// Which files a shell command changed, by content, using git.
//
// Take a snapshot before the command and diff after it. A file counts as
// changed only if its content differs, so:
//   git commit -am ...       dirty → clean, same content   → not a change
//   git checkout <branch>    clean → clean, new content    → change
//   sed -i / formatter       clean or dirty → new content  → change
// Ignored files (dist/, node_modules/, .claudeos/) are never candidates.
//
// The git runner is injected: $.process.run in the plugin, child_process in
// Node tests. Any git failure answers null; the caller then falls back to
// WORKTREE_CHANGED.

export interface GitResult {
  exitCode: number
  stdout: string
}

/** Runs `git <args>` in `cwd`, feeding `stdin` when given. */
export type Git = (args: readonly string[], cwd: string, stdin?: string) => Promise<GitResult>

export interface Snapshot {
  /** Repository top level, forward slashes. */
  top: string
  /** HEAD commit, or null in a repository with no commits yet. */
  head: string | null
  /** Dirty paths (relative to `top`) → worktree blob hash, or DELETED. */
  dirty: ReadonlyMap<string, string>
}

const DELETED = "-"
/** Past this many candidates, give up on precision (command line limits, cost). */
const MAX_PATHS = 2000

export async function snapshot(git: Git, cwd: string): Promise<Snapshot | null> {
  const top = await git(["rev-parse", "--show-toplevel"], cwd)
  if (top.exitCode !== 0) return null
  const root = top.stdout.trim().replace(/\\/g, "/")

  const head = await git(["rev-parse", "-q", "--verify", "HEAD"], root)
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], root)
  if (status.exitCode !== 0) return null

  const entries = parsePorcelain(status.stdout)
  if (entries.length > MAX_PATHS) return null
  const present = entries.filter((e) => !e.deleted).map((e) => e.path)
  const hashes = await hashWorktree(git, root, present)
  if (!hashes) return null

  const dirty = new Map<string, string>()
  for (const e of entries) dirty.set(e.path, e.deleted ? DELETED : hashes.get(e.path)!)
  return { top: root, head: head.exitCode === 0 ? head.stdout.trim() : null, dirty }
}

/** Paths (relative to the repository top) whose content changed since `before`. */
export async function changedSince(git: Git, before: Snapshot): Promise<string[] | null> {
  const after = await snapshot(git, before.top)
  if (!after) return null

  const candidates = new Set([...before.dirty.keys(), ...after.dirty.keys()])
  if (after.head !== before.head) {
    const moved = await headDiff(git, before.top, before.head, after.head)
    if (!moved) return null
    for (const p of moved) candidates.add(p)
  }
  if (candidates.size > MAX_PATHS) return null

  // Content before: the worktree hash if it was dirty, else HEAD's blob.
  const cleanBefore = [...candidates].filter((p) => !before.dirty.has(p))
  const headBlobs = await blobsAt(git, before.top, before.head, cleanBefore)
  if (!headBlobs) return null
  // Content after: the worktree hash if dirty now, else the new HEAD's blob.
  const cleanAfter = [...candidates].filter((p) => !after.dirty.has(p))
  const newBlobs = await blobsAt(git, before.top, after.head, cleanAfter)
  if (!newBlobs) return null

  const changed: string[] = []
  for (const p of candidates) {
    const was = before.dirty.get(p) ?? headBlobs.get(p) ?? DELETED
    const now = after.dirty.get(p) ?? newBlobs.get(p) ?? DELETED
    if (was !== now) changed.push(p)
  }
  return changed.sort()
}

interface StatusEntry {
  path: string
  deleted: boolean
}

/** `git status --porcelain=v1 -z --no-renames`: "XY path\0" per entry. */
export function parsePorcelain(out: string): StatusEntry[] {
  const entries: StatusEntry[] = []
  for (const record of out.split("\0")) {
    if (record.length < 4) continue
    const xy = record.slice(0, 2)
    // Deleted from the worktree (" D") or both sides ("D "/"DD"): no content.
    const deleted = xy[1] === "D" || (xy[0] === "D" && xy[1] === " ")
    entries.push({ path: record.slice(3), deleted })
  }
  return entries
}

async function hashWorktree(git: Git, top: string, paths: string[]): Promise<Map<string, string> | null> {
  const hashes = new Map<string, string>()
  if (paths.length === 0) return hashes
  // --stdin-paths applies the same clean filters (autocrlf, ...) as `git add`,
  // so an unchanged file hashes to its committed blob.
  const out = await git(["hash-object", "--stdin-paths"], top, paths.join("\n") + "\n")
  if (out.exitCode !== 0) return null
  const lines = out.stdout.trim().split(/\r?\n/)
  if (lines.length !== paths.length) return null
  paths.forEach((p, i) => hashes.set(p, lines[i]!))
  return hashes
}

async function blobsAt(git: Git, top: string, head: string | null, paths: string[]): Promise<Map<string, string> | null> {
  const blobs = new Map<string, string>()
  if (head === null || paths.length === 0) return blobs
  const out = await git(["ls-tree", "-z", "--full-tree", head, "--", ...paths], top)
  if (out.exitCode !== 0) return null
  // "<mode> <type> <hash>\t<path>\0"
  for (const record of out.stdout.split("\0")) {
    const tab = record.indexOf("\t")
    if (tab < 0) continue
    const [, type, hash] = record.slice(0, tab).split(" ")
    if (type === "blob" && hash) blobs.set(record.slice(tab + 1), hash)
  }
  return blobs
}

async function headDiff(git: Git, top: string, from: string | null, to: string | null): Promise<string[] | null> {
  // From or to an unborn HEAD: everything in the other tree is a candidate.
  const args =
    from && to
      ? ["diff", "--name-only", "-z", "--no-renames", from, to]
      : ["ls-tree", "-r", "-z", "--name-only", "--full-tree", (from ?? to)!]
  if (!from && !to) return []
  const out = await git(args, top)
  if (out.exitCode !== 0) return null
  return out.stdout.split("\0").filter(Boolean)
}
