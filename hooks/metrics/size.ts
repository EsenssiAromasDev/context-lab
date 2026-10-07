import { utf8Length } from "./hash.ts"

// Local size measurement. Token figures here are estimates and must always be
// rendered with "~" (SPEC §10); exact counts are an opt-in, separate tier.

export interface Size {
  characters: number
  bytes: number
  estimatedTokens: number
}

/** ~4 characters per token: a coarse, documented, local-only heuristic. */
export const CHARS_PER_TOKEN = 4

export function measure(text: string): Size {
  const characters = [...text].length
  return {
    characters,
    bytes: utf8Length(text),
    estimatedTokens: Math.ceil(characters / CHARS_PER_TOKEN),
  }
}

/** Compact count: 812, 3.6k, 71.4k, 1.2M. */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${trim((n / 1000).toFixed(1))}k`
  return `${trim((n / 1_000_000).toFixed(1))}M`
}

/** An estimated token count, always marked as such. */
export function approx(tokens: number | undefined): string {
  return tokens === undefined ? "?" : `~${compact(tokens)}`
}

/** A measured (not estimated) count with thousands separators. */
export function exact(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

function trim(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s
}
