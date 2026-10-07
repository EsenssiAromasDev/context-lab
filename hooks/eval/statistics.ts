// Experiment statistics (SPEC §34). Deterministic given the seed. The
// bootstrap resamples TASKS, not trials: repeated trials of one task are not
// independent evidence, so each resample draws whole tasks with their trials.

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function mean(xs: readonly number[]): number | undefined {
  return xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length
}

export function median(xs: readonly number[]): number | undefined {
  if (xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** (variant - baseline) / baseline × 100; undefined when there is no baseline to compare to. */
export function percentDiff(baseline: number | undefined, variant: number | undefined): number | undefined {
  if (baseline === undefined || variant === undefined || baseline === 0) return undefined
  return ((variant - baseline) / baseline) * 100
}

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

/** One task's outcomes per arm: 1 for a passing trial, 0 for a failing one. */
export interface PairedTask {
  baseline: readonly number[]
  variant: readonly number[]
}

/** Mean over tasks of each task's mean, for one arm: every task weighs the same. */
export function taskMean(tasks: readonly PairedTask[], arm: "baseline" | "variant"): number | undefined {
  return mean(tasks.map((t) => mean(t[arm])).filter((x): x is number => x !== undefined))
}

/**
 * 95% (by default) percentile bootstrap CI of variant − baseline in the
 * task-weighted mean, resampling tasks with replacement.
 */
export function bootstrapDiff(
  tasks: readonly PairedTask[],
  iterations: number,
  seed: number,
  level = 0.95,
): [number, number] | undefined {
  const usable = tasks.filter((t) => t.baseline.length > 0 && t.variant.length > 0)
  if (usable.length === 0) return undefined
  const diffs = usable.map((t) => mean(t.variant)! - mean(t.baseline)!)
  const next = rng(seed)
  const samples: number[] = []
  for (let b = 0; b < iterations; b++) {
    let sum = 0
    for (let k = 0; k < diffs.length; k++) sum += diffs[Math.floor(next() * diffs.length)]!
    samples.push(sum / diffs.length)
  }
  samples.sort((a, b) => a - b)
  const tail = (1 - level) / 2
  return [quantile(samples, tail), quantile(samples, 1 - tail)]
}
