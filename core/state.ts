// ProjectState is the single source of truth. Everything ClaudeOS shows or
// decides must be derivable from: ProjectState + git + working tree + evidence.
// Never from replaying old conversation messages.

export const STATE_VERSION = 1

export type Phase = "planning" | "implementing" | "verifying" | "done"

export type CheckKind = "tests" | "lint" | "types" | "build" | "review"

export const CHECK_KINDS: readonly CheckKind[] = ["tests", "lint", "types", "build", "review"]

export interface CheckResult {
  status: "passed" | "failed" | "error"
  /** Command that produced this result, e.g. "npm test". */
  command?: string
  passed?: number
  failed?: number
  /** Short human-readable failure lines (test names, first error lines). */
  failures?: string[]
  /** When the check finished. Used to detect stale evidence. */
  at: number
}

export interface Task {
  id: string
  title: string
  status: "pending" | "in_progress" | "done"
}

export interface Decision {
  id: string
  text: string
  at: number
}

export interface Blocker {
  id: string
  text: string
  at: number
}

export interface ProjectState {
  version: typeof STATE_VERSION
  projectId: string

  goal: string
  phase: Phase
  currentTask: string

  plan: Task[]
  decisions: Decision[]
  /** Open blockers only; resolved ones are removed. */
  blockers: Blocker[]

  changedFiles: string[]
  /** Timestamp of the last FILE_CHANGED. Evidence older than this is stale. */
  lastChangeAt: number

  evidence: Partial<Record<CheckKind, CheckResult>>

  nextAction: string

  updatedAt: number
}

export function createInitialState(projectId: string, now: number): ProjectState {
  return {
    version: STATE_VERSION,
    projectId,
    goal: "",
    phase: "planning",
    currentTask: "",
    plan: [],
    decisions: [],
    blockers: [],
    changedFiles: [],
    lastChangeAt: 0,
    evidence: {},
    nextAction: "",
    updatedAt: now,
  }
}

/** Fraction of plan tasks completed, 0..1. Returns null when there is no plan. */
export function progress(state: ProjectState): number | null {
  if (state.plan.length === 0) return null
  const done = state.plan.filter((t) => t.status === "done").length
  return done / state.plan.length
}
