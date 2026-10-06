import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ClaudeOSEvent } from "./events.ts"
import { reduce, reduceAll } from "./reducer.ts"
import { STATE_VERSION, createInitialState, type ProjectState } from "./state.ts"

// Persistence. Two files under <project>/.claudeos/:
//   state.json    latest ProjectState snapshot (atomic write)
//   events.jsonl  append-only journal; can rebuild state if the snapshot is lost
//
// Synchronous on purpose: hooks are short-lived processes and must not exit
// before the write lands.

export class FileStore {
  readonly dir: string
  readonly statePath: string
  readonly journalPath: string

  constructor(projectRoot: string) {
    this.dir = join(projectRoot, ".claudeos")
    this.statePath = join(this.dir, "state.json")
    this.journalPath = join(this.dir, "events.jsonl")
  }

  /** Snapshot if valid; otherwise null. A corrupt snapshot is moved aside, not deleted. */
  load(): ProjectState | null {
    if (!existsSync(this.statePath)) return null
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, "utf8"))
      if (isProjectState(parsed)) return parsed
    } catch {
      // fall through
    }
    renameSync(this.statePath, `${this.statePath}.corrupt-${Date.now()}`)
    return null
  }

  save(state: ProjectState): void {
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.statePath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8")
    renameSync(tmp, this.statePath)
  }

  append(event: ClaudeOSEvent): void {
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(this.journalPath, JSON.stringify(event) + "\n", "utf8")
  }

  /** Journal events in order. Skips a torn last line from a crash mid-append. */
  readJournal(): ClaudeOSEvent[] {
    if (!existsSync(this.journalPath)) return []
    const events: ClaudeOSEvent[] = []
    for (const line of readFileSync(this.journalPath, "utf8").split("\n")) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as ClaudeOSEvent)
      } catch {
        // skip
      }
    }
    return events
  }
}

export interface Session {
  readonly state: ProjectState
  /** True when state came from disk (snapshot or journal), i.e. "RESTORED". */
  readonly restored: boolean
  dispatch(event: ClaudeOSEvent): ProjectState
}

/**
 * Open the project's state: snapshot → journal replay → fresh state.
 * Every dispatch is journaled first, then reduced, then snapshotted.
 */
export function openSession(store: FileStore, projectId: string, now: number): Session {
  let state = store.load()
  let restored = state !== null

  if (!state) {
    const journal = store.readJournal()
    state = reduceAll(createInitialState(projectId, now), journal)
    restored = journal.length > 0
    if (restored) store.save(state)
  }

  let current = state
  return {
    get state() {
      return current
    },
    restored,
    dispatch(event) {
      store.append(event)
      const next = reduce(current, event)
      if (next !== current) {
        store.save(next)
        current = next
      }
      return current
    },
  }
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
