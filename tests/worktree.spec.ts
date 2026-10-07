import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { changedSince, parsePorcelain, snapshot, type Git } from "../adapters/claude-code/worktree.ts"

const git: Git = async (args, cwd, stdin) => {
  const r = spawnSync("git", args, { cwd, input: stdin, encoding: "utf8" })
  return { exitCode: r.status ?? 1, stdout: r.stdout }
}

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function repo(): { root: string; sh: (...args: string[]) => void; write: (p: string, text: string) => void } {
  const root = mkdtempSync(join(tmpdir(), "claudeos-wt-"))
  dirs.push(root)
  const sh = (...args: string[]) => {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      stdio: "ignore",
    })
  }
  const write = (p: string, text: string) => {
    mkdirSync(join(root, p, ".."), { recursive: true })
    writeFileSync(join(root, p), text)
  }
  sh("init", "-q", "-b", "main")
  writeFileSync(join(root, ".gitignore"), "dist/\n")
  write("src/a.ts", "a1\n")
  write("src/b.ts", "b1\n")
  sh("add", "-A")
  sh("commit", "-q", "-m", "init")
  return { root, sh, write }
}

async function diff(root: string, act: () => void): Promise<string[] | null> {
  const before = await snapshot(git, root)
  assert.ok(before)
  act()
  return changedSince(git, before)
}

test("editing a clean file is a change", async () => {
  const { root, write } = repo()
  assert.deepEqual(await diff(root, () => write("src/a.ts", "a2\n")), ["src/a.ts"])
})

test("editing an already dirty file again is a change; leaving it is not", async () => {
  const { root, write } = repo()
  write("src/a.ts", "a2\n")
  assert.deepEqual(await diff(root, () => write("src/a.ts", "a3\n")), ["src/a.ts"])
  assert.deepEqual(await diff(root, () => {}), [])
})

test("new, deleted and reverted files are changes", async () => {
  const { root, sh, write } = repo()
  assert.deepEqual(await diff(root, () => write("src/new.ts", "n\n")), ["src/new.ts"])
  assert.deepEqual(await diff(root, () => unlinkSync(join(root, "src/b.ts"))), ["src/b.ts"])
  write("src/a.ts", "a2\n")
  assert.deepEqual(await diff(root, () => sh("checkout", "--", "src/a.ts")), ["src/a.ts"])
})

test("committing changes nothing on disk, so it is not a change", async () => {
  const { root, sh, write } = repo()
  write("src/a.ts", "a2\n")
  write("src/c.ts", "c\n")
  assert.deepEqual(
    await diff(root, () => {
      sh("add", "-A")
      sh("commit", "-q", "-m", "wip")
    }),
    [],
  )
})

test("switching to a branch with different content is a change", async () => {
  const { root, sh, write } = repo()
  sh("checkout", "-q", "-b", "other")
  write("src/b.ts", "b-other\n")
  sh("commit", "-q", "-am", "other")
  sh("checkout", "-q", "main")
  assert.deepEqual(await diff(root, () => sh("checkout", "-q", "other")), ["src/b.ts"])
})

test("ignored files are not candidates", async () => {
  const { root, write } = repo()
  assert.deepEqual(await diff(root, () => write("dist/out.js", "x")), [])
})

test("outside a git repository there is no snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claudeos-nogit-"))
  dirs.push(dir)
  assert.equal(await snapshot(git, dir), null)
})

test("parsePorcelain reads -z records, including spaces and deletions", () => {
  assert.deepEqual(parsePorcelain(" M src/a b.ts\0?? new.ts\0 D gone.ts\0D  staged-gone.ts\0"), [
    { path: "src/a b.ts", deleted: false },
    { path: "new.ts", deleted: false },
    { path: "gone.ts", deleted: true },
    { path: "staged-gone.ts", deleted: true },
  ])
})
