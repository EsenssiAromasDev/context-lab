import { atom, read, update } from "claude-code"
import type { EngineInterface, Register } from "claude-code"
import {
  NESTED_FILES,
  NESTED_SEEN,
  NESTED_UNATTRIBUTED,
  PENDING,
  parseArgs,
  renderDoctor,
  renderHelp,
  renderOverview,
  renderTree,
  type DoctorFacts,
} from "./commands/context-lab.ts"
import { canonicalPath } from "./graph/graph-builder.ts"
import { emptyGraph, restoreGraph, type ContextGraph } from "./graph/graph.ts"
import { applyEngineTokens, observeContext, type ContextPayload } from "./observers/context-observer.ts"
import {
  AVAILABLE_NAMES,
  NESTED_NAMES,
  inferFromRead,
  markAvailable,
  observeNestedAttachment,
  shouldDescend,
  type RepoFile,
} from "./observers/nested-observer.ts"
import { engineFileTokens, toSnapshot, type UsageLike } from "./metrics/usage.ts"

// Context Lab: wiring only. Engine events → pure observers → graph in $.state
// (live) and $.store (counts across sessions) → /context-lab views.
//
//   prompt.context   → observed instruction files (observe only, never modified)
//   prompt.attachment (nested_memory) → nested files the engine attached: observed
//   tool.call (Read) → the engine's nested walk for the read file: inferred
//   session.measure  → usage snapshot + engine per-file estimates
//   command.run      → /context-lab [overview|tree|doctor|...]
//
// Fails open (SPEC §42): an observer error is logged to the debug log and the
// engine's result is always returned untouched.

const COMMAND = "context-lab"

// Live state (survives hot reloads); contract in types/index.d.ts.
const graphAtom = atom({ plugin: "context-lab", key: "graph" } as const, emptyGraph())
const usageAtom = atom({ plugin: "context-lab", key: "usage" } as const, null)
const seenAtom = atom({ plugin: "context-lab", key: "seen" } as const, {})
const loadedForAtom = atom({ plugin: "context-lab", key: "loadedFor" } as const, null)

// Cross-session telemetry in $.store, per project. Bump the version when the
// stored graph's shape changes; older entries are then ignored.
const storeKey = (canonicalRoot: string) => `graph:v1:${canonicalRoot}`

// The repository scan for available instruction files, run by /context-lab
// tree only: breadth first, bounded, skipping dependency and build folders.
const SCAN_MAX_DIRS = 1500
const SCAN_MAX_DEPTH = 6

// Directories already walked for nested files, per context. A cache only: a
// reload empties it and the next Read walks again.
const walked = new Set<string>()
// Observations still being recorded; /context-lab waits for them so it never
// shows a state older than what the engine already sent.
const inFlight = new Set<Promise<void>>()
// Contexts (and their file counts) whose engine breakdown was already asked for.
const breakdownAsked = new Set<string>()

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Profile the context Claude receives: overview, tree, issues, doctor",
    })
    try {
      await ensureLoaded($)
    } catch (err) {
      debug($, "session.start", err)
    }
    return next(e)
  })

  // Observers answer with the engine's result at once and record in the
  // background, so they never hold up the prompt or a tool (SPEC §45).

  on("prompt.context", async ($, e, next) => {
    const result = await next(e)
    track(recordContext($, result))
    return result
  })

  on("prompt.attachment", { type: "nested_memory" }, async ($, e, next) => {
    const result = await next(e)
    // Only what the main conversation is actually sent: not a subagent's
    // copy, not one a hook beneath dropped.
    if (e.agentId === undefined && result.text !== null) track(recordAttachment($, result.text))
    return result
  })

  on("tool.call", { tool: "Read" }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) track(recordRead($, e.file_path))
    return ran
  })

  on("session.measure", async ($, e, next) => {
    const result = await next(e)
    track(recordMeasure($, e))
    return result
  })

  on("command.run", { command: COMMAND }, async ($, e) => {
    const parsed = parseArgs(e.args)
    try {
      await Promise.allSettled([...inFlight])
      if (parsed.view === "overview" || parsed.view === "tree") {
        await ensureLoaded($)
        await measureNow($, undefined)
        if (parsed.view === "tree") await scanAvailable($)
        const input = {
          graph: await read($, graphAtom),
          usage: (await read($, usageAtom)) ?? undefined,
          root: await $.session.root(),
        }
        return { text: parsed.view === "tree" ? renderTree(input) : renderOverview(input) }
      }
      if (parsed.view === "doctor") return { text: renderDoctor(await probe($)) }
      const pending = PENDING[parsed.view]
      return { text: pending ?? renderHelp(parsed) }
    } catch (err) {
      return { text: `Context Lab error: ${message(err)}` }
    }
  })
}

