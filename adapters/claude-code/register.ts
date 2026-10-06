import type { EngineInterface, Register } from "claude-code"
import type { ClaudeOSEvent } from "../../core/events.ts"
import { openSession, type Session } from "../../core/session.ts"
import { mapToolCall, type ToolOutcome } from "./mapper.ts"
import { RuntimeStore, type RuntimeFs } from "./runtime-store.ts"

// Claude Code adapter v0: real host events → ClaudeOSEvents → core reducer,
// persisted under <project>/.claudeos/ through $.fs.
//
//   session.start   → SESSION_STARTED (state restored from disk first)
//   tool.call       → FILE_CHANGED (Edit, Write, NotebookEdit)
//                     CHECK_RAN    (Bash/PowerShell running tests, lint, ...)
//   session.end     → CHECKPOINT
//
// No UI yet. Every rule about what counts as "done" stays in core/.
// ClaudeOS must never break the agent: failures are logged, never thrown.

interface Open {
  root: string
  session: Promise<Session>
}

// Lost on hot reload by design; everything that matters is on disk.
let open: Open | null = null

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    // A new session (or a reload) always restores from disk.
    open = null
    await dispatch($, (_root, at) => [{ type: "SESSION_STARTED", at }])
    return next(e)
  })

  on("tool.call", async ($, e, next) => {
    const ran = await next(e)
    const outcome: ToolOutcome =
      ran.deny !== undefined
        ? { kind: "denied" }
        : ran.isError
          ? { kind: "error", interrupted: isInterrupted(ran.text) }
          : { kind: "ok", result: ran.result }
    const { tool, ...input } = e
    await dispatch($, (root, at) => mapToolCall(String(tool), input, outcome, { root, at }))
    return ran
  })

  on("session.end", async ($, e, next) => {
    await dispatch($, (_root, at) => [{ type: "CHECKPOINT", at }])
    open = null
    return next(e)
  })
}

async function dispatch(
  $: EngineInterface,
  make: (root: string, at: number) => ClaudeOSEvent[],
): Promise<void> {
  try {
    const { root, session } = await current($)
    const events = make(root, await $.clock.now())
    const s = await session
    for (const event of events) await s.dispatch(event)
  } catch (err) {
    $.ui.log(`claudeos: ${err instanceof Error ? err.message : String(err)}`, { to: "debug" })
  }
}

async function current($: EngineInterface): Promise<Open> {
  if (open) return open
  const root = await $.session.root()
  const now = await $.clock.now()
  const fs: RuntimeFs = {
    read: (path) => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: (path) => $.fs.exists(path),
  }
  const store = new RuntimeStore(fs, root, () => now)
  open = { root, session: openSession(store, root, now) }
  return open
}

function isInterrupted(text: string | undefined): boolean {
  return text !== undefined && /interrupted|timed out|aborted/i.test(text)
}
