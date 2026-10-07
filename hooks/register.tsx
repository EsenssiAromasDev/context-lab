import { atom, read, update } from "claude-code"
import type { EngineInterface, Register } from "claude-code"
import {
  NESTED_FILES,
  NESTED_SEEN,
  NESTED_UNATTRIBUTED,
  TABS,
  isPaneView,
  openedLine,
  paneLines,
  parseArgs,
  type PaneView,
  renderDoctor,
  renderHelp,
  type DoctorFacts,
} from "./commands/context-lab.ts"
import { parseAnalysisConfig } from "./analysis/config.ts"
import { analyze, pathsToCheck, type AnalyzedSource, type ContextIssue } from "./analysis/issue-engine.ts"
import { join, locateLine } from "./analysis/stale-paths.ts"
import { canonicalPath } from "./graph/graph-builder.ts"
import { displayPath } from "./graph/graph-selectors.ts"
import { emptyGraph, restoreGraph, type ContextGraph } from "./graph/graph.ts"
import { renderReport, reportFileName } from "./commands/report.ts"
import type { EvalHost } from "./eval/host.ts"
import { initFiles, renderInit } from "./eval/init.ts"
import { renderExperiment } from "./eval/report.ts"
import { latestSummary, prepare, runExperiment, type Prepared } from "./eval/runner.ts"
import {
  applyEngineTokens,
  deliveredTexts,
  observeContext,
  type ContextPayload,
} from "./observers/context-observer.ts"
import {
  AVAILABLE_NAMES,
  NESTED_NAMES,
  attachmentTexts,
  inferFromRead,
  markAvailable,
  observeNestedAttachment,
  shouldDescend,
  type RepoFile,
} from "./observers/nested-observer.ts"
import { engineFileTokens, toSnapshot, type UsageLike } from "./metrics/usage.ts"
import { recordSpawn, type SpawnInput, type SpawnResult } from "./observers/agent-observer.ts"
import { observeSkill, skillNodeId } from "./observers/skill-observer.ts"

// Context Lab: wiring only. Engine events → pure observers → graph in $.state
// (live) and $.store (counts across sessions) → /context-lab views.
//
//   prompt.context   → observed instruction files (observe only, never modified)
//   prompt.attachment (nested_memory) → nested files the engine attached: observed
//   tool.call (Read) → the engine's nested walk for the read file: inferred
//   skill.prompt     → a skill's instructions delivered on activation: observed
//   agent.spawn      → subagent topology (type, fork, parent; never the prompt)
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
const agentsAtom = atom({ plugin: "context-lab", key: "agents" } as const, [])
const viewAtom = atom({ plugin: "context-lab", key: "view" } as const, "overview")
const issuesAtom = atom({ plugin: "context-lab", key: "issues" } as const, null)

const experimentAtom = atom({ plugin: "context-lab", key: "experiment" } as const, null)

const PANE = "context-lab"