/** Merges this project's stored telemetry into the live graph once per session. */
async function ensureLoaded($: EngineInterface): Promise<void> {
  const root = canonicalPath(await $.session.root())
  if ((await read($, loadedForAtom)) === root) return
  const stored = restoreGraph(await $.store.get(storeKey(root)))
  const live = await read($, graphAtom)
  if (stored && live.contexts === 0) await update($, graphAtom, () => stored)
  await update($, loadedForAtom, () => root)
}

async function persist($: EngineInterface, graph: ContextGraph): Promise<void> {
  const root = canonicalPath(await $.session.root())
  await $.store.set(storeKey(root), graph)
}

function track(work: Promise<void>): void {
  inFlight.add(work)
  void work.finally(() => inFlight.delete(work))
}

async function recordContext($: EngineInterface, result: ContextPayload): Promise<void> {
  try {
    await seen($, "prompt.context")
    await ensureLoaded($)
    const at = await $.clock.now()
    const sessionId = await sessionKey($)
    const graph = await update($, graphAtom, (g) => observeContext(g, result, { at, sessionId }))
    await persist($, graph)
  } catch (err) {
    debug($, "prompt.context", err)
  }
}

async function recordAttachment($: EngineInterface, text: string): Promise<void> {
  try {
    await seen($, "prompt.attachment")
    await seen($, NESTED_SEEN)
    const ctx = { at: await $.clock.now(), root: await $.session.root(), sessionId: await sessionKey($) }
    let attributed = 0
    const graph = await update($, graphAtom, (g) => {
      const out = observeNestedAttachment(g, text, ctx)
      attributed = out.attributed
      return out.graph
    })
    if (attributed === 0) await seen($, NESTED_UNATTRIBUTED)
    else {
      await seen($, NESTED_FILES, attributed)
      await persist($, graph)
    }
  } catch (err) {
    debug($, "prompt.attachment", err)
  }
}

async function recordRead($: EngineInterface, filePath: string): Promise<void> {
  try {
    await seen($, "tool.call")
    await inferNested($, filePath)
  } catch (err) {
    debug($, "tool.call", err)
  }
}

async function recordMeasure($: EngineInterface, pushed: UsageLike): Promise<void> {
  try {
    await seen($, "session.measure")
    await measureNow($, pushed)
  } catch (err) {
    debug($, "session.measure", err)
  }
}

/**
 * Updates the usage snapshot. The engine's breakdown (per-file estimates) is
 * slow (~1 s on 2.1.291), so after a turn it is fetched only when this
 * context has files it has not been asked about yet; a command always asks.
 */
async function measureNow($: EngineInterface, pushed: UsageLike | undefined): Promise<void> {
  let usage: UsageLike | undefined = pushed
  const graph = await read($, graphAtom)
  const wanted = `${graph.contexts}:${graph.current.length}:${graph.nested.length}`
  if (pushed === undefined || !breakdownAsked.has(wanted)) {
    breakdownAsked.add(wanted)
    try {
      usage = await $.session.usage({ breakdown: "summary" })
    } catch (err) {
      debug($, "session.usage", err)
    }
  }
  if (!usage) return
  const at = await $.clock.now()
  const previous = await read($, usageAtom)
  const snapshot = toSnapshot(usage, at)
  // A reading without a breakdown keeps the categories the last one had.
  if (snapshot.categories === undefined && previous?.categories !== undefined) snapshot.categories = previous.categories
  await update($, usageAtom, () => snapshot)
  const files = engineFileTokens(usage.context.breakdown)
  if (files.size === 0) return
  const before = await read($, graphAtom)
  const after = await update($, graphAtom, (g) => applyEngineTokens(g, files))
  if (after !== before) await persist($, after)
}

