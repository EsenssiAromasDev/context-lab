import type { ClaudeOSEvent } from "./events.ts"
import { reduce, reduceAll } from "./reducer.ts"
import { STATE_VERSION, createInitialState, type ProjectState } from "./state.ts"

// Restore and dispatch policy, shared by every runtime. Storage backends only
// move text (Node's fs, Claude Code's $.fs, ...); parsing, validation, journal
// replay and ordering live here so every agent gets the same guarantees.
//
// On disk (whatever the backend):
//   state.json    latest ProjectState snapshot
//   events.jsonl  append-only journal; rebuilds state if the snapshot is lost

export interface StateStorage {
  /** Snapshot text, or null when there is none. */
  readSnapshot(): Promise<string | null>
  writeSnapshot(text: string): Promise<void>
  /** Keep a copy of an unreadable snapshot for inspection; never delete it. */
  quarantineSnapshot(text: string): Promise<void>
  /** Whole journal text, or "" when there is none. */
  readJournal(): Promise<string>
  appendJournal(line: string): Promise<void>
}

export interface Session {
  readonly state: ProjectState
  /** True when state came from storage (snapshot or journal), i.e. "RESTORED". */
  readonly restored: boolean
  /** Journal, reduce, snapshot. Calls are applied strictly in call order. */
  dispatch(event: ClaudeOSEvent): Promise<ProjectState>
}

/** Open the project's state: snapshot → journal replay → fresh state. */
export async function openSession(storage: StateStorage, projectId: string, now: number): Promise<Session> {
  let state = await loadSnapshot(storage)
  let restored = state !== null

  if (!state) {
    const journal = parseJournal(await storage.readJournal())
    state = reduceAll(createInitialState(projectId, now), journal)
    restored = journal.length > 0
    if (restored) await storage.writeSnapshot(serialize(state))
  }

  let current = state
  // Hooks can fire concurrently (parallel tool calls); a chain keeps the
  // journal order equal to the reduce order.
  let queue: Promise<unknown> = Promise.resolve()

  return {
    get state() {
      return current
    },
    restored,
    dispatch(event) {
      const run = queue.then(async () => {
        await storage.appendJournal(JSON.stringify(event) + "\n")
        const next = reduce(current, event)
        if (next !== current) {
          await storage.writeSnapshot(serialize(next))
          current = next
        }
        return current
      })
      queue = run.catch(() => {})
      return run
    },
  }
}

async function loadSnapshot(storage: StateStorage): Promise<ProjectState | null> {
  const text = await storage.readSnapshot()
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (isProjectState(parsed)) return parsed
  } catch {
    // fall through
  }
  await storage.quarantineSnapshot(text)
  return null
}

/** Journal events in order. Skips a torn last line from a crash mid-append. */
export function parseJournal(text: string): ClaudeOSEvent[] {
  const events: ClaudeOSEvent[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as ClaudeOSEvent)
    } catch {
      // skip
    }
  }
  return events
}

function serialize(state: ProjectState): string {
  return JSON.stringify(state, null, 2) + "\n"
}

function isProjectState(v: unknown): v is ProjectState {
  if (typeof v !== "object" || v === null) return false
  const s = v as Record<string, unknown>
  return (
    s.version === STATE_VERSION &&
    typeof s.projectId === "string" &&
    typeof s.goal === "string" &&
    typeof s.phase === "string" &&
    Array.isArray(s.plan) &&
    Array.isArray(s.decisions) &&
    Array.isArray(s.blockers) &&
    Array.isArray(s.changedFiles) &&
    typeof s.evidence === "object" &&
    s.evidence !== null
  )
}
