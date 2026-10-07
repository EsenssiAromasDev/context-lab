import { joinPath, listFiles, type EvalHost } from "./host.ts"

// Context variants (SPEC §28): `.context-lab/variants/<name>/manifest.json`
// and a `files/` overlay copied over the trial's tree. Written by people in
// V1; `delete` removes tracked files (e.g. a CLAUDE.md) in the variant.

export interface VariantManifest {
  name: string
  description?: string
  createdFrom?: string
  changes?: { file: string; reason: string }[]
  delete?: string[]
}

export interface Variant {
  name: string
  dir: string
  manifest: VariantManifest
  /** Overlay files, relative to the project root. */
  files: string[]
  delete: string[]
}

export const BASELINE = "baseline"

export function variantDir(root: string, name: string): string {
  return joinPath(root, ".context-lab/variants", name)
}

function safeRelative(p: string): boolean {
  return p.length > 0 && !/^([a-z]:)?[\\/]/i.test(p) && !p.split(/[\\/]/).includes("..")
}

export async function loadVariant(host: EvalHost, root: string, name: string): Promise<Variant | { error: string }> {
  if (!/^[\w.-]{1,64}$/.test(name) || name === BASELINE) return { error: `"${name}" is not a usable variant name` }
  const dir = variantDir(root, name)
  const manifestPath = joinPath(dir, "manifest.json")
  if (!(await host.exists(manifestPath))) return { error: `no variant "${name}": ${manifestPath} not found` }
  let manifest: VariantManifest
  try {
    manifest = JSON.parse(await host.read(manifestPath)) as VariantManifest
  } catch (err) {
    return { error: `${manifestPath}: ${err instanceof Error ? err.message : String(err)}` }
  }
  const del = Array.isArray(manifest.delete) ? manifest.delete.filter((d): d is string => typeof d === "string") : []
  const bad = del.find((d) => !safeRelative(d))
  if (bad !== undefined) return { error: `${manifestPath}: delete entry "${bad}" must be a relative path inside the project` }
  const files = await listFiles(host, joinPath(dir, "files"))
  if (files.length === 0 && del.length === 0) return { error: `variant "${name}" changes nothing (no files/ and no delete)` }
  return { name, dir, manifest, files, delete: del }
}

/** Applies a variant to a trial's project root: overlay copied in, deletions removed through git. */
export async function applyVariant(host: EvalHost, v: Variant, wtRoot: string): Promise<void> {
  for (const rel of v.files) await host.write(joinPath(wtRoot, rel), await host.read(joinPath(v.dir, "files", rel)))
  if (v.delete.length) {
    const r = await host.run(["git", "rm", "-q", "--ignore-unmatch", "--", ...v.delete], { cwd: wtRoot, timeoutMs: 60_000 })
    if (r.exitCode !== 0) throw new Error(`variant delete failed: ${r.stderr.trim()}`)
  }
}

export async function listVariants(host: EvalHost, root: string): Promise<string[]> {
  const dir = joinPath(root, ".context-lab/variants")
  if (!(await host.exists(dir))) return []
  return (await host.list(dir)).filter((e) => e.kind === "dir").map((e) => e.name).sort()
}
