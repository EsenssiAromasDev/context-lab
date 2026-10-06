import type { ClaudeOSEvent } from "../../core/events.ts"
import type { CheckKind, CheckResult } from "../../core/state.ts"

// Claude Code tool calls → ClaudeOSEvents. Pure: the hooks module hands in
// what happened (tool, input, outcome) and the time; nothing here touches $.
//
// Conservative by design: when we cannot tell what a command proved, we
// record nothing. Missing evidence blocks /ship; wrong evidence would not.

export type ToolOutcome =
  | { kind: "denied" }
  | { kind: "error"; interrupted?: boolean }
  | { kind: "ok"; result?: unknown }

export interface MapContext {
  /** Project root, absolute, as `$.session.root()` answers it. */
  root: string
  at: number
}

const EDIT_TOOLS: Record<string, string> = {
  Edit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
}

const SHELL_TOOLS = new Set(["Bash", "PowerShell"])

export function mapToolCall(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  outcome: ToolOutcome,
  ctx: MapContext,
): ClaudeOSEvent[] {
  const pathKey = EDIT_TOOLS[tool]
  if (pathKey !== undefined) {
    // A denied or failed edit changed nothing.
    if (outcome.kind !== "ok") return []
    const raw = input[pathKey]
    if (typeof raw !== "string") return []
    const path = projectRelative(raw, ctx.root)
    if (path === null || isOwnState(path)) return []
    return [{ type: "FILE_CHANGED", path, at: ctx.at }]
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = input.command
    if (typeof command !== "string" || outcome.kind === "denied") return []
    if (input.run_in_background === true || isBackgrounded(outcome)) return []
    const kinds = detectChecks(command)
    if (kinds.length === 0) return []
    const result: CheckResult = { status: checkStatus(outcome), command, at: ctx.at }
    return kinds.map((kind) => ({ type: "CHECK_RAN", kind, result, at: ctx.at }))
  }

  return []
}

function checkStatus(outcome: Exclude<ToolOutcome, { kind: "denied" }>): CheckResult["status"] {
  if (outcome.kind === "ok") return "passed"
  // Interrupted / timed out: the check did not finish, so it proved nothing.
  return outcome.interrupted ? "error" : "failed"
}

function isBackgrounded(outcome: ToolOutcome): boolean {
  if (outcome.kind !== "ok" || typeof outcome.result !== "object" || outcome.result === null) return false
  return typeof (outcome.result as { backgroundTaskId?: unknown }).backgroundTaskId === "string"
}

// ---------------------------------------------------------------------------
// Check detection

// Matched against one simple command with env assignments and wrappers
// stripped, e.g. "npm run test -- --watch=false" → "npm run test ...".
const CHECK_PATTERNS: ReadonlyArray<[CheckKind, RegExp]> = [
  ["tests", /^(npm|pnpm|yarn|bun)( run)? test\b/],
  ["tests", /^(npx |pnpm exec |pnpm |yarn |bunx )?(vitest|jest|mocha|ava|playwright test)\b/],
  ["tests", /^node (.* )?--test\b/],
  ["tests", /^(python3? -m )?pytest\b/],
  ["tests", /^python3? -m unittest\b/],
  ["tests", /^(go|cargo|dotnet|deno|mix) test\b/],
  ["tests", /^(mvn|\.\/mvnw|gradle|\.\/gradlew) .*\btest\b/],
  ["tests", /^(bundle exec )?(rspec|rake test)\b/],
  ["tests", /^(vendor\/bin\/)?phpunit\b/],

  ["lint", /^(npm|pnpm|yarn|bun)( run)? lint\b/],
  ["lint", /^(npx |pnpm exec |yarn |bunx )?(eslint|biome (lint|check)|oxlint)\b/],
  ["lint", /^(ruff check|ruff|flake8|pylint)\b/],
  ["lint", /^(golangci-lint run|cargo clippy)\b/],

  ["types", /^(npm|pnpm|yarn|bun)( run)? (typecheck|type-check|types|tsc)\b/],
  ["types", /^(npx |pnpm exec |yarn |bunx )?(tsc|vue-tsc)\b(?!.*(--build|-b\b|--watch|-w\b|--init|--version|-v\b))/],
  ["types", /^(python3? -m )?(mypy|pyright)\b/],

  ["build", /^(npm|pnpm|yarn|bun)( run)? build\b/],
  ["build", /^(npx |pnpm exec |yarn |bunx )?(vite|next|astro|nuxt) build\b/],
  ["build", /^(npx |pnpm exec |yarn |bunx )?tsc (--build|-b)\b/],
  ["build", /^(cargo|go|dotnet) build\b/],
  ["build", /^(mvn|\.\/mvnw) .*\b(package|install|verify)\b/],
  ["build", /^(gradle|\.\/gradlew) .*\b(build|assemble)\b/],
]