// One eval at a time per process; `eval stop` asks the running one to stop
// after its current trial.
let evalRunning = false
let stopRequested = false

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
// The text each instruction node was last sent with, for the analyzers. In
// this process's memory only, never persisted (SPEC §39); after a reload the
// analyzers read the file from disk and say so.
const delivered = new Map<string, string>()
// Analysis bounds: existence checks per run, and how many run at once.
const MAX_PATH_CHECKS = 2000
const CHECK_BATCH = 50

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

  on("skill.prompt", async ($, e, next) => {
    const result = await next(e)
    track(recordSkill($, e.skill, result.text))
    return result
  })

  on("agent.spawn", async ($, e, next) => {
    const result = await next(e)
    track(recordAgent($, e, result))
    return result
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
      if (isPaneView(parsed.view)) {
        const view = parsed.view
        await refresh($, view === "tree")
        await update($, viewAtom, () => view)
        // Where a surface draws, the pane shows it and the transcript (which
        // the model reads) gets one line; headless, the text is the answer.
        if ((await $.session.surfaces()).length > 0) {
          const opened = await $.ui.open({ id: PANE, title: "Context Lab", focus: true, closeOnEscape: true })
          if (opened.isPlaced) return { text: openedLine(view) }
        }
        return { text: paneLines(view, await viewInput($)).join("\n") }
      }
      if (parsed.view === "doctor") return { text: renderDoctor(await probe($)) }
      if (parsed.view === "init") return { text: await initProject($) }
      if (parsed.view === "report") return { text: await writeReport($) }
      if (parsed.view === "eval") return { text: await startEval($, parsed.arg) }
      return { text: renderHelp(parsed) }
    } catch (err) {
      return { text: `Context Lab error: ${message(err)}` }
    }
  })

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const lines = paneLines(view, await viewInput($))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {TABS.map((tab) => (
            <Button
              key={`tab-${tab.view}`}
              hotkey={tab.hotkey}
              variant={tab.view === view ? "primary" : "secondary"}
              onPress={() => selectView($, tab.view)}
            >
              {tab.label}
            </Button>
          ))}
          <Button key="refresh" hotkey="r" onPress={() => refreshPane($)}>
            Refresh
          </Button>
        </Box>
        {lines.map((line) => (
          <Text bold={isHeading(line)} dimColor={isQuiet(line)}>
            {line.length > 0 ? line : " "}
          </Text>
        ))}
      </Box>
    )
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
  void work.catch(() => undefined).finally(() => inFlight.delete(work))
}

