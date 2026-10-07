import type { Section } from "./sections.ts"

// Dated log entries ("2026-08-12 UTC — unidad 50: …") are the project's
// history, not instructions. Kept in CLAUDE.md, they are read in full in
// every conversation. A run of them is easy to recognize and to move out.

const DATED = /^\d{4}-\d{2}-\d{2}\b/

export const MIN_HISTORY_ENTRIES = 3

export interface HistoryBlock {
  /** 1-based inclusive line ranges, one per dated entry with its sub-sections. */
  ranges: { from: number; to: number }[]
  entries: number
  estimatedTokens: number
}

export function isDatedHeading(heading: string): boolean {
  return DATED.test(heading.trim())
}

/**
 * The dated entries of one file (each with the sub-sections under it), or
 * undefined when there are fewer than MIN_HISTORY_ENTRIES.
 */
export function historyBlock(sections: readonly Section[]): HistoryBlock | undefined {
  const ranges: { from: number; to: number }[] = []
  let tokens = 0
  let entries = 0
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!
    if (s.level === 0 || !isDatedHeading(s.heading)) continue
    let end = s.endLine
    tokens += s.estimatedTokens
    let j = i + 1
    while (j < sections.length && sections[j]!.level > s.level) {
      end = sections[j]!.endLine
      tokens += sections[j]!.estimatedTokens
      j++
    }
    ranges.push({ from: s.line, to: end })
    entries++
    i = j - 1
  }
  return entries >= MIN_HISTORY_ENTRIES ? { ranges, entries, estimatedTokens: tokens } : undefined
}