/**
 * Which checks a shell command proves, given only whether it exited 0.
 *
 * The tool reports success of the command line as a whole, so evidence is
 * credited only when that success is attributable:
 *   - `a && b && c`: success means every part ran and passed → all checks.
 *   - `;`, `||`, `&`, newlines: only the last part decides the status → only
 *     a check in the last part counts.
 *   - a pipe: the status is the last stage's (`npm test | tail`) → nothing.
 */
export function detectChecks(command: string): CheckKind[] {
  const line = command.trim()
  if (line === "" || hasUnquoted(line, PIPE)) return []

  const groups = splitUnquoted(line, SEQUENCE)
  const last = groups[groups.length - 1] ?? ""
  const found = new Set<CheckKind>()
  for (const part of splitUnquoted(last, AND)) {
    const kind = classify(part)
    if (kind) found.add(kind)
  }
  return [...found]
}

function classify(part: string): CheckKind | null {
  const words = part.trim().replace(/^\(+|\)+$/g, "").trim().split(/\s+/)
  // Drop env assignments and harmless wrappers: `CI=1 npx vitest`, `time go test`.
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || /^(time|env|command)$/.test(words[0]!))) {
    words.shift()
  }
  const simple = words.join(" ")
  for (const [kind, pattern] of CHECK_PATTERNS) if (pattern.test(simple)) return kind
  return null
}

// Sticky, so lookbehind sees the whole line. `|` but not `||`; `&` but not
// `&&` or a redirection (`2>&1`, `&>file`).
const PIPE = /(?<!\|)\|(?!\|)/y
const SEQUENCE = /;|\|\||(?<![&<>])&(?![&>])|\n/y
const AND = /&&/y

/** Split on a separator that is outside single/double quotes. */
function splitUnquoted(text: string, sep: RegExp): string[] {
  const parts: string[] = []
  let start = 0
  let skipUntil = 0
  for (const i of unquotedIndices(text)) {
    if (i < skipUntil) continue
    sep.lastIndex = i
    const m = sep.exec(text)
    if (m) {
      parts.push(text.slice(start, i))
      start = skipUntil = i + m[0].length
    }
  }
  parts.push(text.slice(start))
  return parts.filter((p) => p.trim() !== "")
}

function hasUnquoted(text: string, pattern: RegExp): boolean {
  for (const i of unquotedIndices(text)) {
    pattern.lastIndex = i
    if (pattern.test(text)) return true
  }
  return false
}

function* unquotedIndices(text: string): Generator<number> {
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === "\\" && quote === '"') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if (c === "\\") i++
    else yield i
  }
}

// ---------------------------------------------------------------------------
// Paths

/**
 * `path` relative to `root`, forward slashes; null when it lies outside the
 * project (an edit to ~/.bashrc is not a change to this project). Windows
 * paths compare case-insensitively.
 */
export function projectRelative(path: string, root: string): string | null {
  const p = slashes(path)
  const r = slashes(root).replace(/\/+$/, "")
  const isAbsolute = /^([A-Za-z]:)?\//.test(p)
  if (!isAbsolute) return p.replace(/^(\.\/)+/, "") || null

  const windows = /^[A-Za-z]:/.test(r)
  const [pc, rc] = windows ? [p.toLowerCase(), r.toLowerCase()] : [p, r]
  if (!pc.startsWith(rc + "/")) return null
  const rel = p.slice(r.length + 1)
  return rel.split("/").includes("..") ? null : rel
}

function slashes(p: string): string {
  return p.replace(/\\/g, "/")
}

function isOwnState(rel: string): boolean {
  return rel === ".claudeos" || rel.startsWith(".claudeos/")
}
