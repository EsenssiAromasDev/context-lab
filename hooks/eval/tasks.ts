// Eval task files (SPEC §27): `.context-lab/evals/tasks/*.yaml` (or .json).
//
//   id: fix-invalid-user-validation
//   prompt: |
//     The user creation endpoint accepts invalid email addresses.
//   grader:
//     command: "pytest tests/test_users.py -q"     # or argv: [pytest, tests/x.py]
//   timeout_seconds: 600
//
// The YAML reader is deliberately small (maps, block scalars, lists of
// scalars): the hooks module has no dependencies to lean on.

export interface Task {
  id: string
  prompt: string
  /** The grader as an argument vector: never run through a shell (SPEC §41). */
  graderArgv: string[]
  timeoutSeconds: number
  /** The file it came from, relative to the tasks folder. */
  file: string
  /** The commit a trial starts from; absent, the run's HEAD. Mined tasks start before their commit. */
  baseSha?: string
  /** Files restored from `graderFrom` just before grading (a mined commit's tests). */
  graderFiles?: string[]
  graderFrom?: string
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

export const DEFAULT_TIMEOUT_SECONDS = 600

type Yaml = string | Yaml[] | { [key: string]: Yaml }

/** A small YAML subset: nested maps by indentation, `|`/`>` blocks, `- item` lists, comments. */
export function parseYaml(text: string): Yaml {
  const lines = text.replace(/\t/g, "  ").split(/\r?\n/)
  let i = 0

  const indentOf = (l: string) => l.length - l.trimStart().length
  const isBlank = (l: string) => l.trim() === "" || l.trim().startsWith("#")

  function scalar(raw: string): string {
    const v = raw.replace(/\s+#.*$/, "").trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      const inner = v.slice(1, -1)
      return v.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'")
    }
    return v
  }

  function block(parentIndent: number, folded: boolean): string {
    const body: string[] = []
    let indent = -1
    while (i < lines.length) {
      const l = lines[i]!
      if (l.trim() === "") {
        body.push("")
        i++
        continue
      }
      const n = indentOf(l)
      if (n <= parentIndent) break
      if (indent === -1) indent = n
      body.push(l.slice(Math.min(indent, n)))
      i++
    }
    while (body.length && body[body.length - 1] === "") body.pop()
    return folded ? body.join(" ").replace(/\s+/g, " ").trim() : `${body.join("\n")}\n`
  }

  function node(indent: number): Yaml {
    while (i < lines.length && isBlank(lines[i]!)) i++
    if (i >= lines.length) return ""
    if (lines[i]!.trimStart().startsWith("- ")) {
      const list: Yaml[] = []
      while (i < lines.length) {
        if (isBlank(lines[i]!)) {
          i++
          continue
        }
        const l = lines[i]!
        if (indentOf(l) < indent || !l.trimStart().startsWith("- ")) break
        list.push(scalar(l.trimStart().slice(2)))
        i++
      }
      return list
    }
    const map: { [key: string]: Yaml } = {}
    while (i < lines.length) {
      if (isBlank(lines[i]!)) {
        i++
        continue
      }
      const l = lines[i]!
      const n = indentOf(l)
      if (n < indent) break
      const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(l.trim())
      if (!m) throw new Error(`line ${i + 1}: expected "key: value"`)
      const [, key, rest] = m
      i++
      const v = rest!.trim()
      if (v === "|" || v === ">" || v === "|-" || v === ">-") map[key!] = block(n, v.startsWith(">"))
      else if (v === "" || v.startsWith("#")) {
        let j = i
        while (j < lines.length && isBlank(lines[j]!)) j++
        map[key!] = j < lines.length && indentOf(lines[j]!) > n ? node(indentOf(lines[j]!)) : ""
      } else if (v.startsWith("[") && v.endsWith("]")) {
        map[key!] = v.slice(1, -1).split(",").map((x) => scalar(x)).filter((x) => x.length > 0)
      } else map[key!] = scalar(v)
    }
    return map
  }

  return node(0)
}

const SHELL_SYNTAX = /[|&;<>`$]/

/**
 * Splits a grader command into argv with shell-like quoting. Pipes,
 * redirections, `&&`, variables and the like are refused: graders run without
 * a shell, so a command that needs one says so instead of silently changing.
 */
export function splitCommand(command: string): Parsed<string[]> {
  const argv: string[] = []
  let cur = ""
  let quote: '"' | "'" | null = null
  let has = false
  for (let k = 0; k < command.length; k++) {
    const c = command[k]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === "\\" && quote === '"' && command[k + 1] === '"') cur += command[++k]
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
      continue
    }
    if (/\s/.test(c)) {
      if (has || cur) argv.push(cur)
      cur = ""
      has = false
      continue
    }
    if (SHELL_SYNTAX.test(c)) {
      return { ok: false, error: `grader command uses shell syntax ("${c}"); graders run without a shell: use grader.argv or a script` }
    }
    cur += c
    has = true
  }
  if (quote) return { ok: false, error: "grader command has an unterminated quote" }
  if (has || cur) argv.push(cur)
  if (argv.length === 0) return { ok: false, error: "grader command is empty" }
  return { ok: true, value: argv }
}

export function parseTask(text: string, file: string): Parsed<Task> {
  let doc: unknown
  try {
    doc = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text)
  } catch (err) {
    return { ok: false, error: `${file}: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { ok: false, error: `${file}: not a map` }
  const d = doc as Record<string, unknown>
  const id = typeof d.id === "string" ? d.id.trim() : ""
  if (!/^[\w.-]{1,80}$/.test(id)) return { ok: false, error: `${file}: id must be 1-80 of letters, digits, "_", "-", "."` }
  const prompt = typeof d.prompt === "string" ? d.prompt.trim() : ""
  if (!prompt) return { ok: false, error: `${file}: prompt is required` }

  const grader = d.grader as Record<string, unknown> | undefined
  let argv: string[]
  if (grader && Array.isArray(grader.argv) && grader.argv.length > 0 && grader.argv.every((a) => typeof a === "string")) {
    argv = grader.argv as string[]
  } else if (grader && typeof grader.command === "string") {
    const split = splitCommand(grader.command)
    if (!split.ok) return { ok: false, error: `${file}: ${split.error}` }
    argv = split.value
  } else return { ok: false, error: `${file}: grader.command or grader.argv is required` }

  const rawTimeout = d.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS
  const timeoutSeconds = typeof rawTimeout === "number" ? rawTimeout : Number(rawTimeout)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return { ok: false, error: `${file}: timeout_seconds must be a positive number` }

  const task: Task = { id, prompt, graderArgv: argv, timeoutSeconds, file }
  const sha = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{7,40}$/i.test(v.trim()) ? v.trim() : undefined)
  if (d.base_sha !== undefined) {
    const base = sha(d.base_sha)
    if (!base) return { ok: false, error: `${file}: base_sha must be a commit hash` }
    task.baseSha = base
  }
  if (grader && grader.files !== undefined) {
    const files = Array.isArray(grader.files) ? grader.files.filter((f): f is string => typeof f === "string" && f.length > 0) : []
    const from = sha(grader.from_sha)
    if (files.length === 0 || !from) return { ok: false, error: `${file}: grader.files needs a list of paths and grader.from_sha` }
    if (files.some((f) => f.startsWith("/") || f.split("/").includes(".."))) return { ok: false, error: `${file}: grader.files must be relative paths` }
    task.graderFiles = files
    task.graderFrom = from
  }
  return { ok: true, value: task }
}
