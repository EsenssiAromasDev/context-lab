import type { ClaudeOSEvent } from "./events.ts"
import { readinessReasons, shipReadiness } from "./evidence.ts"
import { createInitialState, type ProjectState, type Task } from "./state.ts"

// The only code allowed to change ProjectState. Pure: same state + event
// always yields the same result, and the input state is never mutated.

export function reduce(state: ProjectState, event: ClaudeOSEvent): ProjectState {
  const next = apply(state, event)
  return next === state ? state : { ...next, updatedAt: event.at }
}

export function reduceAll(state: ProjectState, events: Iterable<ClaudeOSEvent>): ProjectState {
  let s = state
  for (const e of events) s = reduce(s, e)
  return s
}

function apply(s: ProjectState, e: ClaudeOSEvent): ProjectState {
  switch (e.type) {
    case "SESSION_STARTED":
    case "CHECKPOINT":
      return { ...s }

    case "USER_GOAL": {
      // A new goal starts a new unit of work; nothing from the old one carries over.
      return { ...createInitialState(s.projectId, e.at), goal: e.goal }
    }

    case "PLAN_SET": {
      const previous = new Map(s.plan.map((t) => [t.id, t.status]))
      const plan: Task[] = e.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: previous.get(t.id) ?? "pending",
      }))
      return { ...s, plan, phase: s.phase === "planning" ? "implementing" : s.phase }
    }

    case "TASK_STARTED": {
      const task = s.plan.find((t) => t.id === e.taskId)
      if (!task) return s
      return {
        ...s,
        plan: setTaskStatus(s.plan, e.taskId, "in_progress"),
        currentTask: task.title,
        phase: "implementing",
      }
    }

    case "TASK_COMPLETED": {
      const task = s.plan.find((t) => t.id === e.taskId)
      if (!task) return s
      return {
        ...s,
        plan: setTaskStatus(s.plan, e.taskId, "done"),
        currentTask: s.currentTask === task.title ? "" : s.currentTask,
      }
    }

    case "DECISION_MADE":
      return {
        ...s,
        decisions: [...s.decisions.filter((d) => d.id !== e.id), { id: e.id, text: e.text, at: e.at }],
      }

    case "FILE_CHANGED": {
      const path = normalizePath(e.path)
      const changedFiles = s.changedFiles.includes(path) ? s.changedFiles : [...s.changedFiles, path]
      // Any edit invalidates verification: back to implementing.
      return { ...s, changedFiles, lastChangeAt: e.at, phase: "implementing" }
    }

    case "WORKTREE_CHANGED":
      return { ...s, lastChangeAt: e.at, phase: "implementing" }

    case "CHECK_RAN":
      return { ...s, evidence: { ...s.evidence, [e.kind]: e.result } }

    case "BLOCKER_FOUND":
      return {
        ...s,
        blockers: [...s.blockers.filter((b) => b.id !== e.id), { id: e.id, text: e.text, at: e.at }],
      }

    case "BLOCKER_RESOLVED": {
      if (!s.blockers.some((b) => b.id === e.id)) return s
      return { ...s, blockers: s.blockers.filter((b) => b.id !== e.id) }
    }

    case "NEXT_ACTION_SET":
      return { ...s, nextAction: e.action }

    case "SHIP_REQUESTED":
      return { ...s, phase: "verifying" }

    case "SHIP_REJECTED":
      return rejectShip(s, e.reasons)

    case "SHIP_APPROVED": {
      const readiness = shipReadiness(s, e.required)
      if (!readiness.ready) return rejectShip(s, readinessReasons(readiness))
      return { ...s, phase: "done", currentTask: "", nextAction: "" }
    }

    default:
      // Unknown event (e.g. from a newer journal): ignore rather than crash.
      return s
  }
}

function rejectShip(s: ProjectState, reasons: string[]): ProjectState {
  return {
    ...s,
    phase: "implementing",
    nextAction: reasons.length ? `Fix before shipping: ${reasons[0]}` : s.nextAction,
  }
}

function setTaskStatus(plan: Task[], id: string, status: Task["status"]): Task[] {
  return plan.map((t) => (t.id === id ? { ...t, status } : t))
}

/** Forward slashes, no leading "./", so paths from Windows and POSIX agents compare equal. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "")
}
