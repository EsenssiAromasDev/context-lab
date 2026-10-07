import { sha256 } from "../metrics/hash.ts"
import { normalized, words, type Section } from "./sections.ts"

// Exact duplication (SPEC §13) and lexical overlap (SPEC §14). Deterministic
// text comparison only: this is never "semantic similarity".

export interface DuplicateGroup {
  sections: Section[]
  /** Characters of the normalized body repeated beyond its first copy. */
  duplicatedCharacters: number
  /** Tokens beyond the first copy: what removing the copies could save. */
  estimatedSavings: number
}

export interface Overlap {
  a: Section
  b: Section
  /** Jaccard similarity of 5-word shingles, 0..1. */
  jaccard: number
  level: "high" | "medium"
  estimatedSavings: number
}

export interface OverlapThresholds {
  high: number
  medium: number
}

export const DEFAULT_OVERLAP: OverlapThresholds = { high: 0.85, medium: 0.7 }

/** Bodies shorter than this (normalized) are too small to call duplicated. */
export const MIN_DUPLICATE_CHARS = 20
/** Sections with fewer shingles than this are too small for a Jaccard figure to mean much. */
export const MIN_SHINGLES = 3
const SHINGLE = 5

export function exactDuplicates(sections: readonly Section[]): DuplicateGroup[] {
  const groups = new Map<string, Section[]>()
  for (const s of sections) {
    const norm = normalized(s.body)
    if (norm.length < MIN_DUPLICATE_CHARS) continue
    const key = sha256(norm)
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const chars = normalized(g[0]!.body).length
      return {
        sections: g,
        duplicatedCharacters: chars * (g.length - 1),
        estimatedSavings: g.slice(1).reduce((n, s) => n + s.estimatedTokens, 0),
      }
    })
}

export function shingles(text: string, size = SHINGLE): Set<string> {
  const w = words(text)
  const out = new Set<string>()
  if (w.length === 0) return out
  if (w.length < size) {
    out.add(w.join(" "))
    return out
  }
  for (let i = 0; i + size <= w.length; i++) out.add(w.slice(i, i + size).join(" "))
  return out
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const x of small) if (large.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/**
 * Pairs of sections with high or medium lexical overlap, exact duplicates
 * excluded (they are reported as duplicates).
 */
export function lexicalOverlaps(
  sections: readonly Section[],
  thresholds: OverlapThresholds = DEFAULT_OVERLAP,
): Overlap[] {
  const exact = new Set<string>()
  for (const g of exactDuplicates(sections)) for (const s of g.sections) exact.add(sectionKey(s))
  const prepared = sections
    .map((s) => ({ s, sh: shingles(s.body) }))
    .filter((p) => p.sh.size >= MIN_SHINGLES)
  const out: Overlap[] = []
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i]!
      const b = prepared[j]!
      if (exact.has(sectionKey(a.s)) && exact.has(sectionKey(b.s)) && normalized(a.s.body) === normalized(b.s.body)) continue
      const score = jaccard(a.sh, b.sh)
      if (score < thresholds.medium) continue
      out.push({
        a: a.s,
        b: b.s,
        jaccard: score,
        level: score >= thresholds.high ? "high" : "medium",
        estimatedSavings: Math.round(Math.min(a.s.estimatedTokens, b.s.estimatedTokens) * score),
      })
    }
  }
  return out.sort((x, y) => y.jaccard - x.jaccard)
}

export function sectionKey(s: Section): string {
  return `${s.nodeId}#${s.line}`
}
