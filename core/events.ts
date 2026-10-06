import type { CheckKind, CheckResult, Task } from "./state.ts"

// Agent-agnostic events. Claude Code, Codex, Gemini CLI, etc. are adapters
// that normalize their native hook payloads into these. Nothing in core/
// knows which agent produced an event.

export type ClaudeOSEventBody =
  | { type: "SESSION_STARTED" }
  | { type: "USER_GOAL"; goal: string }
  | { type: "PLAN_SET"; tasks: Array<Pick<Task, "id" | "title">> }
  | { type: "TASK_STARTED"; taskId: string }
  | { type: "TASK_COMPLETED"; taskId: string }
  | { type: "DECISION_MADE"; id: string; text: string }
  | { type: "FILE_CHANGED"; path: string }
  | { type: "CHECK_RAN"; kind: CheckKind; result: CheckResult }
  | { type: "BLOCKER_FOUND"; id: string; text: string }
  | { type: "BLOCKER_RESOLVED"; id: string }
  | { type: "NEXT_ACTION_SET"; action: string }
  | { type: "SHIP_REQUESTED" }
  | { type: "SHIP_REJECTED"; reasons: string[] }
  // `required` are the checks detected for this project. The reducer re-verifies
  // them against recorded evidence, so an adapter cannot force "done".
  | { type: "SHIP_APPROVED"; required: CheckKind[] }
  | { type: "CHECKPOINT" }

/** Every event carries the time it happened so the reducer stays pure. */
export type ClaudeOSEvent = ClaudeOSEventBody & { at: number }

export type ClaudeOSEventType = ClaudeOSEvent["type"]
