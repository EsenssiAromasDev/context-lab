// What the eval harness needs from the machine. The plugin implements it with
// `$` (register.tsx), the Node CLI with node:child_process and node:fs
// (scripts/eval.ts): one harness, two hosts, so it runs where `/context-lab`
// cannot (a headless `claude -p` does not resolve a Mod's command).

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface FileEntry {
  name: string
  kind: "file" | "dir" | "other"
}

export interface EvalHost {
  /** Runs argv without a shell. Rejects when it cannot start or exceeds `timeoutMs`. */
  run(argv: readonly string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<RunResult>
  read(path: string): Promise<string>
  /** Writes the whole file, creating its directories. */
  write(path: string, text: string): Promise<void>
  exists(path: string): Promise<boolean>
  list(path: string): Promise<readonly FileEntry[]>
  now(): Promise<number>
  isWindows: boolean
}

/** Joins with "/", normalizing backslashes; `..` and `.` segments resolved. */
export function joinPath(base: string, ...parts: string[]): string {
  const segs = base.replace(/\\/g, "/").split("/")
  const lead = segs[0] === "" ? "/" : ""
  const out: string[] = []
  for (const s of [...segs, ...parts.flatMap((p) => p.replace(/\\/g, "/").split("/"))]) {
    if (s === "" || s === ".") continue
    if (s === "..") out.pop()
    else out.push(s)
  }
  return lead + out.join("/")
}

export function dirname(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/\/$/, "")
  const i = p.lastIndexOf("/")
  return i <= 0 ? (i === 0 ? "/" : ".") : p.slice(0, i)
}

export function basename(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/\/$/, "")
  return p.slice(p.lastIndexOf("/") + 1)
}

/** Every file under `dir`, as paths relative to it, in a stable order. */
export async function listFiles(host: EvalHost, dir: string, prefix = ""): Promise<string[]> {
  if (!(await host.exists(dir))) return []
  const out: string[] = []
  const entries = [...(await host.list(dir))].sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.kind === "file") out.push(rel)
    else if (e.kind === "dir") out.push(...(await listFiles(host, joinPath(dir, e.name), rel)))
  }
  return out
}

/**
 * The executable an npm `.cmd` shim starts (`"%dp0%\node_modules\...\claude.exe" %*`),
 * resolved against the shim's folder; undefined when the shim is not of that shape.
 */
export function parseCmdShim(cmdText: string, cmdPath: string): string | undefined {
  const m = /"%dp0%\\?([^"%]+\.exe)"/i.exec(cmdText)
  return m ? joinPath(dirname(cmdPath), m[1]!) : undefined
}

/**
 * How to start Claude Code without a shell: the configured argv, else `claude`,
 * else (Windows) the executable behind its npm `.cmd` shim.
 */
export async function resolveClaude(host: EvalHost, configured?: readonly string[]): Promise<{ argv: string[]; version: string } | { error: string }> {
  const attempt = async (argv: readonly string[]) => {
    try {
      const r = await host.run([...argv, "--version"], { timeoutMs: 30_000 })
      return r.exitCode === 0 ? r.stdout.trim().split(/\s+/)[0] : undefined
    } catch {
      return undefined
    }
  }
  if (configured) {
    const v = await attempt(configured)
    return v ? { argv: [...configured], version: v } : { error: `config "claude" (${configured.join(" ")}) does not start Claude Code` }
  }
  const direct = await attempt(["claude"])
  if (direct) return { argv: ["claude"], version: direct }
  if (host.isWindows) {
    try {
      const where = await host.run(["where", "claude.cmd"], { timeoutMs: 15_000 })
      const shim = where.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
      if (shim) {
        const exe = parseCmdShim(await host.read(shim), shim)
        const v = exe ? await attempt([exe]) : undefined
        if (exe && v) return { argv: [exe], version: v }
      }
    } catch {
      // fall through to the error below
    }
  }
  return { error: 'cannot start Claude Code without a shell: set "claude" in .context-lab/config.json to its executable, e.g. ["C:/path/to/claude.exe"]' }
}