async function seen($: EngineInterface, event: string, by = 1): Promise<void> {
  await update($, seenAtom, (s) => ({ ...s, [event]: (s[event] ?? 0) + by }))
}

/** The conversation's identity: when it began (restarts on /clear). DECISIONS D-008. */
async function sessionKey($: EngineInterface): Promise<string> {
  return String((await $.session.usage()).startedAt)
}

/** The engine's own nested walk for a file just read, inside the project only. */
async function inferNested($: EngineInterface, filePath: string): Promise<void> {
  const root = await $.session.root()
  const canonRoot = canonicalPath(root)
  const file = canonicalPath(filePath)
  if (!file.startsWith(`${canonRoot}/`)) return
  const graph = await read($, graphAtom)
  const dir = `${graph.contexts}:${file.slice(0, file.lastIndexOf("/"))}`
  if (walked.has(dir)) return
  walked.add(dir)
  const found = await $.fs.ancestors({ names: [...NESTED_NAMES], of: filePath, below: root })
  if (found.length === 0) return
  const files = found.map((a) => ({ path: a.parts[0]?.path ?? `${a.dir}/${a.name}`, content: a.content }))
  const at = await $.clock.now()
  const after = await update($, graphAtom, (g) => inferFromRead(g, files, filePath, { at, root }))
  await persist($, after)
}

/** Instruction files present in the repository, bounded breadth-first listing. */
async function scanAvailable($: EngineInterface): Promise<void> {
  const root = await $.session.root()
  const sep = root.includes("\\") ? "\\" : "/"
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  const files: RepoFile[] = []
  let listed = 0
  while (queue.length > 0 && listed < SCAN_MAX_DIRS) {
    const { dir, depth } = queue.shift()!
    listed += 1
    let entries
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = `${dir.replace(/[\\/]$/, "")}${sep}${entry.name}`
      if (entry.kind === "file" && AVAILABLE_NAMES.has(entry.name)) files.push({ path, bytes: entry.size })
      else if (entry.kind === "dir" && depth < SCAN_MAX_DEPTH && shouldDescend(entry.name)) {
        queue.push({ dir: path, depth: depth + 1 })
      }
    }
  }
  const at = await $.clock.now()
  await update($, graphAtom, (g) => markAvailable(g, files, { at, root }))
}

async function probe($: EngineInterface): Promise<DoctorFacts> {
  const root = await $.session.root()
  const facts: DoctorFacts = {
    observed: await read($, seenAtom),
    git: { available: false },
    repo: { isRepo: false },
    root,
    usageApi: false,
    breakdown: false,
    fs: false,
  }
  try {
    facts.version = (await $.session.version()).version
  } catch {}
  try {
    facts.fs = await $.fs.exists(root)
  } catch {}
  try {
    const usage = await $.session.usage({ breakdown: "summary" })
    facts.usageApi = true
    facts.breakdown = usage.context.breakdown !== undefined
  } catch {}
  try {
    const v = await $.process.run(["git", "--version"], { timeoutMs: 10_000 })
    if (v.exitCode === 0) facts.git = { available: true, version: v.stdout.trim().replace(/^git version /, "") }
  } catch {}
  if (facts.git.available) {
    try {
      const head = await $.process.run(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 })
      if (head.exitCode === 0) {
        const status = await $.process.run(["git", "status", "--porcelain"], { cwd: root, timeoutMs: 30_000 })
        const dirty = status.stdout.split("\n").filter(Boolean).length
        facts.repo = { isRepo: true, sha: head.stdout.trim(), clean: status.exitCode === 0 && dirty === 0, dirty }
      }
    } catch {}
  }
  return facts
}

function debug($: EngineInterface, where: string, err: unknown): void {
  $.ui.log(`context-lab ${where}: ${message(err)}`, { to: "debug" })
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