async function recordContext($: EngineInterface, result: ContextPayload): Promise<void> {
  try {
    for (const [id, text] of deliveredTexts(result)) delivered.set(id, text)
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
    for (const [id, delivery] of attachmentTexts(text)) delivered.set(id, delivery)
    const ctx ={ at: await $.clock.now(), root: await $.session.root(), sessionId: await sessionKey($) }
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

async function recordSkill($: EngineInterface, skill: string, text: string): Promise<void> {
  try {
    await seen($, "skill.prompt")
    delivered.set(skillNodeId(skill), text)
    const at = await $.clock.now()
    const sessionId = await sessionKey($)
    const graph = await update($, graphAtom, (g) => observeSkill(g, { skill, text }, { at, sessionId }))
    await persist($, graph)
  } catch (err) {
    debug($, "skill.prompt", err)
  }
}

async function recordAgent($: EngineInterface, e: SpawnInput, result: SpawnResult): Promise<void> {
  try {
    await seen($, "agent.spawn")
    const at = await $.clock.now()
    await update($, agentsAtom, (list) => recordSpawn(list, e, result, at))
  } catch (err) {
    debug($, "agent.spawn", err)
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

/**
 * Runs the analyzers over this context's instruction files (always-on and
 * nested), as delivered when in memory, else as on disk. Existence checks are
 * batched and bounded; nothing is written.
 */
async function findIssues($: EngineInterface): Promise<ContextIssue[]> {
  const graph = await read($, graphAtom)
  const nativeRoot = await $.session.root()
  const root = canonicalPath(nativeRoot)
  const sources: AnalyzedSource[] = []
  for (const id of [...graph.current, ...graph.nested, ...graph.skills]) {
    const node = graph.nodes[id]
    if (!node) continue
    const disk = node.path === undefined ? undefined : await readText($, node.path)
    const memory = delivered.get(id)
    const text = memory ?? disk
    if (text === undefined) continue
    sources.push({
      nodeId: id,
      file: node.path === undefined ? node.name : displayPath(node.path, root),
      text,
      fromDisk: memory === undefined,
      ...(disk === undefined ? {} : { diskLine: (line: number, needle: string) => locateLine(disk, needle, line) }),
    })
  }
  const config = parseAnalysisConfig(await readText($, join(root, ".context-lab/config.json")))
  const input = { graph, sources, root, config }
  const candidates = pathsToCheck(input).slice(0, MAX_PATH_CHECKS)
  const existing = new Set<string>()
  for (let i = 0; i < candidates.length; i += CHECK_BATCH) {
    const batch = candidates.slice(i, i + CHECK_BATCH)
    const found = await Promise.all(batch.map((p) => $.fs.exists(p).catch(() => false)))
    batch.forEach((p, j) => {
      if (found[j]) existing.add(p)
    })
  }
  return analyze(input, existing)
}

// ── Phase 6–7: init, report, eval ───────────────────────────────────────────

/** The eval harness's view of the machine, through `$` (no shell, ten minutes per process). */
function evalHost($: EngineInterface, root: string): EvalHost {
  return {
    isWindows: /^[a-z]:/i.test(root),
    run: async (argv, opts = {}) => {
      const r = await $.process.run([...argv], {
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      })
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    },
    read: (path) => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: (path) => $.fs.exists(path),
    list: async (path) => (await $.fs.list(path)).map((e) => ({ name: e.name, kind: e.kind })),
    now: () => $.clock.now(),
  }
}

/** /context-lab init: creates .context-lab/, never overwriting a file. */
async function initProject($: EngineInterface): Promise<string> {
  const root = canonicalPath(await $.session.root())
  const created: string[] = []
  const kept: string[] = []
  for (const f of initFiles()) {
    const path = join(root, f.path)
    if (await $.fs.exists(path)) kept.push(f.path)
    else {
      await $.fs.write(path, f.text)
      created.push(f.path)
    }
  }
  return renderInit(created, kept)
}

/** /context-lab report: one Markdown file under .context-lab/reports/ (SPEC §24). */
async function writeReport($: EngineInterface): Promise<string> {
  await refresh($, true)
  const root = canonicalPath(await $.session.root())
  const host = evalHost($, root)
  const at = await $.clock.now()
  const environment: { claudeVersion?: string; gitSha?: string; gitClean?: boolean; platform: string } = {
    platform: host.isWindows ? "Windows" : "POSIX",
  }
  try {
    environment.claudeVersion = (await $.session.version()).version
  } catch {}
  try {
    const head = await host.run(["git", "rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 })
    if (head.exitCode === 0) {
      environment.gitSha = head.stdout.trim()
      const st = await host.run(["git", "status", "--porcelain"], { cwd: root, timeoutMs: 30_000 })
      environment.gitClean = st.exitCode === 0 && st.stdout.trim() === ""
    }
  } catch {}
  const usage = await read($, usageAtom)
  const experiment = await latestSummary(host, root).catch(() => undefined)
  const text = renderReport({
    at,
    root,
    graph: await read($, graphAtom),
    ...(usage === null ? {} : { usage }),
    issues: (await read($, issuesAtom)) ?? [],
    agents: await read($, agentsAtom),
    environment,
    ...(experiment === undefined ? {} : { experiment }),
  })
  const path = join(root, `.context-lab/reports/${reportFileName(at)}`)
  await $.fs.write(path, text)
  return `Report written: ${displayPath(path, root)}`
}

/** Shows the latest finished experiment when nothing is running. */
async function loadLatestExperiment($: EngineInterface): Promise<void> {
  const current = await read($, experimentAtom)
  if (current?.status === "running") return
  const root = canonicalPath(await $.session.root())
  const summary = await latestSummary(evalHost($, root), root).catch(() => undefined)
  if (summary && current?.runId !== summary.runId) {
    await update($, experimentAtom, () => ({
      status: "done" as const,
      runId: summary.runId,
      variant: summary.variant,
      done: 0,
      total: 0,
      lines: renderExperiment(summary).split("\n"),
    }))
  }
}

/**
 * /context-lab eval <variant>. With a surface the run continues in the
 * background (progress in the status line and the Experiments view); headless
 * it runs to the end and answers with the result.
 */
async function startEval($: EngineInterface, arg: string | undefined): Promise<string> {
  if (arg === "stop") {
    if (!evalRunning) return "No eval is running."
    stopRequested = true
    return "Stopping after the current trial."
  }
  if (!arg) return "Usage: /context-lab eval <variant>   (variants live in .context-lab/variants/<name>/)"
  if (evalRunning) return "An eval is already running: /context-lab eval stop to stop it."
  const root = canonicalPath(await $.session.root())
  const prepared = await prepare(evalHost($, root), root, arg)
  if ("error" in prepared) return prepared.error
  const total = prepared.tasks.length * prepared.config.trialsPerTask * 2
  evalRunning = true
  stopRequested = false
  const run = runEval($, root, prepared, total)
  if ((await $.session.surfaces()).length === 0) return await run
  void run
  return `Eval started: baseline vs ${arg}, ${prepared.tasks.length} task(s) × ${prepared.config.trialsPerTask} trial(s) × 2 = ${total} trials. Progress: status line and /context-lab experiments. /context-lab eval stop to stop.`
}

async function runEval($: EngineInterface, root: string, prepared: Prepared, total: number): Promise<string> {
  const variant = prepared.variant.name
  try {
    await update($, experimentAtom, () => ({ status: "running" as const, runId: "", variant, done: 0, total, lines: [`Running baseline vs ${variant}: 0/${total} trials`] }))
    const outcome = await runExperiment(evalHost($, root), root, prepared, {
      shouldStop: () => stopRequested,
      onProgress: async (p) => {
        const line = `Running baseline vs ${variant}: ${p.done}/${p.total} trials${p.current ? ` — now ${p.current}` : ""}`
        $.ui.status(`Context Lab eval ${p.done}/${p.total}`)
        await update($, experimentAtom, () => ({ status: "running" as const, runId: p.runId, variant, done: p.done, total: p.total, lines: [line] }))
      },
    })
    const text = renderExperiment(outcome.summary) + (outcome.stopped ? "\n\nStopped before all trials ran." : "")
    const where = `Results: ${displayPath(outcome.resultsDir, root)}`
    await update($, experimentAtom, () => ({
      status: outcome.stopped ? ("stopped" as const) : ("done" as const),
      runId: outcome.runId,
      variant,
      done: outcome.results.length,
      total,
      lines: [...text.split("\n"), "", where],
    }))
    $.ui.toast(`Context Lab eval ${outcome.stopped ? "stopped" : "finished"}: ${outcome.summary.verdict}`)
    return `${text}\n\n${where}`
  } catch (err) {
    const msg = `Context Lab eval failed: ${message(err)}`
    await update($, experimentAtom, () => ({ status: "failed" as const, runId: "", variant, done: 0, total, lines: [msg] }))
    return msg
  } finally {
    evalRunning = false
    stopRequested = false
    $.ui.status(undefined)
  }
}

/** Brings the figures up to date: usage, the analyzers, and with `scan` the repository listing. */
async function refresh($: EngineInterface, scan: boolean): Promise<void> {
  await ensureLoaded($)
  await loadLatestExperiment($)
  await measureNow($, undefined)
  if (scan) await scanAvailable($)
  if ((await read($, graphAtom)).contexts > 0) {
    const issues = await findIssues($)
    await update($, issuesAtom, () => issues)
  }
}

async function viewInput($: EngineInterface) {
  const issues = await read($, issuesAtom)
  const experiment = await read($, experimentAtom)
  return {
    ...(experiment === null ? {} : { experiment: experiment.lines }),
    graph: await read($, graphAtom),
    usage: (await read($, usageAtom)) ?? undefined,
    root: await $.session.root(),
    agents: await read($, agentsAtom),
    ...(issues === null ? {} : { issues }),
  }
}

/** A tab's key: switches the view; tree and issues fetch what they show when missing. */
async function selectView($: EngineInterface, view: PaneView): Promise<void> {
  await update($, viewAtom, () => view)
  try {
    if (view === "tree") await scanAvailable($)
    if (view === "issues" && (await read($, issuesAtom)) === null) await refresh($, false)
  } catch (err) {
    debug($, "pane", err)
  }
}

async function refreshPane($: EngineInterface): Promise<void> {
  try {
    await Promise.allSettled([...inFlight])
    await refresh($, true)
  } catch (err) {
    debug($, "pane", err)
  }
}

function isHeading(line: string): boolean {
  return /^[A-Z][A-Z ()—-]{3,}$/.test(line) || /^\[\d+\] /.test(line)
}

function isQuiet(line: string): boolean {
  return line.startsWith("● observed") || /^\s*\(/.test(line) || line.startsWith("Findings are candidates")
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    if (!(await $.fs.exists(path))) return undefined
    return await $.fs.read(path)
  } catch {
    return undefined
  }
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
