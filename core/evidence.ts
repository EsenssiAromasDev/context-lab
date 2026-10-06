import type { CheckKind, CheckResult, ProjectState } from "./state.ts"

// Evidence rules: a check only counts if it passed AND ran after the last
// file change. "Tests passed an hour ago, then I edited three files" is not
// evidence.

export function isStale(check: CheckResult, lastChangeAt: number): boolean {
  return check.at < lastChangeAt
}

export interface ShipReadiness {
  ready: boolean
  missing: CheckKind[]
  failing: CheckKind[]
  stale: CheckKind[]
  openBlockers: number
  pendingTasks: number
}

/**
 * Whether the project may be declared done. `required` is the set of checks
 * that exist for this project (detected from package.json, pyproject, etc.).
 */
export function shipReadiness(state: ProjectState, required: readonly CheckKind[]): ShipReadiness {
  const missing: CheckKind[] = []
  const failing: CheckKind[] = []
  const stale: CheckKind[] = []

  for (const kind of required) {
    const check = state.evidence[kind]
    if (!check) missing.push(kind)
    else if (check.status !== "passed") failing.push(kind)
    else if (isStale(check, state.lastChangeAt)) stale.push(kind)
  }

  const openBlockers = state.blockers.length
  const pendingTasks = state.plan.filter((t) => t.status !== "done").length

  return {
    ready:
      missing.length === 0 &&
      failing.length === 0 &&
      stale.length === 0 &&
      openBlockers === 0 &&
      pendingTasks === 0,
    missing,
    failing,
    stale,
    openBlockers,
    pendingTasks,
  }
}

export function readinessReasons(r: ShipReadiness): string[] {
  const reasons: string[] = []
  if (r.missing.length) reasons.push(`missing evidence: ${r.missing.join(", ")}`)
  if (r.failing.length) reasons.push(`failing: ${r.failing.join(", ")}`)
  if (r.stale.length) reasons.push(`stale (files changed since): ${r.stale.join(", ")}`)
  if (r.openBlockers) reasons.push(`${r.openBlockers} open blocker(s)`)
  if (r.pendingTasks) reasons.push(`${r.pendingTasks} pending task(s)`)
  return reasons
}
