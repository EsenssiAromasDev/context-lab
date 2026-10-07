import { atom, read, update } from "claude-code"
import type { EngineInterface, Register } from "claude-code"
import {
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
import { applyEngineTokens, observeContext } from "./observers/context-observer.ts"
import { engineFileTokens, toSnapshot, type UsageLike } from "./metrics/usage.ts"

// Context Lab: wiring only. Engine events → pure observers → graph in $.state
// (live) and $.store (counts across sessions) → /context-lab views.
//
//   prompt.context   → observed instruction files (observe only, never modified)
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

  on("prompt.context", async ($, e, next) => {
    const result = await next(e)
    try {
      await seen($, "prompt.context")
      await ensureLoaded($)
      const at = await $.clock.now()
      const sessionId = String((await $.session.usage()).startedAt)
      const graph = await update($, graphAtom, (g) => observeContext(g, result, { at, sessionId }))
      await persist($, graph)
    } catch (err) {
      debug($, "prompt.context", err)
    }
    return result
  })

  on("session.measure", async ($, e, next) => {
    const result = await next(e)
    try {
      await seen($, "session.measure")
      await measureNow($, e)
    } catch (err) {
      debug($, "session.measure", err)
    }
    return result
  })

  on("command.run", { command: COMMAND }, async ($, e) => {
    const parsed = parseArgs(e.args)
    try {
      if (parsed.view === "overview" || parsed.view === "tree") {
        await ensureLoaded($)
        await measureNow($, undefined)
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

/** Pulls usage with the engine's local ("summary") breakdown; falls back to the pushed figures. */
async function measureNow($: EngineInterface, pushed: UsageLike | undefined): Promise<void> {
  let usage: UsageLike | undefined = pushed
  try {
    usage = await $.session.usage({ breakdown: "summary" })
  } catch (err) {
    debug($, "session.usage", err)
  }
  if (!usage) return
  const at = await $.clock.now()
  const snapshot = toSnapshot(usage, at)
  await update($, usageAtom, () => snapshot)
  const files = engineFileTokens(usage.context.breakdown)
  if (files.size === 0) return
  const before = await read($, graphAtom)
  const after = await update($, graphAtom, (g) => applyEngineTokens(g, files))
  if (after !== before) await persist($, after)
}

async function seen($: EngineInterface, event: string): Promise<void> {
  await update($, seenAtom, (s) => ({ ...s, [event]: (s[event] ?? 0) + 1 }))
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
