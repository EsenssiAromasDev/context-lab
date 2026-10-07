import { measure } from "../metrics/size.ts"
import type { SourceText } from "./sections.ts"
import { join } from "./stale-paths.ts"

// Repository-discoverable context (SPEC §16), conservative V1 patterns:
// directory trees and long explicit file inventories whose entries mostly
// exist in the repository — information Claude can list on demand.

export interface ListingBlock {
  nodeId: string
  file: string
  kind: "tree" | "inventory"
  /** 1-based line where the block starts in the analyzed text. */
  line: number
  /** Repository-relative entries, no trailing slash. */
  entries: string[]
  estimatedTokens: number
}

export interface DiscoverableBlock extends ListingBlock {
  existing: number
  /** Entries in the reading kept (the project's own folder line dropped when that reads better). */
  total: number
  /** existing / total */
  ratio: number
}

export const MIN_ENTRIES = 5
export const MIN_RATIO = 0.8

const FENCE = /^[ \t]{0,3}(```|~~~)/
const GLYPH = /[├└│]|^\s*[|`]--/
const COMMENT = /\s+(?:#|<-|←|—|–|-{1,2}\s|\/\/).*$/
const NAME = /^[\w@.+-][\w@.+ -]*\/?$/
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
const LEADING_PATH = /^`?((?:\.\/)?[\w@.-]+(?:\/[\w@.-]+)*\/?)`?(?:\s|$|:)/

export function findListings(src: SourceText): ListingBlock[] {
  const lines = src.text.split(/\r?\n/)
  const out: ListingBlock[] = []
  let i = 0
  while (i < lines.length) {
    const f = FENCE.exec(lines[i]!)
    if (f) {
      const start = i
      const body: string[] = []
      i++
      while (i < lines.length && !(FENCE.exec(lines[i]!)?.[1] === f[1])) body.push(lines[i++]!)
      i++ // closing fence
      const entries = parseTree(body)
      if (entries) out.push(block(src, "tree", start + 1, entries, lines.slice(start, i).join("\n")))
      continue
    }
    if (BULLET.test(lines[i]!)) {
      const start = i
      const items: string[] = []
      while (i < lines.length && BULLET.test(lines[i]!)) items.push(BULLET.exec(lines[i++]!)![1]!)
      const entries = items
        .map((t) => LEADING_PATH.exec(t)?.[1])
        .filter((p): p is string => p !== undefined && (p.includes("/") || /\.\w{1,6}$/.test(p)))
        .map((p) => p.replace(/^\.\//, "").replace(/\/$/, ""))
      // An inventory: most items of the list name a path.
      if (entries.length >= MIN_ENTRIES && entries.length >= items.length * 0.8) {
        out.push(block(src, "inventory", start + 1, entries, lines.slice(start, i).join("\n")))
      }
      continue
    }
    i++
  }
  return out
}

function block(src: SourceText, kind: ListingBlock["kind"], line: number, entries: string[], text: string): ListingBlock {
  return { nodeId: src.nodeId, file: src.file, kind, line, entries: [...new Set(entries)], estimatedTokens: measure(text).estimatedTokens }
}

/**
 * A code block's lines as a directory tree, or null when it is not one: tree
 * glyphs on most lines, or an indented list of bare names (dirs ending "/").
 */
export function parseTree(body: readonly string[]): string[] | null {
  const lines = body.filter((l) => l.trim().length > 0)
  if (lines.length < MIN_ENTRIES) return null
  const glyphs = lines.filter((l) => GLYPH.test(l)).length
  const isGlyphTree = glyphs >= lines.length * 0.6
  if (!isGlyphTree) {
    const named = lines.filter((l) => NAME.test(l.replace(COMMENT, "").trim())).length
    const indented = lines.some((l) => /^\s+\S/.test(l))
    const dirs = lines.some((l) => l.replace(COMMENT, "").trim().endsWith("/"))
    if (!(named === lines.length && indented && dirs)) return null
  }

  const stack: { col: number; name: string }[] = []
  const entries: string[] = []
  for (const raw of lines) {
    const noComment = raw.replace(COMMENT, "")
    const m = /^([\s│├└─|`\-]*)(.*)$/.exec(noComment)!
    const name = m[2]!.trim()
    if (!name || !NAME.test(name)) continue
    const col = m[1]!.length
    while (stack.length && stack[stack.length - 1]!.col >= col) stack.pop()
    const clean = name.replace(/\/$/, "")
    if (clean === "." || clean === "") {
      stack.push({ col, name: "" })
      continue
    }
    const path = [...stack.map((s) => s.name).filter(Boolean), clean].join("/")
    entries.push(path)
    stack.push({ col, name: clean })
  }
  return entries.length >= MIN_ENTRIES ? entries : null
}

/**
 * Scores a listing against the repository. Trees often start at the project's
 * own folder name: entries are tried as written and with that first segment
 * dropped, and the better reading is kept.
 */
export function scoreListing(
  listing: ListingBlock,
  exists: (path: string) => boolean,
  root: string,
): DiscoverableBlock {
  const asWritten = count(listing.entries, exists, root)
  const first = listing.entries[0]?.split("/")[0]
  const shared = first !== undefined && listing.entries.every((e) => e === first || e.startsWith(`${first}/`))
  const stripped = shared
    ? count(
        listing.entries.filter((e) => e !== first).map((e) => e.slice(first.length + 1)),
        exists,
        root,
      )
    : { existing: 0, total: 0 }
  const best =
    stripped.total > 0 && stripped.existing / stripped.total > asWritten.existing / asWritten.total ? stripped : asWritten
  return { ...listing, existing: best.existing, total: best.total, ratio: best.total === 0 ? 0 : best.existing / best.total }
}

/** Every path a listing may name, for the caller to check on disk. */
export function listingCandidates(listing: ListingBlock, root: string): string[] {
  const first = listing.entries[0]?.split("/")[0] ?? ""
  return listing.entries.flatMap((e) => {
    const out = [join(root, e)]
    if (first && e.startsWith(`${first}/`)) out.push(join(root, e.slice(first.length + 1)))
    return out
  })
}

function count(entries: readonly string[], exists: (p: string) => boolean, root: string) {
  return { existing: entries.filter((e) => exists(join(root, e))).length, total: entries.length }
}

export function isDiscoverable(b: DiscoverableBlock, minRatio = MIN_RATIO): boolean {
  return b.total >= MIN_ENTRIES && b.ratio >= minRatio
}
