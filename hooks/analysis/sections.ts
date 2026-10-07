import { measure } from "../metrics/size.ts"

// Markdown → sections by ATX heading (SPEC §13). Headings inside fenced code
// blocks are not headings. Text before the first heading is "(inicio del archivo)".

export interface Section {
  nodeId: string
  /** How the file reads to the person (./CLAUDE.md, ~/.claude/CLAUDE.md). */
  file: string
  /** Heading text, "(inicio del archivo)" for text before the first heading. */
  heading: string
  level: number
  /** 1-based line of the heading (or 1 for the preamble) in the analyzed text. */
  line: number
  /** 1-based last line of the section (its own body; a sub-heading starts a new section). */
  endLine: number
  /** The section's body, heading line excluded. */
  body: string
  estimatedTokens: number
}

export interface SourceText {
  nodeId: string
  file: string
  text: string
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/
const FENCE = /^[ \t]{0,3}(```|~~~)/

export function splitSections(src: SourceText): Section[] {
  const lines = src.text.split(/\r?\n/)
  const out: Section[] = []
  let heading = "(inicio del archivo)"
  let level = 0
  let line = 1
  let body: string[] = []
  let fence: string | null = null

  const flush = () => {
    const text = body.join("\n").trim()
    if (text.length > 0 || level > 0) {
      const endLine = level > 0 ? line + body.length : body.length
      out.push({ nodeId: src.nodeId, file: src.file, heading, level, line, endLine, body: text, estimatedTokens: measure(text).estimatedTokens })
    }
  }

  lines.forEach((raw, i) => {
    const f = FENCE.exec(raw)
    if (f) {
      if (fence === null) fence = f[1]!
      else if (f[1] === fence) fence = null
      body.push(raw)
      return
    }
    const h = fence === null ? HEADING.exec(raw) : null
    if (h) {
      flush()
      heading = h[2]!.trim()
      level = h[1]!.length
      line = i + 1
      body = []
      return
    }
    body.push(raw)
  })
  flush()
  return out
}

/** Lower-cased words of a text with Markdown formatting, links' URLs and punctuation removed. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~>#|]/g, " ")
    .replace(/[^\p{L}\p{N}./-]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.\-/]+|[.\-/]+$/g, ""))
    .filter(Boolean)
}

/** A section body normalized for exact comparison. */
export function normalized(text: string): string {
  return words(text).join(" ")
}
